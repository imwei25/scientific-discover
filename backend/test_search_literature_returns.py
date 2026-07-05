"""回归测试：search_literature 在 fresh-fetch 路径上必须 return dict，
不能因缺失 return 语句而返回 None（曾导致 _facet_grouped_search 抛
AttributeError: 'NoneType' object has no attribute 'get'）。"""
from __future__ import annotations

import asyncio

from app import literature


def test_search_literature_returns_dict_on_fresh_cache():
    """缓存冷的情况下也要返回结构化 dict，不能 fall-off 返回 None。"""

    async def fake_pubmed(queries, share, cap, f):
        return {"papers": [], "network_errors": 0, "queries_tried": list(queries)}

    orig = literature._search_pubmed
    literature._search_pubmed = fake_pubmed
    try:
        # 用未用过的独特 query 避免命中已缓存条目
        result = asyncio.run(
            literature.search_literature(
                ["__unittest_search_literature_returns_query_1__"],
                sources=["pubmed"],
            )
        )
    finally:
        literature._search_pubmed = orig

    assert result is not None, "缺失 return out 导致 fresh-fetch 路径返回 None"
    assert isinstance(result, dict)
    assert "papers" in result
    assert "network_errors" in result
    assert "queries_tried" in result


def test_search_literature_returns_dict_on_all_sources_failing():
    """所有源都异常时也要返回 dict，携带 network_errors 计数。"""

    async def failing_pubmed(queries, share, cap, f):
        raise RuntimeError("simulated network fail")

    orig = literature._search_pubmed
    literature._search_pubmed = failing_pubmed
    try:
        result = asyncio.run(
            literature.search_literature(
                ["__unittest_search_literature_returns_query_2__"],
                sources=["pubmed"],
            )
        )
    finally:
        literature._search_pubmed = orig

    assert result is not None, "全源失败路径也不能返回 None"
    assert isinstance(result, dict)
    assert result.get("network_errors", 0) >= 1


if __name__ == "__main__":
    test_search_literature_returns_dict_on_fresh_cache()
    test_search_literature_returns_dict_on_all_sources_failing()
    print("ALL SEARCH_LITERATURE RETURN TESTS PASSED")
