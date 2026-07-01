"""检索过滤器(年份范围 + 证据等级/发表类型)在各源上的落地。

各源语法不同, 这里集中把统一的 filters dict 翻译成:
  - PubMed  : 追加到检索式的布尔后缀(pdat 日期 + [pt] 发表类型)
  - Europe PMC: 追加到 query 的布尔后缀(FIRST_PDATE 区间 + PUB_TYPE)
  - OpenAlex: 额外的 URL 参数(from_publication_date + 可选 type:review)

filters 形如 {"year_from": int|None, "study_types": [...],
            "min_quartile": int|None, "min_impact": float|None, "keep_unknown": bool}。
study_types 为空表示不限类型。OpenAlex 仅能表达 review(无 RCT/Meta 精确分类), 据实降级。

质量预筛(min_quartile / min_impact)在各源检索源上无法表达, 改为在结果富集了
SJR 分区(scimago)与影响力代理(impactfactor)之后, 用 apply_quality_filter 在
"喂给 AI 之前"统一过滤——这样 AI 写综述时不会过多倚重低质量文献。命中太少时自动
放宽(保留全部), 避免综述因文献过少而单薄。
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
    """把前端传入的 filters 规整为统一结构(含质量预筛字段)。"""
    if not isinstance(raw, dict):
        raw = {}
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

    # 质量预筛(可选): 最低分区档(1=仅Q1,2=Q1–Q2,...) + 最低影响力代理 + 未知是否保留。
    mq = raw.get("min_quartile")
    try:
        min_quartile = int(mq) if mq not in (None, "", "0") else None
    except (ValueError, TypeError):
        min_quartile = None
    if min_quartile is not None and not (1 <= min_quartile <= 4):
        min_quartile = None
    mi = raw.get("min_impact")
    try:
        min_impact = float(mi) if mi not in (None, "") else None
    except (ValueError, TypeError):
        min_impact = None
    if min_impact is not None and min_impact <= 0:
        min_impact = None
    ku = raw.get("keep_unknown", True)
    keep_unknown = ku.lower() in ("1", "true", "yes") if isinstance(ku, str) else bool(ku)

    return {
        "year_from": year_from, "study_types": study_types,
        "min_quartile": min_quartile, "min_impact": min_impact, "keep_unknown": keep_unknown,
    }


# 质量预筛: 命中数低于该下限时自动放宽(保留全部), 避免综述文献过少。
_QUALITY_FLOOR = 8
_Q_RANK = {"Q1": 1, "Q2": 2, "Q3": 3, "Q4": 4}


def quality_active(filters: dict) -> bool:
    """是否启用了质量预筛(分区或影响力任一)。"""
    return bool(filters.get("min_quartile") or filters.get("min_impact"))


def _passes_quality(p: dict, filters: dict) -> bool:
    """单篇是否通过质量门槛。指标未知时按 keep_unknown 决定(默认保留, 不误杀)。"""
    keep_unknown = filters.get("keep_unknown", True)
    mq = filters.get("min_quartile")
    if mq:
        q = p.get("journal_quartile")
        rank = _Q_RANK.get(q) if q else None
        if rank is None:
            if not keep_unknown:
                return False
        elif rank > mq:
            return False
    mi = filters.get("min_impact")
    if mi:
        imp = p.get("journal_impact")
        if imp is None:
            if not keep_unknown:
                return False
        elif imp < mi:
            return False
    return True


def apply_quality_filter(papers: list[dict], filters: dict) -> tuple[list[dict], int, bool]:
    """喂给 AI 前的质量预筛。返回 (kept, dropped, relaxed)。

    - 未启用 → 原样返回。
    - 启用且有效 → 仅剔除"已知低于门槛"的(未知按 keep_unknown 保留)。
    - 兜底: 通过的不足 _QUALITY_FLOOR 篇 → 放宽(保留全部, relaxed=True), 不让综述太单薄。
    """
    if not quality_active(filters):
        return papers, 0, False
    kept = [p for p in papers if _passes_quality(p, filters)]
    dropped = len(papers) - len(kept)
    if dropped == 0:
        return papers, 0, False
    if len(kept) < _QUALITY_FLOOR:
        return papers, 0, True
    return kept, dropped, False


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


def crossref_filter(filters: dict) -> str:
    """Crossref 的 filter 子句(逗号分隔)。Crossref 无 RCT/Meta 等证据等级分类, 仅落地年份。"""
    parts = []
    yf = filters.get("year_from")
    if yf:
        parts.append(f"from-pub-date:{yf}-01-01")
    return ",".join(parts)


def label(filters: dict) -> str:
    """人类可读的过滤摘要(用于状态提示)。"""
    bits = []
    if filters.get("year_from"):
        bits.append(f"{filters['year_from']} 年至今")
    types = filters.get("study_types") or []
    if types:
        bits.append("/".join(_STUDY_MAP[t]["label"] for t in types))
    mq = filters.get("min_quartile")
    if mq:
        bits.append("仅 Q1" if mq == 1 else f"Q1–Q{mq}")
    mi = filters.get("min_impact")
    if mi:
        bits.append(f"影响力≥{mi:g}")
    return "、".join(bits)
