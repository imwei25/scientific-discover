"""每环节模型路由(LLM_STAGE_*)回归测试(不消耗 API 额度)。

验证: 环境变量解析(后缀不混淆) / stream_chat 按 task 选环节模型 /
环节模型配额错误时依次降级到主配置、备用供应商。
"""
import asyncio
import os

from app import config
from app.config import _parse_stage_overrides

config.settings.mock = False
config.settings.provider = "openai"
config.settings.api_key = "primary-key"
config.settings.base_url = "https://primary"
config.settings.model = "primary-model"
config.settings.fallback_api_key = "fb-key"
config.settings.fallback_base_url = "https://fb"
config.settings.fallback_model = "fb-model"

import app.llm as llm  # noqa: E402


async def collect(agen) -> str:
    out = ""
    async for p in agen:
        out += p
    return out


def test_parse_stage_overrides_suffixes():
    keys = {
        "LLM_STAGE_GRANT_REVIEW_MODEL": "deepseek-reasoner",
        "LLM_STAGE_GRANT_REVIEW_API_KEY": "sk-review",
        "LLM_STAGE_GRANT_REVIEW_BASE_URL": "https://other",
        "LLM_STAGE_GRANT_REVIEW_PROVIDER": "openai",
        # 只配了 key 没配 model 的环节不生效
        "LLM_STAGE_IMRAD_API_KEY": "sk-imrad",
        # 空值忽略
        "LLM_STAGE_DEAI_MODEL": "  ",
    }
    old = {k: os.environ.get(k) for k in keys}
    os.environ.update(keys)
    try:
        ov = _parse_stage_overrides()
        assert ov["grant_review"] == {
            "model": "deepseek-reasoner", "api_key": "sk-review",
            "base_url": "https://other", "provider": "openai",
        }
        assert "imrad" not in ov  # 没配 _MODEL 不算有效覆盖
        assert "deai" not in ov
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_stream_chat_routes_by_task():
    config.settings.stage_overrides = {"grant_review": {"model": "review-model"}}

    async def fake_stream(cfg, messages, **kw):
        yield f"model={cfg.model};key={cfg.api_key}"

    orig = llm._stream_with
    llm._stream_with = fake_stream
    try:
        # 有覆盖的环节: 用覆盖模型, key 沿用主配置
        got = asyncio.run(collect(llm.stream_chat([{"role": "user", "content": "hi"}], task="grant_review")))
        assert got == "model=review-model;key=primary-key", got
        # 未覆盖的环节与不传 task: 都走主配置
        got = asyncio.run(collect(llm.stream_chat([{"role": "user", "content": "hi"}], task="imrad")))
        assert got == "model=primary-model;key=primary-key", got
        got = asyncio.run(collect(llm.stream_chat([{"role": "user", "content": "hi"}])))
        assert got == "model=primary-model;key=primary-key", got
    finally:
        llm._stream_with = orig
        config.settings.stage_overrides = {}


def test_stage_quota_falls_back_to_primary_then_fallback():
    config.settings.stage_overrides = {"grant_review": {"model": "review-model"}}
    calls: list[str] = []

    async def fake_stream(cfg, messages, **kw):
        calls.append(cfg.model)
        if cfg.model in ("review-model", "primary-model"):
            raise llm.LLMError("Insufficient Balance", status=402)
            yield  # noqa: 使其成为 async generator
        yield "FB-OK"

    orig = llm._stream_with
    llm._stream_with = fake_stream
    try:
        got = asyncio.run(collect(llm.stream_chat([{"role": "user", "content": "hi"}], task="grant_review")))
        assert got == "FB-OK", got
        assert calls == ["review-model", "primary-model", "fb-model"], calls
    finally:
        llm._stream_with = orig
        config.settings.stage_overrides = {}
