#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""data-analysis 的固化参考实现：方法比对、诊断 CI、效应量。
把易错/库不直接给的方法沉淀成经核对的函数，避免每次让 LLM 现写引入错误。
只依赖已装的 numpy/scipy/scikit-learn。

覆盖：
  - Bland-Altman（偏倚 + 95% LoA + LoA 自身 CI + 比例偏倚检验）
  - Passing-Bablok（稳健回归，两轴皆有误差时用，**禁用普通 OLS 判一致性**）
  - Deming 回归（已知误差方差比时）
  - AUC 的 DeLong 解析 95%CI 与 bootstrap CI
  - 比例（敏感性/特异性/PPV/NPV）的 Wilson 95%CI
  - Cohen's d / Hedges' g，Pearson r 的 Fisher-z 95%CI
"""
from __future__ import annotations

import numpy as np
from scipy import stats


# ============================================================
# 方法比对（method comparison）—— 判两测量方法一致性
# ============================================================

def bland_altman(m1, m2):
    """Bland-Altman 一致性分析。返回 dict：
      bias(平均差), sd_diff, loa_lower/upper(95% 一致性界限 = bias ± 1.96·SD),
      loa_lower_ci/loa_upper_ci(各 LoA 的 95%CI), prop_bias_p(差值~均值回归的斜率 p，
      <0.05 提示存在比例偏倚，此时固定 LoA 不适用)。
    **判一致性不要用相关/OLS**——高相关 ≠ 一致（Bland & Altman 的核心论点）。"""
    m1 = np.asarray(m1, float); m2 = np.asarray(m2, float)
    diff = m1 - m2
    mean = (m1 + m2) / 2
    n = len(diff)
    bias = diff.mean()
    sd = diff.std(ddof=1)
    loa_lo, loa_hi = bias - 1.96 * sd, bias + 1.96 * sd
    # LoA 的标准误 ≈ sqrt(3)·SD/sqrt(n)（Bland-Altman 1986）
    se_loa = np.sqrt(3) * sd / np.sqrt(n)
    t = stats.t.ppf(0.975, n - 1)
    # 比例偏倚：diff 对 mean 回归，斜率显著≠0 即存在
    slope, intercept, r, p_prop, se = stats.linregress(mean, diff)
    return {
        "n": n, "bias": bias, "sd_diff": sd,
        "loa_lower": loa_lo, "loa_upper": loa_hi,
        "loa_lower_ci": (loa_lo - t * se_loa, loa_lo + t * se_loa),
        "loa_upper_ci": (loa_hi - t * se_loa, loa_hi + t * se_loa),
        "prop_bias_slope": slope, "prop_bias_p": p_prop,
    }


def passing_bablok(x, y):
    """Passing-Bablok 稳健回归（非参数，两轴皆有误差、抗离群）。
    返回 dict：slope, intercept, slope_ci, intercept_ci。
    斜率 CI 含 1 且截距 CI 含 0 → 两方法无系统/比例偏差。"""
    x = np.asarray(x, float); y = np.asarray(y, float)
    n = len(x)
    slopes = []
    for i in range(n):
        for j in range(i + 1, n):
            dx = x[j] - x[i]
            if dx == 0:
                continue
            s = (y[j] - y[i]) / dx
            if s == -1:      # 惯例：跳过斜率 -1（垂直/异常）
                continue
            slopes.append(s)
    slopes = np.sort(np.asarray(slopes))
    N = len(slopes)
    # 偏移量 K = 斜率<-1 的个数（PB 原文的中位数偏移校正）
    K = int(np.sum(slopes < -1))
    if N % 2 == 1:
        slope = slopes[(N + 1) // 2 - 1 + K]
    else:
        slope = np.sqrt(slopes[N // 2 - 1 + K] * slopes[N // 2 + K]) if slopes[N // 2 - 1 + K] > 0 else \
            (slopes[N // 2 - 1 + K] + slopes[N // 2 + K]) / 2
    # 斜率 95%CI（基于 Kendall 方差近似）
    C = 1.96 * np.sqrt(n * (n - 1) * (2 * n + 5) / 18.0)
    M1 = int(round((N - C) / 2))
    M2 = N - M1 - 1
    M1 = max(0, min(N - 1, M1 + K))
    M2 = max(0, min(N - 1, M2 + K))
    slope_ci = (float(slopes[M1]), float(slopes[M2]))
    intercept = float(np.median(y - slope * x))
    int_lo = float(np.median(y - slope_ci[1] * x))
    int_hi = float(np.median(y - slope_ci[0] * x))
    return {"slope": float(slope), "intercept": intercept,
            "slope_ci": slope_ci, "intercept_ci": (int_lo, int_hi)}


def deming(x, y, lambda_ratio=1.0):
    """Deming 回归：已知两方法**测量误差方差比**时的正交回归。
    **参数方向（重要）**：`lambda_ratio = σ²_ε(y) / σ²_ε(x)`，即 y 的测量误差方差 ÷ x 的测量误差方差
    （与下式一致；解析上 λ→∞ 时 slope→OLS 的 sxy/sxx，对应 y 误差主导）。
    λ=1（默认）= 两方法测量误差相当，最常用。已知变异系数时 λ=(CV_y·mean_y)²/(CV_x·mean_x)²。
    返回 (slope, intercept)。"""
    x = np.asarray(x, float); y = np.asarray(y, float)
    mx, my = x.mean(), y.mean()
    sxx = np.sum((x - mx) ** 2)
    syy = np.sum((y - my) ** 2)
    sxy = np.sum((x - mx) * (y - my))
    slope = ((syy - lambda_ratio * sxx)
             + np.sqrt((syy - lambda_ratio * sxx) ** 2 + 4 * lambda_ratio * sxy ** 2)) / (2 * sxy)
    intercept = my - slope * mx
    return float(slope), float(intercept)


# ============================================================
# 诊断/ROC 的置信区间
# ============================================================

def delong_auc_ci(y_true, y_score, alpha=0.05):
    """AUC 的 DeLong 解析 95%CI（无需 bootstrap）。返回 (auc, lo, hi)。"""
    y_true = np.asarray(y_true); y_score = np.asarray(y_score, float)
    pos = y_score[y_true == 1]; neg = y_score[y_true == 0]
    m, n = len(pos), len(neg)
    if m == 0 or n == 0:
        raise ValueError("DeLong 需要正负两类都存在")
    # 结构成分（Sen 1960 / DeLong 1988）
    def _mwu_components(pos, neg):
        # V10: 每个正例相对全体负例的胜率；V01: 每个负例相对全体正例
        V10 = np.array([(np.sum(p > neg) + 0.5 * np.sum(p == neg)) / n for p in pos])
        V01 = np.array([(np.sum(pos > q) + 0.5 * np.sum(pos == q)) / m for q in neg])
        return V10, V01
    V10, V01 = _mwu_components(pos, neg)
    auc = V10.mean()
    s10 = V10.var(ddof=1) / m if m > 1 else 0.0
    s01 = V01.var(ddof=1) / n if n > 1 else 0.0
    se = np.sqrt(s10 + s01)
    z = stats.norm.ppf(1 - alpha / 2)
    return float(auc), float(max(0, auc - z * se)), float(min(1, auc + z * se))


def bootstrap_auc_ci(y_true, y_score, n_boot=2000, alpha=0.05, seed=0):
    """AUC 的分层 bootstrap 95%CI（与 DeLong 互为校验）。返回 (auc, lo, hi)。"""
    from sklearn.metrics import roc_auc_score
    y_true = np.asarray(y_true); y_score = np.asarray(y_score, float)
    rng = np.random.default_rng(seed)
    pos_idx = np.where(y_true == 1)[0]; neg_idx = np.where(y_true == 0)[0]
    auc = roc_auc_score(y_true, y_score)
    boots = []
    for _ in range(n_boot):
        pi = rng.choice(pos_idx, len(pos_idx), replace=True)
        ni = rng.choice(neg_idx, len(neg_idx), replace=True)
        idx = np.concatenate([pi, ni])
        boots.append(roc_auc_score(y_true[idx], y_score[idx]))
    lo, hi = np.percentile(boots, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return float(auc), float(lo), float(hi)


def wilson_ci(k, n, alpha=0.05):
    """比例（敏感性/特异性/PPV/NPV）的 Wilson 95%CI。比正态近似在小样本/极端比例更稳。
    返回 (p_hat, lo, hi)。"""
    if n == 0:
        return (float("nan"), 0.0, 1.0)
    z = stats.norm.ppf(1 - alpha / 2)
    p = k / n
    denom = 1 + z ** 2 / n
    center = (p + z ** 2 / (2 * n)) / denom
    half = z * np.sqrt(p * (1 - p) / n + z ** 2 / (4 * n ** 2)) / denom
    return (float(p), float(max(0, center - half)), float(min(1, center + half)))


# ============================================================
# 效应量
# ============================================================

def cohens_d(a, b):
    """两独立组 Cohen's d（合并 SD）。"""
    a = np.asarray(a, float); b = np.asarray(b, float)
    n1, n2 = len(a), len(b)
    sp = np.sqrt(((n1 - 1) * a.var(ddof=1) + (n2 - 1) * b.var(ddof=1)) / (n1 + n2 - 2))
    return float((a.mean() - b.mean()) / sp) if sp > 0 else float("nan")


def hedges_g(a, b):
    """Hedges' g = Cohen's d 的小样本无偏校正。"""
    a = np.asarray(a, float); b = np.asarray(b, float)
    n1, n2 = len(a), len(b)
    d = cohens_d(a, b)
    J = 1 - 3 / (4 * (n1 + n2) - 9)   # 校正因子
    return float(d * J)


def pearson_r_ci(x, y, alpha=0.05):
    """Pearson r 及其 Fisher-z 变换 95%CI。返回 (r, lo, hi, p)。"""
    x = np.asarray(x, float); y = np.asarray(y, float)
    r, p = stats.pearsonr(x, y)
    n = len(x)
    if n < 4:
        return (float(r), float("nan"), float("nan"), float(p))
    z = np.arctanh(r)
    se = 1 / np.sqrt(n - 3)
    zc = stats.norm.ppf(1 - alpha / 2)
    lo, hi = np.tanh(z - zc * se), np.tanh(z + zc * se)
    return (float(r), float(lo), float(hi), float(p))


def meta_pool(effects, variances=None, ses=None):
    """随机/固定效应 Meta 合并（逆方差 + DerSimonian-Laird），**带零异质性钳制**。
    输入效应量 effects（如 log OR / log HR / MD）与其方差 variances 或标准误 ses（二选一）。
    返回 dict，关键字段：
      fixed_effect, fixed_se, fixed_ci
      random_effect, random_se, random_ci
      Q, df, Q_p, I2(%, 已钳到[0,100]), tau2(已钳到≥0), weights_fixed, k
    **为什么要钳制**：statsmodels.combine_effects 在 Q≤df（低/零异质）时 .i2/.tau2 会给出
    负值、且 .i2 是分数不是百分比；直接报会出现"随机效应 SE < 固定效应 SE"的非法结果。
    这里 I²=max(0,·)×100、τ²=max(0,·)，且 Q≤df 时随机效应**塌回固定效应**。"""
    effects = np.asarray(effects, float)
    if ses is not None:
        v = np.asarray(ses, float) ** 2
    elif variances is not None:
        v = np.asarray(variances, float)
    else:
        raise ValueError("需提供 variances 或 ses 之一")
    k = len(effects)
    if k < 2:
        raise ValueError("Meta 合并至少需 2 项研究")
    # 固定效应（逆方差加权）
    w = 1.0 / v
    theta_fe = float(np.sum(w * effects) / np.sum(w))
    se_fe = float(np.sqrt(1.0 / np.sum(w)))
    # Cochran Q 与自由度
    Q = float(np.sum(w * (effects - theta_fe) ** 2))
    df = k - 1
    Q_p = float(stats.chi2.sf(Q, df)) if df > 0 else float("nan")
    # DerSimonian-Laird τ²（钳到 ≥0）
    C = np.sum(w) - np.sum(w ** 2) / np.sum(w)
    tau2 = max(0.0, (Q - df) / C) if C > 0 else 0.0
    # I²（钳到 [0,100]，百分比）
    I2 = max(0.0, (Q - df) / Q) * 100 if Q > 0 else 0.0
    z = stats.norm.ppf(0.975)
    fixed_ci = (theta_fe - z * se_fe, theta_fe + z * se_fe)
    if tau2 == 0.0 or Q <= df:
        # 异质性不显著：随机效应塌回固定效应（避免非法的 SE_re<SE_fe）
        theta_re, se_re, ci_re = theta_fe, se_fe, fixed_ci
        collapsed = True
    else:
        w_re = 1.0 / (v + tau2)
        theta_re = float(np.sum(w_re * effects) / np.sum(w_re))
        se_re = float(np.sqrt(1.0 / np.sum(w_re)))
        ci_re = (theta_re - z * se_re, theta_re + z * se_re)
        collapsed = False
    return {
        "k": k, "fixed_effect": theta_fe, "fixed_se": se_fe, "fixed_ci": fixed_ci,
        "random_effect": theta_re, "random_se": se_re, "random_ci": ci_re,
        "Q": Q, "df": df, "Q_p": Q_p, "I2": I2, "tau2": tau2,
        "weights_fixed": (w / np.sum(w)).tolist(),
        "random_collapsed_to_fixed": collapsed,
    }


if __name__ == "__main__":
    # 自检：已知构造应还原
    rng = np.random.default_rng(0)
    x = rng.normal(50, 10, 200)
    y = x + 3 + rng.normal(0, 2, 200)          # 真 bias≈3, slope≈1
    ba = bland_altman(y, x)
    pb = passing_bablok(x, y)
    print(f"BA bias={ba['bias']:.2f} (期望≈3) LoA=({ba['loa_lower']:.2f},{ba['loa_upper']:.2f})")
    print(f"PB slope={pb['slope']:.3f} (期望≈1) intercept={pb['intercept']:.2f} (期望≈3)")
    yt = rng.binomial(1, 0.4, 300); ys = yt * 0.8 + rng.normal(0, 1, 300)
    print("DeLong AUC CI:", tuple(round(v, 3) for v in delong_auc_ci(yt, ys)))
    print("Bootstrap AUC CI:", tuple(round(v, 3) for v in bootstrap_auc_ci(yt, ys)))
    print("Wilson CI(85/100):", tuple(round(v, 3) for v in wilson_ci(85, 100)))
    # Meta 合并自检：低异质应 I²=0/随机=固定；高异质应正常
    lo = meta_pool([.30, .55, .10, .80, .45, .20], ses=[.20, .30, .25, .35, .22, .28])
    print(f"Meta low-het: I2={lo['I2']:.1f}% tau2={lo['tau2']:.3f} "
          f"collapsed={lo['random_collapsed_to_fixed']} re_se={lo['random_se']:.4f}>=fe_se={lo['fixed_se']:.4f}")
    hi = meta_pool([.10, 1.20, -.40, 1.80, .05, 2.10], ses=[.15, .18, .20, .16, .19, .22])
    print(f"Meta high-het: I2={hi['I2']:.1f}% tau2={hi['tau2']:.3f} random={hi['random_effect']:.3f}")
