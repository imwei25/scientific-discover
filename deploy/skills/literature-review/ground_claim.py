#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
引用溯源到原句：给一句论断 + 它所引的 DOI/PMID，去取那篇文献的摘要，
拆成句子，找出**最能支撑这句论断的原文句子**并打分——把"你的转述是否忠于
原文"从人工核对变成机械可查。

补 `reference-check` 的盲区：reference-check 只确认"这篇文献真实存在、标题吻合"，
**管不了你对它的转述是否准确**（write-paper 明确警告：讨论里的转述失真是最危险的
幻觉）。本脚本把被引文献的摘要里最相关的那一两句捞出来，供你逐句核对措辞。

用法：
  # 单条：第一个参数是论断，后面跟它引的一个或多个 DOI/PMID
  python ground_claim.py "他汀显著降低卒中复发风险" 10.1056/NEJMoa1615664 PMID:27295427
  # 批量：CSV，两列 claim,ref（ref 为 doi 或 pmid），逐对核
  python ground_claim.py --input claims.csv
产出（--outdir，默认 outputs）：
  claim_grounding.md   人读报告（每条论断 → 最匹配原句 + 分数 + 提示）
  claim_grounding.csv  逐条明细

评分是**检索辅助**不是判决：分数高=摘要里有措辞接近的句子；分数低可能是
①转述失真，②该支撑点在全文正文而非摘要（此时用 fulltext-retrieval 读全文再核）。

⚠️ **只对英文论断有效**：评分是 TF-IDF 词面匹配、**不跨语言**。Europe PMC 摘要
基本全英文，**中文论断对英文摘要会恒判 WEAK/0.0，与转述准不准无关**。用法上把
论断先译成英文短句再传入；若传中文，WEAK 一律当"未测"、须人工回原文核，别信分数。
"""
import argparse
import csv
import os
import re
import sys
import time

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    import requests
except ImportError:
    sys.exit("缺少 requests：先在仓库根跑 env-setup 技能。")

EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
_EMAIL = (os.environ.get("SCI_CONTACT_EMAIL")
          or os.environ.get("MEDSCI_CONTACT_EMAIL")
          or os.environ.get("CONTACT_EMAIL")
          or "sci-skill@users.noreply.github.com")
UA = {"User-Agent": f"sci-agent-claim-grounding/1.0 (mailto:{_EMAIL})"}
TIMEOUT = 30
DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I)
PMID_RE = re.compile(r"\bPMID:?\s*(\d{5,9})\b", re.I)


# ---- 产物目录解析（8 个技能脚本统一；见 AGENTS.md §五）----
# 优先级：显式参数 > SCI_OUTPUT_DIR 环境变量 > 当前工作目录(若已在 outputs/<会话id>/ 内) > 报错中止。
# 【绝不】再默认写共享的 outputs/ 根：那里不会出现在界面"产出"侧栏，
# 且同一用户的多个会话共用一个 outputs 卷，写固定名会跨会话互相覆盖。
# 为什么必须由外部传进来：opencode 是【一个进程服务所有会话】的，
# 脚本自己读不到任何会话级上下文，只能靠主控（网关每轮注入的 preamble）用环境变量或参数告知。
def _resolve_out_dir(explicit=None):
    import os as _os, sys as _sys
    from pathlib import Path as _Path
    _cwd = _Path.cwd()
    _in_session = _cwd.parent.name == 'outputs'   # cwd 已是 outputs/<会话id>/
    if explicit:
        _p = _Path(explicit)
        # 【拦截已知的错误传法】cwd 已经是会话产物目录，却又传了以 outputs/ 开头的相对路径：
        # 那会写成 outputs/<会话id>/outputs/xxx —— 网关的 dirState 只列顶层文件，
        # 这份产物在界面“产出”侧栏里【永远看不见】，用户会以为跑成功了却什么都没拿到。
        # 这是旧文档教出来的写法，宁可响亮报错也不要静默产出不可见的文件。
        if _in_session and not _p.is_absolute() and _p.parts and _p.parts[0] == 'outputs':
            _m = [
                '!! 产物目录参数写法有误，已中止。',
                '   你传的是： ' + str(explicit),
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_cwd),
                '   再拼 outputs/ 前缀会写成 ' + str(_cwd / _p) + '，',
                '   而界面的“产出”侧栏只列顶层文件，嵌套子目录里的产物用户永远看不到。',
                '   正确写法：直接用【裸文件名】（如 --out table1.csv），或干脆不传该参数。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    _env = (_os.environ.get('SCI_OUTPUT_DIR') or '').strip()
    if _env:
        _e = _Path(_env)
        # 与 explicit 分支同样的拦截。这条尤其要紧：项目文档教的就是
        # `SCI_OUTPUT_DIR=outputs/<会话id>` 这个【相对】写法，而 cwd 已经是会话产物目录，
        # 解析出来就是 outputs/<会话id>/outputs/<会话id>/ —— 产物在界面上永远看不见。
        if _in_session and not _e.is_absolute() and _e.parts and _e.parts[0] == 'outputs':
            _m = [
                '!! 环境变量 SCI_OUTPUT_DIR 的写法有误，已中止。',
                '   当前值： SCI_OUTPUT_DIR=' + _env,
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_cwd),
                '   再拼 outputs/ 前缀会写成 ' + str(_cwd / _e) + '，',
                '   而界面的“产出”侧栏只列顶层文件，嵌套子目录里的产物用户永远看不到。',
                '   正确做法：不要设这个环境变量（脚本会自动认出当前目录），',
                '   或把它设成【绝对路径】。',
            ]
            _sys.exit(chr(10).join(_m))
        return _e
    if _in_session:
        return _cwd
    _msg = [
        '!! 未指定产物目录，已中止（不再默认写共享的 outputs/ 根）。',
        '   正常情况下不需要指定：每轮对话的当前工作目录就是本会话的产物目录，',
        '   直接用裸文件名即可（如 --out table1.csv）。现在会走到这里，说明当前工作目录是',
        '   ' + str(_cwd) + '，不在任何会话产物目录下。',
        '   请任选一种方式指定：',
        '     1) 先切回本会话的产物目录再跑（推荐）',
        '     2) 环境变量： SCI_OUTPUT_DIR=<会话产物目录绝对路径>',
        '     3) 显式参数： --outdir <会话产物目录绝对路径>',
        '   注意路径要用【绝对路径】或相对当前目录的正确路径，不要再拼 outputs/<会话id>：',
        '   那是旧架构的写法，现在会多套一层目录导致产物在界面上不可见。',
        '   原因：写到共享的 outputs/ 根会跨会话互相覆盖，且不出现在界面的“产出”侧栏里。',
    ]
    _sys.exit(chr(10).join(_msg))

def _resolve_out_file(explicit=None, default_name="output"):
    import sys as _sys
    from pathlib import Path as _Path
    if explicit:
        _p = _Path(explicit)
        # 同 _resolve_out_dir：cwd 已是会话产物目录时再拼 outputs/ 前缀，产物会落到
        # outputs/<会话id>/outputs/... —— 界面“产出”侧栏只列顶层文件，用户永远看不见。
        if (_Path.cwd().parent.name == 'outputs' and not _p.is_absolute()
                and _p.parts and _p.parts[0] == 'outputs'):
            _m = [
                '!! 产物路径写法有误，已中止。',
                '   你传的是： ' + str(explicit),
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_Path.cwd()),
                '   再拼 outputs/ 前缀会写成 ' + str(_Path.cwd() / _p) + '，',
                '   而界面的“产出”侧栏只列顶层文件，嵌套子目录里的产物用户永远看不到。',
                '   正确写法：直接用【裸文件名】（如 --out ' + default_name + '）。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    return _resolve_out_dir() / default_name


def _get(url, **kw):
    kw.setdefault("headers", UA)
    kw.setdefault("timeout", TIMEOUT)
    for attempt in range(4):
        r = requests.get(url, **kw)
        if r.status_code in (429, 503):
            time.sleep(2 * (attempt + 1))
            continue
        return r
    return r


def _epmc_escape(s):
    return re.sub(r'(["\\:()])', r"\\\1", s or "")


def fetch_abstract(ref):
    """ref 是 DOI 或 PMID 串。返回 (title, abstract) 或 (None, None)。"""
    ref = ref.strip()
    pm = PMID_RE.search(ref)
    if pm or ref.isdigit():
        pmid = pm.group(1) if pm else ref
        query = f"EXT_ID:{pmid}"
    else:
        doi = DOI_RE.search(ref)
        if not doi:
            return None, None
        query = f"DOI:{_epmc_escape(doi.group(0))}"
    try:
        r = _get(EPMC, params={"query": query, "format": "json",
                               "resultType": "core", "pageSize": 1})
        r.raise_for_status()
        res = r.json().get("resultList", {}).get("result", [])
        if not res:
            return None, None
        rec = res[0]
        return (rec.get("title", ""),
                (rec.get("abstractText") or "").replace("\n", " ").strip())
    except Exception:
        return None, None


def split_sentences(text):
    # 摘要通常规整；在 .!? 后接空格+大写/数字处断句，保护常见缩写。
    text = re.sub(r"\b(e\.g|i\.e|vs|cf|et al|Fig|no|approx|ca)\.\s", r"\1<DOT> ", text, flags=re.I)
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9(])", text)
    return [p.replace("<DOT>", ".").strip() for p in parts if len(p.strip()) > 15]


def rank_sentences(claim, sentences):
    """返回 [(sentence, score), ...] 按分降序。优先 TF-IDF 余弦；退化用词重叠。"""
    if not sentences:
        return []
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.metrics.pairwise import cosine_similarity
        vec = TfidfVectorizer(stop_words="english", ngram_range=(1, 2))
        mat = vec.fit_transform([claim] + sentences)
        sims = cosine_similarity(mat[0:1], mat[1:]).ravel()
        ranked = sorted(zip(sentences, sims), key=lambda x: x[1], reverse=True)
        return [(s, float(sc)) for s, sc in ranked]
    except Exception:
        # 退化：Jaccard 词重叠
        def toks(s):
            return set(re.findall(r"[a-z0-9]+", s.lower()))
        cw = toks(claim)
        ranked = []
        for s in sentences:
            sw = toks(s)
            j = len(cw & sw) / len(cw | sw) if (cw | sw) else 0.0
            ranked.append((s, j))
        return sorted(ranked, key=lambda x: x[1], reverse=True)


def label(score):
    if score >= 0.45:
        return "GROUNDED", "找到措辞高度相关的原句，请对照确认转述准确"
    if score >= 0.25:
        return "CHECK", "最相关句相关度偏弱——请人工确认你的转述是否忠于原文"
    return "WEAK", "⚠️ 摘要里找不到明显支撑该说法的句子——可能转述失真，或支撑点在全文正文（用 fulltext-retrieval 读全文再核）"


def ground_one(claim, ref):
    title, abstract = fetch_abstract(ref)
    if title is None:
        return dict(claim=claim, ref=ref, verdict="NOTFOUND", score=0.0,
                    best_sentence="", note="按该 DOI/PMID 取不到文献（先过 reference-check 确认它真实存在）",
                    title="")
    if not abstract:
        return dict(claim=claim, ref=ref, verdict="NOABSTRACT", score=0.0,
                    best_sentence="", note="该文献在 Europe PMC 无摘要正文——无法句级核对，请用 fulltext-retrieval 读全文",
                    title=title)
    ranked = rank_sentences(claim, split_sentences(abstract))
    if not ranked:
        return dict(claim=claim, ref=ref, verdict="WEAK", score=0.0,
                    best_sentence="", note="摘要拆不出可比句", title=title)
    best, score = ranked[0]
    second = ranked[1] if len(ranked) > 1 else None
    v, note = label(score)
    return dict(claim=claim, ref=ref, verdict=v, score=round(score, 3),
                best_sentence=best, note=note, title=title,
                second_sentence=(second[0] if second else ""),
                second_score=(round(second[1], 3) if second else 0.0))


def load_pairs(path, positional):
    pairs = []
    if positional:
        claim = positional[0]
        for ref in positional[1:]:
            pairs.append((claim, ref))
        if len(positional) == 1:
            sys.exit("给了论断但没给它引的 DOI/PMID。")
        return pairs
    ext = os.path.splitext(path)[1].lower()
    with open(path, encoding="utf-8-sig") as f:
        if ext == ".csv":
            rd = csv.DictReader(f)
            for row in rd:
                c = (row.get("claim") or "").strip()
                ref = (row.get("ref") or row.get("doi") or row.get("pmid") or "").strip()
                if c and ref:
                    pairs.append((c, ref))
        else:  # 每行 "论断<TAB>ref"
            for line in f:
                if "\t" in line:
                    c, ref = line.rstrip("\n").split("\t", 1)
                    if c.strip() and ref.strip():
                        pairs.append((c.strip(), ref.strip()))
    return pairs


def main():
    ap = argparse.ArgumentParser(description="引用溯源到原句（claim grounding）")
    ap.add_argument("args", nargs="*", help="论断 + 其引的 DOI/PMID（第一个是论断）")
    ap.add_argument("--input", help="CSV(claim,ref) 或 TSV(论断<TAB>ref) 批量核")
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()
    args.outdir = str(_resolve_out_dir(args.outdir))

    pairs = load_pairs(args.input, args.args)
    if not pairs:
        sys.exit("没有 (论断, 引用) 对可核。给位置参数或 --input。")
    os.makedirs(args.outdir, exist_ok=True)

    print(f"核对 {len(pairs)} 组 (论断→引用) …")
    results = []
    for i, (claim, ref) in enumerate(pairs, 1):
        r = ground_one(claim, ref)
        results.append(r)
        print(f"  [{i}/{len(pairs)}] {r['verdict']:10} score={r['score']:<5} {ref}")
        time.sleep(0.2)

    order = {"WEAK": 0, "CHECK": 1, "NOTFOUND": 2, "NOABSTRACT": 3, "GROUNDED": 4}
    results.sort(key=lambda r: order.get(r["verdict"], 9))
    from collections import Counter
    dist = Counter(r["verdict"] for r in results)

    cols = ["verdict", "score", "claim", "ref", "title", "best_sentence", "note"]
    with open(os.path.join(args.outdir, "claim_grounding.csv"), "w",
              encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)

    with open(os.path.join(args.outdir, "claim_grounding.md"), "w", encoding="utf-8") as f:
        f.write(f"# 引用溯源到原句（{len(results)} 组论断→引用）\n\n")
        f.write("> **检索辅助、非判决**：分数=摘要里与你论断措辞的相关度。"
                "WEAK/CHECK 不等于转述一定错——可能支撑点在全文正文而非摘要；"
                "但请把每条 WEAK 都回原文对一眼，防张冠李戴。\n\n")
        f.write("统计：" + "，".join(f"{k} {v}" for k, v in dist.items()) + "\n\n")
        for r in results:
            f.write(f"- **{r['verdict']}** (score {r['score']}) — 论断：{r['claim']}\n")
            f.write(f"  - 引用：{r['ref']}　《{r['title'][:80]}》\n")
            if r["best_sentence"]:
                f.write(f"  - 最匹配原句：> {r['best_sentence']}\n")
            if r.get("second_sentence") and r.get("second_score", 0) >= 0.2:
                f.write(f"  - 次匹配：> {r['second_sentence']}\n")
            f.write(f"  - {r['note']}\n")

    need = dist.get("WEAK", 0) + dist.get("CHECK", 0)
    print("-" * 50)
    print(f"结果：{dict(dist)}")
    print(f"需回原文核对 {need} 条（WEAK {dist.get('WEAK',0)} / CHECK {dist.get('CHECK',0)}）。"
          f"报告见 {args.outdir}/claim_grounding.md / .csv")


if __name__ == "__main__":
    main()
