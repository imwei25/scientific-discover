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
