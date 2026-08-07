# API Reference — Nature Figure Making

Conventions, constants, and reusable code blocks. Implement in your script or adapt as needed.

---

## Constants

### PALETTE

```python
PALETTE = {
    "blue_main":      "#0F4D92",
    "blue_secondary": "#3775BA",
    "green_1": "#DDF3DE",
    "green_2": "#AADCA9",
    "green_3": "#8BCF8B",
    "red_1":   "#F6CFCB",
    "red_2":   "#E9A6A1",
    "red_strong": "#B64342",
    "neutral_light": "#CFCECE",
    "neutral_mid":   "#767676",
    "neutral_dark":  "#4D4D4D",
    "neutral_black": "#272727",
    "gold":   "#FFD700",
    "teal":   "#42949E",
    "violet": "#9A4D8E",
    "magenta":"#EA84DD",
}

DEFAULT_COLORS = [
    PALETTE["blue_main"],
    PALETTE["green_3"],
    PALETTE["red_strong"],
    PALETTE["teal"],
    PALETTE["violet"],
    PALETTE["neutral_light"],
]

PALETTE_NMI_PASTEL = {
    "baseline_dark": "#484878",
    "baseline_mid":  "#7884B4",
    "baseline_soft": "#B4C0E4",
    "ours_tiny":  "#E4E4F0",
    "ours_base":  "#E4CCD8",
    "ours_large": "#F0C0CC",
    "bg_lilac": "#E0E0F0",
    "bg_aqua":  "#E0F0F0",
    "bg_peach": "#F0E0D0",
    "neutral_light": "#D8D8D8",
    "neutral_mid":   "#A8A8A8",
    "neutral_dark":  "#606060",
    "delta_up":   "#2E9E44",
    "delta_down": "#E53935",
}

DEFAULT_COLORS_NMI_PASTEL = [
    PALETTE_NMI_PASTEL["baseline_dark"],
    PALETTE_NMI_PASTEL["baseline_mid"],
    PALETTE_NMI_PASTEL["baseline_soft"],
    PALETTE_NMI_PASTEL["ours_tiny"],
    PALETTE_NMI_PASTEL["ours_base"],
    PALETTE_NMI_PASTEL["ours_large"],
]

PALETTE_NATURE_IMAGING = {
    "bg": "#000000",
    "context": "#B8B8B8",
    "cyan": "#22D7E6",
    "magenta": "#FF2AD4",
    "white": "#FFFFFF",
}

PALETTE_NATURE_MATERIAL = {
    "aqua": "#77D7D1",
    "teal": "#33B5A5",
    "lilac": "#B9A7E8",
    "violet": "#7C6CCF",
    "callout_red": "#E53935",
    "neutral": "#D9D9D9",
}

PALETTE_NATURE_CLINICAL = {
    "baseline": "#272727",
    "week6": "#E28E2C",
    "week13": "#D24B40",
    "week26": "#5B8FD6",
    "year1": "#7BAA5B",
    "year2": "#C45AD6",
    "group_band": "#F2E6D9",
}

PALETTE_NATURE_GENOMICS = {
    "neutral_light": "#D8D8D8",
    "neutral_mid": "#8F8F8F",
    "wave1": "#D9544D",
    "wave2": "#5B7FCA",
    "wave3": "#B89BD9",
    "outline": "#4D4D4D",
}
```

Use `DEFAULT_COLORS` when color itself carries explicit semantic meaning (`hero`, `baseline`, `positive variant`).
Use `DEFAULT_COLORS_NMI_PASTEL` when several compared methods belong to one or two related families and the page
should feel visually unified.

---

## MANDATORY font + SVG rules (always first, no exceptions)

**优先用字体护栏脚本 `scripts/figfont.py`**——它运行时探测**实际已装**的 CJK 字体（跨 Linux/Win/mac），
并提供 `guard_cjk()` 在存图前拦截"含中文却无 CJK 字体→豆腐块"的静默失败（投稿图漏字是硬伤）：

```python
import sys; sys.path.insert(0, "<本技能>/scripts")   # 换成 scripts 目录实际路径
from figfont import setup_fonts, guard_cjk
setup_fonts(font_size=7)          # 设好 font.family(拉丁+已装CJK)、svg/pdf 可编辑文字、负号ASCII
# …画图…
guard_cjk(title, xlabel, ylabel, legend_label, *any_cjk_labels)  # 存图前：含中文却无CJK字体则抛错
fig.savefig("figure.svg")
```

**为什么必须用护栏**：旧版把 `font.family` 硬编码成 Linux 容器专属的
`['Liberation Sans','DejaVu Sans','WenQuanYi Zen Hei','Noto Sans CJK JP']`——一旦宿主
（开发机 / mac / 未装全字体的容器）缺这几个 CJK 字体，中文会**静默**渲染成 □ 而图仍"保存成功"，
只在 stderr 刷 findfont 警告。`figfont.setup_fonts()` 改为从候选链选实际已装的字体，
`guard_cjk()` 把静默豆腐块变成显式报错。

**没有"不便 import"这条退路**：scripts 目录的绝对路径每轮都在会话前言里给了，照抄即可。
以前这里写着"至少手动写等价的多族列表并自行核对中文不是豆腐块"——那是一条**模型根本执行不了**的指令
（它没有图像输入，看不了自己出的图），实测结果就是一整张 KM 图的中文标签全是 □ 而它宣布"图已生成"。
下面这段是唯一正确的写法：

```python
# ★ 字体【必须】走 figfont，不要手抄 rcParams。
# 手抄的字体链写死的是 Linux 容器里的字体名（Liberation Sans / WenQuanYi Zen Hei / Noto Sans CJK JP），
# 而桌面版跑在 Windows 上——这四个一个都没有，于是中文全渲染成豆腐块(□)，
# 且模型【没有图像输入能力】、看不出来，坏图会一路带进投稿件。实测踩过一整张 KM 图。
# setup_fonts() 会现场探测本机真正装了什么（Linux/Windows/macOS 都覆盖）并组好回退链。
import sys; sys.path.insert(0, f"{SKILL_DIR}/scripts")
from figfont import setup_fonts, guard_cjk
setup_fonts(font_size=7)          # 同时设好 svg.fonttype='none' / pdf.fonttype=42
...
guard_cjk(title, xlabel, ylabel, *legend_labels)   # ★ 存图【之前】必须调：含中文却无可用字体时直接报错，
fig.savefig(...)                                    #   把"静默出豆腐块图"变成显式失败   # keeps text as <text> nodes, not paths
```

**Why `svg.fonttype = 'none'`**: matplotlib's default (`'path'`) converts every
glyph to a bezier path, making text unselectable, unsearchable, and impossible to
re-align in Illustrator / Inkscape. With `'none'`, text stays as SVG `<text>` elements
and font substitution happens at render time.

**Output format**: always save as `.svg` (primary). PNG/PDF are optional secondary
exports. Never use `.png` alone when the figure contains text that may need adjustment.

---

## apply_publication_style()

```python
# ★ 字体【必须】走 figfont，不要手抄 rcParams。
# 手抄的字体链写死的是 Linux 容器里的字体名（Liberation Sans / WenQuanYi Zen Hei / Noto Sans CJK JP），
# 而桌面版跑在 Windows 上——这四个一个都没有，于是中文全渲染成豆腐块(□)，
# 且模型【没有图像输入能力】、看不出来，坏图会一路带进投稿件。实测踩过一整张 KM 图。
# setup_fonts() 会现场探测本机真正装了什么（Linux/Windows/macOS 都覆盖）并组好回退链。
import sys
sys.path.insert(0, f"{SKILL_DIR}/scripts")      # SKILL_DIR = 会话前言里给的技能目录绝对路径
from figfont import setup_fonts, guard_cjk


def apply_publication_style(font_size=7, axes_linewidth=2.5, use_tex=False):
    """Apply Nature-style rcParams. Call once before creating any figures."""
    # 字体 + svg.fonttype='none' + pdf.fonttype=42 都由 setup_fonts 一次设好
    setup_fonts(font_size=font_size)
    # ── Layout & style ────────────────────────────────────────────────────────
    plt.rcParams['font.size'] = font_size
    plt.rcParams['axes.spines.right'] = False
    plt.rcParams['axes.spines.top'] = False
    plt.rcParams['axes.linewidth'] = axes_linewidth
    plt.rcParams['legend.frameon'] = False
    if use_tex:
        plt.rcParams['text.usetex'] = True
```

**Presets:**
- Large bar panels: `apply_publication_style(font_size=24, axes_linewidth=3)`
- Compact figures: `apply_publication_style(font_size=15, axes_linewidth=2)`
- Dense journal-width multi-panels: `apply_publication_style(font_size=8, axes_linewidth=1)`
- LaTeX labels: `apply_publication_style(use_tex=True)`

---

## is_dark(hex_color, threshold=128)

```python
def is_dark(hex_color, threshold=128):
    """Return True if hex color is dark (use white text on it)."""
    c = hex_color.lstrip('#')
    r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    return (0.299*r + 0.587*g + 0.114*b) < threshold
```

---

## add_panel_label(ax, label, ...)

```python
def add_panel_label(ax, label, x=-0.06, y=1.02, fontsize=14,
                    color='black', fontweight='bold'):
    """Place a Nature-style panel label near the top-left edge."""
    ax.text(
        x, y, label,
        transform=ax.transAxes,
        fontsize=fontsize,
        fontweight=fontweight,
        color=color,
        ha='left',
        va='bottom',
    )
```

For dark image plates, move the label inside the panel and switch to white:
`add_panel_label(ax, 'a', x=0.01, y=0.98, color='white')`

---

## style_dark_image_ax(ax, ...)

```python
def style_dark_image_ax(ax, facecolor='black'):
    """Prepare an axes for microscopy / rendering plates."""
    ax.set_facecolor(facecolor)
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)
    return ax
```

---

## make_grouped_bar(ax, categories, series, labels, ...)

```python
def make_grouped_bar(ax, categories, series, labels,
                     ylabel='Value', colors=None,
                     annotate=False, bar_width=0.8,
                     error_kw=None):
    """
    Grouped bar chart.

    Parameters
    ----------
    ax         : matplotlib Axes
    categories : list[str]  — x-axis category names (length K)
    series     : list[array] — one array per group (each length K)
    labels     : list[str]  — legend label per group
    ylabel     : str
    colors     : list[str] | None  — defaults to DEFAULT_COLORS; override with
                                     DEFAULT_COLORS_NMI_PASTEL for unified-family figures
    annotate   : bool  — print value above each bar
    bar_width  : float — total width for all bars in one category
    error_kw   : dict  — passed to ax.bar as error_kw

    Returns
    -------
    list[BarContainer]
    """
    import numpy as np
    if colors is None:
        colors = DEFAULT_COLORS
    if error_kw is None:
        error_kw = {'elinewidth': 2, 'capthick': 2, 'capsize': 10}
    n_groups = len(series)
    n_cats = len(categories)
    w = bar_width / n_groups
    x = np.arange(n_cats)
    containers = []
    for i, (vals, label, color) in enumerate(zip(series, labels, colors)):
        offset = (i - (n_groups - 1) / 2) * w
        bars = ax.bar(x + offset, vals, width=w, label=label,
                      color=color, edgecolor='black', linewidth=1.5,
                      error_kw=error_kw)
        containers.append(bars)
        if annotate:
            for bar, val in zip(bars, vals):
                ax.text(bar.get_x() + bar.get_width() / 2,
                        bar.get_height() + 0.01,
                        f'{val:.2f}', ha='center', va='bottom', fontsize=10)
    ax.set_xticks(x)
    ax.set_xticklabels(categories)
    ax.set_ylabel(ylabel)
    ax.legend()
    return containers
```

---

## make_trend(ax, x, y_series, labels, ...)

```python
def make_trend(ax, x, y_series, labels,
               colors=None, ylabel=None, xlabel=None,
               show_shadow=False, shadow_alpha=0.15,
               lw=2.5, marker='o', markersize=8):
    """
    Multi-line trend plot.

    Parameters
    ----------
    x        : array-like   — shared x values
    y_series : list[array]  — one 1D array per line
    labels   : list[str]
    show_shadow : bool  — fill_between ± std if y_series contains 2D arrays (rows=runs)
    """
    import numpy as np
    if colors is None:
        colors = DEFAULT_COLORS
    for y, label, color in zip(y_series, labels, colors):
        y = np.asarray(y)
        if y.ndim == 2:
            mean, std = y.mean(0), y.std(0)
        else:
            mean, std = y, None
        ax.plot(x, mean, color=color, lw=lw, marker=marker,
                markersize=markersize, label=label)
        if show_shadow and std is not None:
            ax.fill_between(x, mean - std, mean + std,
                            color=color, alpha=shadow_alpha)
    if ylabel:
        ax.set_ylabel(ylabel)
    if xlabel:
        ax.set_xlabel(xlabel)
    ax.legend()
```

---

## 临床图 turnkey helper：scripts/clinical_plots.py（KM / 火山 / ROC）

森林图见下方 `make_forest_plot`；**KM 生存曲线、火山图、ROC 这三类别再手写**——
`scripts/clinical_plots.py` 已固化了正确方法学（KM 含删失标记+置信带+numbers-at-risk 风险表；
火山图三色+双阈值线+**防重叠**基因标注；ROC 含对角线+AUC+方形比例），直接调用降低逐次质量方差：

```python
import sys; sys.path.insert(0, "<本技能>/scripts")
import figfont; figfont.setup_fonts(7)          # 字体护栏（见上）
from clinical_plots import make_km, make_volcano, make_roc
fig, ax = make_km(durations, events, groups)                    # 需 lifelines
fig, ax = make_volcano(log2fc, neglog10p, labels=gene_names, top_n=15)
fig, ax = make_roc(y_true, y_score)                             # 需 scikit-learn
fig.savefig("figure.svg")   # 存图前若含中文标签先 figfont.guard_cjk(...)
```

密集散点标注防压字用 `figfont.label_points(ax, xs, ys, labels)`（优先 adjustText，无则退回 y 错位+引线）。

## make_forest_plot(ax, labels, estimates, ci_low, ci_high, ...)

```python
def make_forest_plot(ax, labels, estimates, ci_low, ci_high,
                     colors=None, ref=0.0, xlabel=None, xlim=None,
                     marker='o', markersize=5, lw=1.5):
    """
    Minimal forest plot helper for Nature-style clinical/statistical panels.
    """
    import numpy as np
    y = np.arange(len(labels))[::-1]
    if colors is None:
        colors = ['#B64342'] * len(labels)
    for yi, est, lo, hi, color in zip(y, estimates, ci_low, ci_high, colors):
        ax.plot([lo, hi], [yi, yi], color=color, lw=lw)
        ax.plot(est, yi, marker=marker, ms=markersize, color=color)
    ax.axvline(ref, color='#767676', linestyle='--', linewidth=1.2, alpha=0.8)
    ax.set_yticks(y)
    ax.set_yticklabels(labels)
    if xlabel:
        ax.set_xlabel(xlabel)
    if xlim is not None:
        ax.set_xlim(xlim)
    ax.spines['right'].set_visible(False)
    ax.spines['top'].set_visible(False)
```

Use pale `ax.axhspan(...)` bands behind contiguous label groups when you need the
clinical-triptych look from `Nature`.

---

## make_heatmap(ax, matrix, ...)

```python
def make_heatmap(ax, matrix, x_labels=None, y_labels=None,
                 cmap='magma', cbar_label=None, annotate=False,
                 fmt='{:.2f}', fontsize=12):
    """
    2D heatmap with optional colorbar and cell annotations.
    """
    import numpy as np
    import matplotlib as mpl
    im = ax.imshow(matrix, cmap=cmap, aspect='auto')
    if cbar_label:
        cbar = ax.figure.colorbar(im, ax=ax)
        cbar.set_label(cbar_label)
    if x_labels:
        ax.set_xticks(range(len(x_labels)))
        ax.set_xticklabels(x_labels, rotation=30, ha='right')
    if y_labels:
        ax.set_yticks(range(len(y_labels)))
        ax.set_yticklabels(y_labels)
    if annotate:
        norm = mpl.colors.Normalize(vmin=matrix.min(), vmax=matrix.max())
        cm_obj = plt.get_cmap(cmap)
        for (i, j), val in np.ndenumerate(matrix):
            r, g, b, _ = cm_obj(norm(val))
            lum = 0.299*r + 0.587*g + 0.114*b
            color = 'white' if lum < 0.5 else 'black'
            ax.text(j, i, fmt.format(val), ha='center', va='center',
                    fontsize=fontsize, color=color)
    ax.set_frame_on(False)
```

---

## finalize_figure(fig, out_path, ...)

```python
def finalize_figure(fig, out_path, formats=None, dpi=300,
                    pad=2, bbox_inches=None, close=True):
    """
    Apply tight_layout and save figure.

    Parameters
    ----------
    out_path : str   — path without extension, or with extension
    formats  : list  — e.g. ['png', 'pdf']. If None, uses extension of out_path.
    dpi      : int   — 300 standard, 600 for dense bar panels
    pad      : float — tight_layout pad (2 default, 1 for compact multi-panel)
    """
    import os
    from pathlib import Path
    fig.tight_layout(pad=pad)
    base = Path(out_path)
    os.makedirs(base.parent, exist_ok=True)
    if formats is None:
        formats = [base.suffix.lstrip('.') or 'png']
        base = base.with_suffix('')
    saved = []
    for fmt in formats:
        p = str(base) + f'.{fmt}'
        kw = {}
        if bbox_inches is not None:
            kw['bbox_inches'] = bbox_inches
        fig.savefig(p, dpi=dpi, **kw)
        saved.append(p)
    if close:
        plt.close(fig)
    return saved
```

---

## Validation Rules

- `make_grouped_bar`: `len(categories)` must equal length of each array in `series`.
- `make_trend`: each array in `y_series` must have same length as `x`.
- `make_heatmap`: `matrix` must be 2D; `x_labels` length = `matrix.shape[1]`; `y_labels` length = `matrix.shape[0]`.
- `finalize_figure`: supported formats — `png`, `pdf`, `svg`, `eps`, `jpg`, `tif`.

---

## Conventions

- Save outputs under `./figures/` (or path given by user); `finalize_figure` creates parent dirs.
- In headless / batch runs, set non-interactive backend before importing pyplot:
  ```python
  import matplotlib
  matplotlib.use('Agg')
  import matplotlib.pyplot as plt
  ```
- Always `plt.close(fig)` after saving to free memory.
- For multi-panel figures, prefer one baseline family plus one hero family; reserve green/red for delta cues.
- When color roles, resolution, or layout are underspecified and would change the figure, confirm with user before finalizing.
