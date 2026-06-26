"""PubMed 文献检索客户端(NCBI E-utilities)。

用于医学/药学/生物领域的“找选题”: 实际检索真实文献, 供 LLM 梳理现状与空白,
并生成可点击的 PubMed 链接。E-utilities 免费, 无需 key(限速 3 次/秒)。
"""
from __future__ import annotations

import xml.etree.ElementTree as ET

import httpx

from .config import settings

_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
_TOOL = "research-assistant"


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
        if not pmid or not title:
            continue
        papers.append(
            {
                "pmid": pmid,
                "title": title,
                "abstract": abstract,
                "first_author": first_author,
                "journal": journal,
                "year": year,
                "url": pubmed_url(pmid),
            }
        )
    return papers


async def search_literature(queries: list[str], per_query: int = 6, cap: int = 18) -> list[dict]:
    """对多个检索式检索并合并去重, 返回带摘要的论文列表。"""
    seen: set[str] = set()
    collected: list[str] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for q in queries:
            try:
                ids = await esearch(client, q, retmax=per_query)
            except Exception:  # noqa: BLE001
                continue
            for pid in ids:
                if pid not in seen:
                    seen.add(pid)
                    collected.append(pid)
            if len(collected) >= cap:
                break
        collected = collected[:cap]
        try:
            return await efetch(client, collected)
        except Exception:  # noqa: BLE001
            return []
