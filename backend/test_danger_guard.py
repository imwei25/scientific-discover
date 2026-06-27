"""数据分析安全护栏 _DANGER 的回归测试(不消耗 API 额度)。

运行: .venv\\Scripts\\python.exe test_danger_guard.py
验证: 拦截内置 eval/exec/open 与 subprocess/os.system/socket 等危险调用,
      但不误伤合法的 pandas 方法 df.eval()/df.query()、re.compile、含 open 的列名等。
"""
import sys

from app.dataanalysis import _DANGER

# (代码片段, 期望是否拦截, 说明)
CASES = [
    ('df["c"] = df.eval("a + b")', False, "pandas df.eval"),
    ('sub = df.query("age > 30")', False, "df.query"),
    ('m = re.compile(r"x")', False, "re.compile"),
    ("res = pg.ttest(a, b); print(res)", False, "正常分析"),
    ("vals = data.open_price", False, "列名含 open 不误伤"),
    ("x = eval(user_input)", True, "内置 eval 注入"),
    ("y = exec(payload)", True, "内置 exec 注入"),
    ('f = open("/etc/passwd")', True, "内置 open 读文件"),
    ("import subprocess", True, "subprocess"),
    ('os.system("rm")', True, "os.system"),
    ("import socket", True, "socket"),
    ('__import__("os")', True, "__import__"),
]


def main() -> None:
    failed = 0
    for code, expect, desc in CASES:
        got = bool(_DANGER.search(code))
        if got != expect:
            failed += 1
            print(f"FAIL [{'拦截' if got else '放行'}] {desc}")
    if failed:
        print(f"\n{failed} 个用例失败")
        sys.exit(1)
    print(f"ALL DANGER-GUARD TESTS PASSED ({len(CASES)} 例)")


if __name__ == "__main__":
    main()
