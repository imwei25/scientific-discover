from unittest.mock import AsyncMock
import json
import pytest
from fastapi.testclient import TestClient
from app.main import app  # project convention: `app.main` from `backend/` cwd

client = TestClient(app)


def _refs(n):
    return [
        {"ref_key": f"k{i}", "title": f"Paper {i}", "abstract": f"Abstract of paper {i}"}
        for i in range(n)
    ]


def test_recommend_returns_scores(monkeypatch):
    from app import deep_research as dr
    from app.config import settings
    settings.mock = False  # 走 LLM 分支以验证 stream_chat 补丁生效
    fake_llm_output = json.dumps([
        {"ref_key": "k0", "score": "high", "reason": "对立结论"},
        {"ref_key": "k1", "score": "medium", "reason": "样本量大"},
        {"ref_key": "k2", "score": "none", "reason": "偏离"},
    ])
    async def fake_llm(messages, **kw):
        yield fake_llm_output
    monkeypatch.setattr(dr, "stream_chat", fake_llm)
    resp = client.post(
        "/api/deep_research/recommend",
        json={"question": "X 对 Y 的作用", "refs": _refs(3)},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    scores = {it["ref_key"]: it["score"] for it in data["items"]}
    assert scores == {"k0": "high", "k1": "medium", "k2": "none"}


def test_recommend_high_cap_enforced(monkeypatch):
    from app import deep_research as dr
    from app.config import settings
    settings.mock = False  # 走 LLM 分支
    # LLM 返回 20 篇全 high; 后端应截到 8 篇 high, 其余降级为 none
    fake = json.dumps([{"ref_key": f"k{i}", "score": "high", "reason": "r"} for i in range(20)])
    async def fake_llm(messages, **kw):
        yield fake
    monkeypatch.setattr(dr, "stream_chat", fake_llm)
    resp = client.post(
        "/api/deep_research/recommend",
        json={"question": "Q", "refs": _refs(20)},
    )
    items = resp.json()["items"]
    high_count = sum(1 for it in items if it["score"] == "high")
    assert high_count == 8
