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

UA = "sci-agent-enhanced-search/1.0"
TIMEOUT = 30

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
                ra = exc.headers.get("Retry-After")
                wait = float(ra) if (ra and str(ra).isdigit()) else delay
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
def search_europepmc(query, limit, since):
    q = query
    if since:
        q += f" AND (FIRST_PDATE:[{since}-01-01 TO 3000-12-31])"
    out, cursor = [], "*"
    while len(out) < limit:
        params = {"query": q, "format": "json",
                  "pageSize": min(100, limit - len(out)),
                  "cursorMark": cursor, "resultType": "core"}
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
    ap.add_argument("--email", default=os.environ.get("OPENALEX_MAILTO", ""),
                    help="OpenAlex polite pool 联系邮箱（也读 OPENALEX_MAILTO）")
    ap.add_argument("--outdir", default="outputs")
    args = ap.parse_args()

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
