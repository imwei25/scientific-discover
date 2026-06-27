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

    def __init__(self, message: str, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        # retryable: 瞬时网络/超时类错误, 在尚未产出内容时可安全重试或转用备用供应商。
        self.retryable = retryable


# 瞬时网络错误的重试参数(仅在尚未产出任何内容时生效)。
_MAX_RETRIES = 2
_RETRY_BACKOFF = 0.8  # 秒, 线性递增

# 本进程累计 token 用量(C8): 每次模型调用回报的 usage 累加, 供侧栏展示"本次会话已用"。
_session_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "requests": 0}


def get_session_usage() -> dict:
    return dict(_session_usage)


def _add_usage(u: dict | None) -> None:
    if not u:
        return
    pt = int(u.get("prompt_tokens") or u.get("input_tokens") or 0)
    ct = int(u.get("completion_tokens") or u.get("output_tokens") or 0)
    tt = int(u.get("total_tokens") or (pt + ct))
    _session_usage["prompt_tokens"] += pt
    _session_usage["completion_tokens"] += ct
    _session_usage["total_tokens"] += tt
    _session_usage["requests"] += 1


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
    payload = {
        "model": cfg.model,
        "messages": messages,
        "stream": True,
        # 让上游在流末附带 usage(token 用量); 兼容服务器会忽略未知字段。
        "stream_options": {"include_usage": True},
        **kwargs,
    }
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
                if obj.get("usage"):  # 流末 usage 块(choices 通常为空)
                    _add_usage(obj["usage"])
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
            u_in = u_out = 0
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                t = obj.get("type")
                if t == "message_start":
                    u_in = int(((obj.get("message") or {}).get("usage") or {}).get("input_tokens") or 0)
                elif t == "message_delta":
                    u_out = int((obj.get("usage") or {}).get("output_tokens") or u_out)
                elif t == "content_block_delta":
                    piece = (obj.get("delta") or {}).get("text")
                    if piece:
                        yield piece
            if u_in or u_out:
                _add_usage({"input_tokens": u_in, "output_tokens": u_out})


async def _stream_with(cfg: ProviderConfig, messages: list[dict], **kwargs) -> AsyncIterator[str]:
    if not cfg.api_key:
        raise LLMError("未配置 API key, 且未开启 MOCK_LLM。")
    try:
        if cfg.provider == "anthropic":
            async for piece in _stream_anthropic(cfg, messages, **kwargs):
                yield piece
        else:
            async for piece in _stream_openai(cfg, messages, **kwargs):
                yield piece
    except httpx.TimeoutException as e:
        raise LLMError("请求模型服务超时（网络较慢或服务繁忙），请稍后重试。", retryable=True) from e
    except httpx.ConnectError as e:
        raise LLMError("无法连接到模型服务，请检查网络连接后重试。", retryable=True) from e
    except httpx.RequestError as e:  # 其余传输层错误(读写中断、协议错误等)
        raise LLMError(f"网络请求出错，请稍后重试。（{type(e).__name__}）", retryable=True) from e


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

    # 主供应商: 对瞬时网络/超时错误做有限重试(仅在尚未产出内容时, 避免重复输出)。
    last_err: LLMError | None = None
    for attempt in range(_MAX_RETRIES + 1):
        yielded = False
        try:
            async for piece in _stream_with(_primary_cfg(), messages, **kwargs):
                yielded = True
                yield piece
            return
        except LLMError as e:
            last_err = e
            # 已产出内容则不能安全重试/降级(会重复), 直接抛出。
            if yielded:
                raise
            # 瞬时网络错误且仍有重试次数: 退避后重试同一供应商。
            if e.retryable and attempt < _MAX_RETRIES:
                await asyncio.sleep(_RETRY_BACKOFF * (attempt + 1))
                continue
            break

    # 到此: 主供应商失败且未产出任何内容。
    # 配额耗尽 → 切备用; 网络持续不可达 → 也尝试备用(可能是另一家服务/线路可用)。
    e = last_err
    if settings.has_fallback and e is not None and (is_quota_error(e) or e.retryable):
        async for piece in _stream_with(_fallback_cfg(), messages, **kwargs):
            yield piece
        return
    if e is not None:
        raise e
