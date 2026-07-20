#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文献真实性核查：把每条引用去 Crossref / Europe PMC 对一遍，
揪出 AI 常编的三类假引用：
  - DOI/PMID 根本不存在（FABRICATED）
  - DOI/PMID 存在但标题对不上（MISMATCH：要么引错号，要么标题是编的）
  - 只有标题、查不到匹配（NOT_FOUND：疑似虚构，需人工确认）
真实且标题吻合的记 OK。

输入（三选一）：
  --input refs.bib / refs.ris / refs.txt   （.txt 每行一条引用）
  位置参数直接给 DOI/PMID/标题： verify_refs.py 10.1038/nature12373 "some title"
输出：
  outputs/reference_check.csv   逐条结果
  outputs/reference_check.md    人读报告（按风险分组）

联网调 api.crossref.org 与 ebi.ac.uk；失败的条目标 ERROR，不中断整体。
"""
import argparse
import csv
import os
import re
import sys
import time

# Windows 控制台默认 GBK；强制 UTF-8，避免中文进度输出变 mojibake（agent 靠 stdout 判成败）。
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
from difflib import SequenceMatcher

try:
    import requests
except ImportError:
    sys.exit("缺少 requests：请先在仓库根运行 install.ps1（Windows）/ install.sh（Linux/macOS），或让 agent 运行 env-setup 技能")

# Contact email for Crossref/EPMC polite pools (mailto in UA already enrolls us).
# One unified var; older names kept so an already-configured server needs no change.
_EMAIL = (os.environ.get("SCI_CONTACT_EMAIL")
          or os.environ.get("MEDSCI_CONTACT_EMAIL")
          or os.environ.get("CONTACT_EMAIL")
          or "sci-skill@users.noreply.github.com")
UA = {"User-Agent": f"sci-agent-reference-check/1.1 (mailto:{_EMAIL})"}
# Crossref calls also carry the paid Metadata Plus token when CROSSREF_PLUS_TOKEN
# is set (dedicated server pool / higher SLA); free polite pool otherwise.
CROSSREF_HEADERS = dict(UA)
if os.environ.get("CROSSREF_PLUS_TOKEN"):
    CROSSREF_HEADERS["Crossref-Plus-API-Token"] = f"Bearer {os.environ['CROSSREF_PLUS_TOKEN']}"
CROSSREF = "https://api.crossref.org/works/"
EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
TIMEOUT = 25


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
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
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
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
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
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
                '   正确写法：直接用【裸文件名】（如 --out ' + default_name + '）。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    return _resolve_out_dir() / default_name


def epmc_escape(s):
    r"""Escape Europe PMC query-syntax special chars so a title with quotes/colons
    doesn't break the TITLE:"..." clause."""
    return re.sub(r'(["\\:()])', r"\\\1", s or "")

DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I)
PMID_RE = re.compile(r"\bPMID:?\s*(\d{5,9})\b", re.I)

# 撤稿检测开关（--no-retraction 关掉；离线/赶时间时用）。默认开。
RETRACTION_CHECK = True


def _get(url, **kw):
    """带退避重试的 GET：碰到 429/503 就等一会再试（api.crossref 限速常见）。"""
    kw.setdefault("headers", UA)
    kw.setdefault("timeout", TIMEOUT)
    for attempt in range(4):
        r = requests.get(url, **kw)
        if r.status_code in (429, 503):
            time.sleep(2 * (attempt + 1))
            continue
        return r
    return r


def norm_title(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def title_sim(a, b):
    return SequenceMatcher(None, norm_title(a), norm_title(b)).ratio()


def _epmc_by_doi(doi):
    """Europe PMC fallback for a DOI (reachable from mainland China when Crossref times out)."""
    params = {"query": f"DOI:{epmc_escape(doi)}", "format": "json", "resultType": "core", "pageSize": 1}
    r = _get(EPMC, params=params)
    r.raise_for_status()
    res = r.json().get("resultList", {}).get("result", [])
    if not res:
        return None, None
    rec = res[0]
    return rec.get("title", ""), {"journal": rec.get("journalTitle", ""), "year": rec.get("pubYear", ""),
                                  "authors": rec.get("authorString", "")}


def resolve_doi(doi):
    """返回 (title, meta) 或 (None, None)；Crossref 失败时回退 Europe PMC。"""
    doi = doi.rstrip(".,;)")
    try:
        r = _get(CROSSREF + doi, headers=CROSSREF_HEADERS)
        if r.status_code == 404:
            # Confirm the 404 via EPMC before trusting it — Crossref occasionally
            # 404s a DOI it is merely slow to index.
            t, m = _epmc_by_doi(doi)
            return (t, m) if t else (None, None)
        r.raise_for_status()
        msg = r.json()["message"]
        title = (msg.get("title") or [""])[0]
        meta = {
            "journal": (msg.get("container-title") or [""])[0],
            "year": (msg.get("issued", {}).get("date-parts", [[None]])[0][0]),
            "authors": ", ".join(a.get("family", "") for a in msg.get("author", [])[:3]),
        }
        return title, meta
    except requests.RequestException:
        # Crossref rate-limited/unreachable — try EPMC rather than falsely reporting ERROR/FABRICATED
        return _epmc_by_doi(doi)


def resolve_pmid(pmid):
    # NO "AND SRC:MED": that filter hides real-but-not-yet-MEDLINE records
    # (ahead-of-print, PMC-only, preprints) and would mislabel a real PMID as FABRICATED.
    params = {"query": f"EXT_ID:{pmid}", "format": "json", "resultType": "core"}
    r = _get(EPMC, params=params)
    r.raise_for_status()
    res = r.json().get("resultList", {}).get("result", [])
    if not res:
        return None, None
    # Prefer the record whose external id actually equals the queried PMID.
    rec = next((x for x in res if str(x.get("pmid", "")) == str(pmid)), res[0])
    meta = {"journal": rec.get("journalTitle", ""), "year": rec.get("pubYear", ""),
            "authors": rec.get("authorString", "")}
    return rec.get("title", ""), meta


def title_search(title):
    """只有标题时，去 Europe PMC 反查是否真有这篇。返回最佳匹配 (title, sim, meta)。"""
    params = {"query": f'TITLE:"{epmc_escape(title)}"', "format": "json", "pageSize": 3, "resultType": "core"}
    r = _get(EPMC, params=params)
    r.raise_for_status()
    best = (None, 0.0, None)
    for rec in r.json().get("resultList", {}).get("result", []):
        s = title_sim(title, rec.get("title", ""))
        if s > best[1]:
            best = (rec.get("title", ""), s,
                    {"journal": rec.get("journalTitle", ""), "year": rec.get("pubYear", ""),
                     "doi": rec.get("doi", ""), "pmid": rec.get("pmid", "")})
    return best


def check_retraction(doi, pmid):
    """查一篇（已确认存在的）文献是否被撤稿 / 有勘误·编辑关注。
    去 Europe PMC 取 core 记录，看 pubTypeList 里有没有 'Retracted Publication'
    （= 这篇本身被撤稿，医学投稿引到就是硬伤），并从 commentCorrectionList
    捞出撤稿/勘误通知的出处。

    返回 (status, notice)：
      status ∈ {'retracted', 'concern', ''}；notice 是通知文献的引用串（可能为空）。
      任何异常都吞掉返回 ('', '')——撤稿检测失败绝不能拖垮整体核查。
    """
    if not RETRACTION_CHECK or not (doi or pmid):
        return "", ""
    query = f"EXT_ID:{pmid}" if pmid else f"DOI:{epmc_escape(doi)}"
    try:
        r = _get(EPMC, params={"query": query, "format": "json",
                               "resultType": "core", "pageSize": 1})
        r.raise_for_status()
        res = r.json().get("resultList", {}).get("result", [])
        if not res:
            return "", ""
        rec = res[0]
        pubtypes = [str(x).lower() for x in
                    (rec.get("pubTypeList", {}) or {}).get("pubType", []) or []]
        ccl = ((rec.get("commentCorrectionList", {}) or {})
               .get("commentCorrection", []) or [])
        # 找撤稿/勘误/表达关注通知的出处（type 如 'Retraction in' / 'Expression of concern in'）。
        def _notice(kw):
            for c in ccl:
                t = str(c.get("type", "")).lower()
                if kw in t and "in" in t:  # 'retraction in' 指向撤稿它的那篇通知
                    return c.get("reference", "") or ""
            return ""
        if "retracted publication" in pubtypes:
            return "retracted", _notice("retraction")
        # 表达关注（Expression of Concern）——未撤稿但被编辑标注，值得提示
        eoc = _notice("expression of concern") or _notice("concern")
        if eoc or any("concern" in p for p in pubtypes):
            return "concern", eoc
        return "", ""
    except Exception:
        return "", ""


def _apply_retraction(result):
    """对一条已判"存在"的核查结果补跑撤稿检测；命中就把 verdict 抬成 RETRACTED
    （撤稿是"文献真但绝不能引"的独立风险，凌驾于标题吻合与否）。就地改 result。"""
    if result.get("verdict") not in ("OK", "CHECK", "MISMATCH"):
        return result
    doi = result.get("doi") or result.get("_match_doi")
    pmid = result.get("pmid") or result.get("_match_pmid")
    status, notice = check_retraction(doi, pmid)
    if status == "retracted":
        tail = f"；撤稿通知：{notice}" if notice else ""
        result["verdict"] = "RETRACTED"
        result["note"] = "⚠️ 该文献已被撤稿（Retracted Publication）——请勿引用，替换为未撤稿的来源" + tail \
                         + "。（原核查：" + result.get("note", "") + "）"
    elif status == "concern":
        tail = f"（{notice}）" if notice else ""
        result["note"] = result.get("note", "") + f"；⚠️ 该文献被标注'表达关注'(Expression of Concern){tail}，引用前请核实"
    return result


def _author_year_flags(entry, meta):
    """Cross-check claimed first-author surname + year against the resolved record.
    Catches 'DOI is real but points to a different paper'. Returns a note fragment or ''."""
    flags = []
    cy = (entry.get("claimed_year") or "").strip()
    my = str((meta or {}).get("year") or "").strip()
    if cy and my and cy.isdigit() and my.isdigit() and abs(int(cy) - int(my)) > 1:
        flags.append(f"年份不符(引用{cy} vs 库{my})")
    ca = (entry.get("claimed_authors") or "").lower()
    if ca:
        # first author surname: bibtex "Last, First and ..." or "First Last and ..."
        first = re.split(r"\s+and\s+", ca)[0]
        surname = first.split(",")[0].strip() if "," in first else first.split()[-1:] and first.split()[-1]
        surname = (surname or "").strip()
        found_auth = (meta or {}).get("authors", "").lower()
        if surname and len(surname) > 2 and found_auth and surname not in found_auth:
            flags.append(f"首作者不符(引用{surname})")
    return "；".join(flags)


def _verdict_with_meta(v, base_note, entry, meta):
    """Downgrade an otherwise-OK verdict to CHECK when author/year disagree."""
    extra = _author_year_flags(entry, meta)
    if extra and v == "OK":
        return "CHECK", base_note + "；但" + extra + "——疑似张冠李戴，请核对"
    if extra:
        return v, base_note + "；另" + extra
    return v, base_note


def _id_failed(kind, id_str, claimed, entry):
    """某个 DOI/PMID 查不到时：**按标题反查一次**。
    经常遇到"论文真实存在、但 DOI 是 AI 编造的"——直接判 FABRICATED 会冤枉真论文。
    标题查到强匹配 → ID_FAKE（真论文+假号，附上正确标识供替换）；否则才 FABRICATED。"""
    if claimed:
        ft, tsim, tmeta = title_search(claimed)
        if ft and tsim >= 0.85:
            real_doi = (tmeta or {}).get("doi") or ""
            real_pmid = (tmeta or {}).get("pmid") or ""
            correct = (f"DOI:{real_doi}" if real_doi else
                       (f"PMID:{real_pmid}" if real_pmid else "见下方匹配到的文献"))
            return dict(verdict="ID_FAKE", id=id_str, found_title=ft, sim=round(tsim, 2),
                        note=f"此 {kind} 查无（疑似 AI 伪造），但按标题查到真实文献——正确标识 {correct}；"
                             f"用正确 {kind} 替换即可", **entry)
        return dict(verdict="FABRICATED", id=id_str, found_title=ft or "", sim=round(tsim, 2),
                    note=f"{kind} 查无，且按标题也查不到匹配——疑似整条虚构，请人工确认", **entry)
    return dict(verdict="FABRICATED", id=id_str, found_title="", sim=0.0,
                note=f"{kind} 查无（不存在），且无标题可反查——请人工确认", **entry)


def verify_one(entry):
    """entry: {'raw','claimed_title','doi','pmid',...} -> 结果 dict。"""
    claimed = entry.get("claimed_title", "")
    doi, pmid = entry.get("doi"), entry.get("pmid")
    try:
        if doi:
            rt, meta = resolve_doi(doi)
            if rt is None:
                return _id_failed("DOI", f"doi:{doi}", claimed, entry)
            sim = title_sim(claimed, rt) if claimed else 1.0
            v = "OK" if (not claimed or sim >= 0.85) else (
                "MISMATCH" if sim < 0.6 else "CHECK")
            note = ("标题吻合" if v == "OK" else
                    f"DOI 存在但标题对不上(相似度{sim:.2f})——引错号或标题是编的")
            v, note = _verdict_with_meta(v, note, entry, meta)
            return dict(verdict=v, id=f"doi:{doi}", found_title=rt, sim=round(sim, 2),
                        note=note, **entry)
        if pmid:
            rt, meta = resolve_pmid(pmid)
            if rt is None:
                return _id_failed("PMID", f"pmid:{pmid}", claimed, entry)
            sim = title_sim(claimed, rt) if claimed else 1.0
            v = "OK" if (not claimed or sim >= 0.85) else (
                "MISMATCH" if sim < 0.6 else "CHECK")
            note = "标题吻合" if v == "OK" else f"PMID 存在但标题对不上({sim:.2f})"
            v, note = _verdict_with_meta(v, note, entry, meta)
            return dict(verdict=v, id=f"pmid:{pmid}", found_title=rt, sim=round(sim, 2),
                        note=note, **entry)
        # 只有标题
        if claimed:
            ft, sim, meta = title_search(claimed)
            if ft and sim >= 0.85:
                extra = f" (匹配 DOI:{meta.get('doi') or 'NA'})" if meta else ""
                return dict(verdict="OK", id="title", found_title=ft, sim=round(sim, 2),
                            note="按标题查到真实文献" + extra,
                            _match_doi=(meta or {}).get("doi") or None,
                            _match_pmid=(meta or {}).get("pmid") or None, **entry)
            return dict(verdict="NOT_FOUND", id="title", found_title=ft or "",
                        sim=round(sim, 2), note="按标题查不到匹配——疑似虚构，请人工确认", **entry)
        return dict(verdict="ERROR", id="", found_title="", sim=0.0,
                    note="没提取到 DOI/PMID/标题", **entry)
    except Exception as e:
        return dict(verdict="ERROR", id=doi or pmid or "", found_title="", sim=0.0,
                    note=f"查询出错：{e}", **entry)


def parse_input(path, positional):
    entries = []
    if positional:
        for tok in positional:
            entries.append(extract(tok))
        return entries
    if not path:
        return entries
    ext = os.path.splitext(path)[1].lower()
    if ext == ".bib":
        import bibtexparser
        with open(path, encoding="utf-8") as f:
            db = bibtexparser.load(f)
        for e in db.entries:
            entries.append({"raw": e.get("title", ""), "claimed_title": e.get("title", ""),
                            "doi": (e.get("doi") or "").strip() or None,
                            "pmid": (e.get("pmid") or "").strip() or None,
                            "claimed_year": (e.get("year") or "").strip() or None,
                            "claimed_authors": (e.get("author") or "").strip() or None})
    elif ext == ".ris":
        import rispy
        with open(path, encoding="utf-8") as f:
            for e in rispy.load(f):
                title = e.get("primary_title") or e.get("title", "")
                entries.append({"raw": title, "claimed_title": title,
                                "doi": (e.get("doi") or "").strip() or None,
                                "pmid": None})
    else:  # 纯文本，每行一条
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    entries.append(extract(line))
    return entries


def extract(text):
    """从一行文字里抽 DOI/PMID/标题。"""
    doi = DOI_RE.search(text)
    pmid = PMID_RE.search(text)
    claimed = text
    # 若整行就是个裸标识符，则不当标题
    if doi and text.strip().rstrip(".,;)") == doi.group(0).rstrip(".,;)"):
        claimed = ""
    if pmid and re.fullmatch(r"PMID:?\s*\d+", text.strip(), re.I):
        claimed = ""
    return {"raw": text, "claimed_title": claimed,
            "doi": doi.group(0) if doi else None,
            "pmid": pmid.group(1) if pmid else None}


def main():
    ap = argparse.ArgumentParser(description="文献真实性核查")
    ap.add_argument("ids", nargs="*", help="直接给 DOI/PMID/标题（可多个）")
    ap.add_argument("--input", help="refs.bib / refs.ris / refs.txt")
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--no-retraction", action="store_true",
                    help="跳过撤稿检测（离线/赶时间；默认开启）")
    args = ap.parse_args()
    args.outdir = str(_resolve_out_dir(args.outdir))

    global RETRACTION_CHECK
    RETRACTION_CHECK = not args.no_retraction

    entries = parse_input(args.input, args.ids)
    if not entries:
        sys.exit("没有输入。给 --input 文件，或直接列 DOI/PMID/标题。")
    os.makedirs(args.outdir, exist_ok=True)

    print(f"核查 {len(entries)} 条 …")
    results = []
    for i, e in enumerate(entries, 1):
        r = verify_one(e)
        _apply_retraction(r)
        results.append(r)
        print(f"  [{i}/{len(entries)}] {r['verdict']:10} {(r['claimed_title'] or r['id'])[:60]}")
        time.sleep(0.2)

    # CSV
    cols = ["verdict", "sim", "claimed_title", "found_title", "id", "note", "raw"]
    with open(os.path.join(args.outdir, "reference_check.csv"), "w",
              encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)

    # Markdown 报告（按风险排序）
    order = {"RETRACTED": 0, "FABRICATED": 1, "ID_FAKE": 2, "NOT_FOUND": 3,
             "MISMATCH": 4, "CHECK": 5, "ERROR": 6, "OK": 7}
    results.sort(key=lambda r: order.get(r["verdict"], 9))
    from collections import Counter
    dist = Counter(r["verdict"] for r in results)
    with open(os.path.join(args.outdir, "reference_check.md"), "w", encoding="utf-8") as f:
        f.write(f"# 文献真实性核查报告（{len(results)} 条）\n\n")
        f.write("统计：" + "，".join(f"{k} {v}" for k, v in dist.items()) + "\n\n")
        for r in results:
            f.write(f"- **{r['verdict']}** — {r['claimed_title'] or r['id']}\n")
            f.write(f"  - {r['note']}\n")
            if r["found_title"] and r["found_title"] != r["claimed_title"]:
                f.write(f"  - 实际匹配到：{r['found_title']}\n")

    bad = sum(dist.get(k, 0) for k in ("RETRACTED", "FABRICATED", "ID_FAKE", "NOT_FOUND", "MISMATCH"))
    print("-" * 50)
    print(f"结果：{dict(dist)}")
    print(f"可疑/存疑 {bad} 条。报告见 {args.outdir}/reference_check.md / .csv")


if __name__ == "__main__":
    main()
