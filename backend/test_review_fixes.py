"""第11轮代码审查修复的回归测试（不联网）。

用法: python test_review_fixes.py
"""
import sys

from app.research import _verify_citations
from app.dataanalysis import _dedup_columns, _DANGER
from app.openalex import _params
import pandas as pd


def test_verify_pmid_exact():
    items = [{"url": "https://pubmed.ncbi.nlm.nih.gov/456/", "pmid": "456"}]
    # 子串型伪造 URL(含 456) 不应被判为 verified
    full = "见 [x](https://pubmed.ncbi.nlm.nih.gov/4567890/) 和 [y](https://pubmed.ncbi.nlm.nih.gov/456/)"
    v = _verify_citations(full, items)
    assert v["total"] == 2
    assert "https://pubmed.ncbi.nlm.nih.gov/4567890" in v["unverified"]   # 伪造的被抓出
    assert v["verified"] == 1                                            # 仅真实那条
    print("ok: _verify_citations 精确 PMID 路径段匹配")


def test_dedup_columns():
    df = pd.DataFrame([[1, 2, 3]], columns=["a", "a", "b"])
    d = _dedup_columns(df)
    assert list(d.columns) == ["a", "a.1", "b"]
    # 去重后 df[col] 返回 Series, .dtype 不再崩溃
    assert str(d["a"].dtype)
    print("ok: _dedup_columns 重复列名")


def test_danger_os_popen():
    assert _DANGER.search("os.popen('ls')")
    assert _DANGER.search("import os\nos.system('x')")
    assert not _DANGER.search("df.eval('a+b')")  # 合法 pandas 方法不误伤
    print("ok: _DANGER 拦截 os.popen, 不误伤 df.eval")


def test_openalex_sanitize():
    p = _params("cancer, immunotherapy: PD-1", 5)
    flt = p["filter"]
    assert flt.startswith("title_and_abstract.search:")
    # search 值里不应残留逗号/冒号(冒号只在前缀键处)
    val = flt.split("search:", 1)[1]
    assert "," not in val and ":" not in val
    print("ok: openalex _params 清理逗号/冒号")


if __name__ == "__main__":
    try:
        test_verify_pmid_exact()
        test_dedup_columns()
        test_danger_os_popen()
        test_openalex_sanitize()
        print("\nALL REVIEW-FIX TESTS PASSED")
    except AssertionError as e:
        print("FAILED:", e)
        sys.exit(1)
