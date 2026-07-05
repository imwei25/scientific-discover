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
# 单元格中间嵌入的身份证/手机 —— 用于"混写单元格"("患者张三 13800138000 身份证 11...")
# 之前只匹配"整格纯数字", 混写完全漏检。这里改用 finditer + 边界检查, 只要串里含就命中。
_RE_ID_CARD = re.compile(r"(?<![\dXx])\d{17}[\dXx](?![\dXx])")
_RE_PHONE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
# 仅匹配纯 18 位身份证(单元格本身就是身份证)
_RE_ID_FULL = re.compile(r"^\d{17}[\dXx]$")
_RE_PHONE_FULL = re.compile(r"^1[3-9]\d{9}$")

# 中文姓名"子串检测": 常见姓氏 + 1-3 汉字, 用于混写单元格。
# 精度取舍: 只识别常见 100 姓, 减少误伤(如"研究"两字被误当姓名)。
_COMMON_SURNAMES = (
    "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾"
    "萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏"
    "韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴"
)
# 姓氏子串: 命中条件放宽 —— 名后是非中文分隔, 或紧接职务/关系词 (患者/医师...) 都算.
# 医学场景里"主治医师王五完成手术"这类"姓名+动词"漏检严重, 用 role-word lookahead 补上.
# 同时用黑名单剔除常见"姓氏字+其他汉字"的成语/术语误伤 (如高血压/石头/于是).
_NAME_ROLE_WORDS = (
    # 角色/关系名词
    "患者|家属|医师|医生|主任|教授|女士|先生|同志|病人|受试者|主治|"
    "门诊|入组|出组|随访|复诊|大夫|护士|同学|老师|博士|硕士|工程师|"
    # 常见"人名后接动词"上下文, 覆盖 "王五完成手术" 这类漏检场景
    "完成|说|表示|回答|描述|报告|主诉|负责|参与|入选|签署|同意|拒绝|"
    "接受|进行|承担|填写|提交|通过|退出|出院|入院|就诊|前来|因|于"
)
_RE_NAME_SUBSTR = re.compile(
    # 非贪婪 {1,3}?: 尽早满足 lookahead 停下, 产出 "张三" 而非 "张三入组".
    rf"[{_COMMON_SURNAMES}][\u4e00-\u9fa5]{{1,3}}?(?=[^\u4e00-\u9fa5]|(?:{_NAME_ROLE_WORDS}))"
)
# 假阳性黑名单: 以常见姓氏开头但明显不是人名的日常词/术语.
# 命中后从"姓名候选"中剔除, 避免"高血压患者"里的"高血压"被当姓名弹提示.
_NAME_BLOCKLIST = frozenset({
    "高血压", "高血糖", "高血脂", "高血钾", "高血钙", "高胆固醇", "高浓度", "高剂量",
    "石头", "石灰", "石油", "石英", "于是", "于此", "于今", "余量", "余数", "金属",
    "金融", "金色", "金黄", "钱财", "钱包", "白细胞", "白蛋白", "白血病", "夏天",
    "冬天", "秋天", "春天", "任何", "任意", "史料", "史书", "范围", "范畴", "田野",
    "田间", "尹始", "廖廖",
})
# MRN/住院号子串: 明显医院号前缀 + 数字
_RE_MRN_SUBSTR = re.compile(
    r"(?:住院号|病案号|门诊号|MRN|Patient\s*ID|医保号)[\s:：=]*([A-Z0-9\-]{4,20})",
    re.I,
)
# 邮箱、简版银行卡(13-19 位数字连号)、简版中文地址前缀
_RE_EMAIL = re.compile(r"[\w\.\-]+@[\w\.\-]+\.[A-Za-z]{2,}")
_RE_BANK = re.compile(r"(?<!\d)\d{13,19}(?!\d)")
# 地址: 必须含"省/市/区/县/镇/街道/路/弄"这类真正的行政/道路锚点; "号"单独出现太模糊
# (会误伤"住院号/病案号")故不作独立锚点, 必须接在道路名后(如"XX 路 3 号")
_RE_ADDRESS = re.compile(
    r"[\u4e00-\u9fa5]{2,10}(?:省|市|区|县|镇|街道|大道)[\u4e00-\u9fa5\d]{0,30}"
    r"|[\u4e00-\u9fa5]{2,10}路\s*\d+\s*号?"
)

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
    改造: 支持"子串检测"——混写单元格("患者张三 MRN12345678")也能命中,
    不再只识别"整格恰好是姓名/身份证"的规则。
    """
    if cell is None:
        return []
    if isinstance(cell, float) and pd.isna(cell):
        return []
    s = str(cell).strip()
    if not s:
        return []

    out: list[str] = []
    # 身份证: 整格或子串, 必须通过校验
    for m in _RE_ID_CARD.finditer(s):
        if _id_card_valid(m.group(0)):
            out.append("id_card")
            break
    # 手机号: 整格或子串
    if _RE_PHONE_FULL.match(s) or _RE_PHONE.search(s):
        out.append("phone")

    # 名字: ①列名暗示且整格 2-4 汉字, 或 ②子串命中常见姓氏组合
    if col_name_kind == "name" and _RE_NAME_HAN.match(s):
        out.append("name")
    elif _RE_NAME_SUBSTR.search(s):
        out.append("name")

    # MRN: ①列名暗示接受任意非空; ②子串命中"住院号: xxx"这类模式
    if col_name_kind == "mrn":
        out.append("mrn")
    elif _RE_MRN_SUBSTR.search(s):
        out.append("mrn")

    # 邮箱/银行卡/地址子串
    if _RE_EMAIL.search(s):
        out.append("email")
    if _RE_BANK.search(s) and "id_card" not in out:  # 18 位身份证会先命中银行卡, 排除
        out.append("bank")
    if _RE_ADDRESS.search(s):
        out.append("address")

    # 出生日期: 列名暗示 + 可解析
    if col_name_kind == "birth" and _try_parse_date(s) is not None:
        out.append("birth")

    # 去重, 保留出现顺序
    seen = set()
    result = []
    for t in out:
        if t not in seen:
            seen.add(t)
            result.append(t)
    return result


def scan_text(text: str) -> dict:
    """对自由文本(稿件/审稿意见/回信)扫描 PHI, 返回命中类型与样例。

    用于 rebuttal/checklist/grant 等"上传稿件到 LLM"的入口前置检查:
    发现命中时前端可弹"稿件疑似含 X 条个人信息, 是否继续?"
    """
    if not text:
        return {"hits": {}, "total": 0}
    hits: dict[str, list[str]] = {}
    checks = [
        ("id_card", _RE_ID_CARD, _id_card_valid),
        ("phone", _RE_PHONE, None),
        ("email", _RE_EMAIL, None),
        ("name", _RE_NAME_SUBSTR, None),
        ("mrn", _RE_MRN_SUBSTR, None),
        ("address", _RE_ADDRESS, None),
        # 银行卡: 13-19 位连号数字 (原来只有 apply() 单元格模式查, 自由文本一致对齐)
        ("bank", _RE_BANK, None),
    ]
    for kind, rx, validator in checks:
        found = []
        for m in rx.finditer(text):
            val = m.group(0)
            if validator and not validator(val):
                continue
            # 姓名假阳性剔除: 常见"姓氏字+日常词"(高血压/石头/于是) 不算 PHI
            if kind == "name" and val in _NAME_BLOCKLIST:
                continue
            found.append(val)
            if len(found) >= 5:
                break
        if found:
            hits[kind] = found
    total = sum(len(v) for v in hits.values())
    return {"hits": hits, "total": total}


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


def _substr_mask(s: str) -> str:
    """对文本内所有 PHI 子串就地打码; 用于兜底混写单元格/自由文本。
    确定性类型 (身份证/手机/邮箱/MRN/银行卡) 直接 mask; 姓名走 blocklist 后剩余
    的高置信命中也 mask (避免"最后一道防线"漏姓名到 LLM)。"""
    def _id_sub(m):
        v = m.group(0)
        return _mask_id_card(v) if _id_card_valid(v) else v
    s = _RE_ID_CARD.sub(_id_sub, s)
    s = _RE_PHONE.sub(lambda m: _mask_phone(m.group(0)), s)
    s = _RE_EMAIL.sub("[已脱敏邮箱]", s)
    # MRN / 银行卡 / 姓名: R14 已在 scan_text 里加了识别, 这里同步 mask
    s = _RE_MRN_SUBSTR.sub(lambda m: m.group(0).split(m.group(1))[0] + "[已脱敏MRN]", s)
    s = _RE_BANK.sub("[已脱敏银行卡]", s)
    # 姓名: 命中 blocklist 的日常词跳过 (由 scan_text 相同逻辑保持一致)
    def _name_sub(m):
        v = m.group(0)
        if v in _NAME_BLOCKLIST:
            return v
        return "[已脱敏姓名]"
    s = _RE_NAME_SUBSTR.sub(_name_sub, s)
    return s


def redact_text(text: str) -> str:
    """对自由文本做兜底脱敏: 打码身份证/手机/邮箱, 保留原文其他内容。
    用于 rebuttal/checklist/grant 等出站前的最后一道防线。"""
    if not text:
        return text
    return _substr_mask(text)


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
                # 兜底: 混写单元格("患者张三 45 岁") 用子串脱敏
                masked = _RE_NAME_SUBSTR.sub(lambda m: counter.get(m.group(0)), s)
                if masked != s:
                    new_vals.append(masked)
                    col_map[s] = masked
                    continue

            # 无论主类型是什么, 只要该单元格包含身份证/手机/邮箱这类"确定性子串",
            # 都做兜底打码——避免"混写单元格中的次要 PHI"整格泄漏。
            masked = _substr_mask(s)
            if masked != s:
                new_vals.append(masked)
                col_map[s] = masked
                continue

            new_vals.append(v)

        df[col] = new_vals
        if col_map:
            mapping[col_str] = col_map

    out_bytes = _dump(df, filename)
    return out_bytes, mapping
