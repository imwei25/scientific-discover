"""轻量运行日志: 打到 stdout, 由启动脚本重定向进 backend/server.log。

给"静默降级"的兜底分支留痕用——功能可以降级, 但线上排查必须有据。
"""
from __future__ import annotations

import datetime


def log(msg: str) -> None:
    print(f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def log_swallow(where: str, e: Exception) -> None:
    """兜底吞掉异常时统一留一行痕迹: 哪里、什么异常。"""
    log(f"[degraded] {where}: {type(e).__name__}: {e}")
