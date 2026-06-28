"""/api/run 输入校验与错误流回归测试(C3, mock 零额度)。

运行: .venv\\Scripts\\python.exe test_run_validation.py
验证:
  - build_messages 对缺必填字段抛友好 ValueError(不白调 LLM);
  - /api/run 把 ValueError 正确变成 SSE error 事件(此前闭包引用已清除的 e → NameError 崩溃);
  - 有效输入仍正常流式到 done。
"""
import os
import sys

os.environ.setdefault("MOCK_LLM", "true")

from fastapi.testclient import TestClient

from app.main import app
from app.prompts import build_messages


def main() -> None:
    failed = 0

    def check(cond, msg):
        nonlocal failed
        if not cond:
            failed += 1
            print(f"  FAIL: {msg}")

    # 1) build_messages 友好报错
    for mod, inp in [("checklist", {}), ("format", {"manuscript": "  "}),
                     ("write", {}), ("plan", {"idea": ""})]:
        try:
            build_messages(mod, inp)
            check(False, f"{mod} 空必填未报错")
        except ValueError as e:
            check("请先填写" in str(e), f"{mod} 错误信息不友好: {e}")

    c = TestClient(app)

    # 2) 空必填 → SSE error(不 500/不崩)
    r = c.post("/api/run", json={"module": "checklist", "inputs": {}})
    check(r.status_code == 200, f"空输入状态码 {r.status_code}")
    check("event: error" in r.text and "请先填写" in r.text, "空输入未返回友好 error")

    # 3) 未知模块(此前 NameError 崩溃的同一路径)
    r2 = c.post("/api/run", json={"module": "nonsense", "inputs": {}})
    check(r2.status_code == 200 and "event: error" in r2.text and "未知模块" in r2.text,
          "未知模块未返回友好 error")

    # 4) 有效输入仍正常
    r3 = c.post("/api/run", json={"module": "checklist",
                                  "inputs": {"manuscript": "稿件正文", "guideline": "strobe"}})
    check("event: error" not in r3.text and "event: done" in r3.text, "有效输入未正常完成")

    if failed:
        print(f"\n{failed} 个用例失败")
        sys.exit(1)
    print("ALL RUN-VALIDATION TESTS PASSED")


if __name__ == "__main__":
    main()
