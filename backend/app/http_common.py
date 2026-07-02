"""路由共享的 HTTP 工具: SSE 编码、上传大小限制。"""
from __future__ import annotations

import json

from fastapi import UploadFile

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
