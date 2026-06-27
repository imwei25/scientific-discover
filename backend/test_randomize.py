"""随机化分组表: 可复现 + 区组均衡 + 校验 单测（不联网）。

用法: python test_randomize.py
"""
from app.randomize import generate


def test_reproducible():
    a = generate({"n": 20, "groups": "A,B", "ratio": "1,1", "method": "block", "block_size": 4, "seed": 42})
    b = generate({"n": 20, "groups": "A,B", "ratio": "1,1", "method": "block", "block_size": 4, "seed": 42})
    assert [r["group"] for r in a["rows"]] == [r["group"] for r in b["rows"]]
    print("ok: reproducible with same seed")


def test_block_balance():
    r = generate({"n": 12, "groups": "A,B", "ratio": "1,1", "method": "block", "block_size": 4, "seed": 1})
    seq = [x["group"] for x in r["rows"]]
    assert all(seq[i:i + 4].count("A") == 2 for i in range(0, 12, 4))
    assert r["counts"] == {"A": 6, "B": 6}
    print("ok: block balanced")


def test_ratio_and_block_round():
    r = generate({"n": 30, "groups": "A,B,C", "ratio": "2,2,1", "method": "block", "block_size": 6, "seed": 3})
    # 区组大小 6 不是单位(5)的整数倍 → 取整为 5
    assert r["block_size"] == 5
    assert sum(r["counts"].values()) == 30
    print("ok: ratio + block-size rounding")


def test_validation():
    assert generate({"n": 0, "groups": "A,B"})["ok"] is False
    assert generate({"n": 10, "groups": "A"})["ok"] is False
    assert generate({"n": 10, "groups": "A,B", "ratio": "1,2,3"})["ok"] is False
    print("ok: validation")


if __name__ == "__main__":
    test_reproducible()
    test_block_balance()
    test_ratio_and_block_round()
    test_validation()
    print("\nALL RANDOMIZE TESTS PASSED")
