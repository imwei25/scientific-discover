"""配置解析健壮性回归测试(不消耗 API 额度)。

运行: .venv\\Scripts\\python.exe test_config.py
验证: _int 对空/非法/越界的环境变量回退默认值, 不在导入期崩溃(此前 PORT="" 会 ValueError)。
"""
import os
import sys

from app.config import _int


def main() -> None:
    cases = [
        ("", 8756),
        ("   ", 8756),
        ("abc", 8756),
        ("0", 8756),       # 越界(<1)
        ("70000", 8756),   # 越界(>65535)
        ("8756", 8756),
        ("9000", 9000),
        ("  8080  ", 8080),
    ]
    failed = 0
    for val, expect in cases:
        os.environ["T_PORT"] = val
        got = _int("T_PORT", 8756, lo=1, hi=65535)
        if got != expect:
            failed += 1
            print(f"FAIL {val!r} -> {got} (期望 {expect})")
    os.environ.pop("T_PORT", None)
    if _int("T_PORT", 8756) != 8756:
        failed += 1
        print("FAIL 未设置时未回退默认")
    if failed:
        print(f"\n{failed} 个用例失败")
        sys.exit(1)
    print(f"ALL CONFIG TESTS PASSED ({len(cases) + 1} 例)")


if __name__ == "__main__":
    main()
