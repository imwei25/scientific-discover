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
    """按编码回退链读取 CSV 字节为 DataFrame。

    额外做分隔符嗅探: 欧洲(荷/德/法)与日本 Excel 导出的 CSV 常用 ';' 作分隔,
    也有系统用 '\\t'。默认 pd.read_csv 只认 ',', 会把整行当成 1 列, 后续
    列级分析全部失效。所以先让 pandas 自动嗅探 sep, 失败或只出 1 列时再
    显式尝试 ';' 与 '\\t', 最后回退到默认 ',' 逻辑保证兼容。
    """
    last: Exception | None = None
    for enc in TEXT_ENCODINGS:
        # 1) 尝试自动嗅探分隔符(python 引擎才支持 sep=None)。
        try:
            df = pd.read_csv(io.BytesIO(content), encoding=enc, sep=None, engine="python")
            if df.shape[1] > 1:
                return df
            # 只有 1 列: 可能嗅探被单元格内引号/换行干扰, 按原文里出现的分隔符显式再试。
            try:
                head = content[:8192].decode(enc, errors="ignore")
            except Exception:  # noqa: BLE001
                head = ""
            for sep in (";", "\t"):
                if sep in head:
                    try:
                        df2 = pd.read_csv(io.BytesIO(content), encoding=enc, sep=sep)
                        if df2.shape[1] > 1:
                            return df2
                    except UnicodeDecodeError as e:
                        last = e
                    except Exception:  # noqa: BLE001
                        pass
            # 显式尝试都失败: 保留自动嗅探到的单列结果, 让上层看到内容。
            return df
        except UnicodeDecodeError as e:
            last = e
            continue
        except Exception:  # noqa: BLE001
            # 嗅探本身失败(如空文件/损坏), 回退到默认 ',' 分隔。
            pass
        # 2) 回退: 默认 ',' 分隔。
        try:
            return pd.read_csv(io.BytesIO(content), encoding=enc)
        except UnicodeDecodeError as e:
            last = e
            continue
    raise last if last else ValueError("无法解析 CSV 文件。")
