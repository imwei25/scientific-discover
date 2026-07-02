import asyncio

from app.grant import extract_style_profile


def test_extract_style_empty_returns_empty():
    # 空/纯空白样例: 不调 LLM, 直接返回空档案(降级)
    assert asyncio.run(extract_style_profile("   \n  ")) == ""
