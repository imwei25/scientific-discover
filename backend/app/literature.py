"""PubMed 文献检索客户端(NCBI E-utilities)。

用于医学/药学/生物领域的“找选题”: 实际检索真实文献, 供 LLM 梳理现状与空白,
并生成可点击的 PubMed 链接。E-utilities 免费, 无需 key(限速 3 次/秒)。
"""
from __future__ import annotations

import asyncio
import datetime
import math
import re
import time
import xml.etree.ElementTree as ET

import httpx

from .config import settings
from .europepmc import search_epmc
from .openalex import search_openalex

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


def _rank_papers(papers: list[dict]) -> list[dict]:
    """对合并后的候选池排序选篇: 相关性(0.5) + 被引热度(0.3) + 新近(0.2) 加权。

    - 相关性: 用各源返回顺序里的最佳位置 _pos（越靠前越相关）。
    - 被引: log1p(cited_by_count) 归一（仅 OpenAlex 提供, 其它源 0）。
    - 新近: 近 15 年内线性加权, 越新越高（找选题/找空白对新工作更敏感）。
    被引数只作"热度信号"参与排序, 不当精确学术指标对外展示。
    """
    cur_year = datetime.date.today().year

    def score(p: dict) -> float:
        rel = 1.0 / (1.0 + p.get("_pos", 999))
        cited = p.get("cited_by_count", 0) or 0
        cite = min(1.0, math.log1p(cited) / math.log1p(1000))
        try:
            yr = int(p.get("year", "") or 0)
        except (ValueError, TypeError):
            yr = 0
        recency = 0.0
        if yr:
            recency = max(0.0, min(1.0, (yr - (cur_year - 15)) / 15.0))
        return 0.5 * rel + 0.3 * cite + 0.2 * recency

    return sorted(papers, key=score, reverse=True)


def _merge_all(source_lists: list[list[dict]], cap: int) -> list[dict]:
    """合并多源候选(pmid/doi/title 三键去重), 再排序选篇取前 cap。

    source_lists 顺序即"保留优先级": 第一个里先出现的版本胜出(PubMed 在前→链接走 PubMed)。
    合并时: 被引数取 max、缺失摘要用其它源补、缺 pmid/doi 也互补。
    """
    merged: dict[str, dict] = {}
    for papers in source_lists:
        for pos, p in enumerate(papers):
            key = p.get("doi") or p.get("pmid") or _title_key(p.get("title", ""))
            if not key:
                continue
            if key not in merged:
                q = dict(p)
                q["_pos"] = pos
                q.setdefault("cited_by_count", 0)
                merged[key] = q
            else:
                cur = merged[key]
                cur["_pos"] = min(cur["_pos"], pos)
                cur["cited_by_count"] = max(
                    cur.get("cited_by_count", 0) or 0, p.get("cited_by_count", 0) or 0
                )
                if not cur.get("abstract") and p.get("abstract"):
                    cur["abstract"] = p["abstract"]
                if not cur.get("pmid") and p.get("pmid"):
                    cur["pmid"] = p["pmid"]
                    cur["url"] = p["url"]
                    cur["source"] = p["source"]
                if not cur.get("doi") and p.get("doi"):
                    cur["doi"] = p["doi"]
    ranked = _rank_papers(list(merged.values()))
    for p in ranked:
        p.pop("_pos", None)
    return ranked[:cap]


_PAPER_SOURCES = ("pubmed", "europepmc", "openalex")


async def search_literature(
    queries: list[str], per_query: int = 6, cap: int = 18, sources: list[str] | None = None
) -> dict:
    """并发检索所选论文源(PubMed/Europe PMC/OpenAlex), 合并去重 + 排序选篇。

    返回 {"papers", "network_errors", "queries_tried"}。
    - sources: 要启用的论文源子集; None 或空 → 三源全开。ClinicalTrials 不在此(走旁路)。
    - 各源各自召回至多 cap 篇 → 合并去重得到更大候选池 → 按 相关性+被引+新近 排序 → 取前 cap。
    - network_errors 仅在所选源全部失败时为非零(用于区分『检索式太窄』和『全网连不上』)。
    每篇 paper 带 source: "pubmed" / "preprint" / "europepmc" / "openalex"; OpenAlex 额外带 cited_by_count。
    """
    enabled = [s for s in _PAPER_SOURCES if (not sources or s in sources)]
    if not enabled:  # 防御: 一个论文源都没选 → 退回全开, 否则综述无文献可依
        enabled = list(_PAPER_SOURCES)
    share = max(2, per_query)
    runners = {
        "pubmed": lambda: _search_pubmed(queries, share, cap),
        "europepmc": lambda: search_epmc(queries, share, cap),
        "openalex": lambda: search_openalex(queries, share, cap),
    }
    results = await asyncio.gather(
        *(runners[s]() for s in enabled), return_exceptions=True
    )
    # 保持 PubMed→EuropePMC→OpenAlex 的合并优先级顺序
    by_source: dict[str, dict] = {}
    for s, res in zip(enabled, results):
        by_source[s] = {"papers": [], "network_errors": max(1, len(queries))} if isinstance(res, Exception) else res
    ordered = [by_source[s] for s in _PAPER_SOURCES if s in by_source]
    merged = _merge_all([r["papers"] for r in ordered], cap)
    all_fail = all(r["network_errors"] >= max(1, len(queries)) for r in ordered)
    net_errs = sum(r["network_errors"] for r in ordered)
    return {
        "papers": merged,
        # 上游用 network_errors >= len(queries) 判断网络故障; 只要任一源能通就不算网络全败。
        "network_errors": net_errs if all_fail else 0,
        "queries_tried": list(queries),
    }
