"""W2-1 OnboardingWizard 后端单测。

测试:
- write_env_file 替换/追加/保留其他键 (用 tmp 路径, 不破坏真 .env)
- test_provider_key 在 LLM 不可达 / 401 时返回 ok=False + 中文消息
- /api/config/save 远端 IP 调用应被 403 拒绝
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config_io import test_provider_key as _test_provider_key, write_env_file
from app.main import app


def test_write_env_replace_and_append(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text(
        "# comment\nLLM_PROVIDER=openai\nLLM_API_KEY=oldkey\nNCBI_EMAIL=me@example.com\n",
        encoding="utf-8",
    )
    write_env_file(
        {"LLM_API_KEY": "newkey", "LLM_BASE_URL": "https://api.deepseek.com", "LLM_MODEL": "deepseek-chat"},
        env_path=env,
    )
    text = env.read_text(encoding="utf-8")
    # 旧 key 被替换
    assert "LLM_API_KEY=newkey" in text
    assert "oldkey" not in text
    # 新 key 追加
    assert "LLM_BASE_URL=https://api.deepseek.com" in text
    assert "LLM_MODEL=deepseek-chat" in text
    # 其它键保留
    assert "NCBI_EMAIL=me@example.com" in text
    # 注释保留
    assert "# comment" in text
    # LLM_PROVIDER 原样保留(未传)
    assert "LLM_PROVIDER=openai" in text


def test_write_env_empty_value_removes_key(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("LLM_API_KEY=oldkey\nMOCK_LLM=0\n", encoding="utf-8")
    write_env_file({"LLM_API_KEY": ""}, env_path=env)
    text = env.read_text(encoding="utf-8")
    assert "LLM_API_KEY" not in text
    assert "MOCK_LLM=0" in text


def test_write_env_quotes_special_chars(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    write_env_file({"LLM_API_KEY": "sk has space"}, env_path=env)
    text = env.read_text(encoding="utf-8")
    assert 'LLM_API_KEY="sk has space"' in text


def test_write_env_creates_file_when_missing(tmp_path: Path) -> None:
    env = tmp_path / "subdir" / ".env"
    write_env_file({"LLM_API_KEY": "abc"}, env_path=env)
    assert env.exists()
    assert "LLM_API_KEY=abc" in env.read_text(encoding="utf-8")


def test_test_key_returns_error_when_unreachable() -> None:
    # 用一个肯定不可达的 base_url, 期望返回 ok=False + 中文消息
    ok, msg = asyncio.run(
        _test_provider_key(  # type: ignore
            "openai",
            "fake-key",
            base_url="http://127.0.0.1:1",  # 这个端口几乎肯定无服务
            model="x",
            timeout=2.0,
        )
    )
    assert ok is False
    assert isinstance(msg, str) and len(msg) > 0


def test_test_key_missing_key() -> None:
    ok, msg = asyncio.run(_test_provider_key("openai", "", base_url="", model=""))
    assert ok is False
    assert "未填写" in msg or "key" in msg.lower()


def test_test_key_resolves_provider_endpoint(monkeypatch) -> None:
    """回归: 只给 provider(不给 base_url/model)时, 必须打到该 provider 预设端点+预设 model,
    而非默认落到 DeepSeek。历史 bug: 硅基流动/OpenAI 的 key 被打到 deepseek → 假 401,
    连带"测不过 → 存不了"。"""
    import app.config_io as cio

    captured: dict[str, object] = {}

    class _FakeResp:
        status_code = 200
        text = "{}"

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["model"] = (json or {}).get("model")
            return _FakeResp()

    monkeypatch.setattr(cio.httpx, "AsyncClient", _FakeClient)

    # 硅基流动: 无 base_url → 打到 siliconflow.cn, model 取预设
    ok, _ = asyncio.run(_test_provider_key("siliconflow", "sk-x"))
    assert ok is True
    assert "siliconflow.cn" in str(captured["url"])
    assert "deepseek.com" not in str(captured["url"])
    assert captured["model"] == "deepseek-ai/DeepSeek-V3"

    # OpenAI: 无 base_url → 打到 api.openai.com(此前会误落到 deepseek)
    asyncio.run(_test_provider_key("openai", "sk-y"))
    assert "api.openai.com" in str(captured["url"])

    # 自定义 model 覆盖预设
    asyncio.run(_test_provider_key("siliconflow", "sk-x", model="Qwen/Qwen2.5-72B-Instruct"))
    assert captured["model"] == "Qwen/Qwen2.5-72B-Instruct"

    # 未知 provider 且无 base_url → 拒绝猜端点
    ok2, msg2 = asyncio.run(_test_provider_key("weird", "sk-z"))
    assert ok2 is False
    assert "base_url" in msg2


def test_save_config_localhost_allowed(tmp_path: Path, monkeypatch) -> None:
    # 把 ENV_PATH 改成 tmp, 避免破坏真 .env
    import app.config_io as cio
    monkeypatch.setattr(cio, "ENV_PATH", tmp_path / ".env")

    client = TestClient(app)
    # TestClient 的客户端 host 默认是 testclient, 我们 monkey-patch 一下 _is_localhost
    import app.routes.system as m
    monkeypatch.setattr(m, "_is_localhost", lambda r: True)

    resp = client.post(
        "/api/config/save",
        json={"provider": "deepseek", "key": "sk-test", "mock": False},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    # 验证 .env 被写入
    text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "LLM_API_KEY=sk-test" in text
    assert "MOCK_LLM=0" in text


def test_save_config_remote_forbidden(tmp_path: Path, monkeypatch) -> None:
    import app.config_io as cio
    monkeypatch.setattr(cio, "ENV_PATH", tmp_path / ".env")

    client = TestClient(app)
    # 模拟来自远端 IP 的请求
    import app.routes.system as m
    monkeypatch.setattr(m, "_is_localhost", lambda r: False)

    resp = client.post(
        "/api/config/save",
        json={"provider": "deepseek", "key": "sk-evil", "mock": False},
    )
    # 403
    assert resp.status_code == 403
    body = resp.json()
    assert body["ok"] is False


def test_save_config_mock_mode(tmp_path: Path, monkeypatch) -> None:
    import app.config_io as cio
    monkeypatch.setattr(cio, "ENV_PATH", tmp_path / ".env")

    client = TestClient(app)
    import app.routes.system as m
    monkeypatch.setattr(m, "_is_localhost", lambda r: True)

    resp = client.post(
        "/api/config/save",
        json={"provider": "deepseek", "key": "", "mock": True},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "MOCK_LLM=1" in text


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
