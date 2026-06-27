"""检索结果的进程内 TTL 缓存。

相同检索式(含来源/过滤器)在短时间内复用, 省去重复的网络往返与等待。
仅缓存"有结果或网络正常"的响应, 不缓存全失败(避免把一次偶发网络故障缓存住)。
"""
from __future__ import annotations

import time

_TTL = 900.0  # 15 分钟
_store: dict = {}


def get(key):
    v = _store.get(key)
    if not v:
        return None
    ts, data = v
    if time.monotonic() - ts > _TTL:
        _store.pop(key, None)
        return None
    return data


def put(key, data) -> None:
    _store[key] = (time.monotonic(), data)


def clear() -> None:
    _store.clear()
