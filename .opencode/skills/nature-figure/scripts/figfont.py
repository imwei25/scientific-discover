#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nature-figure 的字体护栏：运行时探测可用 CJK 字体，缺失且图含中文时【显式报错】，
不再静默出豆腐块（□）。跨平台（Linux 容器 / Windows / macOS 字体名都覆盖）。

用法（在出图代码里）：
    import sys; sys.path.insert(0, "<skill>/scripts")
    from figfont import setup_fonts, guard_cjk
    setup_fonts(font_size=7)                 # 设好 rcParams（拉丁+已装CJK，负号ASCII）
    guard_cjk(title, xlabel, ylabel, *labels)  # 存图前调用；含中文却无CJK字体→抛错
    fig.savefig(...)

设计要点：
- font.family 用**多族列表**（拉丁在前、CJK 在后）——matplotlib 唯一能逐字形回退的写法。
- CJK 字体从一条覆盖 Linux/Win/mac 的候选链里选**实际已装**的那个，而非硬编码单一名字
  （旧版硬编码 Linux 专属字体，宿主缺它就中文全豆腐块且不报错）。
- guard_cjk 是关键护栏：把"静默出错图"变成"显式失败"，符合投稿图不容漏字的要求。
"""
from __future__ import annotations

# 覆盖各平台的黑体/无衬线 CJK 字体；按优先级取第一个已装的。
_CJK_CANDIDATES = [
    "WenQuanYi Zen Hei", "WenQuanYi Micro Hei",           # Linux 常见（容器装的）
    "Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK TC",
    "Noto Sans SC", "Noto Sans TC", "Source Han Sans SC", "Source Han Sans CN",
    "Microsoft YaHei", "SimHei", "SimSun",                # Windows
    "PingFang SC", "Heiti SC", "Hiragino Sans GB", "STHeiti",  # macOS
    "Arial Unicode MS",
]
# 拉丁无衬线（与 Arial/Helvetica 度量兼容，满足 Nature 要求）。
_LATIN_CANDIDATES = ["Liberation Sans", "Arial", "Helvetica", "DejaVu Sans"]


def _installed_names():
    from matplotlib import font_manager as fm
    return {f.name for f in fm.fontManager.ttflist}


def detect_cjk_font():
    """返回首个实际已装的 CJK 字体名；一个都没有则 None。"""
    installed = _installed_names()
    for name in _CJK_CANDIDATES:
        if name in installed:
            return name
    return None


def _detect_latin():
    installed = _installed_names()
    avail = [n for n in _LATIN_CANDIDATES if n in installed]
    return avail or ["DejaVu Sans"]


def setup_fonts(font_size: float = 7):
    """设置发表级字体 rcParams：拉丁在前、已装 CJK 在后（逐字形回退），负号用 ASCII。
    返回选中的 CJK 字体名（None=没装 CJK，纯英文图仍正常）。"""
    import matplotlib.pyplot as plt
    cjk = detect_cjk_font()
    family = _detect_latin() + ([cjk] if cjk else [])
    plt.rcParams["font.family"] = family
    plt.rcParams["font.size"] = font_size
    # 负号：部分字体缺 U+2212 会豆腐块；用 ASCII 连字符更稳。
    plt.rcParams["axes.unicode_minus"] = False
    # 矢量导出保持文字可编辑（SVG 存字符、PDF 存 TrueType）。
    plt.rcParams["svg.fonttype"] = "none"
    plt.rcParams["pdf.fonttype"] = 42
    plt.rcParams["ps.fonttype"] = 42
    return cjk


def has_cjk(s) -> bool:
    """字符串是否含中日韩表意字符或全角标点。"""
    for c in str(s):
        o = ord(c)
        if (0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF
                or 0x3000 <= o <= 0x303F or 0xFF00 <= o <= 0xFFEF
                or 0xF900 <= o <= 0xFAFF):
            return True
    return False


def guard_cjk(*texts):
    """存图前调用：任一文本含中文但环境无可用 CJK 字体 → 抛 RuntimeError，
    把"静默豆腐块图"变成显式失败。全英文图或已装 CJK 字体则无操作。"""
    if any(has_cjk(t) for t in texts if t) and detect_cjk_font() is None:
        raise RuntimeError(
            "图中含中文，但当前环境未找到任何可用的 CJK 字体，直接出图会得到豆腐块(□)。\n"
            "请任选其一：① 安装中文字体（Linux: fonts-wqy-zenhei / fonts-noto-cjk；"
            "Windows/mac 自带 微软雅黑/PingFang）；② 把图中标签改成英文。\n"
            f"已探测的候选字体均未安装：{_CJK_CANDIDATES[:6]}…")


def label_points(ax, xs, ys, labels, fontsize=6, max_labels=30):
    """给散点加**防重叠**标注（火山图基因名等）。优先用 adjustText（若已装），
    否则退回一个简单的贪心 y 方向错位 + 引线算法，避免标签压字成"Gene…81"。
    只标前 max_labels 个（按传入顺序，调用方应先按显著性排序），其余静默略过并返回略过数。"""
    xs, ys, labels = list(xs), list(ys), list(labels)
    n = min(len(labels), max_labels)
    skipped = len(labels) - n
    try:
        from adjustText import adjust_text  # 可选依赖
        texts = [ax.text(xs[i], ys[i], labels[i], fontsize=fontsize) for i in range(n)]
        adjust_text(texts, ax=ax, arrowprops=dict(arrowstyle="-", color="0.5", lw=0.4))
        return skipped
    except Exception:
        pass
    # 退回：按 x 排序后在 y 上错位，画细引线到真实点。
    order = sorted(range(n), key=lambda i: xs[i])
    ylim = ax.get_ylim()
    dy = (ylim[1] - ylim[0]) * 0.035
    last_y = {}
    for rank, i in enumerate(order):
        tx, ty = xs[i], ys[i]
        # 简单堆叠：同一 x 邻域内逐个上抬
        key = round(tx, 1)
        ty2 = max(ty, last_y.get(key, ty) + dy) if key in last_y else ty + dy
        last_y[key] = ty2
        ax.annotate(labels[i], xy=(tx, ty), xytext=(tx, ty2),
                    fontsize=fontsize, ha="center",
                    arrowprops=dict(arrowstyle="-", color="0.6", lw=0.4))
    return skipped


if __name__ == "__main__":
    # 自检：打印本机探测结果
    print("CJK font detected:", detect_cjk_font())
    print("Latin fonts available:", _detect_latin())
