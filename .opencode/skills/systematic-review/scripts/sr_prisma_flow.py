#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PRISMA 2020 流程图绘制（版式固定，数字来自 sr_prisma_count.py 的 JSON）。

【为什么必须有这个脚本】此前 systematic-review 只有计数脚本、没有画图脚本，于是每次都由
模型现搓一段 matplotlib。实测出来的图：右侧「去除重复记录」与「(n = 5)」两个框叠印在一起、
数字完全读不出；主干箭头从三个方框的文字中间穿过去；最后两步之间干脆没有连接箭头。
而当前部署的模型**没有图像输入能力**，它自己也说了「I can't visually inspect the PNG」——
也就是"画完看一眼"这条兜底根本不存在。版式必须固化成代码，不能每次重新发明。

用法：
    python sr_prisma_flow.py --counts counts/prisma-summary.json --out prisma_flow.png
    # 同时出 svg/pdf（投稿要矢量）：
    python sr_prisma_flow.py --counts counts/prisma-summary.json --out prisma_flow.png --also-svg --also-pdf

未跑全文筛选阶段（counts 里没有 studies_included）时只画到「报告寻求获取」为止，
不臆造后半程的数字。
"""
import argparse
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, Rectangle

# 中文字体：缺字形会渲染成豆腐块，而流程图上全是中文标签。按可用性依次尝试。
_CJK = ["Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", "SimHei", "PingFang SC", "WenQuanYi Zen Hei"]


def pick_cjk_font():
    from matplotlib import font_manager
    have = {f.name for f in font_manager.fontManager.ttflist}
    for name in _CJK:
        if name in have:
            return name
    return None


# ---- 版式常量：一处定死，别在下面散落魔法数 ----
BOX_W, BOX_H = 0.40, 0.085          # 主干框宽/高（axes 坐标）
SIDE_W = 0.30                        # 右侧"排除"框宽
LEFT_X = 0.06                        # 主干左边缘
SIDE_X = 0.60                        # 侧框左边缘
GAP = 0.055                          # 相邻两级之间的竖直间距
FS_BOX = 10.5                        # 框内字号
FS_STAGE = 11.5                      # 左侧阶段标签字号


def draw_box(ax, x, y, w, h, lines, fc="#ffffff", ec="#333333", fs=FS_BOX):
    """画一个框并把多行文字【居中排在框内】。

    ★ 文字与数字必须写进【同一个】text 调用。此前模型现搓的版本把标题和 "(n = 5)"
      当成两个 text 分别定位，一旦框窄一点两者就叠印——那正是实测图上读不出数字的原因。
    """
    ax.add_patch(Rectangle((x, y), w, h, facecolor=fc, edgecolor=ec, linewidth=1.1, zorder=2))
    ax.text(x + w / 2, y + h / 2, "\n".join(lines), ha="center", va="center",
            fontsize=fs, linespacing=1.45, zorder=3, wrap=True)


def v_arrow(ax, x, y_from, y_to):
    """主干竖直箭头。★ 只在两个框【之间】的空隙里画，绝不跨越框体——
    实测现搓版本的箭头是从上一个框的中心画到下一个框的中心，于是穿过框里的文字。"""
    ax.add_patch(FancyArrowPatch((x, y_from), (x, y_to), arrowstyle="-|>",
                                 mutation_scale=13, linewidth=1.1, color="#333333", zorder=1))


def h_arrow(ax, x_from, x_to, y):
    ax.add_patch(FancyArrowPatch((x_from, y), (x_to, y), arrowstyle="-|>",
                                 mutation_scale=13, linewidth=1.1, color="#333333", zorder=1))


def main():
    ap = argparse.ArgumentParser(description="PRISMA 2020 flow diagram (fixed layout)")
    ap.add_argument("--counts", required=True, help="sr_prisma_count.py 产出的 prisma-summary.json")
    ap.add_argument("--out", required=True, help="输出图片路径（.png）")
    ap.add_argument("--also-svg", action="store_true")
    ap.add_argument("--also-pdf", action="store_true")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--lang", choices=["zh", "en"], default="zh")
    a = ap.parse_args()

    with open(a.counts, encoding="utf-8") as f:
        c = json.load(f)

    has_ft = "studies_included" in c
    zh = a.lang == "zh"
    font = pick_cjk_font()
    if zh and not font:
        print("!! 本机没有可用的中文字体，中文标签会渲染成豆腐块。已自动改用英文标签。")
        print("   要出中文图，请装 Microsoft YaHei / Noto Sans CJK SC 之一后重跑。")
        zh = False
    if zh:
        plt.rcParams["font.family"] = font
    plt.rcParams["axes.unicode_minus"] = False

    T = (lambda z, e: z if zh else e)

    # 主干各级：(文字行, 右侧排除框的文字行或 None)
    rows = [
        ([T("通过数据库检索识别的记录", "Records identified from databases"),
          f"(n = {c['total_identified']})"],
         [T("检索前去除的重复记录", "Duplicate records removed before screening"),
          f"(n = {c['duplicates_removed']})"]),
        ([T("去重后的记录", "Records after duplicates removed"),
          f"(n = {c['records_after_dedup']})"], None),
        ([T("标题/摘要筛选的记录", "Records screened"),
          f"(n = {c['records_screened']})"],
         [T("排除的记录", "Records excluded"),
          f"(n = {c['ta_excluded']})"]),
        ([T("寻求获取全文的报告", "Reports sought for retrieval"),
          f"(n = {c['reports_sought']})"],
         ([T("未获取到全文的报告", "Reports not retrieved"),
           f"(n = {c['reports_not_retrieved']})"] if has_ft else None)),
    ]
    if has_ft:
        excl = [T("全文排除的报告", "Reports excluded"), f"(n = {c['ft_excluded']})"]
        # ★ 排除原因必须按框宽折行/截断。侧框宽是定值(SIDE_W)，而 matplotlib 的 wrap=True
        #   按 figure 宽度算、不按框宽算，等于没用。实测「结局指标不符（未报Clavien-Dindo）：1」
        #   左端的 · 探出框外、右端的数字被框线裁断 —— 而真实系统综述的排除原因几乎必然比
        #   「非随机对照」长，这不是边缘情况。
        #   中文按字宽约 1 个单位、拉丁按 0.55 估，超出就截断加省略号（宁可短，不可压线）。
        def _fit(s, budget=13.0):
            w, out = 0.0, []
            for ch in s:
                w += 1.0 if ord(ch) > 0x2E80 else 0.55
                if w > budget:
                    out.append("…")
                    break
                out.append(ch)
            return "".join(out)
        for reason, n in list((c.get("exclusion_reasons") or {}).items())[:5]:
            excl.append(_fit(f"· {reason}：{n}" if zh else f"· {reason}: {n}"))
        rows.append(([T("评估合格性的报告", "Reports assessed for eligibility"),
                      f"(n = {c['reports_assessed']})"], excl))
        rows.append(([T("纳入系统综述的研究", "Studies included in review"),
                      f"(n = {c['studies_included']})"], None))

    # 每一级的高度：侧框行数多时（排除原因清单）要加高，否则文字挤出框外
    heights = []
    for main_lines, side_lines in rows:
        n = max(len(main_lines), len(side_lines or []))
        heights.append(max(BOX_H, 0.030 * n + 0.030))

    total_h = sum(heights) + GAP * (len(rows) - 1)
    fig_h = max(7.0, total_h * 11.0)
    fig, ax = plt.subplots(figsize=(9.2, fig_h))
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis("off")

    # 从上往下排；先把每一级的 y 算出来（top 为框上沿）
    pad_top, pad_bot = 0.035, 0.035
    usable = 1.0 - pad_top - pad_bot
    scale = usable / total_h
    y_top = 1.0 - pad_top
    placed = []
    for h in heights:
        hh = h * scale
        placed.append((y_top - hh, hh))     # (框下沿, 框高)
        y_top -= hh + GAP * scale

    stage_labels = ([T("识别", "Identification"), T("筛选", "Screening"), T("纳入", "Included")]
                    if has_ft else [T("识别", "Identification"), T("筛选", "Screening")])
    stage_rows = [(0, 1), (2, len(rows) - 2 if has_ft else len(rows) - 1)]
    if has_ft:
        stage_rows.append((len(rows) - 1, len(rows) - 1))

    for i, ((main_lines, side_lines), (y, h)) in enumerate(zip(rows, placed)):
        draw_box(ax, LEFT_X, y, BOX_W, h, main_lines)
        if side_lines:
            sy = y + (h - min(h, 0.030 * len(side_lines) + 0.030)) / 2
            sh = min(h, 0.030 * len(side_lines) + 0.030)
            draw_box(ax, SIDE_X, sy, SIDE_W, sh, side_lines, fc="#f7f7f7")
            h_arrow(ax, LEFT_X + BOX_W, SIDE_X, y + h / 2)
        if i + 1 < len(rows):
            ny = placed[i + 1][0] + placed[i + 1][1]
            v_arrow(ax, LEFT_X + BOX_W / 2, y, ny)      # 只走框与框之间的空隙

    # 左侧阶段色带
    for label, (a_i, b_i) in zip(stage_labels, stage_rows):
        top = placed[a_i][0] + placed[a_i][1]
        bot = placed[b_i][0]
        ax.add_patch(Rectangle((0.005, bot), 0.042, top - bot,
                               facecolor="#e8eef5", edgecolor="#c7d3e0", zorder=0))
        ax.text(0.026, (top + bot) / 2, label, ha="center", va="center",
                fontsize=FS_STAGE, rotation=90, zorder=1)

    fig.tight_layout(pad=0.4)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    fig.savefig(a.out, dpi=a.dpi, bbox_inches="tight")
    print(f"Wrote {a.out}  ({a.dpi} dpi)")
    stem = os.path.splitext(a.out)[0]
    if a.also_svg:
        fig.savefig(stem + ".svg", bbox_inches="tight"); print(f"Wrote {stem}.svg")
    if a.also_pdf:
        fig.savefig(stem + ".pdf", bbox_inches="tight"); print(f"Wrote {stem}.pdf")
    plt.close(fig)

    if not c.get("all_checks_pass", True):
        print("!! 注意：计数自洽校验【未全过】（见 prisma-summary.md），"
              "图上的数字照实画了，但投稿前必须先把校验修绿。")
    if not has_ft:
        print("（未提供全文筛选阶段的数据，流程图只画到「寻求获取全文的报告」为止——"
              "没有的数字不臆造。）")


if __name__ == "__main__":
    main()
