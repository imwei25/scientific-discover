"""环境自检 doctor 的回归测试(不消耗 API 额度)。

运行: .venv\\Scripts\\python.exe test_doctor.py
验证: 健康环境下 main() 返回 0; 缺依赖等问题能被识别为失败项。
"""
import sys

import doctor


def main() -> None:
    # 1) 当前(健康)环境: 全部通过, 退出码 0。
    assert doctor.main() == 0, "健康环境应返回 0"
    print("健康环境 -> 退出码 0: OK")

    # 2) 缺依赖应被识别为失败。
    r = doctor.Report()
    orig = doctor._DEPS
    doctor._DEPS = [("definitely_not_a_real_module_xyz123", "x")]
    try:
        doctor._check_deps(r)
    finally:
        doctor._DEPS = orig
    assert r.failed == 1, "缺依赖应记为失败"
    print("缺依赖 -> 识别为失败: OK")

    # 3) Report 计数语义。
    r2 = doctor.Report()
    r2.ok("a")
    r2.warn("b")
    assert r2.failed == 0
    r2.bad("c")
    assert r2.failed == 1
    print("Report 计数(ok/warn 不计、bad 计): OK")

    print("\nALL DOCTOR TESTS PASSED")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print("FAILED:", e)
        sys.exit(1)
