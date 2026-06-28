"""医学论文常用图表三件套(确定性, 不经 LLM, 零幻觉)。

  - forest_plot(studies, effect='OR') 森林图 + Meta 汇总(随机效应模型)
  - km_curve(df, time_col, event_col, group_col=None) Kaplan-Meier 生存曲线
  - roc_curve_plot(df, y_true_col, y_score_col) ROC 曲线 + AUC + bootstrap 95% CI

每个函数都返回:
  { "png": bytes, "svg": str, "pdf": bytes, ... 其他统计量 ... }

注意: 该模块独立于现有的 `dataanalysis.py`(那个是 LLM 驱动的通用分析),
这里 3 个函数是"医生上传数据 -> 一键出图"的确定性绘制, 不写代码不调模型。
"""
from __future__ import annotations

import io
import math
from typing import Any

import numpy as np


# ---------- 共享: 出图导出 ----------

def _new_fig(figsize=(8, 6)):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({
        "font.sans-serif": ["Microsoft YaHei", "SimHei", "DejaVu Sans"],
        "axes.unicode_minus": False,
        "savefig.dpi": 150,
        "font.size": 11,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "grid.alpha": 0.3,
        "text.usetex": False,
    })
    fig, ax = plt.subplots(figsize=figsize)
    return plt, fig, ax


def _export(plt, fig) -> dict:
    """统一导出 png(bytes) / svg(str) / pdf(bytes)。"""
    out: dict = {}
    # png(高清)
    b = io.BytesIO()
    fig.savefig(b, format="png", dpi=300, bbox_inches="tight")
    out["png"] = b.getvalue()
    # svg(文本)
    b = io.BytesIO()
    fig.savefig(b, format="svg", bbox_inches="tight")
    out["svg"] = b.getvalue().decode("utf-8")
    # pdf(矢量)
    b = io.BytesIO()
    fig.savefig(b, format="pdf", bbox_inches="tight")
    out["pdf"] = b.getvalue()
    plt.close(fig)
    return out


# =====================================================================
# 1. 森林图 + Meta 汇总
# =====================================================================

def _study_effect(s: dict, effect: str) -> tuple[float, float, float, float]:
    """单研究的 effect, SE(log scale), CI_low, CI_high(原 scale)。

    s: {n_treat, event_treat, n_ctrl, event_ctrl}
    effect ∈ {OR, RR}; 用 Haldane-Anscombe 0.5 校正避免除零。
    """
    a = float(s.get("event_treat", 0))
    b = float(s.get("n_treat", 0)) - a
    c = float(s.get("event_ctrl", 0))
    d = float(s.get("n_ctrl", 0)) - c
    # 0.5 校正
    if a == 0 or b == 0 or c == 0 or d == 0:
        a, b, c, d = a + 0.5, b + 0.5, c + 0.5, d + 0.5
    if effect.upper() == "RR":
        p1 = a / (a + b)
        p2 = c / (c + d)
        if p1 <= 0 or p2 <= 0:
            return float("nan"), float("nan"), float("nan"), float("nan")
        es = p1 / p2
        log_es = math.log(es)
        se = math.sqrt(1.0 / a - 1.0 / (a + b) + 1.0 / c - 1.0 / (c + d))
    else:  # OR
        es = (a * d) / (b * c)
        log_es = math.log(es)
        se = math.sqrt(1.0 / a + 1.0 / b + 1.0 / c + 1.0 / d)
    ci_low = math.exp(log_es - 1.96 * se)
    ci_high = math.exp(log_es + 1.96 * se)
    return es, se, ci_low, ci_high


def _meta_random_effects(log_es: np.ndarray, se: np.ndarray) -> dict:
    """DerSimonian-Laird 随机效应模型, 返回 pooled + 95% CI + I^2 + Q 检验 p。"""
    w_fixed = 1.0 / (se ** 2)
    fe = (w_fixed * log_es).sum() / w_fixed.sum()
    q = (w_fixed * (log_es - fe) ** 2).sum()
    k = len(log_es)
    df = k - 1
    c = w_fixed.sum() - (w_fixed ** 2).sum() / w_fixed.sum() if w_fixed.sum() > 0 else 0
    tau2 = max(0.0, (q - df) / c) if c > 0 else 0.0
    w_re = 1.0 / (se ** 2 + tau2)
    pooled = (w_re * log_es).sum() / w_re.sum()
    se_pooled = math.sqrt(1.0 / w_re.sum())
    ci_low = math.exp(pooled - 1.96 * se_pooled)
    ci_high = math.exp(pooled + 1.96 * se_pooled)
    i2 = max(0.0, (q - df) / q) * 100.0 if q > 0 else 0.0
    # Q chi^2 p-value
    try:
        from scipy.stats import chi2
        q_p = float(1 - chi2.cdf(q, df)) if df > 0 else 1.0
    except Exception:  # noqa: BLE001
        q_p = float("nan")
    return {
        "pooled": float(math.exp(pooled)),
        "ci_low": float(ci_low),
        "ci_high": float(ci_high),
        "i2": float(i2),
        "q_pvalue": q_p,
        "k": int(k),
    }


def forest_plot(studies: list[dict], effect: str = "OR") -> dict:
    """生成森林图 + 随机效应汇总。

    studies: [{study, n_treat, event_treat, n_ctrl, event_ctrl}, ...]
    effect ∈ {'OR','RR'}
    返回: {png, svg, pdf, summary: {pooled, ci_low, ci_high, i2, q_pvalue, k}}
    """
    if not studies:
        raise ValueError("studies 不能为空。")
    eff_label = "OR" if effect.upper() == "OR" else "RR"

    rows = []
    for s in studies:
        es, se, lo, hi = _study_effect(s, eff_label)
        rows.append({
            "label": str(s.get("study") or "Study"),
            "es": es,
            "se": se,
            "ci_low": lo,
            "ci_high": hi,
            "n": float(s.get("n_treat", 0)) + float(s.get("n_ctrl", 0)),
        })
    log_es = np.array([math.log(r["es"]) for r in rows])
    se_arr = np.array([r["se"] for r in rows])
    summary = _meta_random_effects(log_es, se_arr)

    # 绘图
    plt, fig, ax = _new_fig(figsize=(9, max(3.5, 0.55 * len(rows) + 2.0)))
    ys = list(range(len(rows), 0, -1))  # 由上到下
    # 每个研究权重(用于方块大小)
    w = 1.0 / (se_arr ** 2)
    sizes = 80 + 300 * (w / w.max())

    for y, r, sz in zip(ys, rows, sizes):
        ax.plot([r["ci_low"], r["ci_high"]], [y, y], color="#0E3A39", lw=1.2)
        ax.scatter([r["es"]], [y], s=sz, marker="s", color="#0F9B94", zorder=3)

    # 汇总菱形
    y0 = 0
    ax.plot(
        [summary["pooled"], summary["ci_low"], summary["pooled"], summary["ci_high"], summary["pooled"]],
        [y0, y0 + 0.3, y0 + 0.6, y0 + 0.3, y0],
        color="#D97706", lw=1.8,
    )

    ax.axvline(1.0, color="#999", lw=0.8, linestyle="--")
    ax.set_xscale("log")
    ax.set_yticks(ys + [y0 + 0.3])
    ax.set_yticklabels(
        [f"{r['label']}  {r['es']:.2f} [{r['ci_low']:.2f}, {r['ci_high']:.2f}]" for r in rows]
        + [f"Pooled ({eff_label})  {summary['pooled']:.2f} "
           f"[{summary['ci_low']:.2f}, {summary['ci_high']:.2f}]"],
        fontsize=10,
    )
    ax.set_xlabel(f"{eff_label} (95% CI)  — I²={summary['i2']:.1f}%, Q p={summary['q_pvalue']:.3f}")
    ax.set_title("Forest plot (random-effects)")
    ax.set_ylim(-0.5, len(rows) + 1)
    ax.grid(axis="y", alpha=0.0)

    out = _export(plt, fig)
    out["summary"] = summary
    return out


# =====================================================================
# 2. Kaplan-Meier 生存曲线
# =====================================================================

def _read_df(df_data: bytes, filename: str):
    import pandas as pd
    name = (filename or "").lower()
    if name.endswith((".xlsx", ".xls")):
        return pd.read_excel(io.BytesIO(df_data))
    from .textio import read_csv_bytes
    return read_csv_bytes(df_data)


def km_curve(
    df_data: bytes,
    filename: str,
    time_col: str,
    event_col: str,
    group_col: str | None = None,
) -> dict:
    """Kaplan-Meier 生存曲线。

    df_data: csv/xlsx 字节
    time_col: 随访时间列名
    event_col: 事件指示列名(1=事件发生, 0=删失)
    group_col: 分组列名(可选; 给定则同时输出 log-rank p)
    返回: {png, svg, pdf, logrank_p, groups: [{name, median_survival, n}]}
    """
    from lifelines import KaplanMeierFitter
    from lifelines.statistics import multivariate_logrank_test

    df = _read_df(df_data, filename)
    for col in (time_col, event_col):
        if col not in df.columns:
            raise ValueError(f"列不存在: {col}")
    if group_col and group_col not in df.columns:
        raise ValueError(f"分组列不存在: {group_col}")

    # 清洗: 去掉 time/event 缺失的行
    keep = df[[time_col, event_col]].dropna().index
    df = df.loc[keep].copy()
    df[time_col] = df[time_col].astype(float)
    df[event_col] = df[event_col].astype(int)

    plt, fig, ax = _new_fig(figsize=(8, 6))
    palette = ["#0F9B94", "#D97706", "#3C5488", "#E64B35", "#00A087", "#925E9F"]
    groups_out: list[dict] = []
    logrank_p = None

    if group_col:
        levels = list(df[group_col].dropna().unique())
        for i, lvl in enumerate(levels):
            sub = df[df[group_col] == lvl]
            if sub.empty:
                continue
            kmf = KaplanMeierFitter()
            kmf.fit(sub[time_col], event_observed=sub[event_col], label=str(lvl))
            kmf.plot_survival_function(ax=ax, color=palette[i % len(palette)], ci_show=True)
            try:
                med = float(kmf.median_survival_time_)
            except Exception:  # noqa: BLE001
                med = float("nan")
            groups_out.append({
                "name": str(lvl),
                "median_survival": med,
                "n": int(len(sub)),
            })
        try:
            res = multivariate_logrank_test(df[time_col], df[group_col], df[event_col])
            logrank_p = float(res.p_value)
        except Exception:  # noqa: BLE001
            logrank_p = None
    else:
        kmf = KaplanMeierFitter()
        kmf.fit(df[time_col], event_observed=df[event_col], label="All")
        kmf.plot_survival_function(ax=ax, color=palette[0], ci_show=True)
        try:
            med = float(kmf.median_survival_time_)
        except Exception:  # noqa: BLE001
            med = float("nan")
        groups_out.append({
            "name": "All",
            "median_survival": med,
            "n": int(len(df)),
        })

    ax.set_xlabel(f"Time ({time_col})")
    ax.set_ylabel("Survival probability")
    title = "Kaplan-Meier curve"
    if logrank_p is not None:
        title += f"  (log-rank p = {logrank_p:.4f})"
    ax.set_title(title)
    ax.set_ylim(0, 1.05)

    out = _export(plt, fig)
    out["logrank_p"] = logrank_p
    out["groups"] = groups_out
    return out


# =====================================================================
# 3. ROC 曲线 + AUC + bootstrap CI
# =====================================================================

def roc_curve_plot(
    df_data: bytes,
    filename: str,
    y_true_col: str,
    y_score_col: str,
    n_bootstrap: int = 1000,
    rng_seed: int = 42,
) -> dict:
    """ROC 曲线 + AUC + bootstrap 95% CI + Youden 最优阈值。

    返回: {png, svg, pdf, auc, auc_ci: [low, high], optimal_threshold}
    """
    from sklearn.metrics import roc_auc_score, roc_curve

    df = _read_df(df_data, filename)
    for col in (y_true_col, y_score_col):
        if col not in df.columns:
            raise ValueError(f"列不存在: {col}")

    sub = df[[y_true_col, y_score_col]].dropna().copy()
    y_true = sub[y_true_col].astype(int).to_numpy()
    y_score = sub[y_score_col].astype(float).to_numpy()
    if len(np.unique(y_true)) < 2:
        raise ValueError("y_true 至少需要 2 个不同的类别。")

    fpr, tpr, thresholds = roc_curve(y_true, y_score)
    auc = float(roc_auc_score(y_true, y_score))

    # Youden's J 找最优阈值
    j = tpr - fpr
    optimal_idx = int(np.argmax(j))
    optimal_threshold = float(thresholds[optimal_idx])

    # Bootstrap 95% CI for AUC
    rng = np.random.default_rng(rng_seed)
    n = len(y_true)
    aucs = []
    for _ in range(n_bootstrap):
        idx = rng.integers(0, n, n)
        yt = y_true[idx]
        if len(np.unique(yt)) < 2:
            continue
        try:
            aucs.append(roc_auc_score(yt, y_score[idx]))
        except Exception:  # noqa: BLE001
            continue
    if aucs:
        low = float(np.percentile(aucs, 2.5))
        high = float(np.percentile(aucs, 97.5))
    else:
        low, high = auc, auc

    plt, fig, ax = _new_fig(figsize=(7, 6))
    ax.plot(fpr, tpr, color="#0F9B94", lw=2.0, label=f"ROC (AUC = {auc:.3f})")
    ax.plot([0, 1], [0, 1], color="#999", lw=0.8, linestyle="--", label="Chance")
    ax.scatter([fpr[optimal_idx]], [tpr[optimal_idx]], s=80, marker="o", color="#D97706",
               zorder=3, label=f"Optimal cutoff = {optimal_threshold:.3f}")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1.02)
    ax.set_xlabel("False positive rate (1 - specificity)")
    ax.set_ylabel("True positive rate (sensitivity)")
    ax.set_title(f"ROC curve  (AUC 95% CI: [{low:.3f}, {high:.3f}])")
    ax.legend(loc="lower right")

    out = _export(plt, fig)
    out["auc"] = auc
    out["auc_ci"] = [low, high]
    out["optimal_threshold"] = optimal_threshold
    return out
