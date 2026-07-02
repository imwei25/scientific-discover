import asyncio

from app.grant import extract_style_profile


def test_extract_style_empty_returns_empty():
    # 空/纯空白样例: 不调 LLM, 直接返回空档案(降级)
    assert asyncio.run(extract_style_profile("   \n  ")) == ""


from app.grant import _section_messages, _revise_messages

_PROFILE = "句式长短交错; 用词平实; 先总后分; 少用套话"


def test_section_messages_injects_style_when_present():
    msgs = _section_messages(
        "一、立项依据", "要点", "约500字", "面上", "侧重",
        "题名", "骨架", "报告", "文献ctx", "背景",
        style_profile=_PROFILE,
    )
    sys = msgs[0]["content"]
    assert "文风指引" in sys and "句式长短交错" in sys


def test_section_messages_no_style_by_default():
    msgs = _section_messages(
        "一、立项依据", "要点", "约500字", "面上", "侧重",
        "题名", "骨架", "报告", "文献ctx", "背景",
    )
    assert "文风指引" not in msgs[0]["content"]


def test_revise_messages_injects_style_when_present():
    msgs = _revise_messages(
        "一、立项依据", "要点", "约500字", "面上", "侧重",
        "题名", "骨架", "报告", "文献ctx", "背景", "现有正文", "改这里",
        style_profile=_PROFILE,
    )
    assert "文风指引" in msgs[0]["content"] and "先总后分" in msgs[0]["content"]
