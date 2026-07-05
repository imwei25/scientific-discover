"""引用元数据补齐（PubMed 反查）单测。

选题导出的 BibTeX 通常只带 url+year(+title)，此模块在 refs_export 之前
基于 PubMed URL 反查补齐 title/authors/journal/doi，避免下游 LLM 猜测。
"""
from __future__ import annotations

import asyncio

from app.refsenrich import _extract_pmid, enrich_refs


def _run(coro):
    return asyncio.run(coro)


def test_extract_pmid_from_url_forms():
    assert _extract_pmid("https://pubmed.ncbi.nlm.nih.gov/38473791/") == "38473791"
    assert _extract_pmid("https://pubmed.ncbi.nlm.nih.gov/38473791") == "38473791"
    assert _extract_pmid("http://pubmed.ncbi.nlm.nih.gov/12345/?extra=1") == "12345"
    assert _extract_pmid("https://doi.org/10.1234/x") is None
    assert _extract_pmid("") is None
    assert _extract_pmid(None) is None


def test_enrich_fills_missing_fields():
    ref = {
        "url": "https://pubmed.ncbi.nlm.nih.gov/38473791/",
        "year": "2024",
        "title": "",
        "authors": [],
        "journal": "",
        "doi": None,
    }

    async def fake_fetch(pmids):
        assert pmids == ["38473791"]
        return [{
            "pmid": "38473791",
            "title": "The Biology and Genomics of Human Hair Follicles",
            "authors": [
                {"family": "Cuevas-Diaz Duran", "given": "R"},
                {"family": "Martinez-Ledesma", "given": "E"},
            ],
            "journal": "International Journal of Molecular Sciences",
            "doi": "10.3390/ijms25052542",
            "year": "2024",
        }]

    result = _run(enrich_refs([ref], fetch_pubmed=fake_fetch))
    r = result[0]
    assert r["title"] == "The Biology and Genomics of Human Hair Follicles"
    assert r["journal"] == "International Journal of Molecular Sciences"
    assert r["doi"] == "10.3390/ijms25052542"
    assert r["authors"] == ["Cuevas-Diaz Duran, R", "Martinez-Ledesma, E"]


def test_enrich_preserves_multipart_family_name():
    ref = {
        "url": "https://pubmed.ncbi.nlm.nih.gov/38891839/",
        "authors": [], "journal": "", "title": "", "doi": None,
    }

    async def fake_fetch(pmids):
        return [{
            "pmid": "38891839",
            "title": "Deciphering the Complex Immunopathogenesis of Alopecia Areata",
            "authors": [{"family": "Šutić Udović", "given": "Ivana"}],
            "journal": "International Journal of Molecular Sciences",
            "doi": "10.3390/ijms25115652",
        }]

    result = _run(enrich_refs([ref], fetch_pubmed=fake_fetch))
    assert result[0]["authors"] == ["Šutić Udović, Ivana"]


def test_enrich_does_not_overwrite_existing_fields():
    ref = {
        "url": "https://pubmed.ncbi.nlm.nih.gov/12345/",
        "title": "User's own title",
        "authors": ["Custom, Author"],
        "journal": "Custom Journal",
        "doi": "10.9/existing",
    }

    async def fake_fetch(pmids):
        return [{
            "pmid": "12345", "title": "PubMed Title",
            "authors": [{"family": "X", "given": "Y"}],
            "journal": "PubMed J", "doi": "10.1/pub",
        }]

    result = _run(enrich_refs([ref], fetch_pubmed=fake_fetch))
    r = result[0]
    assert r["title"] == "User's own title"
    assert r["authors"] == ["Custom, Author"]
    assert r["journal"] == "Custom Journal"
    assert r["doi"] == "10.9/existing"


def test_enrich_ignores_non_pubmed_urls():
    ref = {"url": "https://doi.org/10.1/x", "title": "",
           "authors": [], "journal": "", "doi": None}

    async def fake_fetch(pmids):
        raise AssertionError("should not be called when no PubMed URLs present")

    result = _run(enrich_refs([ref], fetch_pubmed=fake_fetch))
    assert result[0]["title"] == ""


def test_enrich_batches_multiple_pmids_into_one_call():
    refs = [
        {"url": "https://pubmed.ncbi.nlm.nih.gov/111/",
         "title": "", "authors": [], "journal": "", "doi": None},
        {"url": "https://pubmed.ncbi.nlm.nih.gov/222/",
         "title": "", "authors": [], "journal": "", "doi": None},
    ]
    call_count = 0

    async def fake_fetch(pmids):
        nonlocal call_count
        call_count += 1
        assert set(pmids) == {"111", "222"}
        return [
            {"pmid": "111", "title": "T1", "authors": [], "journal": "J1", "doi": "d1"},
            {"pmid": "222", "title": "T2", "authors": [], "journal": "J2", "doi": "d2"},
        ]

    result = _run(enrich_refs(refs, fetch_pubmed=fake_fetch))
    assert call_count == 1
    assert result[0]["title"] == "T1"
    assert result[1]["title"] == "T2"


def test_enrich_handles_empty_list():
    result = _run(enrich_refs([], fetch_pubmed=None))
    assert result == []


def test_enrich_survives_fetch_failure():
    """PubMed unreachable → return refs unchanged, no exception raised."""
    ref = {"url": "https://pubmed.ncbi.nlm.nih.gov/1/",
           "title": "", "authors": [], "journal": "", "doi": None}

    async def fake_fetch(pmids):
        raise RuntimeError("network down")

    result = _run(enrich_refs([ref], fetch_pubmed=fake_fetch))
    assert result[0]["title"] == ""  # unchanged, no crash


if __name__ == "__main__":
    test_extract_pmid_from_url_forms()
    test_enrich_fills_missing_fields()
    test_enrich_preserves_multipart_family_name()
    test_enrich_does_not_overwrite_existing_fields()
    test_enrich_ignores_non_pubmed_urls()
    test_enrich_batches_multiple_pmids_into_one_call()
    test_enrich_handles_empty_list()
    test_enrich_survives_fetch_failure()
    print("ALL REFSENRICH TESTS PASSED")
