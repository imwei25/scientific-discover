"""路由共享的 HTTP 工具: SSE 编码、上传大小限制、上游 API 指数退避重试。"""
from __future__ import annotations

import asyncio
import json
from typing import Awaitable, Callable, TypeVar

import httpx
from fastapi import UploadFile

_T = TypeVar("_T")


async def with_backoff(
    fn: Callable[[], Awaitable[_T]],
    *,
    attempts: int = 3,
    base_delay: float = 1.0,
    retry_on_status: tuple[int, ...] = (429, 500, 502, 503, 504),
) -> _T:
    """在 fn 抛 httpx.HTTPStatusError (状态码在 retry_on_status) 或超时/连接错误时,
    指数退避重试. delay = base_delay * 3**i (i=0,1,2 → 1s, 3s, 9s).
    抛出的最后一次异常向上传播."""
    last_exc: Exception | None = None
    for i in range(attempts):
        try:
            return await fn()
        except httpx.HTTPStatusError as e:
            if e.response.status_code not in retry_on_status:
                raise
            last_exc = e
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            last_exc = e
        if i < attempts - 1:
            await asyncio.sleep(base_delay * (3 ** i))
    assert last_exc is not None
    raise last_exc

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# 上传大小上限(与前端 Dropzone 一致); 后端再设一道, 防 LAN/直连绕过前端导致 OOM。
MAX_UPLOAD_BYTES = 30 * 1024 * 1024


async def _read_capped(file: UploadFile, limit: int | None = None) -> bytes | None:
    """分块读取上传文件, 超过 limit 立即停止并返回 None(不把超大文件整个读入内存)。"""
    lim = MAX_UPLOAD_BYTES if limit is None else limit
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > lim:
            return None
        chunks.append(chunk)
    return b"".join(chunks)
