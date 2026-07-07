"""Europe PMC 文献检索客户端。

Europe PMC 覆盖 PubMed 全量 + bioRxiv/medRxiv 等预印本 + Agricola 等。
REST 接口免费、无需 key、查询语法与 PubMed 兼容（支持 MeSH）。

对外暴露 search_epmc(), 返回与 literature.py 同构的论文 dict 列表。
"""
from __future__ import annotations

import re
from html import unescape

import httpx

from . import searchfilters

_ENDPOINT = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
_REST_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"


def _normalize(raw: dict) -> dict | None:
    """把 Europe PMC 原始 result 转成统一论文 dict。

    PubMed 来源（source=MED）会同时带 pmid，链接走 pubmed.ncbi.nlm.nih.gov；
    预印本（source=PPR）pmid 为空，链接走 europepmc.org。
    """
    title = (raw.get("title") or "").strip()
    if not title:
        return None
    eid = str(raw.get("id") or "").strip()
    src = (raw.get("source") or "").strip()
    pmid = str(raw.get("pmid") or "").strip()
    doi = (raw.get("doi") or "").strip().lower()
    if pmid:
        url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
        tag = "pubmed"
    else:
        url = f"https://europepmc.org/article/{src or 'MED'}/{eid}"
        tag = "preprint" if src == "PPR" else "europepmc"
    author_string = raw.get("authorString") or ""
    first_author = author_string.split(",")[0].strip() if author_string else ""
    # resultType=core 带 journalInfo.journal, 含 issn(印刷)/essn(电子) —— 供影响力按 ISSN 匹配。
    jinfo = ((raw.get("journalInfo") or {}).get("journal")) or {}
    issn = (jinfo.get("issn") or jinfo.get("essn") or "").strip().upper()
    return {
        "pmid": pmid,
        "doi": doi,
        "title": title,
        "abstract": (raw.get("abstractText") or "").strip(),
        "first_author": first_author,
        "journal": (raw.get("journalTitle") or "").strip(),
        "issn": issn,
        "year": str(raw.get("pubYear") or "").strip(),
        "url": url,
        "source": tag,
    }


async def _search_one(client: httpx.AsyncClient, query: str, per_query: int) -> list[dict]:
    from .http_common import with_backoff
    params = {
        "query": query,
        "format": "json",
        "resultType": "core",
        "pageSize": str(per_query),
    }

    async def _do() -> httpx.Response:
        r = await client.get(_ENDPOINT, params=params)
        r.raise_for_status()
        return r
    r = await with_backoff(_do)
    data = r.json()
    out: list[dict] = []
    for raw in data.get("resultList", {}).get("result", []) or []:
        norm = _normalize(raw)
        if norm:
            out.append(norm)
    return out


async def search_epmc(queries: list[str], per_query: int = 6, cap: int = 18, filters: dict | None = None) -> dict:
    """对多个检索式跑 Europe PMC, 返回 {papers, network_errors, queries_tried}。"""
    suffix = searchfilters.epmc_suffix(filters or {})
    seen_keys: set[str] = set()
    collected: list[dict] = []
    network_errors = 0
    queries_tried = list(queries)
    # 用 User-Agent 标识本工具 (Europe PMC 无 mailto 但 UA 帮助追踪流量, 避免被误当匿名爬虫)
    from .config import settings as _settings
    email = getattr(_settings, "ncbi_email", "") or ""
    ua = f"research-assistant/1.0 (mailto:{email})" if email else "research-assistant/1.0 (https://github.com/imwei25/scientific-discover)"
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), headers={"User-Agent": ua}) as client:
        for q in queries:
            try:
                results = await _search_one(client, q + suffix, per_query)
            except Exception:  # noqa: BLE001
                network_errors += 1
                continue
            for p in results:
                key = p["doi"] or p["pmid"] or p["url"]
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                collected.append(p)
                if len(collected) >= cap:
                    break
            if len(collected) >= cap:
                break
    return {"papers": collected, "network_errors": network_errors, "queries_tried": queries_tried}


async def fetch_fulltext(pmid: str = "", doi: str = "", timeout: float = 15.0) -> str:
    """按 pmid/doi 反查 Europe PMC, 有开放全文 (fullTextXML) 时返回纯文本, 否则 ""。

    供深度调研深读兜底: 无 OA PDF 链接的文献仍可能在 PMC 有免费全文。
    XML 只做粗提纯 (去标签+合并空行), 供 LLM 摄入足够。
    """
    if not pmid and not doi:
        return ""
    query = f"EXT_ID:{pmid} AND SRC:MED" if pmid else f'DOI:"{doi}"'
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
        r = await client.get(_ENDPOINT, params={
            "query": query, "format": "json", "resultType": "lite", "pageSize": "1",
        })
        r.raise_for_status()
        results = (r.json().get("resultList") or {}).get("result") or []
        if not results:
            return ""
        pmcid = str(results[0].get("pmcid") or "").strip()
        if not pmcid:
            return ""
        r2 = await client.get(f"{_REST_BASE}/{pmcid}/fullTextXML")
        if r2.status_code != 200 or not r2.text.strip():
            return ""
        xml = r2.text
    text = unescape(re.sub(r"<[^>]+>", "\n", xml))
    return re.sub(r"\n{3,}", "\n\n", text).strip()
