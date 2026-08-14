#!/usr/bin/env python
"""table_caption_to_pandoc.py — 把「表题写在表格上方的加粗段」改写成 pandoc 表格题注。

本套件 write-paper 的表格写法是（对 Word 排版最直观）：

    **表1. 基线特征**

    | 变量 | 组A | 组B |
    |---|---|---|

Word 侧 postprocess_docx.py 认得这种手写表题（按题注字号居中、序号加粗）。但 PDF 侧
那只是一段普通加粗正文——caption 宏包只作用于真正的 `\\caption{}`，所以表题会保持
正文字号，和图题（真 caption）大小不一致。

本脚本把这类表题搬成 pandoc 的表格题注语法（表格后另起一行 `: 题注`），pandoc 便生成
真 `\\caption{}`，题注字号/居中/序号加粗才落得下去：

    | 变量 | 组A | 组B |
    |---|---|---|

    : **表1.** 基线特征

只动"紧挨着 pipe 表格的、整行加粗的、以 表n/Table n 开头"的段落，其余一律不碰；
围栏代码块内不处理。已经是 `: 题注` 写法的表格不受影响。

用法: python table_caption_to_pandoc.py IN.md --out OUT.md
"""
import argparse
import re
import sys

# 整行加粗、以「表1」「Table 2」「表 S1」开头的段落 = 手写表题
CAP_LINE = re.compile(r"^\*\*\s*(表|Table|Tab\.?)\s*S?\d+.*\*\*\s*$", re.I)
FENCE = re.compile(r"^\s*(```|~~~)")
SEP_ROW = re.compile(r"^\s*\|[\s:|-]+\|\s*$")


def is_table_start(lines, i):
    """lines[i] 是 pipe 表首行？（下一行必须是 |---|---| 分隔行，否则只是普通竖线文本）"""
    return (
        i + 1 < len(lines)
        and lines[i].lstrip().startswith("|")
        and SEP_ROW.match(lines[i + 1])
    )


def convert(text):
    lines = text.split("\n")
    out = []
    i = 0
    moved = 0
    in_fence = False
    while i < len(lines):
        line = lines[i]
        if FENCE.match(line):
            in_fence = not in_fence
        if in_fence or not CAP_LINE.match(line.strip()):
            out.append(line)
            i += 1
            continue

        # 表题候选：向后跳过空行，看是不是紧跟着一张 pipe 表
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j >= len(lines) or not is_table_start(lines, j):
            out.append(line)          # 后面不是表 → 原样保留（可能是表注或正文）
            i += 1
            continue

        # 收表体：连续的 | 开头行
        k = j
        while k < len(lines) and lines[k].lstrip().startswith("|"):
            k += 1
        # 表后已有 `: 题注` 就别再加第二个
        n = k
        while n < len(lines) and not lines[n].strip():
            n += 1
        if n < len(lines) and lines[n].lstrip().startswith(": "):
            out.append(line)
            i += 1
            continue

        inner = line.strip()[2:-2].strip()   # 去掉首尾 **
        # 「表1. 基线特征」→「**表1.** 基线特征」：序号加粗、说明文字不加粗（期刊惯例）
        m = re.match(r"^((?:表|Table|Tab\.?)\s*S?\d+\s*[\.．。:：]?)\s*(.*)$", inner, re.I)
        cap = f"**{m.group(1).strip()}** {m.group(2)}".strip() if m else f"**{inner}**"

        out.extend(lines[j:k])
        out.append("")
        out.append(f": {cap}")
        out.append("")
        moved += 1
        i = k
        # 表后的空行已由上面补出，跳过原有的连续空行避免堆叠
        while i < len(lines) and not lines[i].strip():
            i += 1
    return "\n".join(out), moved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as f:
        text = f.read()
    new, moved = convert(text)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(new)
    print(f"[table_caption] 表题转 pandoc 题注: {moved} 处 -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
