"""crossref.fetch_by_doi 单测：DOI 反查得到结构化 authors，
用于补齐非 PubMed 期刊（Dermatology Online Journal / OUP suppl / Med Alphabet 等）。"""
from __future__ import annotations

from app.crossref import _parse_work_message


# 真实 CrossRef /works/{doi} 返回结构精简版
_HOANG = {
    "DOI": "10.25251/8dsre395",
    "title": ["Medicaid coverage of Janus kinase inhibitors for alopecia areata treatment"],
    "container-title": ["Dermatology Online Journal"],
    "author": [
        {"family": "Hoang", "given": "Megan"},
        {"family": "Doe", "given": "Jane A"},
    ],
    "issued": {"date-parts": [[2026]]},
}


def test_parse_work_message_extracts_structured_authors():
    out = _parse_work_message(_HOANG)
    assert out is not None
    assert out["doi"] == "10.25251/8dsre395"
    assert out["title"] == "Medicaid coverage of Janus kinase inhibitors for alopecia areata treatment"
    assert out["journal"] == "Dermatology Online Journal"
    assert out["year"] == "2026"
    # 关键：authors 是 [{family, given}] 结构，不是缩写字符串——防止 "H. M" 之类颠倒
    assert out["authors"] == [
        {"family": "Hoang", "given": "Megan"},
        {"family": "Doe", "given": "Jane A"},
    ]


def test_parse_work_message_handles_missing_optional_fields():
    """CrossRef 返回缺 author/container-title 时不崩，返回值兼容 enrich 消费。"""
    minimal = {"DOI": "10.1/x", "title": ["T"]}
    out = _parse_work_message(minimal)
    assert out["title"] == "T"
    assert out["authors"] == []
    assert out["journal"] == ""


def test_parse_work_message_returns_none_when_no_title():
    """无 title 视为无效条目，返回 None 让 enrich 跳过。"""
    assert _parse_work_message({"DOI": "10.1/x"}) is None
    assert _parse_work_message({}) is None


if __name__ == "__main__":
    test_parse_work_message_extracts_structured_authors()
    test_parse_work_message_handles_missing_optional_fields()
    test_parse_work_message_returns_none_when_no_title()
    print("ALL CROSSREF FETCH TESTS PASSED")
