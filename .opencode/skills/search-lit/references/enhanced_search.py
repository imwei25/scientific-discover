#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多源文献检索 + 跨源去重（search-lit 的"增强检索"路径）。

一次把多个公开学术 API 打一遍，跨源去重后汇成一张统一证据表。定位与
literature-review/search.py 一致（检索式 → 去重证据表），区别是它同时打
**多个源**并做**跨源合并去重**，用于召回更全的场景（交叉学科、预印本、
按被引/机构补充）。

来源（可用 --sources 选择，默认全开）
------------------------------------
    europepmc        Europe PMC —— 覆盖 PubMed，**中国大陆可达**，作为骨干源
    semantic_scholar Semantic Scholar Graph API —— 语义召回、被引数（跨学科好）
    arxiv            arXiv Atom API —— 数理/CS/量化生物预印本（PubMed 覆盖不到）
    openalex         OpenAlex —— 覆盖最广的学术图谱；mailto polite pool，key 可选

网络说明（重要）
----------------
Europe PMC 国内直连稳定；semantic_scholar / arxiv / openalex 从中国大陆直连
**不一定通**（与 NCBI 同类问题）。因此本脚本把 europepmc 当骨干：**任一增强源
失败只跳过并在末尾报告，不会中断整体检索**，最终仍以能打通的源为准。境外服务器
/ 有代理时四源齐发效果最佳。

OpenAlex 鉴权（对齐 openscience 的做法）
---------------------------------------
默认走 polite pool，只需一个联系邮箱（`--email` 或环境变量 OPENALEX_MAILTO）。
**不需要 API key** 即可匿名调通；若设置了环境变量 OPENALEX_API_KEY 则自动带上
以进入更高限额的 premium pool。Semantic Scholar 同理：设 S2_API_KEY 可提限额，
不设也能用共享池（本脚本对 429 做指数退避）。

反幻觉契约
----------
所有记录均来自真实 API 返回，绝不凭记忆生成。抓不到就少，不编。

检索条数
--------
**默认不限**：每源每检索式都翻页取到源枯竭（或该源 API 自己的深翻上限）。各源命中总数会打印。
只有检索式过宽时才由跑飞护栏 SCI_SEARCH_MAX（默认 5000/源/式，设 0 取消）截断，且截断必定
【响亮报告】。要少取就显式 `--limit N`。

用法
----
    python enhanced_search.py "sglt2 inhibitor heart failure" --since 2019   # 不限条数
    python enhanced_search.py "sglt2 inhibitor heart failure" --limit 25     # 只要前 25 条
    python enhanced_search.py "graph neural network" "protein design" \
        --sources semantic_scholar,arxiv,openalex --email you@example.com

一个会话里做多轮检索（重要）
--------------------------
产物默认是**固定名**，第二次跑会把第一次挤成 .bak。分概念 / 分主题多轮检索时，**每轮都带 `--tag`**：

    python enhanced_search.py "sglt2 inhibitor" --tag drug
    python enhanced_search.py "heart failure outcome" --tag outcome
    # → evidence_table__drug.csv / evidence_table__outcome.csv，互不覆盖

不带 --tag 时**也不会覆盖**：同名旧产物先改名成 `evidence_table.csv.bak`（已有 .bak 就 .bak2、
.bak3……）让位，并在 stderr 报出改名了哪些文件。但下游按固定名读表，只会读到最新这次的结果，
前几轮躺在 .bak 里没人看——所以多轮检索还是应当带 --tag。要一次检索多条式子并**合并成一张表**，
直接把多个检索式作为位置参数传给同一次调用（本脚本会跨式跨源去重）。

产出
----
    evidence_table.csv   title/year/journal/design/cites/doi/pmid/sources/abstract
    evidence.md          精简清单（写综述时逐条引用）
    （带 --tag 时为 evidence_table__<标签>.csv / evidence__<标签>.md）
    stderr               每源命中数、跨源重叠、去重后总数
"""

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

# Windows 控制台默认 GBK；强制 UTF-8，否则本脚本的中文进度/告警在 agent 那边是一串乱码
# （"⚠ 命中 N 条 > 上限"这种话读不出来 = 等于没报）。与 literature-review/search.py 同法。
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass

# One unified contact var (older names incl. OPENALEX_MAILTO kept for back-compat).
# The mailto in the UA enrolls Europe PMC / OpenAlex / Crossref polite pools for free.
_EMAIL = (os.environ.get("SCI_CONTACT_EMAIL")
          or os.environ.get("MEDSCI_CONTACT_EMAIL")
          or os.environ.get("CONTACT_EMAIL")
          or os.environ.get("OPENALEX_MAILTO")
          or "sci-skill@users.noreply.github.com")
UA = f"sci-agent-enhanced-search/1.1 (mailto:{_EMAIL})"
TIMEOUT = 30
# 服务端要求等待超过这个秒数，就当这个源本轮不可用（别真的 sleep 下去，见 _fetch 的说明）
MAX_RETRY_AFTER = float(os.environ.get("SCI_MAX_RETRY_AFTER", "60"))

EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
S2_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search"
ARXIV = "http://export.arxiv.org/api/query"
OPENALEX = "https://api.openalex.org/works"

ALL_SOURCES = ("europepmc", "semantic_scholar", "arxiv", "openalex")

# 每页取多少（都在各源允许范围内）。EPMC 允许 pageSize 到 1000，但 resultType=core 每条都带
# 摘要，1000 条一页实测十几 MB，代理那层直接掐断连接 —— 100 是稳的，翻页靠 cursorMark。
PAGE_EPMC, PAGE_S2, PAGE_ARXIV, PAGE_OA = 100, 100, 100, 200
# S2 的 relevance 检索端点（/paper/search）**总量硬上限 1000 条**（offset+limit>1000 直接报错），
# 再多要走 bulk 端点。arXiv 建议每页 ≤2000 且请求间隔 3 秒。这些是源方的限制，取不到就如实说。
S2_SEARCH_HARD_TOTAL = 1000

# ---- 检索条数：默认【不限】----
# 不给 --limit 就每源翻页取到枯竭。SCI_SEARCH_MAX 只是跑飞护栏（每源每式取到这么多就停下并
# 响亮报告截断），设 0 则真·不限。显式 --limit N 时按 N 精确取，护栏不介入。
DEFAULT_HARD_CAP = 5000


def _hard_cap():
    raw = (os.environ.get("SCI_SEARCH_MAX") or "").strip()
    if not raw:
        return DEFAULT_HARD_CAP
    try:
        v = int(raw)
    except ValueError:
        sys.stderr.write(f"⚠ SCI_SEARCH_MAX={raw!r} 不是整数，按默认 {DEFAULT_HARD_CAP} 处理\n")
        return DEFAULT_HARD_CAP
    return v if v > 0 else math.inf


def _page(remaining, cap):
    """本次请求要多少条：不限时按整页取。"""
    return cap if remaining == math.inf else max(1, min(cap, int(remaining)))


def _cut(rows, limit):
    return rows if limit == math.inf else rows[:limit]

# 研究类型粗分类（与 literature-review/search.py 对齐）
DESIGN = [
    ("meta-analysis", r"meta-?analysis|systematic review"),
    ("RCT", r"randomi[sz]ed|randomised controlled|double-?blind|placebo-?controlled"),
    ("cohort", r"cohort|prospective|longitudinal"),
    ("case-control", r"case-?control"),
    ("cross-sectional", r"cross-?sectional|survey"),
    ("review", r"\breview\b|narrative review"),
    ("case-report", r"case report|case series"),
    ("preclinical", r"mice|mouse|in vitro|in vivo|rat\b|cell line"),
]


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
        # 那会写成 outputs/<会话id>/outputs/xxx —— 侧栏只递归一层，这是两层，
        # 这份产物在界面“产出”侧栏里【看不见】，用户会以为跑成功了却什么都没拿到。
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
        # outputs/<会话id>/outputs/... —— 侧栏只递归一层，这是两层，用户看不见。
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


# --------------------------------------------------------------------------- #
# 证据表落盘路径：同一会话里跑第二次检索，不带 --tag 时旧表会被改名成 .bak 让位（绝不覆盖）
# --------------------------------------------------------------------------- #
_TAG_BAD = re.compile(r"[^0-9A-Za-z一-鿿_.-]+")


def _slug_tag(tag):
    s = _TAG_BAD.sub("-", (tag or "").strip()).strip("-._")
    return s[:40] or "run"


def _backup(path):
    """目标文件已存在就改名让位（<原名>.bak / .bak2 / .bak3 …），绝不覆盖。

    返回 (原名, 备份名) 供调用方告警；文件本来不存在则返回 None。
    """
    if not os.path.exists(path):
        return None
    cand, n = path + ".bak", 1
    while os.path.exists(cand):
        n += 1
        cand = f"{path}.bak{n}"
    os.replace(path, cand)
    return (os.path.basename(path), os.path.basename(cand))


def _out_paths(outdir, explicit=None, tag=None):
    """决定 evidence_table / evidence 的路径；同名旧产物改名成 .bak 让位，绝不覆盖。"""
    if explicit:
        p = _resolve_out_file(explicit, "evidence_table.csv")
        csv_path, md_path = str(p), str(p.with_suffix(".md"))
    elif tag:
        s = _slug_tag(tag)
        csv_path = os.path.join(outdir, f"evidence_table__{s}.csv")
        md_path = os.path.join(outdir, f"evidence__{s}.md")
    else:
        csv_path = os.path.join(outdir, "evidence_table.csv")
        md_path = os.path.join(outdir, "evidence.md")
    moved = [b for b in (_backup(csv_path), _backup(md_path)) if b]
    if moved:
        sys.stderr.write(
            "\n!! 目标文件已存在（上一次检索的产物），【没有覆盖】，先改名备份让位：\n"
            + "".join(f"   {a} → {b}\n" for a, b in moved)
            + "   同一会话里做第 2 次及以后的检索，建议直接加 --tag <短标签>\n"
              "   （写成 evidence_table__<标签>.csv / evidence__<标签>.md），"
              "或用 --out <文件名.csv> 显式指定；\n"
              "   否则下游（idea-forge / grant-proposal / zotero push）按固定名读表，\n"
              "   只会读到最后一次检索的结果，前几轮都躺在 .bak 里没人看。\n\n")
    return csv_path, md_path


def classify(text):
    t = (text or "").lower()
    for name, pat in DESIGN:
        if re.search(pat, t):
            return name
    return "other"


# --------------------------------------------------------------------------- #
# HTTP（纯标准库，与 snowball.py 一致；对 429/503 指数退避）
# --------------------------------------------------------------------------- #
def _http_get(url, headers=None, retries=4):
    hdr = {"User-Agent": UA}
    if headers:
        hdr.update(headers)
    delay = 2.0
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers=hdr)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # noqa: S310
                return resp.read()
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code in (429, 503) and attempt < retries - 1:
                # ★ Retry-After 必须封顶。OpenAlex 已改成按额度计费，额度用尽时回的是
                #   `Retry-After: 42170`（≈11.7 小时，"Resets at midnight UTC"）——原样 sleep
                #   等于把整轮检索挂死在这里。实测后果：Europe PMC 明明已经拿到 60 条，
                #   整轮却因为卡在 OpenAlex 超时中断，**已检索到的结果一条都没落盘**，
                #   用户白等一轮还得重跑。
                #   等不起就别等：判定该源本轮不可用，抛出去让调用方降级并在报告里注明。
                ra = exc.headers.get("Retry-After")
                wait = float(ra) if (ra and str(ra).isdigit()) else delay
                if wait > MAX_RETRY_AFTER:
                    raise RuntimeError(
                        "该检索源要求等待 %.0f 秒（超过 %d 秒上限）才肯再受理请求，本轮判定它不可用。"
                        "常见原因：按额度计费的源（如 OpenAlex）当日额度已用尽。"
                        "请改用其它源，并在报告里注明这一源本次没能参与检索。" % (wait, MAX_RETRY_AFTER)
                    ) from exc
                time.sleep(wait)
                delay *= 2
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as exc:
            last = exc
            if attempt < retries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    if last:
        raise last
    raise RuntimeError("request did not complete")


def _get_json(url, headers=None):
    return json.loads(_http_get(url, headers=headers).decode("utf-8"))


# --------------------------------------------------------------------------- #
# 归一化 / 去重键（与 systematic-review/sr_dedup.py、snowball.py 同规则）
# --------------------------------------------------------------------------- #
def norm_doi(doi):
    if not doi:
        return ""
    d = doi.strip().lower()
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d)
    d = re.sub(r"^doi:\s*", "", d)
    return d.strip()


def norm_title(title):
    if not title:
        return ""
    t = re.sub(r"[^a-z0-9]+", "", title.lower())
    return t


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def blank_record():
    return {"title": "", "year": "", "journal": "", "authors": "",
            "doi": "", "pmid": "", "arxiv_id": "", "cites": 0,
            "abstract": "", "sources": []}


# --------------------------------------------------------------------------- #
# 各源检索：统一返回 blank_record() 形状的 list
# --------------------------------------------------------------------------- #
def _epmc_pass(q, limit, sort=None):
    out, cursor = [], "*"
    while len(out) < limit:
        params = {"query": q, "format": "json",
                  "pageSize": _page(limit - len(out), PAGE_EPMC),
                  "cursorMark": cursor, "resultType": "core"}
        if sort:
            params["sort"] = sort        # urlencode 会把空格与冒号正确转义，别自己拼字符串
        d = _get_json(EPMC + "?" + urllib.parse.urlencode(params))
        batch = d.get("resultList", {}).get("result", [])
        if not batch:
            break
        for rec in batch:
            r = blank_record()
            r["title"] = (rec.get("title") or "").strip().rstrip(".")
            r["year"] = str(rec.get("pubYear") or "")
            r["journal"] = rec.get("journalInfo", {}).get("journal", {}).get("title", "")
            r["authors"] = rec.get("authorString", "")
            r["doi"] = rec.get("doi", "") or ""
            r["pmid"] = rec.get("pmid", "") or ""
            r["cites"] = _int(rec.get("citedByCount", 0))
            r["abstract"] = (rec.get("abstractText") or "").replace("\n", " ").strip()
            r["sources"] = ["europepmc"]
            out.append(r)
        nxt = d.get("nextCursorMark")
        if not nxt or nxt == cursor:
            break
        cursor = nxt
        if len(out) >= PAGE_EPMC * 5:      # 长检索报进度，别看着像卡死
            sys.stderr.write(f"[europepmc] …已取 {len(out)} 条\n")
        time.sleep(0.34)
    return _cut(out, limit)


# ---- 检索式合法性闸：OR 组里的多词词条必须自带括号 ----
# ★ 2026-09-22 实测的静默失血点（与 literature-review/search.py 的 lint_query 同一份逻辑）：
#     (GLP-1 receptor agonist OR semaglutide) AND ...   → 命中 16410，目标文献【丢了】
#     ((GLP-1 receptor agonist) OR (semaglutide)) AND ... → 命中 10725，目标文献在
#     ("GLP-1 receptor agonist" OR "semaglutide") AND ... → 命中  7101，目标文献在
#   多词词条不加括号时按词级结合解析，布尔逻辑散架，而**命中数是涨的** —— 模型唯一能
#   观察到的信号指向反方向，靠自省发现不了。补括号而不是补引号：加引号会变成精确词组，
#   比原意窄（7101 < 10725）；补括号只修优先级、保留词条内部的词级 AND。
#   全是单词的 OR 组（EZH2 OR KMT6A OR PRC2）本就无歧义，实测补不补都是 873 条，这一闸不动它们。
_FIELD_RE = re.compile(r"^[A-Za-z_]{2,}\s*:")


def _wrapped_in_parens(s):
    """整条被同一对括号包住（而不是 "(a) AND (b)" 那种首尾恰好是括号）。"""
    if not (s.startswith("(") and s.endswith(")")):
        return False
    depth = 0
    for i, c in enumerate(s):
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i == len(s) - 1
    return False


def _split_top(s, op):
    """按顶层（括号深度 0、引号外）的 op 切开；切不开返回 None。"""
    parts, cur, depth, in_q, i, pad = [], [], 0, False, 0, f" {op} "
    while i < len(s):
        c = s[i]
        if c == '"':
            in_q = not in_q
        if not in_q:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            elif depth == 0 and c == " " and s[i:i + len(pad)].upper() == pad:
                parts.append("".join(cur))
                cur = []
                i += len(pad)
                continue
        cur.append(c)
        i += 1
    parts.append("".join(cur))
    return parts if len(parts) > 1 else None


def lint_query(q):
    """补齐 OR 组里多词词条的括号。返回 (修好的检索式, [被改写的词条])。"""
    changed = []

    def fix(s):
        s = s.strip()
        ors = _split_top(s, "OR")
        if ors:
            out = []
            for p in ors:
                core = fix(p)
                if (" " in core and not (core.startswith('"') and core.endswith('"'))
                        and not _wrapped_in_parens(core) and not _FIELD_RE.match(core)):
                    changed.append(core)
                    core = f"({core})"
                out.append(core)
            return " OR ".join(out)
        ands = _split_top(s, "AND")
        if ands:
            return " AND ".join(fix(p) for p in ands)
        if _wrapped_in_parens(s):
            return "(" + fix(s[1:-1]) + ")"
        return s

    return fix(q), changed


# 截断取样（见 _epmc_year_stratified 头注）：不给 --since 时往回摊开几年，
# 以及留给"不分年的领域基石"那一趟的名额占比。与 literature-review/search.py 保持一致。
DEFAULT_YEARS_BACK = 10
CLASSICS_SHARE = 0.2


def _since_clause(since):
    """--since 的时间窗子句，**往前放宽一年**。

    ★ EPMC 的 FIRST_PDATE（首次上线日）与记录的 pubYear（卷期年）经常差一年 ——
      SMART 试验 firstPubDate=2024-10-25 而 pubYear=2025。直接按 `FIRST_PDATE >= since`
      过滤，用户选「2025 年起」就把这篇刚发的重磅挡在外面，而表里其他 pubYear=2025 的
      文章照常在，看上去毫无异常。NEJM / Nature 系这类 online-first 提前数月的期刊全部
      受影响，且越重磅越早上线。放宽一年多取进来的那部分由下游按 pubYear 收口。
    """
    return f" AND (FIRST_PDATE:[{int(since) - 1}-01-01 TO 3000-12-31])" if since else ""


def _epmc_hit_count(q):
    """命中数。**返回 0 要复核一次**。

    ★ 2026-09-22 实测：同一条检索式直接问是 7960 条，一次回归跑里却返回 hitCount=0，
      紧接着的检索照样取回 515 篇 —— EPMC 在负载下会偶发返回 0。后果有两层且都不响：
      ① `hits <= limit` 成立 → 静默跳过分层取样；② 打印出来的命中数是 PRISMA 要记的
      数字，直接是假的。真·零命中多问一次的代价可以忽略。
    """
    def _ask():
        d = _get_json(EPMC + "?" + urllib.parse.urlencode(
            {"query": q, "format": "json", "pageSize": 1, "resultType": "idlist"}))
        return int(d.get("hitCount") or 0)
    n = _ask()
    if n == 0:
        time.sleep(1.0)
        n2 = _ask()
        if n2:
            sys.stderr.write(f"[europepmc] (命中数第一次问到 0，复核得 {n2} —— 按 {n2} 处理)\n")
        return n2
    return n


# ---- 截断时的取样：按年分层，而不是"一半按被引降序 + 一半按时间倒排" ----
# ★ 2026-09-22 实测（GLP-1 受体激动剂 × 慢性肾病 × 非糖尿病，命中 7772 条、取回 611 条）：
#   旧的两趟取法在年份上取出一个【甜甜圈空洞】——
#     2026 年 392 篇(64%)、2025 年 13 篇、2024 年 14 篇、2023 年 28 篇、2019 年 38 篇。
#   两头厚、中间空，而 2024-2025 恰恰是"近期进展"类综述最要紧的窗口：新到还没积累被引、
#   又不是当年新文，两趟都够不着。收窄检索式也不解决 —— 收窄后取回 100 篇全是 2026 年。
#   真漏文献：SMART 试验（Apperloo, Nat Med 2025, PMID 39455729 —— 非糖尿病 CKD 人群
#   唯一的专属肾脏结局 RCT）检索式明明命中它，却按被引降序前 600 名进不去（只有 93 引）、
#   按时间倒排排在 2026 年那 1318 篇后面。真机综述因此写出"非糖尿病 CKD 只有替代终点
#   证据"这种审稿人一眼能看出的硬伤。
# ★ 顺带修掉第二个毛病：全局 CITED desc 捞回来的【不是领域基石，是被引巨兽】。
#   同一次实测前 8 名：Heart Disease and Stroke Statistics-2023(4027 引)、2024 版(2294)、
#   AASLD 肝病指南(1874)、Therapeutic peptides(1506)、微生物-肠-脑轴(863) —— EPMC 是
#   宽松全文匹配，跟题目关系很浅的超高被引文章横扫前排，半个配额就这么废了。
#   按年分桶后这类文章在各自年份里只占 1 个名额，挤不动别人。
# ★ 分层后实测：SMART 在 2024 桶内按被引排第 58 位 —— 每年取 60 就能捞回来。
def _epmc_year_stratified(q, limit, since):
    """把 limit 个名额按年份摊开：每年各按被引降序取一桶，另留一小份给不分年的领域基石。"""
    this_year = time.localtime().tm_year
    # 与 _since_clause 一致地往前放宽一年，否则 pubYear=since 而 FIRST_PDATE=since-1 的
    # online-first 文章在分层这一层又被漏掉。
    lo = (int(since) - 1) if since else this_year - DEFAULT_YEARS_BACK + 1
    lo = max(1900, min(lo, this_year))
    years = list(range(this_year, lo - 1, -1))
    classics = max(1, int(limit * CLASSICS_SHARE))
    per_year = max(1, (limit - classics) // max(1, len(years)))
    sys.stderr.write(f"[europepmc] 按年分层取样：{len(years)} 个年份桶（{lo}-{this_year}）"
                     f"× 每桶最多 {per_year} 条，另加不分年的被引降序 {classics} 条兜底\n")
    batches, got = [], 0
    for y in years:
        yq = f"({q}) AND (FIRST_PDATE:[{y}-01-01 TO {y}-12-31])"
        try:
            recs = _epmc_pass(yq, per_year, sort="CITED desc")
        except Exception as e:            # noqa: BLE001 —— 单桶失败不影响其余年份
            sys.stderr.write(f"[europepmc]   ⚠ {y} 年这一桶失败（{type(e).__name__}: {e}），跳过\n")
            continue
        got += len(recs)
        batches.append(recs)
    try:
        batches.append(_epmc_pass(q, max(classics, limit - got), sort="CITED desc"))
    except Exception as e:                # noqa: BLE001
        sys.stderr.write(f"[europepmc]   ⚠ 不分年的被引降序那一趟失败（{type(e).__name__}: {e}）\n")
    return batches


def search_europepmc(query, limit, since):
    """默认取全；取不全时才做取样 —— **按年分层**（见 _epmc_year_stratified 头注）。

    下面两条是当初定下"两趟取"的理由，分层取样把它们都覆盖了：每桶内部按被引降序
    保证捞得到该年最受认可的几篇（治第一条），分桶本身保证近两年不被挤掉（治第二条），
    而且顺带治好了"全局被引降序捞回来的是被引巨兽、不是领域基石"这个更隐蔽的毛病。

    ★ 为什么不能只用默认顺序：EPMC 不给 sort 时【按时间倒排】，于是结果全是当年新文、
      cites 恒为 0，领域基石一篇都进不来。实测（SGLT2i × HFpEF，limit=25）：25 篇全是 2026 年、
      被引 0–1，EMPEROR-Preserved / DELIVER / EMPA-KIDNEY 这些里程碑 RCT 一篇都没有；
      而同一检索式加 `sort=CITED desc` 一发就中（3708 次被引那篇排第一）。
      模型那一轮自己察觉不对，又花了约 7 分钟、十几轮工具调用去 Crossref 逐个把里程碑捞回来 ——
      一个不较真的模型交付的就是"一份只有当年综述、没有一篇原始 RCT 的证据摸底"。
    ★ 为什么不能只按被引降序：那会系统性偏向老文献，把近两年的进展全挤掉 ——
      而"最新进展"恰恰是综述最要紧的部分。
    ★ 这条比"结果不够好"严重：模型拿不到经典文献时会自己想办法补，
      隔壁 literature-review/search.py 的注释记着实测出现过【凭记忆手敲 landmark DOI】。
      把经典捞回来就消掉了这个动机。

    做法与 literature-review/search.py 的 _two_pass() 一致 —— 那边早就修过这个坑，
    这边一直没移植过来，于是走 `--sources` 多源的用户拿到的是没排序的那一版。
    """
    q = query + _since_clause(since)
    try:
        hits = _epmc_hit_count(q)
        sys.stderr.write(f"[europepmc] 命中 {hits} 条\n")
    except Exception as e:                    # noqa: BLE001 —— 探测失败不影响检索本身
        sys.stderr.write(f"[europepmc] 命中数探测失败（{e}），直接取\n")
        hits = None
    if hits is not None and hits <= limit:    # 取得全 → 一趟翻到底，排序无所谓
        return _epmc_pass(q, limit)
    if limit == math.inf:      # 命中数探测失败且没设上限：分不了层，退回两趟取法
        batches = [_epmc_pass(q, math.inf, sort="CITED desc"),
                   _epmc_pass(q, math.inf, sort=None)]
    else:
        batches = _epmc_year_stratified(q, limit, since)
    merged, seen = [], set()
    for rec in [r for b in batches for r in b]:     # 同一篇只留一次
        key = norm_doi(rec.get("doi")) or (rec.get("pmid") or "") or norm_title(rec.get("title"))[:80]
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(rec)
    merged = _cut(merged, limit)
    if hits is not None and hits > limit:
        sys.stderr.write(f"[europepmc] ⚠ 命中 {hits} 条 > 上限 {limit}，只取回 {len(merged)} 条"
                         f"（按年分层取样：每年各按被引降序取一桶，避免中间年份被挤空）。收窄检索式，"
                         f"或设 SCI_SEARCH_MAX=0 取消上限。\n")
    return merged


def search_semantic_scholar(query, limit, since):
    """按 offset 翻页取。

    ⚠ S2 的 relevance 检索端点自己有 **1000 条总量硬上限**（offset+limit 超了直接报错），
    所以这一源"不限"最多也就到 1000 —— 到顶时明说，别让人以为这就是全部命中。"""
    fields = "title,year,venue,externalIds,abstract,citationCount,authors.name"
    headers = {}
    key = os.environ.get("S2_API_KEY")
    if key:
        headers["x-api-key"] = key
    out, offset, total = [], 0, None
    while len(out) < limit and offset < S2_SEARCH_HARD_TOTAL:
        page = min(_page(limit - len(out), PAGE_S2), S2_SEARCH_HARD_TOTAL - offset)
        params = {"query": query, "limit": page, "offset": offset, "fields": fields}
        if since:
            params["year"] = f"{since}-"
        d = _get_json(S2_SEARCH + "?" + urllib.parse.urlencode(params), headers=headers)
        if total is None:
            total = _int(d.get("total"))
            sys.stderr.write(f"[semantic_scholar] 命中 {total} 条\n")
        batch = d.get("data") or []
        if not batch:
            break
        for p in batch:
            if not p.get("title"):
                continue
            ext = p.get("externalIds") or {}
            r = blank_record()
            r["title"] = (p.get("title") or "").strip().rstrip(".")
            r["year"] = str(p.get("year") or "")
            r["journal"] = p.get("venue", "") or ""
            r["authors"] = ", ".join(a.get("name", "") for a in (p.get("authors") or []) if a.get("name"))
            r["doi"] = ext.get("DOI", "") or ""
            r["pmid"] = ext.get("PubMed", "") or ""
            r["arxiv_id"] = ext.get("ArXiv", "") or ""
            r["cites"] = _int(p.get("citationCount", 0))
            r["abstract"] = (p.get("abstract") or "").replace("\n", " ").strip()
            r["sources"] = ["semantic_scholar"]
            out.append(r)
        nxt = d.get("next")
        if nxt is None:
            break
        offset = _int(nxt)
        time.sleep(0.34)
    if total and total > len(out) and offset >= S2_SEARCH_HARD_TOTAL:
        sys.stderr.write(f"[semantic_scholar] ⚠ 命中 {total} 条，但该端点最多只给前 "
                         f"{S2_SEARCH_HARD_TOTAL} 条（源方限制，非本次设的上限），"
                         f"已取 {len(out)} 条。\n")
    return _cut(out, limit)


def _arxiv_parse(raw, since):
    ns = {"a": "http://www.w3.org/2005/Atom",
          "arxiv": "http://arxiv.org/schemas/atom"}
    root = ET.fromstring(raw)
    entries = root.findall("a:entry", ns)
    out = []
    for e in entries:
        title = (e.findtext("a:title", default="", namespaces=ns) or "").strip()
        title = re.sub(r"\s+", " ", title)
        if not title:
            continue
        published = e.findtext("a:published", default="", namespaces=ns) or ""
        year = published[:4]
        if since and year.isdigit() and int(year) < since:
            continue
        aid_url = e.findtext("a:id", default="", namespaces=ns) or ""
        m = re.search(r"arxiv\.org/abs/([^v\s]+)", aid_url)
        arxiv_id = m.group(1) if m else ""
        doi = e.findtext("arxiv:doi", default="", namespaces=ns) or ""
        if not doi and arxiv_id:
            doi = f"10.48550/arXiv.{arxiv_id}"
        authors = ", ".join(
            (a.findtext("a:name", default="", namespaces=ns) or "").strip()
            for a in e.findall("a:author", ns)
        )
        summary = (e.findtext("a:summary", default="", namespaces=ns) or "").replace("\n", " ").strip()
        r = blank_record()
        r["title"] = title.rstrip(".")
        r["year"] = year
        r["journal"] = "arXiv preprint"
        r["authors"] = authors
        r["doi"] = doi
        r["arxiv_id"] = arxiv_id
        r["abstract"] = summary
        r["sources"] = ["arxiv"]
        out.append(r)
    # 返回本页解析出的记录 + 本页【原始】条目数：靠后者判断还有没有下一页
    # （--since 会滤掉一部分，拿过滤后的数量判断会提前收工）
    return out, len(entries)


def search_arxiv(query, limit, since):
    out, start = [], 0
    while len(out) < limit:
        params = {"search_query": f"all:{query}", "start": start,
                  "max_results": _page(limit - len(out), PAGE_ARXIV),
                  "sortBy": "relevance", "sortOrder": "descending"}
        raw = _http_get(ARXIV + "?" + urllib.parse.urlencode(params))
        page, got = _arxiv_parse(raw, since)
        out.extend(page)
        if got < params["max_results"]:      # 不满一页 = 到底了
            break
        start += got
        time.sleep(3.0)                      # arXiv 明确要求请求间隔 3 秒，别改小
    return _cut(out, limit)


def _openalex_abstract(inv):
    """abstract_inverted_index（词→位置）还原成正文。"""
    if not inv:
        return ""
    positions = []
    for word, idxs in inv.items():
        for i in idxs:
            positions.append((i, word))
    positions.sort(key=lambda x: x[0])
    return " ".join(w for _, w in positions).strip()


def search_openalex(query, limit, since, email):
    """cursor 翻页取全（OpenAlex 的深翻只能用 cursor，page= 参数到 1 万条就被拒）。"""
    out, cursor, reported = [], "*", False
    while len(out) < limit and cursor:
        params = {"search": query, "per-page": _page(limit - len(out), PAGE_OA),
                  "cursor": cursor, "mailto": email or "support@example.org"}
        if since:
            params["filter"] = f"from_publication_date:{since}-01-01"
        key = os.environ.get("OPENALEX_API_KEY")
        if key:
            params["api_key"] = key
        d = _get_json(OPENALEX + "?" + urllib.parse.urlencode(params))
        meta = d.get("meta") or {}
        if not reported:
            sys.stderr.write(f"[openalex] 命中 {_int(meta.get('count'))} 条\n")
            reported = True
        batch = d.get("results") or []
        if not batch:
            break
        out.extend(_openalex_rows(batch))
        cursor = meta.get("next_cursor")
        time.sleep(0.34)
    return _cut(out, limit)


def _openalex_rows(results):
    out = []
    for w in results:
        title = (w.get("display_name") or w.get("title") or "").strip()
        if not title:
            continue
        authors = ", ".join(
            (a.get("author") or {}).get("display_name", "")
            for a in (w.get("authorships") or []) if (a.get("author") or {}).get("display_name")
        )
        loc = w.get("primary_location") or {}
        venue = (loc.get("source") or {}).get("display_name", "") if loc else ""
        r = blank_record()
        r["title"] = title.rstrip(".")
        r["year"] = str(w.get("publication_year") or "")
        r["journal"] = venue or ""
        r["authors"] = authors
        r["doi"] = norm_doi(w.get("doi"))  # OpenAlex 给的是完整 doi.org URL
        r["cites"] = _int(w.get("cited_by_count", 0))
        r["abstract"] = _openalex_abstract(w.get("abstract_inverted_index"))
        r["sources"] = ["openalex"]
        out.append(r)
    return out


SEARCHERS = {
    "europepmc": lambda q, lim, since, email: search_europepmc(q, lim, since),
    "semantic_scholar": lambda q, lim, since, email: search_semantic_scholar(q, lim, since),
    "arxiv": lambda q, lim, since, email: search_arxiv(q, lim, since),
    "openalex": lambda q, lim, since, email: search_openalex(q, lim, since, email),
}


# --------------------------------------------------------------------------- #
# 跨源合并去重
# --------------------------------------------------------------------------- #
def merge_into(canon, new):
    """把 new 合并进已存在的 canon：并源、补全空字段、取较大被引数。"""
    for s in new["sources"]:
        if s not in canon["sources"]:
            canon["sources"].append(s)
    for f in ("doi", "pmid", "arxiv_id", "journal", "authors", "abstract", "year"):
        if not canon.get(f) and new.get(f):
            canon[f] = new[f]
    canon["cites"] = max(_int(canon.get("cites")), _int(new.get("cites")))


def dedup(records):
    """按 DOI→标题跨源去重，返回 (合并后列表, 重叠计数)。"""
    by_doi = {}     # norm_doi -> canon
    by_title = {}   # norm_title -> canon
    kept = []
    overlap = 0
    for r in records:
        d = norm_doi(r.get("doi"))
        t = norm_title(r.get("title"))
        canon = None
        if d and d in by_doi:
            canon = by_doi[d]
        elif t and t in by_title:
            canon = by_title[t]
        if canon is not None:
            before = len(canon["sources"])
            merge_into(canon, r)
            if len(canon["sources"]) > before:
                overlap += 1
            # 合并后若补上了 DOI，登记 doi 键
            nd = norm_doi(canon.get("doi"))
            if nd and nd not in by_doi:
                by_doi[nd] = canon
            continue
        kept.append(r)
        if d:
            by_doi[d] = r
        if t:
            by_title[t] = r
    return kept, overlap


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="多源文献检索 + 跨源去重")
    ap.add_argument("queries", nargs="+", help="一个或多个检索式")
    ap.add_argument("--sources", default=",".join(ALL_SOURCES),
                    help=f"逗号分隔，默认全开：{','.join(ALL_SOURCES)}")
    ap.add_argument("--limit", type=int, default=0,
                    help="每源每检索式取多少。默认 0 = 不限（翻页取到源枯竭）；"
                         "只有确实只想要前 N 条时才给")
    ap.add_argument("--since", type=int, help="起始年份（含）")
    ap.add_argument("--email", default=_EMAIL,
                    help="OpenAlex polite pool 联系邮箱（也读 OPENALEX_MAILTO）")
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--tag", default=None,
                    help="本次检索的短标签，产物写成 evidence_table__<标签>.csv / "
                         "evidence__<标签>.md。同一会话里第 2 次及以后的检索务必带上，"
                         "否则上一次的证据表会被挤成 .bak，手上那张就只剩最后一轮")
    ap.add_argument("--out", default=None,
                    help="直接指定证据表 CSV 的文件名（.md 用同一 stem）；与 --tag 二选一")
    args = ap.parse_args()
    args.outdir = str(_resolve_out_dir(args.outdir))

    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    bad = [s for s in sources if s not in SEARCHERS]
    if bad:
        sys.exit(f"未知来源：{bad}；可选：{list(SEARCHERS)}")
    os.makedirs(args.outdir, exist_ok=True)

    # 不给 --limit 就不限条数；跑飞护栏见 _hard_cap()。
    target = args.limit if args.limit and args.limit > 0 else _hard_cap()
    sys.stderr.write("检索条数：" + ("不限（取到各源枯竭）" if target == math.inf
                                 else (f"每源每式最多 {target} 条"
                                       + ("（跑飞护栏 SCI_SEARCH_MAX，设 0 可取消）"
                                          if not args.limit else "（--limit 指定）"))) + "\n")

    # 检索式合法性闸（见 lint_query 头注）：OR 组里的多词词条补括号。
    # 【必须响亮报告】—— 这一闸修的是"命中数反而变多"的静默失血，不说出来的话
    # 模型和用户都会以为原来那条检索式是对的。
    for i, raw in enumerate(args.queries):
        fixed, changed = lint_query(raw)
        if changed:
            args.queries[i] = fixed
            sys.stderr.write(
                f"⚠ 检索式已修正（OR 组里的多词词条缺括号）：{'、'.join(changed)}\n"
                f"    原式：{raw}\n    改为：{fixed}\n"
                f"    原因：多词词条不加括号时按词级结合解析，布尔逻辑散架 ——"
                f"【命中数会变多而不是变少】，看起来像召回变宽了，实际会漏掉该命中的文献。\n")

    all_records = []
    per_source = {}   # source -> 命中数（去重前）
    failures = {}     # source -> 错误信息
    for src in sources:
        cnt = 0
        for q in args.queries:
            try:
                recs = SEARCHERS[src](q, target, args.since, args.email)
            except Exception as e:  # noqa: BLE001 —— 单源失败不阻断整体
                failures[src] = str(e)
                sys.stderr.write(f"[{src}] 失败（跳过）：{e}\n")
                recs = []
                break
            all_records.extend(recs)
            cnt += len(recs)
            time.sleep(0.34)
        per_source[src] = cnt
        if src not in failures:
            sys.stderr.write(f"[{src}] 命中 {cnt} 条（去重前）\n")

    if not all_records:
        sys.exit("四源均无命中（检查检索式 / 网络；国内注意增强源多半连不通，"
                 "至少 europepmc 应可达）。")

    merged, overlap = dedup(all_records)
    for r in merged:
        r["design"] = classify(f"{r['title']} {r['abstract']}")
    merged.sort(key=lambda x: (_int(x["year"]), _int(x["cites"])), reverse=True)

    csv_path, md_path = _out_paths(args.outdir, args.out, args.tag)
    import csv as _csv
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = _csv.DictWriter(f, fieldnames=["title", "year", "journal", "design",
                                           "cites", "doi", "pmid", "sources", "abstract"])
        w.writeheader()
        for r in merged:
            w.writerow({
                "title": r["title"], "year": r["year"], "journal": r["journal"],
                "design": r["design"], "cites": r["cites"], "doi": r["doi"],
                "pmid": r["pmid"], "sources": "+".join(r["sources"]),
                "abstract": r["abstract"],
            })

    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# 证据清单（{len(merged)} 篇，跨源去重后）\n\n")
        for i, r in enumerate(merged, 1):
            src = "+".join(r["sources"])
            f.write(f"{i}. **{r['title']}** ({r['year']}, {r['journal']}) "
                    f"— *{r['design']}*, cited {r['cites']}x, [{src}]. "
                    f"DOI:{r['doi'] or 'NA'}\n")
            if r["abstract"]:
                f.write(f"   > {r['abstract'][:400]}\n")
            f.write("\n")

    # 报告
    from collections import Counter
    dist = Counter(r["design"] for r in merged)
    raw_total = sum(per_source.values())
    sys.stderr.write(
        f"\n跨源汇总：去重前 {raw_total} 条 → 去重后 {len(merged)} 篇"
        f"（跨源重叠合并 {overlap} 次）。\n"
        f"各源贡献（去重前）：{per_source}\n"
    )
    if failures:
        sys.stderr.write(f"失败来源：{list(failures)}（已跳过，结果以其余源为准）\n")
    sys.stderr.write(f"研究类型分布：{dict(dist)}\n")
    print(f"已写：{csv_path}\n      {md_path}")


if __name__ == "__main__":
    main()
