"""全端点冒烟测试（mock 模式，确定性，零额度）。

逐个打所有 HTTP 端点，断言不出 500、关键端点返回预期结构。
锁死 8 模块 + 工具端点的接线，防新增功能时静默回归。

用法: python test_endpoints.py
"""
import sys

from app import config

config.settings.mock = True  # 关键：LLM 端点走 mock，零额度、确定性

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

c = TestClient(app)


def _sse_ok(resp, must_have="done"):
    assert resp.status_code == 200, resp.status_code
    body = resp.text
    assert "data:" in body, "无 SSE 数据"
    if must_have:
        assert must_have in body, f"SSE 未含 {must_have}"


def main() -> None:
    # GET
    assert c.get("/api/health").status_code == 200
    assert c.get("/api/journals").json()["journals"]
    assert c.get("/api/usage").status_code == 200
    print("ok: GET health/journals/usage")

    # SSE：文本类模块 + 各旗舰流
    _sse_ok(c.post("/api/run", json={"module": "plan", "inputs": {"idea": "x"}}))
    _sse_ok(c.post("/api/idea", json={"module": "idea", "inputs": {"field": "肠道菌群"}}))
    _sse_ok(c.post("/api/imrad", json={"module": "imrad", "inputs": {"background": "x"}}))
    _sse_ok(c.post("/api/rebuttal", json={"module": "rebuttal", "inputs": {"reviews": "R1: small sample?"}}))
    _sse_ok(c.post("/api/idea-followup", json={"module": "idea", "inputs": {"mode": "ask", "question": "q", "references": [{"url": "u", "title": "t"}]}}))
    print("ok: SSE run/idea/imrad/rebuttal/idea-followup")

    # JSON：检索/核验/计算类
    assert c.post("/api/check-refs", json={"references": "Smith 2023"}).json()["ok"] is True
    assert c.post("/api/journal-match", json={"abstract": "TNBC PD-1"}).json()["ok"] is True
    assert c.post("/api/statcheck", json={"text": "t(38)=2.1, p=0.04"}).json()["ok"] is True
    assert c.post("/api/figure-captions", json={"count": 1, "code": "plt.plot()"}).json()["ok"] is True
    print("ok: check-refs/journal-match/statcheck/figure-captions (mock)")

    # 确定性（非 LLM）
    ss = c.post("/api/sample-size", json={"design": "ttest", "params": {"effect_size": "0.5"}}).json()
    assert ss.get("per_group"), ss
    rz = c.post("/api/randomize", json={"design": "randomize", "params": {"n": 6, "groups": "A,B"}}).json()
    assert rz["ok"] and len(rz["rows"]) == 6
    fd = c.post("/api/flow-diagram", json={"kind": "prisma", "counts": {"identified": 100, "included": 10}}).json()
    assert fd["ok"] and fd["png"]
    print("ok: sample-size/randomize/flow-diagram (deterministic)")

    # 导出类
    assert c.post("/api/docx", json={"text": "# 标题\n正文"}).status_code == 200
    bz = c.post("/api/bundle", json={"files": [{"name": "a.md", "content": "hi"}], "docx": []})
    assert bz.status_code == 200 and bz.content[:2] == b"PK"
    print("ok: docx/bundle")

    print("\nALL ENDPOINT SMOKE TESTS PASSED")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print("FAILED:", e)
        sys.exit(1)
