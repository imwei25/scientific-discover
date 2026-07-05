"""确保 CSL type 从 OpenAlex / CrossRef 一路传到 Reference dict，
使前端 refToCsl 能设置正确的 CSL 'type'，从而让 _detect_non_academic
在格式化阶段识别会议摘要/预印本等非期刊来源（如 [72] BJD Suppl）。"""
from __future__ import annotations

import asyncio

from app.crossref import _parse_work_message, _normalize as crossref_normalize
from app.openalex import _normalize as openalex_normalize
from app.refsenrich import enrich_refs


def test_crossref_parse_work_message_returns_type():
    msg = {
        "DOI": "10.1093/bjd/ljaf085.235",
        "title": ["BH14 Irish dermatologists..."],
        "type": "proceedings-article",
        "container-title": ["British Journal of Dermatology"],
        "author": [{"family": "Grechin", "given": "Cristina"}],
        "issued": {"date-parts": [[2025]]},
    }
    out = _parse_work_message(msg)
    assert out["type"] == "proceedings-article"


def test_crossref_search_normalize_returns_type():
    raw = {
        "DOI": "10.1/x", "title": ["T"], "type": "posted-content",
        "container-title": ["biorxiv"], "URL": "https://biorxiv.org/x",
    }
    out = crossref_normalize(raw)
    assert out["type"] == "posted-content"


def test_openalex_normalize_returns_type():
    raw = {
        "id": "https://openalex.org/W1", "title": "T",
        "type": "posted-content",
        "publication_year": 2024, "authorships": [],
    }
    out = openalex_normalize(raw)
    assert out["type"] == "posted-content"


def test_refsenrich_apply_copies_type_when_empty():
    ref = {"doi": "10.1/x", "url": "", "type": "",
           "title": "", "authors": [], "journal": ""}

    async def fake_crossref(doi):
        return {"doi": "10.1/x", "title": "T",
                "authors": [{"family": "X", "given": "Y"}],
                "journal": "J", "type": "proceedings-article"}

    out = asyncio.run(enrich_refs([ref], fetch_pubmed=None, fetch_crossref=fake_crossref))
    assert out[0]["type"] == "proceedings-article"


def test_refsenrich_apply_does_not_overwrite_existing_type():
    ref = {"doi": "10.1/x", "url": "", "type": "article-journal",
           "title": "", "authors": [], "journal": ""}

    async def fake_crossref(doi):
        return {"doi": "10.1/x", "title": "T",
                "authors": [{"family": "X", "given": "Y"}],
                "journal": "J", "type": "proceedings-article"}

    out = asyncio.run(enrich_refs([ref], fetch_pubmed=None, fetch_crossref=fake_crossref))
    assert out[0]["type"] == "article-journal"  # 用户/上游的更"权威"


if __name__ == "__main__":
    test_crossref_parse_work_message_returns_type()
    test_crossref_search_normalize_returns_type()
    test_openalex_normalize_returns_type()
    test_refsenrich_apply_copies_type_when_empty()
    test_refsenrich_apply_does_not_overwrite_existing_type()
    print("ALL TYPE PROPAGATION TESTS PASSED")
