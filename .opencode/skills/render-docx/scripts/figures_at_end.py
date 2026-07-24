#!/usr/bin/env python
"""figures_at_end.py — 把 Markdown 里的图与表搬到正文末尾（多数期刊送审稿要求）。

NEJM / JAMA / Lancet 等要求正文中不内嵌图表，图表统一置于参考文献/正文之后、常各自
成页。本脚本把稿件中"独占整行的图片 `![cap](path)`"与"pipe 表格块（含其上方紧邻的
`**表 x**` 题注和下方 `: caption`）"抽出，按出现顺序追加到文末，原位留一句占位提示。

用法:
  python figures_at_end.py IN.md --out OUT.md
  # 选项：--no-placeholder 不在原位留占位行；--heading "图表" 自定义文末小标题

保守起见：只搬"独占行"的图（前后是空行或段落边界）与"标准 pipe 表格块"，不动行内图、
不动代码块内的伪表格。搬移不改任何文字内容，只调顺序。
"""
import argparse
import re
import sys

IMG_LINE = re.compile(r'^\s*!\[[^\]]*\]\([^)]*\)\s*(\{[^}]*\})?\s*$')
TABLE_ROW = re.compile(r'^\s*\|.*\|\s*$')
CAPTION_BELOW = re.compile(r'^\s*:\s+\S')          # pandoc 表题: ": 表 1 ..."
CAPTION_ABOVE = re.compile(r'^\s*(\*\*)?(表|图|Table|Figure)\s*\d', re.I)


def split_frontmatter(lines):
    if lines and lines[0].strip() == '---':
        for i in range(1, len(lines)):
            if lines[i].strip() == '---':
                return lines[:i + 1], lines[i + 1:]
    return [], lines


def is_blank(ln):
    return ln.strip() == ''


def extract(lines):
    """返回 (body_without_floats, floats)。floats 为搬到文末的图/表块列表。"""
    body, floats, i, n = [], [], 0, len(lines)
    in_fence = False
    while i < n:
        ln = lines[i]
        s = ln.strip()
        if s.startswith('```') or s.startswith('~~~'):
            in_fence = not in_fence
            body.append(ln); i += 1; continue
        if in_fence:
            body.append(ln); i += 1; continue

        # 图：独占行
        if IMG_LINE.match(ln):
            block = [ln]
            # 紧随其后的 pandoc 图题 ": ..." 或下一行的斜体题注一并带走
            j = i + 1
            if j < n and CAPTION_BELOW.match(lines[j]):
                block.append(lines[j]); j += 1
            floats.append(('图', block))
            _append_placeholder(body, args_placeholder, '图')
            i = j
            continue

        # 表：可能有上方题注行 + 连续 pipe 行 + 下方 caption
        if TABLE_ROW.match(ln):
            start = i
            cap_above = []
            # 回看上一非空行是不是"**表 x**"题注
            if body:
                k = len(body) - 1
                while k >= 0 and is_blank(body[k]):
                    k -= 1
                if k >= 0 and CAPTION_ABOVE.match(body[k]):
                    cap = body[k]
                    cap_above = [cap if cap.endswith('\n') else cap + '\n']
                    del body[k]  # 从正文摘掉题注（连同其后空行留着无妨）
            block = list(cap_above)
            # 题注与表格首行之间必须留一空行：pandoc 的 pipe_table 要求表前有空行，
            # 题注段落直接黏在 `| … |` 上会让整块被当普通段落、表格不再被识别，
            # 渲染成一堆裸竖线文本（docx 真表消失 / PDF 泄漏 `|`）。缺此空行=毁表。
            if cap_above:
                block.append('\n')
            while i < n and (TABLE_ROW.match(lines[i]) or CAPTION_BELOW.match(lines[i])):
                block.append(lines[i]); i += 1
            floats.append(('表', block))
            _append_placeholder(body, args_placeholder, '表')
            continue

        body.append(ln); i += 1
    return body, floats


def _append_placeholder(body, enabled, kind):
    if enabled:
        body.append(f'*（{kind}见文末）*\n')


def main():
    global args_placeholder
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('--out', required=True)
    ap.add_argument('--no-placeholder', action='store_true')
    ap.add_argument('--heading', default='图表')
    ap.add_argument('--refs-anchor', action='store_true',
                    help='在图表节前插入 citeproc 文献锚点，令参考文献表落在图表之前（期刊惯例：正文→参考文献→图表）')
    a = ap.parse_args()
    args_placeholder = not a.no_placeholder

    lines = open(a.input, encoding='utf-8').read().splitlines(keepends=True)
    fm, rest = split_frontmatter(lines)
    body, floats = extract(rest)

    out = list(fm) + body
    if floats:
        if out and not out[-1].endswith('\n'):
            out[-1] += '\n'
        # citeproc 默认把参考文献表放全文最末（= 图表之后），不符期刊"正文→参考文献→图表"
        # 顺序。插一个空的 #refs Div 锚点，pandoc-citeproc 会把文献表放到锚点处，即图表之前。
        # 无 citeproc（[n] 文本引用稿）时该空 Div 不可见，无副作用。
        if a.refs_anchor:
            out.append('\n\n::: {#refs}\n:::\n')
        out.append(f'\n\n# {a.heading}\n\n')
        for kind, block in floats:
            for b in block:
                out.append(b if b.endswith('\n') else b + '\n')
            out.append('\n\n')  # 期刊常要求每图表独立成段/成页
    else:
        print('[figures_at_end] 未发现可搬移的独占行图或 pipe 表格，原样输出', file=sys.stderr)

    open(a.out, 'w', encoding='utf-8').writelines(out)
    print(f'[figures_at_end] moved {len(floats)} float(s) to end -> {a.out}', file=sys.stderr)


if __name__ == '__main__':
    main()
