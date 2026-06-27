"""参考文献核验：归一化 + 跨键去重 单测（不联网）。

用法: python test_refcheck.py
"""
from app.refcheck import _norm_doi, _norm_title, _mark_duplicates


def test_norm_doi():
    assert _norm_doi("https://doi.org/10.1/ABC") == "10.1/abc"
    assert _norm_doi("  10.2/X.  ") == "10.2/x"
    print("ok: _norm_doi")


def test_norm_title():
    assert _norm_title("A Study: Part 1!") == "a study part 1"
    print("ok: _norm_title")


def test_dedup_cross_key():
    items = [
        {"doi": "10.1/x", "pmid": "", "title": "Same Paper"},
        {"doi": "10.2/y", "pmid": "", "title": "Other"},
        {"doi": "", "pmid": "", "title": "Same Paper"},   # 仅同标题
        {"doi": "10.1/x", "pmid": "", "title": "Whatever"},  # 同 DOI
    ]
    _mark_duplicates(items)
    assert items[0].get("duplicate_of") is None
    assert items[1].get("duplicate_of") is None
    assert items[2].get("duplicate_of") == 1  # 标题撞 #1
    assert items[3].get("duplicate_of") == 1  # DOI 撞 #1
    print("ok: _mark_duplicates (cross doi/pmid/title)")


if __name__ == "__main__":
    test_norm_doi()
    test_norm_title()
    test_dedup_cross_key()
    print("\nALL REFCHECK TESTS PASSED")
