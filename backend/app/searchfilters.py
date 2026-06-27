"""检索过滤器(年份范围 + 证据等级/发表类型)在各源上的落地。

各源语法不同, 这里集中把统一的 filters dict 翻译成:
  - PubMed  : 追加到检索式的布尔后缀(pdat 日期 + [pt] 发表类型)
  - Europe PMC: 追加到 query 的布尔后缀(FIRST_PDATE 区间 + PUB_TYPE)
  - OpenAlex: 额外的 URL 参数(from_publication_date + 可选 type:review)

filters 形如 {"year_from": int|None, "study_types": ["rct","meta","systematic","review"]}。
study_types 为空表示不限类型。OpenAlex 仅能表达 review(无 RCT/Meta 精确分类), 据实降级。
"""
from __future__ import annotations

# 统一的证据等级 key → 各源的发表类型表达
_STUDY_MAP = {
    "rct": {
        "label": "随机对照试验",
        "pubmed": "Randomized Controlled Trial[pt]",
        "epmc": 'PUB_TYPE:"Randomized Controlled Trial"',
    },
    "meta": {
        "label": "Meta 分析",
        "pubmed": "Meta-Analysis[pt]",
        "epmc": 'PUB_TYPE:"Meta-Analysis"',
    },
    "systematic": {
        "label": "系统综述",
        "pubmed": "Systematic Review[pt]",
        "epmc": 'PUB_TYPE:"Systematic Review"',
    },
    "review": {
        "label": "综述",
        "pubmed": "Review[pt]",
        "epmc": 'PUB_TYPE:"Review"',
    },
}

VALID_STUDY_TYPES = tuple(_STUDY_MAP.keys())


def normalize(raw) -> dict:
    """把前端传入的 filters 规整为 {year_from:int|None, study_types:[...]}。"""
    if not isinstance(raw, dict):
        return {"year_from": None, "study_types": []}
    yf = raw.get("year_from")
    try:
        year_from = int(yf) if yf not in (None, "", "0") else None
    except (ValueError, TypeError):
        year_from = None
    if year_from is not None and not (1800 <= year_from <= 2100):
        year_from = None
    st = raw.get("study_types") or []
    if isinstance(st, str):
        st = [s.strip() for s in st.split(",")]
    study_types = [s for s in st if s in _STUDY_MAP]
    return {"year_from": year_from, "study_types": study_types}


def _types_clause(filters: dict, source: str) -> str:
    types = filters.get("study_types") or []
    if not types:
        return ""
    parts = [_STUDY_MAP[t][source] for t in types if t in _STUDY_MAP]
    if not parts:
        return ""
    return "(" + " OR ".join(parts) + ")"


def pubmed_suffix(filters: dict) -> str:
    """返回追加到 PubMed term 的布尔后缀(含前导空格), 无过滤则空串。"""
    out = []
    yf = filters.get("year_from")
    if yf:
        out.append(f'("{yf}"[pdat] : "3000"[pdat])')
    tc = _types_clause(filters, "pubmed")
    if tc:
        out.append(tc)
    return ("" if not out else " AND " + " AND ".join(out))


def epmc_suffix(filters: dict) -> str:
    """返回追加到 Europe PMC query 的布尔后缀(含前导空格), 无过滤则空串。"""
    out = []
    yf = filters.get("year_from")
    if yf:
        out.append(f"(FIRST_PDATE:[{yf}-01-01 TO 2100-12-31])")
    tc = _types_clause(filters, "epmc")
    if tc:
        out.append(tc)
    return ("" if not out else " AND " + " AND ".join(out))


def openalex_params(filters: dict) -> dict:
    """OpenAlex 的额外过滤(并入 filter 参数)。返回 {filter_extra: str}。"""
    parts = []
    yf = filters.get("year_from")
    if yf:
        parts.append(f"from_publication_date:{yf}-01-01")
    # OpenAlex 仅能近似表达 review(无 RCT/Meta 精确类型) → 仅当只选 review/systematic 时加 type:review
    types = filters.get("study_types") or []
    if types and set(types) <= {"review", "systematic"}:
        parts.append("type:review")
    return {"filter_extra": ",".join(parts)}


def label(filters: dict) -> str:
    """人类可读的过滤摘要(用于状态提示)。"""
    bits = []
    if filters.get("year_from"):
        bits.append(f"{filters['year_from']} 年至今")
    types = filters.get("study_types") or []
    if types:
        bits.append("/".join(_STUDY_MAP[t]["label"] for t in types))
    return "、".join(bits)
