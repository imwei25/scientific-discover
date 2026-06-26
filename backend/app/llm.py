"""LLM 适配层。

统一封装两种调用格式:
  - openai   : OpenAI / DeepSeek / 硅基流动 等兼容 /chat/completions 的服务
  - anthropic: Anthropic /v1/messages

对外暴露异步生成器 stream_chat(), 逐段 yield 文本增量(token delta),
上层(FastAPI)再转成 SSE 推给前端。

自动降级: 当主供应商返回“余额不足/配额超限”类错误且尚未产出任何内容时,
自动切换到备用供应商(如硅基流动)重试一次。

MOCK 模式: 不调用真实模型, 逐字吐出一段假回复, 用于 UI 开发和自动化测试,
保证确定性且不消耗 API 额度。
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import AsyncIterator

import httpx

from .config import settings


class LLMError(Exception):
    """对上层友好的错误类型。"""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class ProviderConfig:
    provider: str
    api_key: str
    base_url: str
    model: str


def _primary_cfg() -> ProviderConfig:
    return ProviderConfig(settings.provider, settings.api_key, settings.base_url, settings.model)


def _fallback_cfg() -> ProviderConfig:
    return ProviderConfig(
        settings.fallback_provider,
        settings.fallback_api_key,
        settings.fallback_base_url,
        settings.fallback_model,
    )


# 余额/配额类错误的判定: 命中则触发自动降级。
_QUOTA_HINTS = (
    "insufficient balance",
    "insufficient_quota",
    "exceeded",
    "余额",
    "配额",
    "quota",
    "out of credit",
)


def is_quota_error(e: LLMError) -> bool:
    if e.status in (402, 429):
        return True
    msg = str(e).lower()
    return any(h in msg for h in _QUOTA_HINTS)


# ----------------------------- MOCK -----------------------------

async def _stream_mock(messages: list[dict]) -> AsyncIterator[str]:
    last_user = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"),
        "",
    )
    reply = f"[MOCK] 已收到你的输入:「{last_user}」。这是用于开发与测试的模拟回复。"
    for ch in reply:
        await asyncio.sleep(0)
        yield ch


# ----------------------------- OpenAI 格式 -----------------------------

async def _stream_openai(cfg: ProviderConfig, messages: list[dict], **kwargs) -> AsyncIterator[str]:
    url = f"{cfg.base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {cfg.api_key}", "Content-Type": "application/json"}
    payload = {"model": cfg.model, "messages": messages, "stream": True, **kwargs}
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                raise LLMError(
                    f"上游返回 {resp.status_code}: {body.decode('utf-8', 'ignore')[:300]}",
                    status=resp.status_code,
                )
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = obj.get("choices") or []
                if not choices:
                    continue
                piece = (choices[0].get("delta") or {}).get("content")
                if piece:
                    yield piece


# ----------------------------- Anthropic 格式 -----------------------------

async def _stream_anthropic(cfg: ProviderConfig, messages: list[dict], **kwargs) -> AsyncIterator[str]:
    system = "\n".join(m["content"] for m in messages if m.get("role") == "system")
    convo = [m for m in messages if m.get("role") in {"user", "assistant"}]
    url = f"{cfg.base_url}/v1/messages"
    headers = {
        "x-api-key": cfg.api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    payload = {
        "model": cfg.model,
        "messages": convo,
        "max_tokens": kwargs.pop("max_tokens", 4096),
        "stream": True,
        **kwargs,
    }
    if system:
        payload["system"] = system
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                raise LLMError(
                    f"上游返回 {resp.status_code}: {body.decode('utf-8', 'ignore')[:300]}",
                    status=resp.status_code,
                )
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "content_block_delta":
                    piece = (obj.get("delta") or {}).get("text")
                    if piece:
                        yield piece


async def _stream_with(cfg: ProviderConfig, messages: list[dict], **kwargs) -> AsyncIterator[str]:
    if not cfg.api_key:
        raise LLMError("未配置 API key, 且未开启 MOCK_LLM。")
    if cfg.provider == "anthropic":
        async for piece in _stream_anthropic(cfg, messages, **kwargs):
            yield piece
    else:
        async for piece in _stream_openai(cfg, messages, **kwargs):
            yield piece


# ----------------------------- 对外入口 -----------------------------

async def get_balance() -> dict:
    """查询当前供应商余额(目前支持 DeepSeek 的 /user/balance)。"""
    if settings.mock or "deepseek" not in settings.base_url:
        return {"available": False}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            r = await client.get(
                f"{settings.base_url}/user/balance",
                headers={"Authorization": f"Bearer {settings.api_key}"},
            )
            if r.status_code != 200:
                return {"available": False}
            data = r.json()
            cny = next(
                (b for b in data.get("balance_infos", []) if b.get("currency") == "CNY"),
                None,
            )
            if not cny:
                return {"available": False}
            return {
                "available": True,
                "provider": "DeepSeek",
                "currency": "CNY",
                "balance": cny.get("total_balance"),
            }
    except Exception:  # noqa: BLE001
        return {"available": False}


async def stream_chat(messages: list[dict], **kwargs) -> AsyncIterator[str]:
    """根据配置选择格式, 流式返回文本增量; 主供应商额度用尽时自动切到备用。"""
    if settings.mock:
        async for piece in _stream_mock(messages):
            yield piece
        return

    yielded = False
    try:
        async for piece in _stream_with(_primary_cfg(), messages, **kwargs):
            yielded = True
            yield piece
        return
    except LLMError as e:
        # 仅在“尚未产出任何内容”且命中配额错误且配置了备用时, 才降级重试。
        if yielded or not settings.has_fallback or not is_quota_error(e):
            raise

    # 自动降级到备用供应商。
    async for piece in _stream_with(_fallback_cfg(), messages, **kwargs):
        yield piece
