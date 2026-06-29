"""病例数据脱敏 (PHI Detection & Redaction)。

设计目标:
  - 扫描 csv/xlsx 字节, 识别每一列可能包含的 PHI(个人健康信息)类型
    与匹配单元格数;
  - 按用户勾选的列, 用确定性映射做就地替换, 输出脱敏后的字节流 + 映射表。

检测规则(贴近中文临床表习惯):
  - 姓名: 列名含 姓名/患者/姓/Name/Patient(大小写不敏感) + 单元格是 2-4 个汉字
  - 身份证: 18 位正则 + 校验位(GB 11643-1999)
  - 手机号: 1 + [3-9] + 9 位数字
  - MRN/住院号: 列名匹配 住院号|病案号|MRN|Patient ID|医保号
  - 出生日期: 列名含 出生|生日|DOB|Birth + 单元格能解析为日期 -> 保留年份(YYYY)

替换策略:
  - 姓名/MRN -> 顺序编号 PT0001..PT9999, 同值映射同值
  - 身份证 -> 保留前 4 位 + 后 4 位, 中间 10 位用 * 打码
  - 手机号 -> 保留前 3 后 4, 中间 4 位用 * 打码
  - 出生日期 -> 仅保留年份(YYYY)

对外:
  - scan(data, filename) -> dict
  - apply(data, filename, columns_to_redact) -> (bytes, mapping)

映射表 mapping 的结构:
  {
    "<列名>": {"<原值>": "<新值>", ...},
    ...
  }
"""
from __future__ import annotations

import io
import re
from datetime import datetime
from typing import Any

import pandas as pd

from .textio import read_csv_bytes


# ---------- 正则与列名关键字 ----------

_NAME_COLUMN_HINTS = ("姓名", "患者", "姓", "name", "patient")
_MRN_COLUMN_RE = re.compile(r"(住院号|病案号|mrn|patient\s*id|医保号)", re.I)
_BIRTH_COLUMN_HINTS = ("出生", "生日", "dob", "birth")

_RE_NAME_HAN = re.compile(r"^[\u4e00-\u9fa5]{2,4}$")
_RE_ID_CARD = re.compile(r"\b\d{17}[\dXx]\b")
_RE_PHONE = re.compile(r"\b1[3-9]\d{9}\b")
# 仅匹配纯 18 位身份证(单元格本身就是身份证)
_RE_ID_FULL = re.compile(r"^\d{17}[\dXx]$")
_RE_PHONE_FULL = re.compile(r"^1[3-9]\d{9}$")

# 身份证校验位权重
_ID_WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
_ID_CHECK = "10X98765432"


def _id_card_valid(s: str) -> bool:
    """中国大陆 18 位身份证校验位验证(GB 11643-1999)。"""
    if not _RE_ID_FULL.match(s):
        return False
    s = s.upper()
    try:
        nums = [int(c) for c in s[:17]]
    except ValueError:
        return False
    chk = sum(n * w for n, w in zip(nums, _ID_WEIGHTS)) % 11
    return _ID_CHECK[chk] == s[-1]


def _looks_name_column(col: str) -> bool:
    if not col:
        return False
    low = str(col).lower()
    return any(h.lower() in low for h in _NAME_COLUMN_HINTS)


def _looks_mrn_column(col: str) -> bool:
    return bool(_MRN_COLUMN_RE.search(str(col or "")))


def _looks_birth_column(col: str) -> bool:
    if not col:
        return False
    low = str(col).lower()
    return any(h.lower() in low for h in _BIRTH_COLUMN_HINTS)


def _try_parse_date(v: Any) -> datetime | None:
    """宽松地把单元格解析为日期。"""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, (pd.Timestamp, datetime)):
        try:
            return pd.Timestamp(v).to_pydatetime()
        except Exception:  # noqa: BLE001
            return None
    s = str(v).strip()
    if not s:
        return None
    # 常见格式快速尝试
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y%m%d", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    # 兜底: 让 pandas 尝试
    try:
        ts = pd.to_datetime(s, errors="coerce")
        if pd.isna(ts):
            return None
        return ts.to_pydatetime()
    except Exception:  # noqa: BLE001
        return None


# ---------- IO ----------

def _load(filename: str, data: bytes) -> pd.DataFrame:
    name = (filename or "").lower()
    if name.endswith((".xlsx", ".xls")):
        return pd.read_excel(io.BytesIO(data), dtype=object)
    return read_csv_bytes(data).astype(object)


def _dump(df: pd.DataFrame, filename: str) -> bytes:
    name = (filename or "").lower()
    buf = io.BytesIO()
    if name.endswith((".xlsx", ".xls")):
        with pd.ExcelWriter(buf, engine="openpyxl") as writer:
            df.to_excel(writer, index=False)
        return buf.getvalue()
    # CSV: 默认 utf-8-sig 以便 Excel 中文不乱码
    df.to_csv(buf, index=False, encoding="utf-8-sig")
    return buf.getvalue()


# ---------- 扫描 ----------

def _detect_cell_phi(cell: Any, col_name_kind: str | None) -> list[str]:
    """对单个单元格判定可能的 PHI 类型, 返回类型列表(可多种)。

    col_name_kind: 列名暗示的"主类型"(name / mrn / birth / None), 用于辅助判定。
    """
    if cell is None:
        return []
    if isinstance(cell, float) and pd.isna(cell):
        return []
    s = str(cell).strip()
    if not s:
        return []

    out: list[str] = []
    # 身份证: 优先单独格(纯 18 位)
    if _RE_ID_FULL.match(s) and _id_card_valid(s):
        out.append("id_card")
    # 手机号: 纯 11 位
    if _RE_PHONE_FULL.match(s):
        out.append("phone")

    # 名字: 必须列名暗示
    if col_name_kind == "name" and _RE_NAME_HAN.match(s):
        out.append("name")

    # MRN: 列名暗示, 接受任意非空字符串
    if col_name_kind == "mrn":
        out.append("mrn")

    # 出生日期: 列名暗示 + 可解析
    if col_name_kind == "birth" and _try_parse_date(s) is not None:
        out.append("birth")

    return out


def scan(data: bytes, filename: str) -> dict:
    """扫描数据, 返回每列 PHI 类型/计数/样例与总行数。

    返回:
      {
        "columns": [
          {"name": str, "phi_types": [str, ...], "count": int, "samples": [str, ...]},
          ...
        ],
        "total_rows": int
      }
    """
    df = _load(filename, data)
    total_rows = int(df.shape[0])
    columns_report: list[dict] = []

    for col in df.columns:
        col_str = str(col)
        # 判断列名暗示
        kind: str | None = None
        if _looks_name_column(col_str):
            kind = "name"
        elif _looks_mrn_column(col_str):
            kind = "mrn"
        elif _looks_birth_column(col_str):
            kind = "birth"

        col_types: set[str] = set()
        col_count = 0
        samples: list[str] = []
        for v in df[col]:
            kinds = _detect_cell_phi(v, kind)
            if kinds:
                col_types.update(kinds)
                col_count += 1
                if len(samples) < 3:
                    samples.append(str(v))

        if col_types:
            # 把列名暗示放在前面, 让前端展示更稳定
            ordered = []
            preferred = ["name", "id_card", "phone", "mrn", "birth"]
            for k in preferred:
                if k in col_types:
                    ordered.append(k)
            columns_report.append({
                "name": col_str,
                "phi_types": ordered,
                "count": int(col_count),
                "samples": samples,
            })

    return {"columns": columns_report, "total_rows": total_rows}


# ---------- 脱敏 ----------

class _Counter:
    """顺序编号生成器: PT0001, PT0002, ..."""

    def __init__(self):
        self._n = 0
        self._map: dict[str, str] = {}

    def get(self, raw: str) -> str:
        if raw in self._map:
            return self._map[raw]
        self._n += 1
        token = f"PT{self._n:04d}"
        self._map[raw] = token
        return token


def _mask_id_card(s: str) -> str:
    if not _RE_ID_FULL.match(s):
        return s
    return s[:4] + ("*" * 10) + s[-4:]


def _mask_phone(s: str) -> str:
    if not _RE_PHONE_FULL.match(s):
        return s
    return s[:3] + ("*" * 4) + s[-4:]


def _mask_birth(v: Any) -> str:
    dt = _try_parse_date(v)
    if dt is None:
        return "" if v is None else str(v)
    return f"{dt.year:04d}"


def apply(
    data: bytes,
    filename: str,
    columns_to_redact: list[str],
) -> tuple[bytes, dict]:
    """按指定列脱敏, 返回 (脱敏字节, 映射表 dict)。

    columns_to_redact: 用户勾选要脱敏的列名列表
    映射表:
      {
        "<列名>": { "<原值>": "<脱敏后值>", ... },
        ...
      }
    """
    df = _load(filename, data)
    targets = set(str(c) for c in (columns_to_redact or []))
    mapping: dict[str, dict[str, str]] = {}

    # 每列(若为姓名/MRN)有独立的顺序编号空间, 互不干扰
    counters: dict[str, _Counter] = {}

    for col in df.columns:
        col_str = str(col)
        if col_str not in targets:
            continue

        # 判定列类型: 优先列名提示, 否则在该列扫描决定主类型
        if _looks_name_column(col_str):
            col_kind = "name"
        elif _looks_mrn_column(col_str):
            col_kind = "mrn"
        elif _looks_birth_column(col_str):
            col_kind = "birth"
        else:
            # 没有列名提示时按内容投票
            votes = {"id_card": 0, "phone": 0, "name": 0}
            for v in df[col]:
                if v is None or (isinstance(v, float) and pd.isna(v)):
                    continue
                s = str(v).strip()
                if _RE_ID_FULL.match(s) and _id_card_valid(s):
                    votes["id_card"] += 1
                elif _RE_PHONE_FULL.match(s):
                    votes["phone"] += 1
                elif _RE_NAME_HAN.match(s):
                    votes["name"] += 1
            col_kind = max(votes, key=votes.get) if max(votes.values()) > 0 else "name"

        col_map: dict[str, str] = {}
        new_vals = []
        counter = counters.setdefault(col_str, _Counter())

        for v in df[col]:
            if v is None or (isinstance(v, float) and pd.isna(v)):
                new_vals.append(v)
                continue
            s = str(v)
            stripped = s.strip()

            # 按列类型分发
            if col_kind == "id_card":
                if _RE_ID_FULL.match(stripped) and _id_card_valid(stripped):
                    new = _mask_id_card(stripped)
                    new_vals.append(new)
                    col_map[s] = new
                    continue
            elif col_kind == "phone":
                if _RE_PHONE_FULL.match(stripped):
                    new = _mask_phone(stripped)
                    new_vals.append(new)
                    col_map[s] = new
                    continue
            elif col_kind == "birth":
                new = _mask_birth(v)
                new_vals.append(new)
                col_map[s] = new
                continue
            elif col_kind == "mrn":
                # MRN: 不限制原文形态, 全部替换为顺序编号
                new = counter.get(stripped)
                new_vals.append(new)
                col_map[s] = new
                continue
            elif col_kind == "name":
                if _RE_NAME_HAN.match(stripped):
                    new = counter.get(stripped)
                    new_vals.append(new)
                    col_map[s] = new
                    continue
            new_vals.append(v)

        df[col] = new_vals
        if col_map:
            mapping[col_str] = col_map

    out_bytes = _dump(df, filename)
    return out_bytes, mapping
