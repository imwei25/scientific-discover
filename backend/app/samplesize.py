"""样本量 / 检验效能计算（确定性，使用 statsmodels，不经 LLM）。

支持常见设计：
  - ttest      两独立样本 t 检验（输入效应量 Cohen's d）
  - proportion 两组率比较（输入两组率 p1、p2）
  - anova      单因素方差分析（输入效应量 Cohen's f 与组数 k）
  - survival   生存分析 log-rank / Cox（Schoenfeld 公式）
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

        if design == "survival":
            hr = float(params.get("hr", 0))
            event_rate = float(params.get("event_rate", 0))
            alloc_ratio = float(params.get("alloc_ratio", 1.0))
            res = calc_survival_n(hr=hr, event_rate=event_rate,
                                  alloc_ratio=alloc_ratio, alpha=alpha, power=power)
            if not res.get("ok"):
                return res
            # 归一到旧接口字段, 同时保留 events / n_per_group 供前端展示
            per_group = res["n_per_group"]
            total = res["n_total"]
            per = per_group[0] if per_group else math.ceil(total / 2)
            return {
                "ok": True,
                "per_group": per,
                "total": total,
                "events": res["events"],
                "n_per_group": per_group,
                "note": f"生存分析(log-rank/Cox, Schoenfeld)，HR={hr}，事件率={event_rate}，α={alpha}，power={power}，分配比={alloc_ratio}",
            }

        return {"ok": False, "error": f"未知设计类型：{design}"}
    except (ValueError, TypeError) as e:  # 参数类型/取值不合法 -> 友好提示
        msg = str(e)
        if "could not convert" in msg.lower() or "invalid literal" in msg.lower():
            hint = "计算失败：输入的数值格式不合法（比如把百分比写成了 %），请填数字（如 0.05 或 5）。"
        elif "log" in msg.lower() or "domain" in msg.lower():
            hint = "计算失败：某个参数超出取值范围（例如比例需在 0–1 之间；HR、比率不能为 0 或负数）。"
        else:
            hint = "计算失败：请核对每一项输入的取值范围是否合理（α 常见 0.05；power 常见 0.8；比例 0–1）。"
        return {"ok": False, "error": hint, "detail": msg}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "计算失败：内部错误，请检查输入并重试。", "detail": str(e)}


# ---------- 生存分析（log-rank / Cox, Schoenfeld 公式） ----------

def calc_survival_n(
    hr: float,
    event_rate: float,
    alloc_ratio: float = 1.0,
    alpha: float = 0.05,
    power: float = 0.80,
) -> dict:
    """基于 Schoenfeld 公式估算 log-rank / Cox 所需总事件数与总样本量。

    公式:  E = ((z_{α/2} + z_β)^2 * (1 + k)^2) / (k * (ln HR)^2),  k = alloc_ratio
    再由随访期事件发生率反推总样本:  N = E / event_rate

    参数:
      hr           风险比 (Hazard Ratio); 需 > 0 且 ≠ 1
      event_rate   随访期总事件发生率 (0, 1]
      alloc_ratio  试验组:对照组 分配比 k (默认 1)
      alpha        双侧显著性水平 (0, 1)
      power        检验效能 (0, 1)

    返回: {ok, events, n_total, n_per_group:[n_ctrl, n_trt], notes:[...]}
    失败时返回 {ok: False, error: <中文说明>}
    """
    from math import ceil, log

    from scipy.stats import norm

    try:
        hr = float(hr)
        event_rate = float(event_rate)
        alloc_ratio = float(alloc_ratio)
        alpha = float(alpha)
        power = float(power)
    except (TypeError, ValueError):
        return {"ok": False, "error": "参数格式错误，请填写数字。"}

    if hr <= 0:
        return {"ok": False, "error": "风险比 HR 必须为正数（>0）。"}
    if hr == 1:
        return {"ok": False, "error": "HR=1 表示无效应，无法估算样本量；请填写 ≠1 的 HR。"}
    if not (0 < event_rate <= 1):
        return {"ok": False, "error": "事件发生率必须在 (0, 1] 之间。"}
    if event_rate == 0:
        return {"ok": False, "error": "事件发生率为 0，无法反推样本量。"}
    if alloc_ratio <= 0:
        return {"ok": False, "error": "分配比必须为正数（>0）。"}
    if not (0 < alpha < 1) or not (0 < power < 1):
        return {"ok": False, "error": "α 与 power 需在 0~1 之间。"}

    z_a = norm.ppf(1 - alpha / 2)
    z_b = norm.ppf(power)
    k = alloc_ratio
    ln_hr = log(hr)

    # Schoenfeld: 总事件数
    events_f = ((z_a + z_b) ** 2) * ((1 + k) ** 2) / (k * (ln_hr ** 2))
    events = int(ceil(events_f))

    # 反推总样本量
    n_total_f = events_f / event_rate
    n_total = int(ceil(n_total_f))

    # 按分配比拆分: 对照 : 试验 = 1 : k
    n_ctrl = int(ceil(n_total / (1 + k)))
    n_trt = int(ceil(n_ctrl * k))
    # 修正: 保证 sum >= n_total
    if n_ctrl + n_trt < n_total:
        n_trt = n_total - n_ctrl

    notes = [
        f"Schoenfeld 公式: E = (z_{{α/2}}+z_β)²·(1+k)² / (k·(ln HR)²)",
        f"z_{{α/2}}={z_a:.3f}, z_β={z_b:.3f}, ln HR={ln_hr:.4f}, k={k}",
        f"需 {events} 次事件；按随访期事件率 {event_rate:.2%} 反推总样本 {n_total}。",
        "若考虑失访/删失，建议再上浮 10%–20%。",
    ]

    return {
        "ok": True,
        "events": events,
        "n_total": n_total,
        "n_per_group": [n_ctrl, n_trt],
        "notes": notes,
    }


# ---------- 扫描: 单参数 vs 样本量 曲线 ----------

# scenario 对外名 -> 内部 design 名
_SCENARIO_MAP = {
    "two_proportions": "proportion",
    "two_means": "ttest",
    "one_proportion": "one_proportion",
    "one_mean": "one_mean",
    "survival": "survival",
}


def _solve_one(scenario: str, params: dict) -> int | None:
    """单点求解 N(总样本量), 失败返回 None。"""
    design = _SCENARIO_MAP.get(scenario)
    if design is None:
        raise ValueError(f"未知 scenario: {scenario}")

    # 复用已有的两组场景
    if design in ("ttest", "proportion", "survival"):
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
