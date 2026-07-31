#!/usr/bin/env python3
"""交给 pandoc 之前的两项规范化：① 块级元素补空行；② Unicode 上下标转真上下标。

【② 为什么需要】写作阶段常把上下标写成 Unicode 字符（FT₃、10⁻⁴、10⁹）。这不是格式、
就是普通文字，渲染全看字体里有没有那个字形——而中文投稿常用字体根本没有：

    宋体 SimSun / 等线    有 ² ³ ¹    缺 ⁻ ⁴ ⁵ ⁹ ₃ ₄
    微软雅黑              有 ² ³ ¹ ⁴ ⁵  缺 ⁻ ⁹ ₃ ₄

缺字形时 Word 临时换字体去顶，于是「10」是宋体、「⁻⁴」是另一套字体，字重/大小/基线
全对不上。而 ² ³ ¹ 恰在 Latin-1 区、宋体里有 —— 这就是「m² 正常、10⁹ 就坏」的原因，
症状时有时无，最难排查。

转成 pandoc 的 `^-4^` / `~3~` 后，pandoc 生成 w:vertAlign 真上下标：字符本身是普通
ASCII，任何字体都有，且字号随正文自动缩放，永不缺字形。

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

SUP_MAP = {'⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7',
           '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
           'ⁿ': 'n', 'ⁱ': 'i'}
SUB_MAP = {chr(0x2080 + i): str(i) for i in range(10)}
SUB_MAP.update({'₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')', 'ₐ': 'a', 'ₑ': 'e',
                'ₒ': 'o', 'ₓ': 'x', 'ₕ': 'h', 'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n',
                'ₚ': 'p', 'ₛ': 's', 'ₜ': 't'})
SUP_RE = re.compile('[' + ''.join(SUP_MAP) + ']+')
SUB_RE = re.compile('[' + ''.join(SUB_MAP) + ']+')
CODE_SPAN_RE = re.compile(r'`[^`]*`')

# 宋体（中文投稿默认正文字体）缺字形、且有安全等价写法的字符。
# U+2212 数学减号：宋体没有它，而它按 UAX#11 属"东亚歧义宽度"，Word 在中文文档里
# 倾向按东亚字体取字 → 落到宋体 → 缺字形 → 系统兜底字体，于是每个负号都跟前后不是
# 一套字。满屏负数的结果表尤其明显。换成 ASCII 连字符后无歧义走西文字体，宋体本身
# 也有这个字形，两条路都正确。中文医学期刊本来就用连字符写负数。
GLYPH_SAFE = {'−': '-'}
GLYPH_RE = re.compile('[' + ''.join(GLYPH_SAFE) + ']')


def _convert_supsub(text):
    """Unicode 上下标 → pandoc ^x^ / ~x~。行内代码区不碰（那里要的就是字面量）。"""
    n = 0

    def sup(m):
        nonlocal n
        n += 1
        return '^' + ''.join(SUP_MAP[c] for c in m.group(0)) + '^'

    def sub(m):
        nonlocal n
        n += 1
        return '~' + ''.join(SUB_MAP[c] for c in m.group(0)) + '~'

    def glyph(m):
        nonlocal n
        n += 1
        return GLYPH_SAFE[m.group(0)]

    def one(seg):
        return GLYPH_RE.sub(glyph, SUB_RE.sub(sub, SUP_RE.sub(sup, seg)))

    out, last = [], 0
    for m in CODE_SPAN_RE.finditer(text):
        out.append(one(text[last:m.start()]))
        out.append(m.group(0))
        last = m.end()
    out.append(one(text[last:]))
    return ''.join(out), n


def is_table_start(lines, i):
    """第 i 行是管道表格的表头行吗（判据：本行含 |，下一行是分隔行）。"""
    if i + 1 >= len(lines):
        return False
    return '|' in lines[i] and DELIM_RE.match(lines[i + 1]) is not None


def _supsub_pass(lines):
    """先整体过一遍上下标转换（围栏代码块内不动），再做块级补空行。

    分两遍而不是边走边转：表格块是整段搬运的，混在一个循环里容易漏掉表内的上下标。
    """
    out, in_fence, tok0, n = [], False, '', 0
    for line in lines:
        m = FENCE_RE.match(line)
        if m:
            if not in_fence:
                in_fence, tok0 = True, m.group(1)
            elif m.group(1) == tok0:
                in_fence, tok0 = False, ''
            out.append(line)
            continue
        if in_fence:
            out.append(line)
            continue
        conv, k = _convert_supsub(line)
        out.append(conv)
        n += k
    return out, n


def normalize(text):
    lines, n_supsub = _supsub_pass(text.split('\n'))
    out = []
    in_fence = False
    fence_tok = ''
    stats = {'table': 0, 'heading': 0, 'list': 0, 'supsub': n_supsub}

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
    ap = argparse.ArgumentParser(
        description='pandoc 前置规范化：块级元素补空行 + Unicode 上下标转 ^x^/~x~')
    ap.add_argument('input')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    with open(a.input, encoding='utf-8') as f:
        src = f.read()
    fixed, stats = normalize(src)
    with open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(fixed)

    if stats['table'] or stats['heading'] or stats['list']:
        print(f"[normalize_md] 补空行：表格 {stats['table']} 处、标题 {stats['heading']} 处、"
              f"列表 {stats['list']} 处（不补则 pandoc 会把它们摊平成普通段落）", file=sys.stderr)
    if stats['supsub']:
        print(f"[normalize_md] Unicode 上下标转真上下标 + 缺字形字符替换：{stats['supsub']} 处"
              f"（原样保留则中文字体缺字形、Word 换字兜底，大小基线对不齐）", file=sys.stderr)


if __name__ == '__main__':
    main()
