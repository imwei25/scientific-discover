"""文本/CSV 字节解码的健壮工具。

中文用户上传的文件常是 GBK/ANSI 或带 BOM 的 utf-8（Excel/记事本导出），
若一律按 utf-8 解码会崩溃（CSV）或静默丢字（txt 用 errors='ignore'）。

难点: 单纯"按顺序取第一个不报错的编码"并不可靠——gb18030 / latin-1 几乎能解码
任意字节而不抛异常, GBK 的字节偶尔还能凑成合法 utf-8, 于是"能解出来"却是乱码
（典型现象: 中文里夹杂 Ã¥ / é / 方块 / 问号, 即用户说的"一些乱码"）。

所以这里改为"打分选优": 对每种候选编码都试解一遍, 给解码结果按"像不像正常中文/文本"
打分（奖励 CJK 与 ASCII, 重罚替换符 U+FFFD、私用区、以及中文被错当单字节解码时
会大量冒出的 Latin-1 补充块字符）, 取得分最高者。这样 GBK 文件即使能被 utf-8 勉强
解出, 也会因乱码得分低而被 gb18030 的干净结果击败。
"""
from __future__ import annotations

import io

import pandas as pd

# 候选编码。顺序仅用于同分时的稳定偏好（优先 utf-8 家族, 其次简/繁中文, 最后永不报错的 latin-1）。
TEXT_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "big5", "latin-1")

# 打分只看前若干字节即可判定编码, 避免超大文件全量扫描。
_SAMPLE_BYTES = 262144


def _mojibake_score(text: str) -> float:
    """给解码文本打"可信度"分, 0~1, 越高越像正常文本; 用于在多个候选编码间择优。"""
    if not text:
        return 0.0
    good = bad = 0
    for ch in text:
        o = ord(ch)
        if o == 0xFFFD:                       # 替换符: 解码失败的铁证, 重罚
            bad += 6
        elif 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF:  # CJK 统一表意(含扩展A)
            good += 3
        elif 0x3000 <= o <= 0x303F or 0xFF00 <= o <= 0xFFEF:  # CJK 标点 / 全角
            good += 2
        elif o < 0x80:                        # ASCII
            good += 1
        elif 0xE000 <= o <= 0xF8FF:           # 私用区: 几乎只在错误解码时出现, 重罚
            bad += 4
        elif 0x00A0 <= o <= 0x00FF:           # Latin-1 补充块: 中文被错当单字节解码时的重灾区
            bad += 1
        else:                                 # 其他脚本/符号: 视为有意内容
            good += 1
    total = good + bad
    return good / total if total else 0.0


def _encodings_by_score(content: bytes) -> list[str]:
    """按"解出来像不像正常文本"的得分, 从高到低给候选编码排序。"""
    sample = content[:_SAMPLE_BYTES]
    scored = []
    for i, enc in enumerate(TEXT_ENCODINGS):
        # errors='replace' 保证一定能算出分数(替换符会被打分重罚), 同时避免采样在多字节
        # 边界被截断而误判"此编码不可用"。
        text = sample.decode(enc, "replace")
        scored.append((_mojibake_score(text), -i, enc))  # -i: 同分时保持 TEXT_ENCODINGS 原顺序偏好
    scored.sort(reverse=True)
    return [enc for _, _, enc in scored]


def decode_text(content: bytes) -> str:
    """把字节解码为文本: 在候选编码里择优（而非取第一个不报错的）, 绝不静默丢弃中文, 也不抛错。"""
    for enc in _encodings_by_score(content):
        try:
            return content.decode(enc)
        except UnicodeDecodeError:
            # 采样判优选中此编码, 但完整内容尾部有个别非法字节: 退到下一优选编码。
            continue
    # 理论上 latin-1 不会走到这里；最后兜底确保不抛错。
    return content.decode("latin-1", "ignore")


def _read_csv_one_enc(content: bytes, enc: str) -> pd.DataFrame:
    """用指定编码读取 CSV, 并做分隔符嗅探。

    欧洲(荷/德/法)与日本 Excel 导出的 CSV 常用 ';' 作分隔, 也有系统用 '\\t'。默认
    pd.read_csv 只认 ',', 会把整行当成 1 列, 后续列级分析全部失效。所以先让 pandas
    自动嗅探 sep, 失败或只出 1 列时再显式尝试 ';' 与 '\\t', 最后回退默认 ','。
    """
    # 1) 自动嗅探分隔符(python 引擎才支持 sep=None)。
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
                except UnicodeDecodeError:
                    raise
                except Exception:  # noqa: BLE001
                    pass
        # 显式尝试都失败: 保留自动嗅探到的单列结果, 让上层看到内容。
        return df
    except UnicodeDecodeError:
        raise
    except Exception:  # noqa: BLE001
        # 嗅探本身失败(如空文件/损坏): 回退默认 ',' 分隔。
        return pd.read_csv(io.BytesIO(content), encoding=enc)


def read_csv_bytes(content: bytes) -> pd.DataFrame:
    """按"打分选优"确定编码后读取 CSV 字节为 DataFrame（兼容中文常见的 GBK / 带 BOM）。"""
    last: Exception | None = None
    for enc in _encodings_by_score(content):
        try:
            return _read_csv_one_enc(content, enc)
        except UnicodeDecodeError as e:
            # 此编码完整解码在尾部失败: 退到下一优选编码再试。
            last = e
            continue
    raise last if last else ValueError("无法解析 CSV 文件。")
