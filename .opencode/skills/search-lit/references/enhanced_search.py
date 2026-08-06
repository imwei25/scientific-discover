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

用法
----
    python enhanced_search.py "sglt2 inhibitor heart failure" --limit 25 --since 2019
    python enhanced_search.py "graph neural network" "protein design" \
        --sources semantic_scholar,arxiv,openalex --email you@example.com
产出
----
    outputs/evidence_table.csv   title/year/journal/design/cites/doi/pmid/sources/abstract
    outputs/evidence.md          精简清单（写综述时逐条引用）
    stderr                       每源命中数、跨源重叠、去重后总数
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

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
                  "pageSize": min(100, limit - len(out)),
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
        time.sleep(0.34)
    return out[:limit]


def search_europepmc(query, limit, since):
    """两趟检索再合并去重：一趟按被引降序捞经典，一趟默认顺序捞最新。

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
    q = query
    if since:
        q += f" AND (FIRST_PDATE:[{since}-01-01 TO 3000-12-31])"
    half = max(1, limit // 2)
    cited = _epmc_pass(q, half, sort="CITED desc")
    recent = _epmc_pass(q, limit - len(cited) + half, sort=None)
    merged, seen = [], set()
    for rec in list(cited) + list(recent):          # 经典在前，同一篇只留一次
        key = norm_doi(rec.get("doi")) or (rec.get("pmid") or "") or norm_title(rec.get("title"))[:80]
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(rec)
    return merged[:limit]


def search_semantic_scholar(query, limit, since):
    fields = "title,year,venue,externalIds,abstract,citationCount,authors.name"
    params = {"query": query, "limit": min(100, limit), "fields": fields}
    if since:
        params["year"] = f"{since}-"
    headers = {}
    key = os.environ.get("S2_API_KEY")
    if key:
        headers["x-api-key"] = key
    d = _get_json(S2_SEARCH + "?" + urllib.parse.urlencode(params), headers=headers)
    out = []
    for p in d.get("data", []) or []:
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
    return out[:limit]


def search_arxiv(query, limit, since):
    params = {"search_query": f"all:{query}", "start": 0,
              "max_results": min(100, limit),
              "sortBy": "relevance", "sortOrder": "descending"}
    raw = _http_get(ARXIV + "?" + urllib.parse.urlencode(params))
    ns = {"a": "http://www.w3.org/2005/Atom",
          "arxiv": "http://arxiv.org/schemas/atom"}
    root = ET.fromstring(raw)
    out = []
    for e in root.findall("a:entry", ns):
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
    return out[:limit]


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
    params = {"search": query, "per-page": min(50, limit),
              "mailto": email or "support@example.org"}
    if since:
        params["filter"] = f"from_publication_date:{since}-01-01"
    key = os.environ.get("OPENALEX_API_KEY")
    if key:
        params["api_key"] = key
    d = _get_json(OPENALEX + "?" + urllib.parse.urlencode(params))
    out = []
    for w in d.get("results", []) or []:
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
    return out[:limit]


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
    ap.add_argument("--limit", type=int, default=25, help="每源每检索式取多少")
    ap.add_argument("--since", type=int, help="起始年份（含）")
    ap.add_argument("--email", default=_EMAIL,
                    help="OpenAlex polite pool 联系邮箱（也读 OPENALEX_MAILTO）")
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()
    args.outdir = str(_resolve_out_dir(args.outdir))

    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    bad = [s for s in sources if s not in SEARCHERS]
    if bad:
        sys.exit(f"未知来源：{bad}；可选：{list(SEARCHERS)}")
    os.makedirs(args.outdir, exist_ok=True)

    all_records = []
    per_source = {}   # source -> 命中数（去重前）
    failures = {}     # source -> 错误信息
    for src in sources:
        cnt = 0
        for q in args.queries:
            try:
                recs = SEARCHERS[src](q, args.limit, args.since, args.email)
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

    csv_path = os.path.join(args.outdir, "evidence_table.csv")
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

    md_path = os.path.join(args.outdir, "evidence.md")
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
