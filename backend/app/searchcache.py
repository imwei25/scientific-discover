"""检索结果的进程内 TTL 缓存 (LRU + 上限 512).

相同检索式(含来源/过滤器)在短时间内复用, 省去重复的网络往返与等待。
仅缓存"有结果或网络正常"的响应, 不缓存全失败(避免把一次偶发网络故障缓存住)。

原来的 dict 无上限, 长跑进程 (大量 filter 组合) 内存会缓慢膨胀; 改用 OrderedDict + LRU,
访问一次就 move_to_end, 超过 MAX_SIZE 时淘汰最久未用.
"""
from __future__ import annotations

import time
from collections import OrderedDict

_TTL = 900.0  # 15 分钟
_MAX_SIZE = 512
_store: OrderedDict = OrderedDict()


def get(key):
    v = _store.get(key)
    if not v:
        return None
    ts, data = v
    if time.monotonic() - ts > _TTL:
        _store.pop(key, None)
        return None
    # LRU: 访问即视为"最近使用", 挪到末尾
    _store.move_to_end(key)
    return data


def put(key, data) -> None:
    _store[key] = (time.monotonic(), data)
    _store.move_to_end(key)
    # 超上限: 弹出最久未用 (OrderedDict 头部)
    while len(_store) > _MAX_SIZE:
        _store.popitem(last=False)


def clear() -> None:
    _store.clear()
