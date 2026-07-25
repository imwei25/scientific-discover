#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nature-figure 的三个临床图 turnkey helper：KM 生存曲线、火山图、ROC。
把方法学固化成可直接调用的函数，降低"每次让 agent 现写"的质量方差
（易漏 numbers-at-risk / 删失标记 / 对角线 / 阈值线等要素）。

都返回 (fig, ax)，调用方自行 savefig。出图前请先 `figfont.setup_fonts()`；
若含中文标签再 `figfont.guard_cjk(...)`。配色走投稿友好蓝/红/灰。
"""
from __future__ import annotations

_BLUE, _RED, _GRAY, _TEAL = "#3b5b92", "#c0392b", "#7f8c8d", "#1a9e9e"


def make_km(durations, events, groups=None, labels=None, ax=None,
            time_label="Time", risk_table=True, ci=True):
    """Kaplan-Meier 生存曲线（含删失标记、置信带、numbers-at-risk 风险表）。
    durations/events 等长；groups 可选（分组曲线）。需要 lifelines。"""
    import numpy as np
    import matplotlib.pyplot as plt
    from lifelines import KaplanMeierFitter
    durations = np.asarray(durations, float)
    events = np.asarray(events, int)
    if groups is None:
        groups = np.zeros(len(durations), int)
    groups = np.asarray(groups)
    uniq = list(dict.fromkeys(groups.tolist()))
    labels = labels or {g: str(g) for g in uniq}
    colors = [_BLUE, _RED, _TEAL, _GRAY, "#8e44ad", "#e67e22"]

    if ax is None:
        fig, ax = plt.subplots(figsize=(3.4, 3.0))
    else:
        fig = ax.figure
    kmfs = []
    for i, g in enumerate(uniq):
        m = groups == g
        kmf = KaplanMeierFitter(label=str(labels.get(g, g)))
        kmf.fit(durations[m], events[m])
        kmf.plot_survival_function(ax=ax, ci_show=ci, color=colors[i % len(colors)],
                                   show_censors=True,
                                   censor_styles={"marker": "|", "ms": 5})
        kmfs.append((g, kmf))
    ax.set_xlabel(time_label)
    ax.set_ylabel("Survival probability")
    ax.set_ylim(0, 1.02)
    ax.legend(frameon=False, fontsize=6)

    if risk_table:
        # numbers-at-risk：在 x 轴下方按时间网格列出每组风险人数。
        import numpy as np
        tmax = durations.max()
        ticks = np.linspace(0, tmax, 6)
        ax.set_xticks(ticks)
        y0 = -0.20
        # 组名行标签放到坐标轴左外侧，避免和 t=0 处的首列数字压字。
        xmax = float(ticks[-1]) if len(ticks) else 1.0
        lab_x = -0.10 * xmax
        for i, (g, kmf) in enumerate(kmfs):
            yi = y0 - i * 0.09
            n_at = [int((durations[groups == g] >= t).sum()) for t in ticks]
            for xt, nn in zip(ticks, n_at):
                ax.text(xt, yi, str(nn), transform=ax.get_xaxis_transform(),
                        ha="center", va="top", fontsize=5,
                        color=colors[i % len(colors)])
            ax.text(lab_x, yi, str(labels.get(g, g)), transform=ax.get_xaxis_transform(),
                    ha="right", va="top", fontsize=5, color=colors[i % len(colors)],
                    clip_on=False)
        ax.text(lab_x, y0 + 0.06, "No. at risk", transform=ax.get_xaxis_transform(),
                ha="right", va="top", fontsize=5.5, fontweight="bold", clip_on=False)
        fig.subplots_adjust(bottom=0.30, left=0.20)
    return fig, ax


def make_volcano(log2fc, neglog10p, labels=None, fc_thresh=1.0, p_thresh=0.05,
                 top_n=15, ax=None):
    """火山图：log2FC vs −log10P，上/下调/NS 三色，阈值线，显著点防重叠标注。"""
    import numpy as np
    import matplotlib.pyplot as plt
    log2fc = np.asarray(log2fc, float)
    y = np.asarray(neglog10p, float)
    p_line = -np.log10(p_thresh)
    up = (log2fc >= fc_thresh) & (y >= p_line)
    down = (log2fc <= -fc_thresh) & (y >= p_line)
    ns = ~(up | down)

    if ax is None:
        fig, ax = plt.subplots(figsize=(3.4, 3.2))
    else:
        fig = ax.figure
    ax.scatter(log2fc[ns], y[ns], s=6, c=_GRAY, alpha=0.5, edgecolors="none",
               rasterized=True, label=f"NS ({ns.sum()})")
    ax.scatter(log2fc[up], y[up], s=8, c=_RED, alpha=0.8, edgecolors="none",
               rasterized=True, label=f"Up ({up.sum()})")
    ax.scatter(log2fc[down], y[down], s=8, c=_BLUE, alpha=0.8, edgecolors="none",
               rasterized=True, label=f"Down ({down.sum()})")
    ax.axhline(p_line, ls="--", lw=0.6, color="0.4")
    ax.axvline(fc_thresh, ls="--", lw=0.6, color="0.4")
    ax.axvline(-fc_thresh, ls="--", lw=0.6, color="0.4")
    ax.set_xlabel(r"log$_2$ fold change")
    ax.set_ylabel(r"$-$log$_{10}$ P")
    ax.legend(frameon=False, fontsize=6, loc="upper center", ncol=3)

    if labels is not None and top_n > 0:
        sig = np.where(up | down)[0]
        sig = sig[np.argsort(y[sig])[::-1][:top_n]]  # 按显著性取前 top_n
        try:
            from figfont import label_points
            label_points(ax, log2fc[sig], y[sig], [labels[i] for i in sig], fontsize=5)
        except Exception:
            for i in sig:
                ax.annotate(str(labels[i]), (log2fc[i], y[i]), fontsize=5)
    return fig, ax


def make_roc(y_true, y_score, ax=None, show_auc=True, label=None):
    """ROC 曲线（含对角参考线、AUC 标注、方形比例）。需要 scikit-learn。"""
    import matplotlib.pyplot as plt
    from sklearn.metrics import roc_curve, roc_auc_score
    fpr, tpr, _ = roc_curve(y_true, y_score)
    auc = roc_auc_score(y_true, y_score)
    if ax is None:
        fig, ax = plt.subplots(figsize=(3.0, 3.0))
    else:
        fig = ax.figure
    lab = (label + " " if label else "") + (f"AUC = {auc:.3f}" if show_auc else "")
    ax.plot(fpr, tpr, color=_RED, lw=1.5, label=lab)
    ax.plot([0, 1], [0, 1], ls="--", lw=0.8, color="0.5")
    ax.set_xlim(0, 1); ax.set_ylim(0, 1.02)
    ax.set_xlabel("1 − Specificity"); ax.set_ylabel("Sensitivity")
    ax.set_aspect("equal")
    ax.legend(frameon=False, fontsize=6, loc="lower right")
    return fig, ax
