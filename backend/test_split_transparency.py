"""_split_transparency() 鲁棒性回归。运行: .venv\\Scripts\\python.exe test_split_transparency.py"""
import sys
import app.dataanalysis as da


def _check(name, got, expected):
    ok = got == expected
    print(("PASS " if ok else "FAIL ") + name)
    if not ok:
        print("  expected:", expected)
        print("  got     :", got)
    return ok


def main():
    passed = 0
    failed = 0

    # 1. 标准三段(prompt 强制的分隔符, 段间有空行)
    stdout = "『【方法选择】』\n用了 t 检验\n\n『【假设检查】』\nShapiro p=0.3\n\n『【数据质量】』\n无缺失\n\n主分析结果 p=0.02"
    r = da._split_transparency(stdout)
    if _check("标准三段/method", r["method"].strip(), "用了 t 检验"): passed += 1
    else: failed += 1
    if _check("标准三段/assumption", r["assumption"].strip(), "Shapiro p=0.3"): passed += 1
    else: failed += 1
    if _check("标准三段/quality", r["quality"].strip(), "无缺失"): passed += 1
    else: failed += 1
    if _check("标准三段/main", r["main"].strip(), "主分析结果 p=0.02"): passed += 1
    else: failed += 1

    # 2. 缺全角括号(『』)
    stdout = "【方法选择】\nA\n\n【假设检查】\nB\n\n【数据质量】\nC\n\nD"
    r = da._split_transparency(stdout)
    if _check("无 『』/method", r["method"].strip(), "A"): passed += 1
    else: failed += 1
    if _check("无 『』/main", r["main"].strip(), "D"): passed += 1
    else: failed += 1

    # 3. markdown 标题包裹
    stdout = "## 方法选择\nX\n\n## 假设检查\nY\n\n## 数据质量\nZ\n\n主结果"
    r = da._split_transparency(stdout)
    if _check("md 标题/method", r["method"].strip(), "X"): passed += 1
    else: failed += 1
    if _check("md 标题/quality", r["quality"].strip(), "Z"): passed += 1
    else: failed += 1

    # 4. 序号 + 缺括号
    stdout = "1. 方法选择:aa\n\n2. 假设检查:bb\n\n3. 数据质量:cc\n\n主 dd"
    r = da._split_transparency(stdout)
    if _check("序号/method", r["method"].strip(), "aa"): passed += 1
    else: failed += 1
    if _check("序号/main", r["main"].strip(), "主 dd"): passed += 1
    else: failed += 1

    # 5. 顺序颠倒
    stdout = "『【数据质量】』\nQ1\n\n『【方法选择】』\nM1\n\n『【假设检查】』\nA1\n\nMAIN"
    r = da._split_transparency(stdout)
    if _check("乱序/method", r["method"].strip(), "M1"): passed += 1
    else: failed += 1
    if _check("乱序/quality", r["quality"].strip(), "Q1"): passed += 1
    else: failed += 1
    if _check("乱序/main", r["main"].strip(), "MAIN"): passed += 1
    else: failed += 1

    # 6. 只有 2 个 marker(方法选择缺失)
    stdout = "『【假设检查】』\nA\n\n『【数据质量】』\nQ\n\nM"
    r = da._split_transparency(stdout)
    if _check("缺 method/method 为空", r["method"], ""): passed += 1
    else: failed += 1
    if _check("缺 method/assumption 有", r["assumption"].strip(), "A"): passed += 1
    else: failed += 1
    if _check("缺 method/main 有", r["main"].strip(), "M"): passed += 1
    else: failed += 1

    # 7. 一个 marker 都没有 → 全落 main
    stdout = "just some raw output\nline 2"
    r = da._split_transparency(stdout)
    if _check("无 marker/method 空", r["method"], ""): passed += 1
    else: failed += 1
    if _check("无 marker/main 全部", r["main"].strip(), "just some raw output\nline 2"): passed += 1
    else: failed += 1

    # 8. 空串
    r = da._split_transparency("")
    if _check("空串/main 空", r["main"], ""): passed += 1
    else: failed += 1

    # 9. 圆圈序号 + 超串防误判
    stdout = "① 方法选择:aa\n\n② 假设检查:bb\n\n③ 数据质量:cc\n\nmain content"
    r = da._split_transparency(stdout)
    if _check("圆圈/method", r["method"].strip(), "aa"): passed += 1
    else: failed += 1
    if _check("圆圈/quality", r["quality"].strip(), "cc"): passed += 1
    else: failed += 1

    # 10. 超串防误判(假设检查通过 ≠ 假设检查 marker)
    stdout = "假设检查通过，继续分析\nmain content"
    r = da._split_transparency(stdout)
    if _check("超串/assumption 不匹配", r["assumption"], ""): passed += 1
    else: failed += 1
    if _check("超串/main 全部", r["main"].strip(), "假设检查通过，继续分析\nmain content"): passed += 1
    else: failed += 1

    print(f"\nRESULT: {passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
