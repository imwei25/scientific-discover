"""statcheck 重算 + 分类 单测（不联网）。

用法: python test_statcheck.py
"""
from app.statcheck import _recompute, _parse_p, _classify


def test_recompute():
    assert abs(_recompute({"type": "t", "df1": 38, "value": 2.10}) - 0.0424) < 0.001
    assert abs(_recompute({"type": "chi2", "df1": 1, "value": 3.84}) - 0.05) < 0.002
    assert abs(_recompute({"type": "z", "value": 1.96}) - 0.05) < 0.002
    assert abs(_recompute({"type": "r", "df1": 18, "value": 0.5}) - 0.0248) < 0.001
    assert _recompute({"type": "t", "value": 2.0}) is None  # 缺自由度
    print("ok: _recompute")


def test_parse_p():
    assert _parse_p("0.04") == ("=", 0.04, 2)
    assert _parse_p("<0.001") == ("<", 0.001, 3)
    assert _parse_p("= .045") == ("=", 0.045, 3)
    print("ok: _parse_p")


def test_classify():
    p = _recompute({"type": "t", "df1": 38, "value": 2.10})  # 0.0424
    assert _classify(_parse_p("0.04"), p) == "consistent"
    assert _classify(_parse_p("0.20"), p) == "decision_error"  # 报不显著, 实显著
    assert _classify(_parse_p("0.02"), p) == "inconsistent"    # 都显著但数值不符
    assert _classify(_parse_p("<0.001"), p) == "inconsistent"  # 报<.001 实0.042, 仍都显著→数值不一致
    assert _classify(None, None) == "unparsable"
    print("ok: _classify")


if __name__ == "__main__":
    test_recompute()
    test_parse_p()
    test_classify()
    print("\nALL STATCHECK TESTS PASSED")
