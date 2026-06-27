"""ClinicalTrials 归一化 + sources 解析 + 论文源过滤 单测（不联网）。

用法: python test_clinicaltrials.py
"""
import asyncio

from app.clinicaltrials import _normalize
from app.research import _parse_sources, _src_label
import app.literature as lit


def test_ct_normalize():
    study = {
        "protocolSection": {
            "identificationModule": {"nctId": "NCT01234567", "briefTitle": "A Trial of X"},
            "statusModule": {"overallStatus": "RECRUITING", "startDateStruct": {"date": "2025-03-01"}},
            "designModule": {"phases": ["PHASE3"]},
            "conditionsModule": {"conditions": ["Breast Cancer", "TNBC"]},
            "descriptionModule": {"briefSummary": "x" * 1000},
        }
    }
    t = _normalize(study)
    assert t["nct_id"] == "NCT01234567"
    assert t["title"] == "A Trial of X"
    assert t["status"] == "RECRUITING"
    assert t["phase"] == "Phase 3"
    assert t["conditions"] == "Breast Cancer, TNBC"
    assert t["year"] == "2025"
    assert len(t["summary"]) == 600  # 截断
    assert t["url"] == "https://clinicaltrials.gov/study/NCT01234567"
    assert _normalize({"protocolSection": {}}) is None  # 无 nct/title
    print("ok: clinicaltrials _normalize")


def test_parse_sources():
    assert _parse_sources(None) == ["pubmed", "europepmc", "openalex", "clinicaltrials"]
    assert _parse_sources(["pubmed", "openalex"]) == ["pubmed", "openalex"]
    assert _parse_sources("pubmed,clinicaltrials") == ["pubmed", "clinicaltrials"]
    assert _parse_sources(["bogus"]) == ["pubmed", "europepmc", "openalex", "clinicaltrials"]  # 非法→全开
    assert _parse_sources([]) == ["pubmed", "europepmc", "openalex", "clinicaltrials"]
    print("ok: _parse_sources")


def test_src_label():
    assert _src_label(["pubmed", "openalex"]) == "PubMed / OpenAlex"
    assert _src_label(["clinicaltrials"]) == "PubMed"  # 无论文源时兜底
    print("ok: _src_label")


def test_literature_respects_sources():
    """sources 只含 openalex 时, 只应调用 OpenAlex 一个 runner。"""
    calls = []

    async def fake_pm(q, s, c, f=None):
        calls.append("pubmed")
        return {"papers": [], "network_errors": 0}

    async def fake_ep(q, s, c, f=None):
        calls.append("europepmc")
        return {"papers": [], "network_errors": 0}

    async def fake_oa(q, s, c, f=None):
        calls.append("openalex")
        return {"papers": [{"pmid": "1", "doi": "", "title": "T", "abstract": "",
                            "url": "u", "source": "openalex", "year": "2024", "cited_by_count": 3}],
                "network_errors": 0}

    orig = (lit._search_pubmed, lit.search_epmc, lit.search_openalex)
    lit._search_pubmed, lit.search_epmc, lit.search_openalex = fake_pm, fake_ep, fake_oa
    try:
        res = asyncio.run(lit.search_literature(["q"], per_query=5, cap=10, sources=["openalex"]))
    finally:
        lit._search_pubmed, lit.search_epmc, lit.search_openalex = orig
    assert calls == ["openalex"], calls
    assert len(res["papers"]) == 1 and res["papers"][0]["source"] == "openalex"
    print("ok: search_literature respects sources")


if __name__ == "__main__":
    test_ct_normalize()
    test_parse_sources()
    test_src_label()
    test_literature_respects_sources()
    print("\nALL CLINICALTRIALS/SOURCES TESTS PASSED")
