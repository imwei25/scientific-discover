"""PubMed 文献检索客户端(NCBI E-utilities)。

用于医学/药学/生物领域的“找选题”: 实际检索真实文献, 供 LLM 梳理现状与空白,
并生成可点击的 PubMed 链接。E-utilities 免费, 无需 key(限速 3 次/秒)。
"""
from __future__ import annotations

import asyncio
import re
import time
import xml.etree.ElementTree as ET

import httpx

from .config import settings
from .europepmc import search_epmc

_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
_TOOL = "research-assistant"

# NCBI E-utilities 无 api_key 时限速 3 次/秒, 超限会返回 429 甚至临时封 IP。
# 深度调研会连发多次 esearch/efetch, 这里做全局节流, 保证请求间隔 >= 0.34s。
_NCBI_MIN_INTERVAL = 0.34
_ncbi_lock = asyncio.Lock()
_ncbi_last = 0.0


async def _throttle() -> None:
    """确保相邻 NCBI 请求间隔不小于 _NCBI_MIN_INTERVAL 秒。"""
    global _ncbi_last
    async with _ncbi_lock:
        wait = _NCBI_MIN_INTERVAL - (time.monotonic() - _ncbi_last)
        if wait > 0:
            await asyncio.sleep(wait)
        _ncbi_last = time.monotonic()


def pubmed_url(pmid: str) -> str:
    return f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"


def _common_params() -> dict:
    p = {"tool": _TOOL}
    email = getattr(settings, "ncbi_email", "") or ""
    if email:
        p["email"] = email
    return p


async def esearch(client: httpx.AsyncClient, query: str, retmax: int = 8) -> list[str]:
    params = {
        "db": "pubmed",
        "term": query,
        "retmax": str(retmax),
        "retmode": "json",
        "sort": "relevance",
        **_common_params(),
    }
    await _throttle()
    r = await client.get(f"{_BASE}/esearch.fcgi", params=params)
    r.raise_for_status()
    data = r.json()
    return data.get("esearchresult", {}).get("idlist", [])


def _text(el) -> str:
    return "".join(el.itertext()).strip() if el is not None else ""


async def efetch(client: httpx.AsyncClient, pmids: list[str]) -> list[dict]:
    if not pmids:
        return []
    params = {
        "db": "pubmed",
        "id": ",".join(pmids),
        "retmode": "xml",
        "rettype": "abstract",
        **_common_params(),
    }
    await _throttle()
    r = await client.get(f"{_BASE}/efetch.fcgi", params=params)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    papers: list[dict] = []
    for art in root.findall(".//PubmedArticle"):
        pmid = _text(art.find(".//PMID"))
        title = _text(art.find(".//Article/ArticleTitle"))
        # 摘要可能分多段(带 Label)
        abstract_parts = []
        for ab in art.findall(".//Abstract/AbstractText"):
            label = ab.get("Label")
            txt = _text(ab)
            abstract_parts.append(f"{label}: {txt}" if label else txt)
        abstract = " ".join(abstract_parts)
        # 第一作者
        first_author = ""
        author = art.find(".//AuthorList/Author")
        if author is not None:
            last = _text(author.find("LastName"))
            initials = _text(author.find("Initials"))
            first_author = f"{last} {initials}".strip()
        journal = _text(art.find(".//Journal/Title"))
        year = _text(art.find(".//JournalIssue/PubDate/Year")) or _text(
            art.find(".//JournalIssue/PubDate/MedlineDate")
        )
        # DOI 用于跨源去重（与 Europe PMC 结果对齐）。
        doi = ""
        for aid in art.findall(".//ArticleIdList/ArticleId"):
            if (aid.get("IdType") or "").lower() == "doi":
                doi = _text(aid).lower()
                break
        if not pmid or not title:
            continue
        papers.append(
            {
                "pmid": pmid,
                "doi": doi,
                "title": title,
                "abstract": abstract,
                "first_author": first_author,
                "journal": journal,
                "year": year,
                "url": pubmed_url(pmid),
                "source": "pubmed",
            }
        )
    return papers


async def _search_pubmed(queries: list[str], per_query: int, cap: int) -> dict:
    """只跑 PubMed（NCBI E-utilities）的版本, 返回与 search_literature 同形 dict。"""
    seen: set[str] = set()
    collected: list[str] = []
    network_errors = 0
    queries_tried = list(queries)
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for q in queries:
            try:
                ids = await esearch(client, q, retmax=per_query)
            except Exception:  # noqa: BLE001
                network_errors += 1
                continue
            for pid in ids:
                if pid not in seen:
                    seen.add(pid)
                    collected.append(pid)
            if len(collected) >= cap:
                break
        collected = collected[:cap]
        papers: list[dict] = []
        if collected:
            try:
                papers = await efetch(client, collected)
            except Exception:  # noqa: BLE001
                network_errors += 1
                papers = []
    return {"papers": papers, "network_errors": network_errors, "queries_tried": queries_tried}


_PUNCT_RE = re.compile(r"[^a-z0-9]+")


def _title_key(title: str) -> str:
    """标题归一化键（去标点+小写+折叠空白）, 用于跨源题名级去重。"""
    return _PUNCT_RE.sub(" ", title.lower()).strip()


def _merge_sources(pubmed: list[dict], epmc: list[dict], cap: int) -> list[dict]:
    """合并 PubMed + Europe PMC, 优先保留 PubMed 版本（pmid/doi/title 三键去重）。"""
    out: list[dict] = list(pubmed)
    pmids = {p["pmid"] for p in pubmed if p.get("pmid")}
    dois = {p["doi"] for p in pubmed if p.get("doi")}
    titles = {_title_key(p["title"]) for p in pubmed if p.get("title")}
    for p in epmc:
        if p.get("pmid") and p["pmid"] in pmids:
            continue
        if p.get("doi") and p["doi"] in dois:
            continue
        tk = _title_key(p.get("title", ""))
        if tk and tk in titles:
            continue
        out.append(p)
        if p.get("pmid"):
            pmids.add(p["pmid"])
        if p.get("doi"):
            dois.add(p["doi"])
        if tk:
            titles.add(tk)
        if len(out) >= cap:
            break
    return out[:cap]


async def search_literature(queries: list[str], per_query: int = 6, cap: int = 18) -> dict:
    """并发检索 PubMed + Europe PMC, 合并去重。

    返回 {"papers", "network_errors", "queries_tried"}。
    network_errors 是两源失败次数之和（用于区分『检索式太窄』和『两源都连不上』）。
    每篇 paper 多带一个 source 字段: "pubmed" / "preprint" / "europepmc"。
    """
    pubmed_share = max(2, per_query)
    epmc_share = max(2, per_query)
    pm_task = _search_pubmed(queries, pubmed_share, cap)
    ep_task = search_epmc(queries, epmc_share, cap)
    pm, ep = await asyncio.gather(pm_task, ep_task)
    merged = _merge_sources(pm["papers"], ep["papers"], cap)
    # 全部失败的边界: PubMed 全网络错 且 Europe PMC 也全错。
    pm_total_fail = pm["network_errors"] >= max(1, len(queries))
    ep_total_fail = ep["network_errors"] >= max(1, len(queries))
    net_errs = pm["network_errors"] + ep["network_errors"]
    return {
        "papers": merged,
        # 上游用 network_errors >= len(queries) 判断网络故障; 只要任一源能通就不算网络全败。
        "network_errors": net_errs if (pm_total_fail and ep_total_fail) else 0,
        "queries_tried": list(queries),
    }
