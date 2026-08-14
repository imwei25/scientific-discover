#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""改写不变量校验：比对"去 AI 味"改写前后，确保数字、引用标记、图表、（可选）术语未被动过。

学术润色的硬约束——不改数据、不动引用、不丢图表——光靠声明不可靠。这个脚本把它变成机械检查：
抽取原文与改写稿里的
  - 数字（含小数、百分比、含单位的量）
  - 引用标记：[n] / [1,2] / (Author, 2024) / DOI / PMID
  - **图片**（按链接路径计，改标题不算改图，整张图没了才判红）
  - **表格**（按"表头首格｜列数×行数"计，整张表被摊平成正文或少了几行都判红）
  - 用户指定的术语白名单（--terms t1,t2,...）
做集合 diff，任何"改写稿里丢失或新增"的都报出来，供人工确认。

★ 图表这两类是补进来的，别再删掉：此前本脚本只看数字与引用，LLM 整篇重写时把
  `![](...)` 那行和整块 pipe 表漏掉，脚本照样打印 "[OK] ... 一致" —— 用户以为过了闸，
  真相是排版出件时 pandoc 只打一句 WARNING 然后退 0，产出的 docx 里一张图都没有。

用法：
  python check_invariants.py --before orig.md --after humanized.md
  python check_invariants.py --before orig.md --after humanized.md --terms "HFpEF,SGLT2i,eGFR"

退出码：发现差异=1，无差异=0。差异不一定是错（如把 "5%" 改成 "five percent"），但必须人工看过。
"""
import argparse
import re
import sys
from collections import Counter
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 常见科研/医学计量单位（用于把"数字+粘连单位"整体抽取，如 5mg / 1.73m2 / 12mL/min）。
# 旧版 NUM_RE 尾部 (?![0-9A-Za-z]) 会把 5mg 的 5 挡掉——剂量 5mg→8mg 篡改竟报 OK（严重假阴性）。
_UNIT = (r"(?:%|mg|kg|[µu]g|ng|pg|g|mL|dL|[µu]L|L|mmol|mol|[µu]mol|nmol|pmol|"
         r"IU|U/L|U|mmHg|kPa|mm|cm|nm|[µu]m|m|kb|bp|min|ms|h|d|wk|mo|yr|Hz|kHz)")
# 数字：整数/小数/百分比/千分位 + 可选科学计数法(1.2e3) + 可选粘连/带空格单位(含 m2、mL/min 复合)。
# 边界用 ASCII 类而非 \w——Python 的 \w 把中文汉字也算词字符，会导致"共45名"这种
# 中文无空格写法里的数字被 lookbehind 挡掉、漏抓。基因/化学式里的数字(SGLT2/TP53)因
# 数字前是字母、被 lookbehind 正确排除，不误抓（改这类用 --terms/--auto-terms）。
# ★ 千分位必须写成 (?:,\d{3})* 而不是 [\d,]*：后者会把「2022, 31 例」里的逗号吃进去，
#   抽出 '2022,' 这个 token。于是润色把「见表 3, 4」改成「见表 3 和 4」时，
#   本闸报「丢失 '3,'、新增 '3'」——最要紧的数字闸在最常见的改写上放假警报。
NUM_RE = re.compile(
    r"(?<![0-9A-Za-z.])"
    r"[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?"    # 数字主体（千分位/小数/科学计数法）
    r"(?:\s?" + _UNIT + r"\d?(?:/" + _UNIT + r"\d?)*)?"  # 可选单位（m2 / mL/min/… 复合）
    r"(?![0-9A-Za-z])"
)
# 引用标记：[n]、[1,2]、[1-3]
BRACKET_CITE_RE = re.compile(r"\[\d+(?:\s*[-,]\s*\d+)*\]")
# (Author, 2024) / (Author et al., 2024)
PAREN_CITE_RE = re.compile(r"\([A-Z][A-Za-z\-]+(?:\s+et\s+al\.?)?,?\s*\d{4}[a-z]?\)")
# 中文作者-年引用：（张三等, 2020）/（李四 2019）/（Wang 等，2021）——半/全角括号皆认。
CJK_CITE_RE = re.compile(r"[（(][一-龥A-Za-z][^（()）]*?(?<![0-9])\d{4}[a-z]?[)）]")
DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I)
PMID_RE = re.compile(r"\bPMID:?\s*\d{5,9}\b", re.I)
# 基因/化学式/缩写术语（TP53 / SGLT2 / BRCA1 / IL-6 / CD4）——含内嵌数字，--auto-terms 时自动纳入比对。
AUTOTERM_RE = re.compile(r"\b[A-Z][A-Za-z]*\d+[A-Za-z0-9]*\b|\b[A-Z]{2,}-?\d+\b")
# 图片：只取【链接目标】，不取 alt/题注 —— 题注本来就在润色范围内（"图1. xxx 曲线"可以改措辞），
# 拿题注比对会满屏假阳性；而图真的丢了，链接一定跟着消失。
IMG_RE = re.compile(r"!\[[^\]]*\]\(\s*<?([^)>\s]+)")
# pipe 表：表体行 + 表头分隔行（|---|:--:|）
PIPE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
PIPE_SEP_RE = re.compile(r"^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$")


def _cells(line):
    """把一行 pipe 表拆成单元格；两端的空串是 | 分隔符产生的，去掉。"""
    parts = line.strip().split("|")
    if parts and parts[0].strip() == "":
        parts = parts[1:]
    if parts and parts[-1].strip() == "":
        parts = parts[:-1]
    return [p.strip() for p in parts]


def extract_tables(text):
    """抽出每张 pipe 表的签名：`表[表头首格｜N列×M行]`。

    用签名而不是整表原文：列宽 padding 在 pandoc 各处理步之间会变（`| a  |` ↔ `| a |`），
    拿原文比会满屏假阳性；而"整张表被摊平成正文""少了两行数据"这两种真事故，
    列数或行数一定变。表头首格带上是为了让报错能指出**是哪张表**。
    """
    sigs = Counter()
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        if not PIPE_ROW_RE.match(lines[i]):
            i += 1
            continue
        j = i
        while j < len(lines) and PIPE_ROW_RE.match(lines[j]):
            j += 1
        block = lines[i:j]
        sep = next((k for k, ln in enumerate(block) if PIPE_SEP_RE.match(ln)), None)
        if sep is not None and sep > 0:
            header = _cells(block[sep - 1])
            ncol = len(_cells(block[sep]))
            nrow = len(block) - sep - 1          # 分隔行之后的都是数据行
            first = header[0] if header else ""
            sigs[f"表[{first or '(无表头)'}｜{ncol}列×{nrow}行]"] += 1
        i = j
    return sigs


def mask_media(text):
    """把图片的【链接目标】与紧随其后的 pandoc 属性块抹掉，再去抽数字/术语。

    不这么做的话，`![图1](manuscript_files/fig_001.png){width="0.5555555555555556in"}`
    会往"数字"里塞进 001、0.5555…、0 一堆垃圾，于是每一份正常润色稿都报"数字有变化"。
    数字闸是本脚本最要紧的一条，被噪声淹掉等于废掉 —— 宁可少看这几个路径数字。
    只抹【图片】的链接目标（那一定是文件路径），普通链接 [..](..) 不动，
    因为 DOI 常写在普通链接里，抹了会漏检。
    """
    text = re.sub(r"(!\[[^\]]*\])\([^)]*\)", r"\1()", text)
    return re.sub(r"(!\[[^\]]*\]\(\))\s*\{[^}]*\}", r"\1", text)


def extract(text):
    masked = mask_media(text)
    return {
        "数字": Counter(m.group(0).strip() for m in NUM_RE.finditer(masked)),
        "引用[n]": Counter(BRACKET_CITE_RE.findall(text)),
        "引用(作者,年)": Counter(PAREN_CITE_RE.findall(text) + CJK_CITE_RE.findall(text)),
        "DOI": Counter(m.group(0) for m in DOI_RE.finditer(text)),
        "PMID": Counter(PMID_RE.findall(text)),
        "图片": Counter(IMG_RE.findall(text)),
        "表格": extract_tables(text),
    }


def diff_counter(before, after):
    lost = before - after      # 改写稿里丢失的
    added = after - before     # 改写稿里新增的
    return lost, added


def main():
    ap = argparse.ArgumentParser(description="改写不变量校验（数字/引用/图表/术语）")
    ap.add_argument("--before", required=True, help="原文")
    ap.add_argument("--after", required=True, help="改写稿")
    ap.add_argument("--terms", default="", help="逗号分隔的术语白名单，逐个精确计数比对")
    ap.add_argument("--auto-terms", action="store_true",
                    help="自动把基因名/化学式/缩写(TP53/SGLT2/BRCA1/IL-6)纳入术语比对，防 TP53→TP63 漏检")
    args = ap.parse_args()

    b = open(args.before, encoding="utf-8").read()
    a = open(args.after, encoding="utf-8").read()
    eb, ea = extract(b), extract(a)

    # 术语同样走抹掉图片路径的文本：媒体文件名（fig_001.png / image_A1.png）会被
    # AUTOTERM_RE 当成基因名收进来，一改文件名就报"术语丢失"。
    bm, am = mask_media(b), mask_media(a)
    terms = {x.strip() for x in args.terms.split(",") if x.strip()}
    if args.auto_terms:
        terms |= set(AUTOTERM_RE.findall(bm)) | set(AUTOTERM_RE.findall(am))
    if terms:
        for t in terms:
            eb.setdefault("术语", Counter())[t] = bm.count(t)
            ea.setdefault("术语", Counter())[t] = am.count(t)

    problems = 0
    hard = 0                       # 图表丢失属硬伤，不是"请人工确认"
    for kind in eb:
        lost, added = diff_counter(eb[kind], ea.get(kind, Counter()))
        if lost or added:
            problems += 1
            if kind in ("图片", "表格") and lost:
                hard += 1
            print(f"[!] {kind} 有变化：")
            for k, n in lost.items():
                print(f"    - 丢失 {k!r} ×{n}")
            for k, n in added.items():
                print(f"    + 新增 {k!r} ×{n}")

    # 链接在、文件不在 —— 这是丢图最隐蔽的一种：改写稿里 `![](x.png)` 还写着，
    # 但图根本没落盘。排版时 pandoc 只打一句 WARNING 然后退 0，产出的 docx 里没有图。
    dangling = []
    base = Path(args.after).resolve().parent
    for ref in ea["图片"]:
        if re.match(r"^[a-z]+://|^data:", ref, re.I):
            continue
        if not (base / ref).is_file():
            dangling.append(ref)
    if dangling:
        hard += 1
        problems += 1
        print("[!] 图片链接指向的文件不存在（排版时会无声消失）：")
        for ref in dangling:
            print(f"    - {ref}")

    print("-" * 50)
    if problems:
        if hard:
            print("[FAIL] 改写稿丢了图或表——这是硬伤，不是「可接受的等价改写」。")
            print("       图与表必须原样搬进改写稿（含题注、pipe 表结构与 ![](路径) 那一行）；")
            print("       补回去再跑一遍本脚本，别拿这份稿子去排版出件。")
        print(f"发现 {problems} 类变化——请人工确认是否可接受（如 5% → five percent 属正常）。")
        print("凡涉及数据、引用编号、DOI/PMID 的丢失或改动，都必须核对原文。")
        sys.exit(1)
    print("[OK] 数字、引用标记、图片、表格、术语在改写前后一致。")


if __name__ == "__main__":
    main()
