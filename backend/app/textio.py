"""文本/CSV 字节解码的健壮工具。

中文用户上传的文件常是 GBK/ANSI 或带 BOM 的 utf-8（Excel/记事本导出），
若一律按 utf-8 解码会崩溃（CSV）或静默丢字（txt 用 errors='ignore'）。
这里统一按编码回退链解码：
  utf-8-sig（去 BOM）→ utf-8 → gb18030（gbk/gb2312 超集）→ latin-1（永不报错兜底）。
"""
from __future__ import annotations

import io

import pandas as pd

TEXT_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "latin-1")


def decode_text(content: bytes) -> str:
    """把字节按编码回退链解码为文本；绝不静默丢弃中文。"""
    for enc in TEXT_ENCODINGS:
        try:
            return content.decode(enc)
        except UnicodeDecodeError:
            continue
    # 理论上 latin-1 不会到这里；最后兜底确保不抛错。
    return content.decode("latin-1", "ignore")


def read_csv_bytes(content: bytes) -> pd.DataFrame:
    """按编码回退链读取 CSV 字节为 DataFrame。"""
    last: Exception | None = None
    for enc in TEXT_ENCODINGS:
        try:
            return pd.read_csv(io.BytesIO(content), encoding=enc)
        except UnicodeDecodeError as e:
            last = e
            continue
    raise last if last else ValueError("无法解析 CSV 文件。")
