"""T3 确定性统计方法路由。

核心思想(依据 StatQA 实证): LLM 强于"识别这是哪类统计任务", 弱于"判断某方法在当前
数据条件下是否适用"。所以把**前提假设检验 + 方法选择**从 LLM 手里收回给代码:
  - LLM 只负责把研究问题结构化抽取成"分析规格"(每个分析的结局变量/分组/变量类型);
  - 这里用真实数据跑前提检验(正态性 Shapiro、方差齐性 Levene、期望频数), 用**确定性决策树**
    机械地选检验, 生成"决策卡"给用户看、并把选定方法喂回代码生成。

这样 AI 就没有机会"硬跑参数检验": 方法与前提由代码保证一致 —— 直接消灭最隐蔽的静默错误。
只处理有把握的常见医学场景; 拿不准的(生存分析/复杂回归/多变量)标记为"交由 AI 判断",
绝不比基线更差。
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats

_ALPHA = 0.05
# Shapiro 对样本量的合理区间: 太小无意义, 太大 scipy 会警告/失真。
_SHAPIRO_MIN, _SHAPIRO_MAX = 3, 5000


def _is_numeric(s: pd.Series) -> bool:
    return pd.api.types.is_numeric_dtype(s)


def _fmt_p(p: float | None) -> str:
    if p is None or (isinstance(p, float) and np.isnan(p)):
        return "n/a"
    return "p<0.001" if p < 0.001 else f"p={p:.3f}"


def _normal(x: np.ndarray) -> tuple[bool | None, float | None]:
    """Shapiro-Wilk 正态性; 返回(是否近似正态, p)。样本量不合适时返回(None, None)。"""
    x = x[~np.isnan(x)]
    if len(x) < _SHAPIRO_MIN or len(x) > _SHAPIRO_MAX:
        return None, None
    try:
        _, p = stats.shapiro(x)
        return bool(p > _ALPHA), float(p)
    except Exception:  # noqa: BLE001
        return None, None


def _card(goal, data_desc, assumptions, recommended, fallback="", note="") -> dict:
    return {
        "goal": goal,
        "data": data_desc,
        "assumptions": assumptions,
        "recommended": recommended,
        "fallback": fallback,
        "note": note,
    }


def _route_two_groups(goal, outcome, groupcol, groups, series_by_group) -> dict:
    a, b = groups
    xa = series_by_group[a]
    xb = series_by_group[b]
    na, nb = len(xa), len(xb)
    data_desc = f"2 组独立比较连续变量『{outcome}』；{groupcol}={a}(n={na})、{b}(n={nb})"
    if na < _SHAPIRO_MIN or nb < _SHAPIRO_MIN:
        return _card(
            goal, data_desc, ["某组样本量过小，前提检验不可靠"],
            "样本量过小，建议非参数 Mann-Whitney U 或谨慎解读",
            note="小样本，交由 AI 结合具体情况判断",
        )
    na_ok, pa = _normal(xa)
    nb_ok, pb = _normal(xb)
    normal = bool(na_ok) and bool(nb_ok)
    try:
        _, plev = stats.levene(xa, xb)
        equal_var = plev > _ALPHA
    except Exception:  # noqa: BLE001
        plev, equal_var = None, True
    assumptions = [
        f"正态性(Shapiro): {a} {_fmt_p(pa)}、{b} {_fmt_p(pb)} → {'满足' if normal else '不满足'}",
        f"方差齐性(Levene): {_fmt_p(plev)} → {'满足' if equal_var else '不满足'}",
    ]
    if not normal:
        return _card(goal, data_desc, assumptions, "Mann-Whitney U 检验（非参数）",
                     fallback="", note="因正态性不满足，不使用 t 检验")
    if equal_var:
        return _card(goal, data_desc, assumptions, "独立样本 t 检验",
                     fallback="若你认为方差不齐，可改用 Welch t 检验")
    return _card(goal, data_desc, assumptions, "Welch t 检验（方差不齐）",
                 fallback="正态但方差不齐，故用 Welch 校正")


def _route_multi_groups(goal, outcome, groupcol, groups, series_by_group) -> dict:
    counts = ", ".join(f"{g}(n={len(series_by_group[g])})" for g in groups)
    data_desc = f"{len(groups)} 组独立比较连续变量『{outcome}』；{groupcol}: {counts}"
    normals, ps = [], []
    for g in groups:
        ok, p = _normal(series_by_group[g])
        normals.append(bool(ok))
        ps.append(p)
    all_normal = all(normals)
    arrays = [series_by_group[g][~np.isnan(series_by_group[g])] for g in groups]
    try:
        _, plev = stats.levene(*arrays)
        equal_var = plev > _ALPHA
    except Exception:  # noqa: BLE001
        plev, equal_var = None, True
    assumptions = [
        f"各组正态性(Shapiro): {', '.join(f'{g} {_fmt_p(p)}' for g, p in zip(groups, ps))} → {'均满足' if all_normal else '有组不满足'}",
        f"方差齐性(Levene): {_fmt_p(plev)} → {'满足' if equal_var else '不满足'}",
    ]
    if all_normal and equal_var:
        return _card(goal, data_desc, assumptions, "单因素方差分析 (One-way ANOVA)",
                     fallback="若显著，随后做事后两两比较并 Holm/Tukey 校正")
    if all_normal and not equal_var:
        return _card(goal, data_desc, assumptions, "Welch ANOVA（方差不齐）",
                     fallback="事后用 Games-Howell 校正")
    return _card(goal, data_desc, assumptions, "Kruskal-Wallis 检验（非参数）",
                 fallback="若显著，事后用 Dunn 检验并校正", note="因正态性不满足")


def _route_categorical(goal, outcome, groupcol, df) -> dict:
    sub = df[[groupcol, outcome]].dropna()
    ct = pd.crosstab(sub[groupcol], sub[outcome])
    data_desc = f"分类变量『{outcome}』在 {groupcol} 各组的分布（{ct.shape[0]}×{ct.shape[1]} 列联表）"
    try:
        chi2, p, dof, expected = stats.chi2_contingency(ct)
        min_exp = float(np.min(expected))
        small = min_exp < 5
        assumptions = [f"最小期望频数 = {min_exp:.2f} → {'有单元格<5' if small else '均≥5'}"]
        if ct.shape == (2, 2) and small:
            return _card(goal, data_desc, assumptions, "Fisher 精确检验",
                         note="2×2 且期望频数<5，用 Fisher 更稳")
        if small:
            return _card(goal, data_desc, assumptions,
                         "卡方检验（注意：有期望频数<5，结果需谨慎，或合并类别）",
                         fallback="可考虑合并稀疏类别或用精确检验")
        return _card(goal, data_desc, assumptions, "卡方检验 (Pearson chi-square)")
    except Exception:  # noqa: BLE001
        return _card(goal, data_desc, ["列联表构建失败"],
                     "交由 AI 判断", note="数据不适合直接构建列联表")


def _route_correlation(goal, xcol, ycol, df) -> dict:
    sub = df[[xcol, ycol]].dropna()
    data_desc = f"两个连续变量『{xcol}』与『{ycol}』的相关（n={len(sub)}）"
    if len(sub) < _SHAPIRO_MIN:
        return _card(goal, data_desc, ["样本量过小"], "样本过小，谨慎", note="")
    _, px = _normal(sub[xcol].to_numpy())
    _, py = _normal(sub[ycol].to_numpy())
    both_normal = (px is not None and px > _ALPHA) and (py is not None and py > _ALPHA)
    assumptions = [f"正态性(Shapiro): {xcol} {_fmt_p(px)}、{ycol} {_fmt_p(py)} → {'均近似正态' if both_normal else '非全正态'}"]
    if both_normal:
        return _card(goal, data_desc, assumptions, "Pearson 相关",
                     fallback="若关系非线性/有离群，改用 Spearman")
    return _card(goal, data_desc, assumptions, "Spearman 秩相关（非参数）",
                 note="因非全正态，用秩相关更稳健")


def route_one(df: pd.DataFrame, spec: dict) -> dict | None:
    """对单个分析规格路由; 无法可靠处理时返回 None(交由 AI 自行判断)。"""
    goal = str(spec.get("goal") or "").strip() or "（未命名分析）"
    outcome = spec.get("outcome")
    group = spec.get("group")
    otype = (spec.get("outcome_type") or "").lower()
    design = (spec.get("design") or "").lower()
    paired = bool(spec.get("paired"))
    cols = set(map(str, df.columns))

    # 列必须真实存在, 否则不硬猜(避免给出误导性的决策卡)。
    if outcome is not None and str(outcome) not in cols:
        return None
    if group is not None and str(group) not in cols:
        group = None

    # 配对/重复测量: 决策更复杂, 交由 AI(仅给提示)。
    if paired or design in ("within", "repeated"):
        return _card(goal, f"配对/重复测量设计，结局『{outcome}』",
                     ["配对设计的前提检验较复杂"],
                     "配对 t 检验 / Wilcoxon 符号秩 / 重复测量 ANOVA / Friedman（按分布与组数）",
                     note="配对/重复测量，交由 AI 结合数据判断")

    # 相关
    if design == "correlation" or otype == "continuous" and group is None and spec.get("x") and spec.get("y"):
        x, y = str(spec.get("x") or outcome), str(spec.get("y"))
        if x in cols and y in cols and _is_numeric(df[x]) and _is_numeric(df[y]):
            return _route_correlation(goal, x, y, df)
        return None

    # 生存分析: 交由 AI(lifelines)。
    if otype in ("time_to_event", "survival"):
        return _card(goal, f"时间到事件结局『{outcome}』",
                     ["生存数据含删失"],
                     "Kaplan-Meier + log-rank（组间）/ Cox 比例风险回归（多因素）",
                     note="生存分析，交由 AI 用 lifelines 实现")

    # 组间比较连续结局
    if group is not None and outcome is not None and _is_numeric(df[str(outcome)]) and otype in ("", "continuous"):
        sub = df[[str(group), str(outcome)]].dropna()
        # 分组取值(样本量≥2 的组才纳入)
        vc = sub[str(group)].value_counts()
        groups = [g for g, c in vc.items() if c >= 2]
        if len(groups) < 2:
            return None
        series_by_group = {g: sub.loc[sub[str(group)] == g, str(outcome)].to_numpy(dtype=float) for g in groups}
        if len(groups) == 2:
            return _route_two_groups(goal, str(outcome), str(group), groups, series_by_group)
        if len(groups) <= 8:
            return _route_multi_groups(goal, str(outcome), str(group), groups, series_by_group)
        return None

    # 分类结局 × 分组 → 列联表
    if group is not None and outcome is not None and otype in ("binary", "categorical", "nominal", "ordinal"):
        return _route_categorical(goal, str(outcome), str(group), df)

    return None


def route_analyses(df: pd.DataFrame, specs: list[dict]) -> list[dict]:
    """对一组分析规格逐个路由, 返回可用的决策卡列表(跳过无法可靠处理的)。"""
    cards = []
    for spec in specs or []:
        try:
            card = route_one(df, spec)
        except Exception:  # noqa: BLE001
            card = None
        if card:
            cards.append(card)
    return cards


def cards_to_prompt(cards: list[dict]) -> str:
    """把决策卡转成喂给代码生成的文本(系统判定的方法与前提)。"""
    if not cards:
        return ""
    lines = []
    for i, c in enumerate(cards, 1):
        lines.append(f"分析{i}：{c['goal']}")
        lines.append(f"  数据情况：{c['data']}")
        if c.get("assumptions"):
            lines.append("  前提检查：" + "；".join(c["assumptions"]))
        lines.append(f"  → 建议方法：{c['recommended']}")
        if c.get("fallback"):
            lines.append(f"  备选/说明：{c['fallback']}")
        if c.get("note"):
            lines.append(f"  备注：{c['note']}")
    return "\n".join(lines)
