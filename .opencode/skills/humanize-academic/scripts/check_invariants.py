#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""改写不变量校验：比对"去 AI 味"改写前后，确保数字、引用标记、（可选）术语未被动过。

学术润色的硬约束——不改数据、不动引用——光靠声明不可靠。这个脚本把它变成机械检查：
抽取原文与改写稿里的
  - 数字（含小数、百分比、含单位的量）
  - 引用标记：[n] / [1,2] / (Author, 2024) / DOI / PMID
  - 用户指定的术语白名单（--terms t1,t2,...）
做集合 diff，任何"改写稿里丢失或新增"的都报出来，供人工确认。

用法：
  python check_invariants.py --before orig.md --after humanized.md
  python check_invariants.py --before orig.md --after humanized.md --terms "HFpEF,SGLT2i,eGFR"

退出码：发现差异=1，无差异=0。差异不一定是错（如把 "5%" 改成 "five percent"），但必须人工看过。
"""
import argparse
import re
import sys
from collections import Counter

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
NUM_RE = re.compile(
    r"(?<![0-9A-Za-z.])"
    r"[-+]?\d[\d,]*(?:\.\d+)?(?:[eE][-+]?\d+)?"          # 数字主体（含科学计数法）
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


def extract(text):
    return {
        "数字": Counter(m.group(0).strip() for m in NUM_RE.finditer(text)),
        "引用[n]": Counter(BRACKET_CITE_RE.findall(text)),
        "引用(作者,年)": Counter(PAREN_CITE_RE.findall(text) + CJK_CITE_RE.findall(text)),
        "DOI": Counter(m.group(0) for m in DOI_RE.finditer(text)),
        "PMID": Counter(PMID_RE.findall(text)),
    }


def diff_counter(before, after):
    lost = before - after      # 改写稿里丢失的
    added = after - before     # 改写稿里新增的
    return lost, added


def main():
    ap = argparse.ArgumentParser(description="改写不变量校验（数字/引用/术语）")
    ap.add_argument("--before", required=True, help="原文")
    ap.add_argument("--after", required=True, help="改写稿")
    ap.add_argument("--terms", default="", help="逗号分隔的术语白名单，逐个精确计数比对")
    ap.add_argument("--auto-terms", action="store_true",
                    help="自动把基因名/化学式/缩写(TP53/SGLT2/BRCA1/IL-6)纳入术语比对，防 TP53→TP63 漏检")
    args = ap.parse_args()

    b = open(args.before, encoding="utf-8").read()
    a = open(args.after, encoding="utf-8").read()
    eb, ea = extract(b), extract(a)

    terms = {x.strip() for x in args.terms.split(",") if x.strip()}
    if args.auto_terms:
        terms |= set(AUTOTERM_RE.findall(b)) | set(AUTOTERM_RE.findall(a))
    if terms:
        for t in terms:
            eb.setdefault("术语", Counter())[t] = b.count(t)
            ea.setdefault("术语", Counter())[t] = a.count(t)

    problems = 0
    for kind in eb:
        lost, added = diff_counter(eb[kind], ea.get(kind, Counter()))
        if lost or added:
            problems += 1
            print(f"[!] {kind} 有变化：")
            for k, n in lost.items():
                print(f"    - 丢失 {k!r} ×{n}")
            for k, n in added.items():
                print(f"    + 新增 {k!r} ×{n}")

    print("-" * 50)
    if problems:
        print(f"发现 {problems} 类变化——请人工确认是否可接受（如 5% → five percent 属正常）。")
        print("凡涉及数据、引用编号、DOI/PMID 的丢失或改动，都必须核对原文。")
        sys.exit(1)
    print("[OK] 数字、引用标记、术语在改写前后一致。")


if __name__ == "__main__":
    main()
