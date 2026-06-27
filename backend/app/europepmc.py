"""Europe PMC 文献检索客户端。

Europe PMC 覆盖 PubMed 全量 + bioRxiv/medRxiv 等预印本 + Agricola 等。
REST 接口免费、无需 key、查询语法与 PubMed 兼容（支持 MeSH）。

对外暴露 search_epmc(), 返回与 literature.py 同构的论文 dict 列表。
"""
from __future__ import annotations

import httpx

from . import searchfilters

_ENDPOINT = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"


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
    return {
        "pmid": pmid,
        "doi": doi,
        "title": title,
        "abstract": (raw.get("abstractText") or "").strip(),
        "first_author": first_author,
        "journal": (raw.get("journalTitle") or "").strip(),
        "year": str(raw.get("pubYear") or "").strip(),
        "url": url,
        "source": tag,
    }


async def _search_one(client: httpx.AsyncClient, query: str, per_query: int) -> list[dict]:
    params = {
        "query": query,
        "format": "json",
        "resultType": "core",
        "pageSize": str(per_query),
    }
    r = await client.get(_ENDPOINT, params=params)
    r.raise_for_status()
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
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
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
