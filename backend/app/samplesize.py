"""样本量 / 检验效能计算（确定性，使用 statsmodels，不经 LLM）。

支持常见设计：
  - ttest      两独立样本 t 检验（输入效应量 Cohen's d）
  - proportion 两组率比较（输入两组率 p1、p2）
  - anova      单因素方差分析（输入效应量 Cohen's f 与组数 k）
返回每组样本量与总样本量。
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
