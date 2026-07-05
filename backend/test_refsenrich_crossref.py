"""enrich_refs CrossRef 兜底路径单测：
非 PubMed 的引用（只有 DOI，无 PubMed URL）也要能补齐 authors/journal。"""
from __future__ import annotations

import asyncio

from app.refsenrich import enrich_refs


def _run(coro):
    return asyncio.run(coro)


def test_crossref_fallback_fills_missing_authors_for_doi_only_ref():
    ref = {
        "url": "",  # 无 PubMed URL
        "doi": "10.25251/8dsre395",
        "year": "2026",
        "title": "",
        "authors": [],
        "journal": "",
    }

    async def fake_pubmed(pmids):
        raise AssertionError("no PMID, should not call PubMed")

    async def fake_crossref(doi):
        assert doi == "10.25251/8dsre395"
        return {
            "doi": "10.25251/8dsre395",
            "title": "Medicaid coverage of Janus kinase inhibitors for alopecia areata treatment",
            "authors": [{"family": "Hoang", "given": "Megan"}],
            "journal": "Dermatology Online Journal",
            "year": "2026",
        }

    out = _run(enrich_refs([ref], fetch_pubmed=fake_pubmed, fetch_crossref=fake_crossref))
    r = out[0]
    assert r["title"] == "Medicaid coverage of Janus kinase inhibitors for alopecia areata treatment"
    assert r["journal"] == "Dermatology Online Journal"
    assert r["authors"] == ["Hoang, Megan"]


def test_crossref_fallback_after_pubmed_fills_only_gaps():
    """PubMed 抓到了 title/journal 但缺 authors → CrossRef 只补 authors。"""
    ref = {
        "url": "https://pubmed.ncbi.nlm.nih.gov/999/",
        "doi": "10.1/x",
        "title": "", "authors": [], "journal": "",
    }

    async def fake_pubmed(pmids):
        # PubMed 侧只补上 title/journal（例如某罕见记录 AuthorList 为空）
        return [{"pmid": "999", "title": "T", "authors": [], "journal": "J", "doi": "10.1/x"}]

    called = []
    async def fake_crossref(doi):
        called.append(doi)
        return {"doi": "10.1/x", "title": "T-cr", "authors": [{"family": "X", "given": "Y"}], "journal": "J-cr"}

    out = _run(enrich_refs([ref], fetch_pubmed=fake_pubmed, fetch_crossref=fake_crossref))
    r = out[0]
    # title/journal 已由 PubMed 补齐，CrossRef 只补 authors
    assert r["title"] == "T"
    assert r["journal"] == "J"
    assert r["authors"] == ["X, Y"]
    # CrossRef 被调用了（因为 authors 仍空）
    assert called == ["10.1/x"]


def test_crossref_not_called_when_authors_already_filled_by_pubmed():
    ref = {
        "url": "https://pubmed.ncbi.nlm.nih.gov/1/",
        "doi": "10.1/x",
        "title": "", "authors": [], "journal": "",
    }

    async def fake_pubmed(pmids):
        return [{"pmid": "1", "title": "T", "authors": [{"family": "A", "given": "B"}],
                 "journal": "J", "doi": "10.1/x"}]

    async def fake_crossref(doi):
        raise AssertionError("PubMed already filled everything, CrossRef should not run")

    out = _run(enrich_refs([ref], fetch_pubmed=fake_pubmed, fetch_crossref=fake_crossref))
    assert out[0]["authors"] == ["A, B"]


def test_crossref_survives_fetch_failure():
    ref = {"url": "", "doi": "10.1/x", "title": "", "authors": [], "journal": ""}

    async def fake_crossref(doi):
        raise RuntimeError("crossref down")

    out = _run(enrich_refs([ref], fetch_pubmed=None, fetch_crossref=fake_crossref))
    assert out[0]["authors"] == []  # unchanged, no crash


def test_crossref_skipped_when_no_doi_and_no_pubmed_url():
    ref = {"url": "https://example.com/paper", "doi": None,
           "title": "", "authors": [], "journal": ""}

    async def fake_crossref(doi):
        raise AssertionError("no DOI, must not call CrossRef")

    out = _run(enrich_refs([ref], fetch_pubmed=None, fetch_crossref=fake_crossref))
    assert out[0]["authors"] == []


if __name__ == "__main__":
    test_crossref_fallback_fills_missing_authors_for_doi_only_ref()
    test_crossref_fallback_after_pubmed_fills_only_gaps()
    test_crossref_not_called_when_authors_already_filled_by_pubmed()
    test_crossref_survives_fetch_failure()
    test_crossref_skipped_when_no_doi_and_no_pubmed_url()
    print("ALL REFSENRICH+CROSSREF TESTS PASSED")
