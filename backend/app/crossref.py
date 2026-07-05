"""Crossref 文献检索客户端(api.crossref.org)。

Crossref 是出版商 DOI 注册中心, 覆盖跨学科期刊/会议元数据, 免费、无需 key
(填 mailto 进 polite pool 更稳更快)。它给本方案带来 PubMed/Europe PMC 之外的补充:
  1) 更广的出版物覆盖(尤其非 PubMed 收录的期刊);
  2) is-referenced-by-count 被引数 —— 参与"排序选篇"(与 OpenAlex 对齐, 合并时取 max);
  3) 权威 DOI, 利于跨源去重与后续 Unpaywall 取 OA 全文。

对外暴露 search_crossref(), 返回与 literature.py/openalex.py 同构的论文 dict。
摘要在 Crossref 里是 JATS XML(部分文献缺失), 需本地剥标签为纯文本。
"""
from __future__ import annotations

import re

import httpx

from . import searchfilters
from .config import settings

_ENDPOINT = "https://api.crossref.org/works"
_WORK_SELECT = "DOI,title,author,container-title,issued,published-print,published-online"
# 只取需要的字段, 省带宽。
_SELECT = (
    "DOI,title,author,container-title,ISSN,issued,published-print,published-online,"
    "abstract,is-referenced-by-count,URL"
)

# PubMed 检索式里的字段标签[tiab]/MeSH 记号与布尔词, 对 Crossref 自由文本检索是噪声, 检索前剔除。
_FIELD_TAG = re.compile(r"\[[^\]]*\]")
_BOOL_WORD = re.compile(r"\b(AND|OR|NOT)\b")
_JATS_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def _clean_query(query: str) -> str:
    """把 PubMed 风格检索式降级为 Crossref 可用的自由文本(去字段标签/布尔词/括号引号)。"""
    s = _FIELD_TAG.sub(" ", query or "")
    s = re.sub(r'[()"]', " ", s)
    s = _BOOL_WORD.sub(" ", s)
    return _WS.sub(" ", s).strip()


def _strip_jats(s: str) -> str:
    return _WS.sub(" ", _JATS_TAG.sub(" ", s or "")).strip()


def _year(item: dict) -> str:
    for k in ("published-print", "published-online", "issued", "created"):
        dp = (item.get(k) or {}).get("date-parts") or []
        if dp and dp[0] and dp[0][0]:
            return str(dp[0][0])
    return ""


def _first_author(item: dict) -> str:
    authors = item.get("author") or []
    if not authors:
        return ""
    a = authors[0]
    family = (a.get("family") or "").strip()
    given = (a.get("given") or "").strip()
    if family:
        initials = "".join(p[0] for p in given.replace(".", " ").split() if p)[:2].upper()
        return f"{family} {initials}".strip()
    return (a.get("name") or "").strip()


def _normalize(item: dict) -> dict | None:
    titles = item.get("title") or []
    title = (titles[0] if titles else "").strip()
    if not title:
        return None
    doi = (item.get("DOI") or "").strip().lower()
    containers = item.get("container-title") or []
    journal = (containers[0] if containers else "").strip()
    issns = item.get("ISSN") or []
    issn = (issns[0] if issns else "").strip().upper()
    url = f"https://doi.org/{doi}" if doi else (item.get("URL") or "").strip()
    if not url:
        return None
    return {
        "pmid": "",  # Crossref 不可靠提供 PMID
        "doi": doi,
        "title": title,
        "abstract": _strip_jats(item.get("abstract") or ""),
        "first_author": _first_author(item),
        "journal": journal,
        "issn": issn,
        "year": _year(item),
        "url": url,
        "source": "crossref",
        "cited_by_count": int(item.get("is-referenced-by-count") or 0),
        # CSL type：供下游 _detect_non_academic 识别 proceedings-article / posted-content 等
        "type": str(item.get("type") or "").strip().lower(),
    }


def _params(query: str, rows: int, filter_str: str, email: str) -> dict:
    p = {
        "query.bibliographic": _clean_query(query),
        "rows": str(rows),
        "select": _SELECT,
        "sort": "relevance",
    }
    if filter_str:
        p["filter"] = filter_str
    if email:
        p["mailto"] = email  # 进 polite pool, 响应更稳定
    return p


def _parse_work_message(msg: dict) -> dict | None:
    """把 CrossRef /works/{doi} 返回的 message 解析为 refsenrich 消费的结构：
      {doi, title, authors: [{family, given}], journal, year}
    保留 authors 结构，避免下游 CSL 渲染时姓/名颠倒（这是 [70]-[74] 的根因）。"""
    if not isinstance(msg, dict):
        return None
    titles = msg.get("title") or []
    title = (titles[0] if titles else "").strip()
    if not title:
        return None
    doi = (msg.get("DOI") or "").strip().lower()
    containers = msg.get("container-title") or []
    journal = (containers[0] if containers else "").strip()
    authors_raw = msg.get("author") or []
    authors: list[dict] = []
    for a in authors_raw:
        family = str(a.get("family") or "").strip()
        given = str(a.get("given") or "").strip()
        if not family and not given:
            # 兼容 organization-style author
            name = str(a.get("name") or "").strip()
            if name:
                authors.append({"family": name, "given": ""})
            continue
        authors.append({"family": family, "given": given})
    return {
        "doi": doi,
        "title": title,
        "authors": authors,
        "journal": journal,
        "year": _year(msg),
        "type": str(msg.get("type") or "").strip().lower(),
    }


async def fetch_by_doi(client: httpx.AsyncClient, doi: str) -> dict | None:
    """GET /works/{doi}，返回结构化 dict 或 None（网络/404 时静默）。"""
    if not doi:
        return None
    email = getattr(settings, "ncbi_email", "") or ""
    ua = f"research-assistant/1.0 (mailto:{email})" if email else "research-assistant/1.0"
    params = {"select": _WORK_SELECT}
    if email:
        params["mailto"] = email
    try:
        r = await client.get(
            f"{_ENDPOINT}/{doi}",
            params=params,
            headers={"User-Agent": ua},
        )
        r.raise_for_status()
        msg = (r.json() or {}).get("message") or {}
    except Exception:  # noqa: BLE001
        return None
    return _parse_work_message(msg)


async def search_title(title: str, limit: int = 1) -> list[dict]:
    """按题名精确检索 Crossref, 返回 [{title, abstract, first_author, year, url, doi}, ...]。

    与 search_crossref 不同, 这里用 query.title 字段, 追求"题名反查"的精准度而非广度。
    网络失败/超时 → 返回 []。
    """
    if not title or not title.strip():
        return []
    email = getattr(settings, "ncbi_email", "") or ""
    ua = f"research-assistant/1.0 (mailto:{email})" if email else "research-assistant/1.0"
    params = {
        "query.title": _clean_query(title),
        "rows": str(max(1, min(limit, 5))),
        "select": _SELECT,
        "sort": "relevance",
    }
    if email:
        params["mailto"] = email
    out: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0), headers={"User-Agent": ua}) as client:
            r = await client.get(_ENDPOINT, params=params)
            r.raise_for_status()
            items = (r.json().get("message") or {}).get("items") or []
    except Exception:  # noqa: BLE001
        return []
    for raw in items:
        norm = _normalize(raw)
        if norm:
            out.append(norm)
        if len(out) >= limit:
            break
    return out


async def search_crossref(queries: list[str], per_query: int = 6, cap: int = 18, filters: dict | None = None) -> dict:
    """对多个检索式跑 Crossref, 返回 {papers, network_errors, queries_tried}。"""
    filt = searchfilters.crossref_filter(searchfilters.normalize(filters))
    email = getattr(settings, "ncbi_email", "") or ""
    ua = f"research-assistant/1.0 (mailto:{email})" if email else "research-assistant/1.0"
    seen_keys: set[str] = set()
    collected: list[dict] = []
    network_errors = 0
    queries_tried = list(queries)
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), headers={"User-Agent": ua}) as client:
        for q in queries:
            try:
                r = await client.get(_ENDPOINT, params=_params(q, per_query, filt, email))
                r.raise_for_status()
                items = (r.json().get("message") or {}).get("items") or []
            except Exception:  # noqa: BLE001
                network_errors += 1
                continue
            for raw in items:
                norm = _normalize(raw)
                if not norm:
                    continue
                key = norm["doi"] or norm["url"]
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                collected.append(norm)
                if len(collected) >= cap:
                    break
            if len(collected) >= cap:
                break
    return {"papers": collected, "network_errors": network_errors, "queries_tried": queries_tried}
