"""检索过滤器翻译 + TTL 缓存 单测（不联网）。

用法: python test_searchfilters.py
"""
from app import searchfilters as sf
from app import searchcache


_QUAL_OFF = {"min_quartile": None, "min_impact": None, "keep_unknown": True}


def test_normalize():
    assert sf.normalize(None) == {"year_from": None, "study_types": [], **_QUAL_OFF}
    assert sf.normalize({"year_from": "2019", "study_types": ["rct", "bogus"]}) == {
        "year_from": 2019,
        "study_types": ["rct"],
        **_QUAL_OFF,
    }
    assert sf.normalize({"year_from": "1700"})["year_from"] is None  # 越界
    assert sf.normalize({"study_types": "meta,review"})["study_types"] == ["meta", "review"]
    # 质量预筛字段
    f = sf.normalize({"min_quartile": "2", "min_impact": "5", "keep_unknown": False})
    assert f["min_quartile"] == 2 and f["min_impact"] == 5.0 and f["keep_unknown"] is False
    assert sf.normalize({"min_quartile": "9"})["min_quartile"] is None  # 越界
    assert sf.normalize({"min_impact": "-1"})["min_impact"] is None  # 非正
    print("ok: normalize")


def test_quality_filter():
    pool = (
        [{"journal_quartile": "Q1", "journal_impact": 10.0} for _ in range(10)]
        + [{"journal_quartile": "Q4", "journal_impact": 1.0} for _ in range(5)]
        + [{"journal_quartile": None, "journal_impact": None} for _ in range(5)]
    )
    # 未启用 → 原样
    kept, dropped, relaxed = sf.apply_quality_filter(pool, sf.normalize(None))
    assert len(kept) == 20 and dropped == 0 and relaxed is False
    # Q1–Q2 保留未知 → 剔除 5 篇 Q4, 留 15(10 Q1 + 5 未知)
    kept, dropped, relaxed = sf.apply_quality_filter(pool, sf.normalize({"min_quartile": 2}))
    assert len(kept) == 15 and dropped == 5 and relaxed is False
    # Q1–Q2 去未知 → 留 10 篇 Q1
    kept, dropped, relaxed = sf.apply_quality_filter(pool, sf.normalize({"min_quartile": 2, "keep_unknown": False}))
    assert len(kept) == 10 and dropped == 10
    # 通过的太少(<8) → 放宽保留全部
    few = [{"journal_quartile": "Q1", "journal_impact": 9.0}] * 3 + [{"journal_quartile": "Q4", "journal_impact": 1.0}] * 10
    kept, dropped, relaxed = sf.apply_quality_filter(few, sf.normalize({"min_quartile": 1, "keep_unknown": False}))
    assert relaxed is True and len(kept) == 13 and dropped == 0
    print("ok: quality_filter")


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
    assert sf.label(sf.normalize({"min_quartile": 2, "min_impact": 5})) == "Q1–Q2、影响力≥5"
    assert sf.label(sf.normalize({"min_quartile": 1})) == "仅 Q1"
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
    test_quality_filter()
    test_pubmed_suffix()
    test_epmc_suffix()
    test_openalex_params()
    test_label()
    test_cache()
    print("\nALL SEARCHFILTERS/CACHE TESTS PASSED")
