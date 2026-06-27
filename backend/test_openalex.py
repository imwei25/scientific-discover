"""OpenAlex 归一化 + 倒排索引摘要重建 + 多源合并/排序选篇 单测（不联网）。

用法: python test_openalex.py
"""
from app.openalex import _normalize, _rebuild_abstract
from app.literature import _merge_all, _rank_papers


def test_rebuild_abstract():
    inv = {"Hello": [0, 3], "world": [1], "again": [2]}
    assert _rebuild_abstract(inv) == "Hello world again Hello"
    assert _rebuild_abstract(None) == ""
    assert _rebuild_abstract({}) == ""
    print("ok: _rebuild_abstract")


def test_normalize_with_pmid():
    raw = {
        "id": "https://openalex.org/W123",
        "doi": "https://doi.org/10.1000/ABC",
        "ids": {"pmid": "https://pubmed.ncbi.nlm.nih.gov/99887766"},
        "title": "A Trial",
        "publication_year": 2022,
        "authorships": [{"author": {"display_name": "Zhang San"}}],
        "primary_location": {"source": {"display_name": "Nature"}},
        "cited_by_count": 42,
        "abstract_inverted_index": {"Background": [0], "study": [1]},
    }
    p = _normalize(raw)
    assert p["pmid"] == "99887766"
    assert p["doi"] == "10.1000/abc"  # 去前缀 + 小写
    assert p["url"] == "https://pubmed.ncbi.nlm.nih.gov/99887766/"
    assert p["source"] == "openalex"
    assert p["cited_by_count"] == 42
    assert p["abstract"] == "Background study"
    assert p["first_author"] == "Zhang San"
    print("ok: _normalize (pmid -> pubmed url)")


def test_normalize_without_pmid():
    raw = {
        "id": "https://openalex.org/W999",
        "title": "Preprintish",
        "publication_year": 2025,
        "authorships": [],
        "cited_by_count": 0,
    }
    p = _normalize(raw)
    assert p["pmid"] == ""
    assert p["url"] == "https://openalex.org/W999"
    assert p["abstract"] == ""
    assert _normalize({"title": ""}) is None
    print("ok: _normalize (no pmid -> openalex url)")


def test_merge_takes_max_citation_and_prefers_pubmed():
    pubmed = [{"pmid": "1", "doi": "10.1/x", "title": "Shared paper", "abstract": "",
               "url": "https://pubmed.ncbi.nlm.nih.gov/1/", "source": "pubmed", "year": "2023"}]
    openalex = [{"pmid": "1", "doi": "10.1/x", "title": "Shared paper",
                 "abstract": "rich abstract", "url": "https://openalex.org/W1",
                 "source": "openalex", "year": "2023", "cited_by_count": 500}]
    merged = _merge_all([pubmed, openalex], cap=10)
    assert len(merged) == 1  # 去重
    m = merged[0]
    assert m["source"] == "pubmed"  # PubMed 版本优先(链接更权威)
    assert m["url"].startswith("https://pubmed")
    assert m["cited_by_count"] == 500  # 被引取 max
    assert m["abstract"] == "rich abstract"  # 缺摘要用 OpenAlex 补
    print("ok: _merge_all (dedup + max citation + pubmed-preferred + abstract fill)")


def test_rank_prefers_relevant_then_cited():
    # 同位置时, 被引高者靠前; _pos 小(更相关)优先级最高。
    a = {"_pos": 0, "cited_by_count": 0, "year": "2024"}
    b = {"_pos": 5, "cited_by_count": 1000, "year": "2024"}
    ranked = _rank_papers([b, a])
    assert ranked[0] is a  # 相关性权重(0.5) > 被引(0.3)
    c = {"_pos": 0, "cited_by_count": 0, "year": "2024"}
    d = {"_pos": 0, "cited_by_count": 1000, "year": "2024"}
    ranked2 = _rank_papers([c, d])
    assert ranked2[0] is d  # 同相关性时被引高者胜
    print("ok: _rank_papers (relevance primary, citation secondary)")


if __name__ == "__main__":
    test_rebuild_abstract()
    test_normalize_with_pmid()
    test_normalize_without_pmid()
    test_merge_takes_max_citation_and_prefers_pubmed()
    test_rank_prefers_relevant_then_cited()
    print("\nALL OPENALEX TESTS PASSED")
