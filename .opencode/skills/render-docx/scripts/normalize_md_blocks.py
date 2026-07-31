#!/usr/bin/env python3
"""把块级元素前后缺失的空行补上，再交给 pandoc。

【为什么需要它】pandoc 的 markdown 阅读器要求管道表格（pipe table）**前面有空行**。
写作模型极常见地把表题和表格贴在一起：

    **表1  FT3与不同平台一致性**
    | 比对平台 | 配对样本量 |
    |---------|-----------|

pandoc 会把表题当段落开头、把下面每一行当作该段落的「懒续行」——整张表被摊平成
一段纯文本，docx 里 `<w:tbl>` 计数为 0，而且**不报任何错**。稿子看着有内容、表却没了，
最容易漏检。2026-07-31 实测：贴着写 → 0 个表；中间加一个空行 → 正常成表。

同样的问题也会吃掉紧贴正文的标题行与列表，一并补上。

只增删空行，绝不改动任何一行的内容；围栏代码块内一律不碰。
"""
import argparse
import re
import sys

# 表格分隔行：| --- | :---: | ---: |，允许没有首尾竖线
DELIM_RE = re.compile(r'^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$')
FENCE_RE = re.compile(r'^\s*(```|~~~)')
ATX_RE = re.compile(r'^\s{0,3}#{1,6}\s')
LIST_RE = re.compile(r'^\s{0,3}([-*+]\s|\d+[.)]\s)')


def is_table_start(lines, i):
    """第 i 行是管道表格的表头行吗（判据：本行含 |，下一行是分隔行）。"""
    if i + 1 >= len(lines):
        return False
    return '|' in lines[i] and DELIM_RE.match(lines[i + 1]) is not None


def normalize(text):
    lines = text.split('\n')
    out = []
    in_fence = False
    fence_tok = ''
    stats = {'table': 0, 'heading': 0, 'list': 0}

    i = 0
    while i < len(lines):
        line = lines[i]

        m = FENCE_RE.match(line)
        if m:
            tok = m.group(1)
            if not in_fence:
                in_fence, fence_tok = True, tok
            elif tok == fence_tok:
                in_fence, fence_tok = False, ''
            out.append(line)
            i += 1
            continue

        if in_fence:
            out.append(line)
            i += 1
            continue

        prev_nonblank = out and out[-1].strip() != ''

        if is_table_start(lines, i):
            if prev_nonblank:
                out.append('')
                stats['table'] += 1
            out.append(line)
            i += 1
            # 整张表原样搬运，表尾后若紧跟正文再补一个空行
            while i < len(lines) and lines[i].strip() != '' and '|' in lines[i]:
                out.append(lines[i])
                i += 1
            if i < len(lines) and lines[i].strip() != '':
                out.append('')
            continue

        if ATX_RE.match(line) and prev_nonblank:
            out.append('')
            stats['heading'] += 1
        elif LIST_RE.match(line) and prev_nonblank and not LIST_RE.match(out[-1]):
            out.append('')
            stats['list'] += 1

        out.append(line)
        i += 1

    return '\n'.join(out), stats


def main():
    ap = argparse.ArgumentParser(description='补齐块级元素前的空行（表格/标题/列表），供 pandoc 正确解析')
    ap.add_argument('input')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    with open(a.input, encoding='utf-8') as f:
        src = f.read()
    fixed, stats = normalize(src)
    with open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(fixed)

    total = sum(stats.values())
    if total:
        print(f"[normalize_md_blocks] 补空行：表格 {stats['table']} 处、标题 {stats['heading']} 处、"
              f"列表 {stats['list']} 处（不补则 pandoc 会把它们摊平成普通段落）", file=sys.stderr)


if __name__ == '__main__':
    main()
