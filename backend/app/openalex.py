"""OpenAlex 文献检索客户端。

OpenAlex 覆盖 2.5 亿+ 学术著作（超出 PubMed 的生物医学边界，含跨学科/方法学文献），
免费、无需 key（填 mailto 进 polite pool 更稳更快）。它给本方案带来两个现有源
（PubMed / Europe PMC）都没有的能力：
  1) 更广的覆盖面（兜底命中 PubMed 收录之外的工作）；
  2) 被引数 cited_by_count —— 用于"排序选篇"（先扩召回再按热度+相关性+新近择优纳入）。

对外暴露 search_openalex(), 返回与 europepmc.py / literature.py 同构的论文 dict,
额外带一个 cited_by_count 字段（其它源没有时为 0，合并时取 max）。
摘要在 OpenAlex 里是倒排索引(abstract_inverted_index)，需本地重建为纯文本。
"""
from __future__ import annotations

import httpx

from . import searchfilters
from .config import settings

_ENDPOINT = "https://api.openalex.org/works"
# 只取需要的字段，省带宽。
_SELECT = (
    "id,doi,ids,title,publication_year,authorships,"
    "primary_location,cited_by_count,abstract_inverted_index"
)


def _rebuild_abstract(inv: dict | None) -> str:
    """把 abstract_inverted_index {word: [pos, ...]} 还原为纯文本。

    老记录可能没有该字段(返回 null) —— 视为无摘要, 不是错误。
    """
    if not inv:
        return ""
    positions: list[tuple[int, str]] = []
    for word, idxs in inv.items():
        for i in idxs:
            positions.append((i, word))
    positions.sort(key=lambda x: x[0])
    return " ".join(w for _, w in positions).strip()


def _normalize(raw: dict) -> dict | None:
    """把 OpenAlex 原始 work 转成统一论文 dict（含 cited_by_count）。"""
    title = (raw.get("title") or "").strip()
    if not title:
        return None
    # DOI 字段形如 https://doi.org/10.xxxx —— 去前缀、转小写用于跨源去重。
    doi = (raw.get("doi") or "").replace("https://doi.org/", "").strip().lower()
    pmid = ""
    ids = raw.get("ids") or {}
    pmid_url = ids.get("pmid")
    if pmid_url:  # 形如 https://pubmed.ncbi.nlm.nih.gov/12345
        pmid = str(pmid_url).rstrip("/").split("/")[-1].strip()
    authorships = raw.get("authorships") or []
    first_author = ""
    if authorships:
        first_author = ((authorships[0].get("author") or {}).get("display_name") or "").strip()
    src = (raw.get("primary_location") or {}).get("source") or {}
    journal = (src.get("display_name") or "").strip()
    # 有 PMID 的优先指回 PubMed（与其它源对齐、链接更权威）；否则用 OpenAlex 落地页。
    if pmid:
        url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
    else:
        url = (raw.get("id") or "").strip()  # OpenAlex work URL, 如 https://openalex.org/W...
    if not url:
        return None
    return {
        "pmid": pmid,
        "doi": doi,
        "title": title,
        "abstract": _rebuild_abstract(raw.get("abstract_inverted_index")),
        "first_author": first_author,
        "journal": journal,
        "year": str(raw.get("publication_year") or "").strip(),
        "url": url,
        "source": "openalex",
        "cited_by_count": int(raw.get("cited_by_count") or 0),
    }


def _params(query: str, per_query: int, filter_extra: str = "") -> dict:
    # OpenAlex 的 filter 用逗号分隔 AND 子句、冒号分隔键值; PubMed 检索式里的逗号/冒号
    # 会破坏 filter 语法导致整源 4xx 失效。这里把它们替换为空格(检索词仍保留)。
    safe_q = query.replace(",", " ").replace(":", " ").strip()
    # title_and_abstract.search 比裸 search 更精准（只搜标题+摘要）; 过滤器并入同一 filter 串。
    flt = f"title_and_abstract.search:{safe_q}"
    if filter_extra:
        flt += "," + filter_extra
    p = {
        "filter": flt,
        "per_page": str(per_query),
        "select": _SELECT,
        "sort": "relevance_score:desc",
    }
    email = getattr(settings, "ncbi_email", "") or ""
    if email:
        p["mailto"] = email  # 进 polite pool, 响应更稳定
    return p


async def _search_one(client: httpx.AsyncClient, query: str, per_query: int, filter_extra: str = "") -> list[dict]:
    r = await client.get(_ENDPOINT, params=_params(query, per_query, filter_extra))
    r.raise_for_status()
    out: list[dict] = []
    for raw in r.json().get("results", []) or []:
        norm = _normalize(raw)
        if norm:
            out.append(norm)
    return out


async def search_openalex(queries: list[str], per_query: int = 6, cap: int = 18, filters: dict | None = None) -> dict:
    """对多个检索式跑 OpenAlex, 返回 {papers, network_errors, queries_tried}。"""
    filter_extra = searchfilters.openalex_params(filters or {}).get("filter_extra", "")
    seen_keys: set[str] = set()
    collected: list[dict] = []
    network_errors = 0
    queries_tried = list(queries)
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for q in queries:
            try:
                results = await _search_one(client, q, per_query, filter_extra)
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
