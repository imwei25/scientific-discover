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

# 数字：整数/小数/百分比/带千分位。
# 边界用 ASCII 类而非 \w——Python 的 \w 把中文汉字也算词字符，会导致"共45名"这种
# 中文无空格写法里的数字被 lookbehind 挡掉、漏抓（假阴性，比误报更危险）。
NUM_RE = re.compile(r"(?<![0-9A-Za-z.])[-+]?\d[\d,]*(?:\.\d+)?%?(?![0-9A-Za-z])")
# 引用标记：[n]、[1,2]、[1-3]
BRACKET_CITE_RE = re.compile(r"\[\d+(?:\s*[-,]\s*\d+)*\]")
# (Author, 2024) / (Author et al., 2024)
PAREN_CITE_RE = re.compile(r"\([A-Z][A-Za-z\-]+(?:\s+et\s+al\.?)?,?\s*\d{4}[a-z]?\)")
DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I)
PMID_RE = re.compile(r"\bPMID:?\s*\d{5,9}\b", re.I)


def extract(text):
    return {
        "数字": Counter(m.group(0) for m in NUM_RE.finditer(text)),
        "引用[n]": Counter(BRACKET_CITE_RE.findall(text)),
        "引用(作者,年)": Counter(PAREN_CITE_RE.findall(text)),
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
    args = ap.parse_args()

    b = open(args.before, encoding="utf-8").read()
    a = open(args.after, encoding="utf-8").read()
    eb, ea = extract(b), extract(a)

    if args.terms.strip():
        for t in [x.strip() for x in args.terms.split(",") if x.strip()]:
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
