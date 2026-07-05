"""参考文献格式化时的非学术资源提示逻辑单测。

场景来自真实用户反馈：EMJ Infographic、BJD 会议摘要等被选题模块召入，
用户在期刊排版格式化时需要看到明确警示。"""
from __future__ import annotations

from app.citations import _detect_non_academic


def test_flags_preprint():
    items = [{"id": "ref1", "type": "posted-content",
              "title": "Some preprint", "URL": "https://biorxiv.org/x"}]
    w = _detect_non_academic(items)
    assert len(w) == 1
    assert w[0]["index"] == 1
    assert w[0]["kind"] == "preprint"
    assert "预印本" in w[0]["message"]


def test_flags_conference_abstract():
    items = [{"id": "ref1", "type": "proceedings-article",
              "title": "BH14 Irish dermatologists' experience..."}]
    w = _detect_non_academic(items)
    assert w[0]["kind"] == "conference"
    assert "会议" in w[0]["message"]


def test_flags_infographic_by_url_pattern():
    items = [{"id": "ref1", "type": "article-journal",  # CrossRef 有时误标为 journal-article
              "title": "JAK Inhibitors for Alopecia Areata",
              "URL": "https://www.emjreviews.com/dermatology/infographics/jak-inhibitors-for-alopecia-areata/"}]
    w = _detect_non_academic(items)
    assert w[0]["kind"] == "infographic"
    assert "信息图" in w[0]["message"] or "infographic" in w[0]["message"].lower()


def test_flags_report_dataset_and_other_non_academic_types():
    items = [
        {"id": "ref1", "type": "report", "title": "Report"},
        {"id": "ref2", "type": "dataset", "title": "Dataset"},
        {"id": "ref3", "type": "personal-communication", "title": "PC"},
    ]
    w = _detect_non_academic(items)
    kinds = {x["kind"] for x in w}
    assert "report" in kinds
    assert "dataset" in kinds
    assert "communication" in kinds


def test_does_not_flag_normal_journal_articles():
    items = [
        {"id": "ref1", "type": "article-journal", "title": "T1",
         "URL": "https://doi.org/10.1234/x"},
        {"id": "ref2", "type": "book-chapter", "title": "T2"},
        {"id": "ref3", "type": "book", "title": "T3"},
    ]
    assert _detect_non_academic(items) == []


def test_includes_title_and_index_in_warning():
    items = [
        {"id": "ref1", "type": "article-journal", "title": "Good"},
        {"id": "ref2", "type": "posted-content", "title": "The Preprint Title"},
    ]
    w = _detect_non_academic(items)
    assert len(w) == 1
    assert w[0]["index"] == 2
    assert w[0]["title"] == "The Preprint Title"


def test_missing_type_treated_as_non_standard():
    """LLM 解析或用户手粘时可能 type 缺失/为空，安全起见提示。"""
    items = [{"id": "ref1", "title": "T"}]  # 无 type
    # 无 type + 无 DOI + 无学术 URL → 可疑
    w = _detect_non_academic(items)
    assert len(w) == 1
    assert w[0]["kind"] == "unknown"


def test_missing_type_but_has_doi_is_ok():
    """有 DOI 视为学术，不报警。"""
    items = [{"id": "ref1", "title": "T", "DOI": "10.1234/x"}]
    assert _detect_non_academic(items) == []


if __name__ == "__main__":
    test_flags_preprint()
    test_flags_conference_abstract()
    test_flags_infographic_by_url_pattern()
    test_flags_report_dataset_and_other_non_academic_types()
    test_does_not_flag_normal_journal_articles()
    test_includes_title_and_index_in_warning()
    test_missing_type_treated_as_non_standard()
    test_missing_type_but_has_doi_is_ok()
    print("ALL NON-ACADEMIC WARNING TESTS PASSED")
