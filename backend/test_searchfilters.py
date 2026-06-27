"""检索过滤器翻译 + TTL 缓存 单测（不联网）。

用法: python test_searchfilters.py
"""
from app import searchfilters as sf
from app import searchcache


def test_normalize():
    assert sf.normalize(None) == {"year_from": None, "study_types": []}
    assert sf.normalize({"year_from": "2019", "study_types": ["rct", "bogus"]}) == {
        "year_from": 2019,
        "study_types": ["rct"],
    }
    assert sf.normalize({"year_from": "1700"})["year_from"] is None  # 越界
    assert sf.normalize({"study_types": "meta,review"})["study_types"] == ["meta", "review"]
    print("ok: normalize")


def test_pubmed_suffix():
    f = sf.normalize({"year_from": 2020, "study_types": ["rct", "meta"]})
    s = sf.pubmed_suffix(f)
    assert '"2020"[pdat]' in s
    assert "Randomized Controlled Trial[pt]" in s
    assert "Meta-Analysis[pt]" in s
    assert s.startswith(" AND ")
    assert sf.pubmed_suffix(sf.normalize(None)) == ""
    print("ok: pubmed_suffix")


def test_epmc_suffix():
    f = sf.normalize({"year_from": 2021, "study_types": ["systematic"]})
    s = sf.epmc_suffix(f)
    assert "FIRST_PDATE:[2021-01-01 TO 2100-12-31]" in s
    assert 'PUB_TYPE:"Systematic Review"' in s
    print("ok: epmc_suffix")


def test_openalex_params():
    assert sf.openalex_params(sf.normalize({"year_from": 2018}))["filter_extra"] == "from_publication_date:2018-01-01"
    # 只选 review/systematic → 加 type:review; 含 rct 则不加(无法精确表达)
    assert "type:review" in sf.openalex_params(sf.normalize({"study_types": ["review"]}))["filter_extra"]
    assert "type:review" not in sf.openalex_params(sf.normalize({"study_types": ["rct"]}))["filter_extra"]
    print("ok: openalex_params")


def test_label():
    assert sf.label(sf.normalize({"year_from": 2020, "study_types": ["rct"]})) == "2020 年至今、随机对照试验"
    assert sf.label(sf.normalize(None)) == ""
    print("ok: label")


def test_cache():
    searchcache.clear()
    assert searchcache.get(("k",)) is None
    searchcache.put(("k",), {"v": 1})
    assert searchcache.get(("k",)) == {"v": 1}
    searchcache.clear()
    assert searchcache.get(("k",)) is None
    print("ok: cache get/put/clear")


if __name__ == "__main__":
    test_normalize()
    test_pubmed_suffix()
    test_epmc_suffix()
    test_openalex_params()
    test_label()
    test_cache()
    print("\nALL SEARCHFILTERS/CACHE TESTS PASSED")
