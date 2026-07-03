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


def _log(msg: str) -> None:
    """LLM 调用链路日志: 打到 stdout(由启动脚本重定向进 backend/server.log), 便于排查降级/重试。"""
    import datetime

    print(f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] [llm] {msg}", flush=True)


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


# 环节(stage)注册表: stream_chat(task=...) 用的键 → 展示用中文名。
# 每个环节都可在 .env 用 LLM_STAGE_<键大写>_MODEL(_API_KEY/_BASE_URL/_PROVIDER) 单独指定模型;
# 未配置的环节用主配置。/api/config/stages 会列出每个环节当前生效的模型。
STAGES: dict[str, str] = {
    "research": "找选题（调研/报告/追问/检索式）",
    "grant_plan": "写标书·方案凝练与大纲",
    "grant_write": "写标书·分节撰写",
    "grant_review": "写标书·评审组模拟评审",
    "grant_revise": "写标书·逐节修订",
    "grant_style": "写标书·文风提炼",
    "imrad": "论文撰写（IMRaD 装配）",
    "analysis": "数据分析（写代码/结论解读）",
    "deai": "去 AI 味改写",
    "edit": "AI 精修（局部改写/补丁）",
    "journal_match": "期刊匹配理由",
    "rebuttal": "回复审稿意见",
    "refcheck": "参考文献核查",
    "statcheck": "统计一致性核查",
    "figcaptions": "图注生成",
    "citations": "引用整理",
    "stats_advice": "统计顾问",
    # /api/run 的通用文本模块: 环节键即模块名(plan/ethics/consent/checklist/abstract/
    # keywords/pico/precheck/coverletter/write/format 等), 同样支持 LLM_STAGE_ 覆盖。
}


def _primary_cfg() -> ProviderConfig:
    return ProviderConfig(settings.provider, settings.api_key, settings.base_url, settings.model)


def _stage_cfg(task: str | None) -> ProviderConfig | None:
    """某环节的覆盖配置; 未覆盖的字段(key/地址/协议)沿用主配置。"""
    ov = settings.stage_override(task)
    if not ov:
        return None
    return ProviderConfig(
        (ov.get("provider") or settings.provider).strip().lower(),
        (ov.get("api_key") or settings.api_key).strip(),
        (ov.get("base_url") or settings.base_url).strip().rstrip("/"),
        ov["model"].strip(),
    )


def _fallback_cfg() -> ProviderConfig:
    return ProviderConfig(
        settings.fallback_provider,
        settings.fallback_api_key,
        settings.fallback_base_url,
        settings.fallback_model,
    )


def _vlm_cfg() -> ProviderConfig:
    return ProviderConfig(
        settings.vlm_provider,
        settings.vlm_api_key,
        settings.vlm_base_url,
        settings.vlm_model,
    )


async def vlm_complete(system: str, user_text: str, image_b64: str, *, max_tokens: int = 1800) -> str:
    """视觉模型一次性(非流式)补全: 把一张图 + 文本发给多模态模型, 返回完整文本。

    用于「学术海报」排版审阅。走 OpenAI 兼容的多模态消息格式(content 数组含 image_url)。
    要求已配置 VLM_*(settings.has_vlm), 否则抛 LLMError。
    """
    cfg = _vlm_cfg()
    if not cfg.api_key or not cfg.base_url or not cfg.model:
        raise LLMError("未配置视觉模型(VLM)。请在设置里填写用于排版审阅的多模态模型。")
    # data URI: 兼容已带前缀或纯 base64 两种输入
    data_uri = image_b64 if image_b64.startswith("data:") else f"data:image/png;base64,{image_b64}"
    messages = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": data_uri}},
            ],
        },
    ]
    url = f"{cfg.base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {cfg.api_key}", "Content-Type": "application/json"}
    payload = {"model": cfg.model, "messages": messages, "stream": False, "max_tokens": max_tokens}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            resp = await client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as e:
        raise LLMError("视觉模型请求超时，请稍后重试。", retryable=True) from e
    except httpx.RequestError as e:
        raise LLMError(f"视觉模型网络请求出错（{type(e).__name__}）。", retryable=True) from e
    if resp.status_code != 200:
        raise LLMError(
            f"视觉模型返回 {resp.status_code}: {resp.text[:300]}", status=resp.status_code
        )
    obj = resp.json()
    _add_usage(obj.get("usage"))
    choices = obj.get("choices") or []
    if not choices:
        return ""
    content = (choices[0].get("message") or {}).get("content")
    # 兼容个别多模态服务返回 content 数组的情况
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return content or ""


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
        # Anthropic 协议要求必须带 max_tokens; 给一个宽松上限, 避免长结论/长代码被拦腰截断
        # (输出是流式的, 用户可随时点「停止」中断, 无需靠小上限来控长度)。
        "max_tokens": kwargs.pop("max_tokens", 16384),
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


async def stream_chat(messages: list[dict], *, task: str | None = None, **kwargs) -> AsyncIterator[str]:
    """根据配置选择格式, 流式返回文本增量; 首选供应商额度用尽时自动降级。

    task: 环节标识(见 STAGES)。配了 LLM_STAGE_<环节>_* 时该环节走覆盖的模型,
    失败(未产出内容且属配额/网络类)时依次降级: 环节覆盖 → 主配置 → 备用供应商。
    """
    if settings.mock:
        async for piece in _stream_mock(messages):
            yield piece
        return

    stage = _stage_cfg(task)
    first = stage or _primary_cfg()
    first_name = (f"环节[{task}]覆盖({first.provider}/{first.model})" if stage
                  else f"主供应商({first.provider}/{first.model})")

    # 首选供应商: 对瞬时网络/超时错误做有限重试(仅在尚未产出内容时, 避免重复输出)。
    last_err: LLMError | None = None
    for attempt in range(_MAX_RETRIES + 1):
        yielded = False
        try:
            async for piece in _stream_with(first, messages, **kwargs):
                yielded = True
                yield piece
            return
        except LLMError as e:
            last_err = e
            # 已产出内容则不能安全重试/降级(会重复), 直接抛出。
            if yielded:
                _log(f"{first_name}流式中途出错(已产出内容, 不重试): {e}")
                raise
            # 瞬时网络错误且仍有重试次数: 退避后重试同一供应商。
            if e.retryable and attempt < _MAX_RETRIES:
                _log(f"{first_name}瞬时错误[{e.status or '-'}], "
                     f"{_RETRY_BACKOFF * (attempt + 1):.1f}s 后重试({attempt + 1}/{_MAX_RETRIES}): {e}")
                await asyncio.sleep(_RETRY_BACKOFF * (attempt + 1))
                continue
            break

    # 到此: 首选供应商失败且未产出任何内容。
    # 配额耗尽 → 降级; 网络持续不可达 → 也降级(可能另一家服务/线路可用)。
    # 降级链: 环节覆盖失败先回主配置, 再到备用供应商。
    chain: list[tuple[str, ProviderConfig]] = []
    if stage is not None:
        p = _primary_cfg()
        if p.api_key and (p.provider, p.base_url, p.model) != (stage.provider, stage.base_url, stage.model):
            chain.append((f"主配置({p.provider}/{p.model})", p))
    if settings.has_fallback:
        chain.append((f"备用供应商({settings.fallback_provider}/{settings.fallback_model})", _fallback_cfg()))

    err = last_err
    for name, cfg in chain:
        if err is None or not (is_quota_error(err) or err.retryable):
            break
        reason = "额度不足/配额超限" if is_quota_error(err) else "网络持续不可达"
        _log(f"{first_name}失败({reason}: {err}); 切换到{name}重试…")
        try:
            got = False
            async for piece in _stream_with(cfg, messages, **kwargs):
                got = True
                yield piece
            _log(f"{name}成功接管。" if got else f"{name}无输出(空回复)。")
            return
        except LLMError as fe:
            _log(f"{name}也失败: {fe}")
            if got:  # 已产出内容, 不能再降级(会重复输出)
                raise
            err = fe
    if err is not None:
        _log(f"{first_name}失败且无可用降级: {err}")
        raise err
