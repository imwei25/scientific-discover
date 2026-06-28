"""样本量 / 检验效能计算（确定性，使用 statsmodels，不经 LLM）。

支持常见设计：
  - ttest      两独立样本 t 检验（输入效应量 Cohen's d）
  - proportion 两组率比较（输入两组率 p1、p2）
  - anova      单因素方差分析（输入效应量 Cohen's f 与组数 k）
返回每组样本量与总样本量。

另暴露 sweep(scenario, fixed_params, vary, range_values) 函数, 用于
前端滑块实时画"样本量随参数变化"曲线。
"""
from __future__ import annotations

import math

from statsmodels.stats.power import FTestAnovaPower, NormalIndPower, TTestIndPower
from statsmodels.stats.proportion import proportion_effectsize


def compute(design: str, params: dict) -> dict:
    try:
        alpha = float(params.get("alpha", 0.05))
        power = float(params.get("power", 0.8))
        if not (0 < alpha < 1) or not (0 < power < 1):
            return {"ok": False, "error": "α 与 power 需在 0~1 之间。"}

        if design == "ttest":
            d = float(params.get("effect_size", 0))
            if d == 0:
                return {"ok": False, "error": "请填写效应量 Cohen's d（≠0）。"}
            n = TTestIndPower().solve_power(effect_size=abs(d), alpha=alpha, power=power, ratio=1, alternative="two-sided")
            per = math.ceil(n)
            return {"ok": True, "per_group": per, "total": per * 2,
                    "note": f"两独立样本 t 检验，d={d}，α={alpha}，power={power}（双侧）"}

        if design == "proportion":
            p1 = float(params.get("p1", -1))
            p2 = float(params.get("p2", -1))
            if not (0 < p1 < 1) or not (0 < p2 < 1) or p1 == p2:
                return {"ok": False, "error": "请填写两组不同的率 p1、p2（0~1）。"}
            es = abs(proportion_effectsize(p1, p2))
            n = NormalIndPower().solve_power(effect_size=es, alpha=alpha, power=power, ratio=1, alternative="two-sided")
            per = math.ceil(n)
            return {"ok": True, "per_group": per, "total": per * 2,
                    "note": f"两组率比较，p1={p1}、p2={p2}，α={alpha}，power={power}（双侧）"}

        if design == "anova":
            f = float(params.get("effect_size", 0))
            k = int(params.get("k_groups", 0))
            if f == 0 or k < 2:
                return {"ok": False, "error": "请填写效应量 Cohen's f（≠0）与组数 k（≥2）。"}
            n_total = FTestAnovaPower().solve_power(effect_size=abs(f), nobs=None, alpha=alpha, power=power, k_groups=k)
            total = math.ceil(n_total)
            per = math.ceil(total / k)
            return {"ok": True, "per_group": per, "total": per * k,
                    "note": f"单因素方差分析，f={f}，{k} 组，α={alpha}，power={power}"}

        return {"ok": False, "error": f"未知设计类型：{design}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"计算失败：{e}"}


# ---------- 扫描: 单参数 vs 样本量 曲线 ----------

# scenario 对外名 -> 内部 design 名
_SCENARIO_MAP = {
    "two_proportions": "proportion",
    "two_means": "ttest",
    "one_proportion": "one_proportion",
    "one_mean": "one_mean",
}


def _solve_one(scenario: str, params: dict) -> int | None:
    """单点求解 N(总样本量), 失败返回 None。"""
    design = _SCENARIO_MAP.get(scenario)
    if design is None:
        raise ValueError(f"未知 scenario: {scenario}")

    # 复用已有的两组场景
    if design in ("ttest", "proportion"):
        res = compute(design, params)
        if not res.get("ok"):
            return None
        return int(res["total"])

    # 单组场景: 自实现(statsmodels 也可, 这里直接用解析公式)
    from math import ceil

    from scipy.stats import norm
    alpha = float(params.get("alpha", 0.05))
    power = float(params.get("power", 0.8))
    if not (0 < alpha < 1) or not (0 < power < 1):
        return None
    z_a = norm.ppf(1 - alpha / 2)
    z_b = norm.ppf(power)

    if design == "one_proportion":
        # H0: p = p0;  H1: p = p1
        p0 = float(params.get("p0", -1))
        p1 = float(params.get("p1", -1))
        if not (0 < p0 < 1) or not (0 < p1 < 1) or p0 == p1:
            return None
        num = (z_a * (p0 * (1 - p0)) ** 0.5 + z_b * (p1 * (1 - p1)) ** 0.5) ** 2
        n = num / (p1 - p0) ** 2
        return int(ceil(n))

    if design == "one_mean":
        # 单样本 z 检验近似: d = (mu1 - mu0) / sigma
        d = float(params.get("effect_size", 0))
        if d == 0:
            return None
        n = ((z_a + z_b) / abs(d)) ** 2
        return int(ceil(n))

    return None


def sweep(
    scenario: str,
    fixed_params: dict,
    vary: str,
    range_values: list[float],
) -> list[tuple[float, int]]:
    """画"参数 -> 样本量"曲线供前端实时渲染。

    scenario ∈ {'two_proportions','two_means','one_proportion','one_mean'}
    fixed_params: 固定参数字典(如 {'alpha':0.05,'power':0.8,'p1':0.5})
    vary: 要扫描的参数名(如 'effect_size','p2','alpha','power')
    range_values: 该参数依次取值

    返回 [(value, N_total), ...]; 某个点求解失败时 N=0(由前端过滤或显示空缺)。
    """
    out: list[tuple[float, int]] = []
    for v in range_values:
        params = dict(fixed_params)
        params[vary] = v
        try:
            n = _solve_one(scenario, params)
        except Exception:  # noqa: BLE001
            n = None
        out.append((float(v), int(n) if n is not None else 0))
    return out
