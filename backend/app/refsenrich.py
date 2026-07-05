"""引用元数据补齐：选题模块导出的 BibTeX 通常只带 url+year(+title)，
本模块在序列化前基于 PubMed URL / DOI 反查填补 authors/journal/doi/title，
避免下游 LLM 猜测导致的：期刊截断、复姓被误缩、DOI 张冠李戴、姓氏颠倒。

流程：
  1. PubMed URL 批量 EFetch（医学期刊主力源，最准确）
  2. 仍缺 authors/journal 但有 DOI → CrossRef /works/{doi} 兜底
     （覆盖非 PubMed 期刊：Dermatology Online Journal / OUP suppl / Med Alphabet 等）

只补空字段，绝不覆盖用户已填的数据。网络失败静默降级。
"""
from __future__ import annotations

import asyncio
import re
from typing import Awaitable, Callable

import httpx

from . import crossref as _crossref
from . import literature


_PMID_RE = re.compile(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d+)", re.IGNORECASE)


def _extract_pmid(url: str | None) -> str | None:
    if not url:
        return None
    m = _PMID_RE.search(str(url))
    return m.group(1) if m else None


def _fmt_author(a: dict) -> str:
    family = str(a.get("family") or "").strip()
    given = str(a.get("given") or "").strip()
    if family and given:
        return f"{family}, {given}"
    return family or given


def _is_empty(v) -> bool:
    if v is None:
        return True
    if isinstance(v, str):
        return not v.strip()
    if isinstance(v, list):
        return len(v) == 0
    return False


async def _default_pubmed_fetch(pmids: list[str]) -> list[dict]:
    if not pmids:
        return []
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        return await literature.efetch_full(client, pmids)


async def _default_crossref_fetch(doi: str) -> dict | None:
    if not doi:
        return None
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        return await _crossref.fetch_by_doi(client, doi)


def _apply(ref: dict, src: dict) -> None:
    """把 src 中的字段补到 ref 空处。src 形如 {title, authors: [{family,given}], journal, doi, year}。"""
    authors_fmt = [_fmt_author(a) for a in (src.get("authors") or []) if _fmt_author(a)]
    if _is_empty(ref.get("title")) and src.get("title"):
        ref["title"] = src["title"]
    if _is_empty(ref.get("authors")) and authors_fmt:
        ref["authors"] = authors_fmt
    if _is_empty(ref.get("journal")) and src.get("journal"):
        ref["journal"] = src["journal"]
    if _is_empty(ref.get("doi")) and src.get("doi"):
        ref["doi"] = src["doi"]
    if _is_empty(ref.get("year")) and src.get("year"):
        ref["year"] = src["year"]
    # CSL type：传给前端 refToCsl，让 _detect_non_academic 识别非学术来源
    if _is_empty(ref.get("type")) and src.get("type"):
        ref["type"] = src["type"]


def _still_missing_core(ref: dict) -> bool:
    return _is_empty(ref.get("authors")) or _is_empty(ref.get("journal"))


async def enrich_refs(
    refs: list[dict],
    fetch_pubmed: Callable[[list[str]], Awaitable[list[dict]]] | None = None,
    fetch_crossref: Callable[[str], Awaitable[dict | None]] | None = None,
) -> list[dict]:
    """对含 PubMed URL 或 DOI 且部分字段缺失的 refs 批量补齐。原地修改并返回同一 list。

    fetch_pubmed / fetch_crossref 允许注入以便测试。
    """
    if not refs:
        return refs

    fetch_pm = fetch_pubmed if fetch_pubmed is not None else _default_pubmed_fetch
    fetch_cr = fetch_crossref if fetch_crossref is not None else _default_crossref_fetch

    # ---- Step 1: PubMed 批量 ----
    pmid_to_refs: dict[str, list[dict]] = {}
    for r in refs:
        pmid = _extract_pmid(r.get("url"))
        if not pmid:
            continue
        if (_is_empty(r.get("title")) or _is_empty(r.get("authors"))
                or _is_empty(r.get("journal")) or _is_empty(r.get("doi"))):
            pmid_to_refs.setdefault(pmid, []).append(r)

    if pmid_to_refs:
        try:
            fetched = await fetch_pm(list(pmid_to_refs.keys()))
        except Exception:  # noqa: BLE001
            fetched = []
        by_pmid = {str(f.get("pmid") or ""): f for f in fetched if f.get("pmid")}
        for pmid, ref_list in pmid_to_refs.items():
            src = by_pmid.get(pmid)
            if not src:
                continue
            for r in ref_list:
                _apply(r, src)

    # ---- Step 2: CrossRef 兜底（有 DOI 但仍缺 authors/journal 的 refs）----
    # 并行 fetch：用 Semaphore(4) 限流，避免打爆 CrossRef；用 (idx, result) 保序回填。
    cr_tasks: list[tuple[int, str]] = []
    for idx, r in enumerate(refs):
        doi = r.get("doi")
        if not doi or not _still_missing_core(r):
            continue
        cr_tasks.append((idx, str(doi).strip().lower()))

    if cr_tasks:
        sem = asyncio.Semaphore(4)

        async def _one(doi: str) -> dict | None:
            async with sem:
                try:
                    return await fetch_cr(doi)
                except Exception:  # noqa: BLE001
                    return None

        results = await asyncio.gather(*(_one(doi) for _, doi in cr_tasks))
        for (idx, _doi), src in zip(cr_tasks, results):
            if src:
                _apply(refs[idx], src)

    return refs
