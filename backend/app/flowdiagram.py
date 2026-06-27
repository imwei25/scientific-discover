"""PRISMA 2020 / CONSORT 2025 流程图确定性绘制。

每篇系统综述/Meta 必交 PRISMA 流程图、每个 RCT 必交 CONSORT 流程图，手画繁琐、
期刊审查严。这里用 matplotlib 在本地确定性绘制（布局写死、数字来自用户表单，
LLM 不参与绘图→零幻觉），一次导出 PNG(300dpi)/SVG/PDF，全离线、契合隐私定位。

对外: render_flow(kind, counts) -> {"ok", "png", "svg", "pdf"} (base64)。
"""
from __future__ import annotations

import base64
import io


def _n(counts: dict, key: str, default: str = "") -> str:
    v = counts.get(key, default)
    return "" if v is None else str(v).strip()


def _new_ax():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update({
        "font.sans-serif": ["Microsoft YaHei", "SimHei", "DejaVu Sans"],
        "axes.unicode_minus": False,
    })
    fig, ax = plt.subplots(figsize=(8.5, 10))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")
    return plt, fig, ax


def _box(ax, cx, cy, w, h, text, fc="#eef2f1", ec="#0E3A39"):
    from matplotlib.patches import FancyBboxPatch

    ax.add_patch(FancyBboxPatch(
        (cx - w / 2, cy - h / 2), w, h,
        boxstyle="round,pad=0.3,rounding_size=1.2",
        linewidth=1.1, edgecolor=ec, facecolor=fc,
    ))
    ax.text(cx, cy, text, ha="center", va="center", fontsize=9, wrap=True)


def _arrow(ax, x1, y1, x2, y2):
    ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle="-|>", color="#0E3A39", lw=1.1))


def _phase(ax, cy, label):
    ax.text(2.5, cy, label, ha="center", va="center", rotation=90,
            fontsize=10, fontweight="bold", color="#0F9B94")


def _export(plt, fig) -> dict:
    out = {}
    for fmt in ("png", "svg", "pdf"):
        b = io.BytesIO()
        fig.savefig(b, format=fmt, dpi=(300 if fmt == "png" else None), bbox_inches="tight")
        out[fmt] = base64.b64encode(b.getvalue()).decode()
    plt.close(fig)
    return out


def _draw_prisma(counts: dict) -> dict:
    plt, fig, ax = _new_ax()
    mx, mw = 33, 46          # 主列中心 x / 宽
    rx, rw = 80, 34          # 右侧排除框
    blue = "#dce9e7"
    # 主列盒子 (y 从上到下)
    A, B, C, D, E = 88, 70, 52, 34, 14
    _box(ax, mx, A, mw, 9, f"通过数据库/检索识别的记录\n(n = {_n(counts,'identified')})", blue)
    _box(ax, mx, B, mw, 9, f"去重后筛选的记录\n(n = {_n(counts,'screened')})")
    _box(ax, mx, C, mw, 9, f"获取全文的报告\n(n = {_n(counts,'sought')})")
    _box(ax, mx, D, mw, 9, f"评估合格性的全文\n(n = {_n(counts,'assessed')})")
    _box(ax, mx, E, mw, 9, f"纳入研究\n(n = {_n(counts,'included')})", "#cfe8e3")
    # 右侧排除框
    _box(ax, rx, (A + B) / 2 + 2, rw, 8, f"筛选前剔除：\n重复等 (n = {_n(counts,'duplicates')})", "#f5eada", "#9a5b00")
    _box(ax, rx, B, rw, 8, f"排除的记录\n(n = {_n(counts,'records_excluded')})", "#f5eada", "#9a5b00")
    _box(ax, rx, C, rw, 8, f"未能获取全文\n(n = {_n(counts,'not_retrieved')})", "#f5eada", "#9a5b00")
    _box(ax, rx, D, rw, 9, f"排除的全文：\n{_n(counts,'reports_excluded') or '(原因/数量)'}", "#f5eada", "#9a5b00")
    # 箭头
    for y1, y2 in ((A, B), (B, C), (C, D), (D, E)):
        _arrow(ax, mx, y1 - 4.5, mx, y2 + 4.5)
    _arrow(ax, mx + mw / 2, B, rx - rw / 2, B)
    _arrow(ax, mx + mw / 2, C, rx - rw / 2, C)
    _arrow(ax, mx + mw / 2, D, rx - rw / 2, D)
    _arrow(ax, mx, A - 4.5, mx, A - 9)  # 指向去重侧框水平
    _arrow(ax, mx + mw / 2, A - 6, rx - rw / 2, (A + B) / 2 + 2)
    # 阶段标签
    _phase(ax, A, "识别")
    _phase(ax, (B + D) / 2, "筛选")
    _phase(ax, E, "纳入")
    ax.set_title("PRISMA 2020 流程图", fontsize=13, fontweight="bold", color="#0E3A39")
    return _export(plt, fig)


def _draw_consort(counts: dict) -> dict:
    plt, fig, ax = _new_ax()
    a1 = _n(counts, "arm1_label") or "干预组"
    a2 = _n(counts, "arm2_label") or "对照组"
    cx, lw = 50, 50
    lx, rx, aw = 27, 73, 42   # 两臂中心 x / 宽
    blue = "#dce9e7"
    # 顶部
    _box(ax, cx, 92, lw, 8, f"评估合格性 (n = {_n(counts,'assessed')})", blue)
    _box(ax, 82, 80, 34, 10, f"排除 (n = {_n(counts,'excluded')})\n{_n(counts,'excluded_reasons') or '(不符合/拒绝/其他)'}", "#f5eada", "#9a5b00")
    _box(ax, cx, 70, lw, 8, f"随机化 (n = {_n(counts,'randomized')})", "#cfe8e3")
    _arrow(ax, cx, 88, cx, 74)
    _arrow(ax, cx, 84, 82 - 17, 80)
    # 分配阶段两臂
    _box(ax, lx, 54, aw, 11, f"分配至{a1} (n = {_n(counts,'arm1_alloc')})\n接受 (n = {_n(counts,'arm1_received')})；未接受 (n = {_n(counts,'arm1_notreceived')})", blue)
    _box(ax, rx, 54, aw, 11, f"分配至{a2} (n = {_n(counts,'arm2_alloc')})\n接受 (n = {_n(counts,'arm2_received')})；未接受 (n = {_n(counts,'arm2_notreceived')})", blue)
    _arrow(ax, cx, 66, lx, 60)
    _arrow(ax, cx, 66, rx, 60)
    # 随访
    _box(ax, lx, 36, aw, 9, f"失访 (n = {_n(counts,'arm1_lost')})\n中止 (n = {_n(counts,'arm1_discont')})", "#f5eada", "#9a5b00")
    _box(ax, rx, 36, aw, 9, f"失访 (n = {_n(counts,'arm2_lost')})\n中止 (n = {_n(counts,'arm2_discont')})", "#f5eada", "#9a5b00")
    _arrow(ax, lx, 48.5, lx, 40.5)
    _arrow(ax, rx, 48.5, rx, 40.5)
    # 分析
    _box(ax, lx, 18, aw, 9, f"纳入分析 (n = {_n(counts,'arm1_analysed')})\n剔除分析 (n = {_n(counts,'arm1_excl')})", "#cfe8e3")
    _box(ax, rx, 18, aw, 9, f"纳入分析 (n = {_n(counts,'arm2_analysed')})\n剔除分析 (n = {_n(counts,'arm2_excl')})", "#cfe8e3")
    _arrow(ax, lx, 31.5, lx, 22.5)
    _arrow(ax, rx, 31.5, rx, 22.5)
    _phase(ax, 92, "入组")
    _phase(ax, 54, "分配")
    _phase(ax, 36, "随访")
    _phase(ax, 18, "分析")
    ax.set_title("CONSORT 2025 流程图", fontsize=13, fontweight="bold", color="#0E3A39")
    return _export(plt, fig)


def render_flow(kind: str, counts: dict) -> dict:
    kind = (kind or "prisma").strip().lower()
    counts = counts or {}
    try:
        data = _draw_consort(counts) if kind == "consort" else _draw_prisma(counts)
        return {"ok": True, **data}
    except Exception as e:  # noqa: BLE001
        import traceback
        print("[flowdiagram] exception:\n" + traceback.format_exc(), flush=True)
        return {"ok": False, "error": f"绘制失败：{type(e).__name__}: {e}"}
