#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 系统综述 PRISMA 计数脚本（筛选流水线收尾）。纯标准库、无 LLM。
# 移植自 kgraph57/paper-writer-skill（MIT），逻辑原样保留。
# 从三个阶段的产物读数，算出 PRISMA 2020 流程图需要的每个数字、每个筛选阶段的
# 评审者一致性（Cohen's κ），以及 8 条内部一致性自洽校验。数字喂给 nature-figure 画流程图。
"""
SR PRISMA Counter — final step of the screening pipeline.

Reads the three stage outputs and emits every number the PRISMA 2020 flow
diagram needs, the inter-rater reliability (Cohen's kappa) for each screening
stage, and the 8 internal-consistency checks.

Usage:
    python sr_prisma_count.py \
        --identification counts/identification.json \
        --ta 02_title_abstract_screen.csv \
        --ft 03_fulltext_screen.csv \
        --output counts/prisma-summary.md

--ft is optional (full-text screening may not be done yet); the summary then
covers identification + title/abstract only.

No LLM. Pure counting from the decision columns produced by the dual-screening
stages. Expected screening-CSV columns: reviewer1_decision, reviewer2_decision,
consensus_decision, conflict (Y/N), pdf_retrieved (Y/N, full-text CSV only),
exclusion_reason_category (full-text CSV only).
"""

import argparse
import csv
import json
import os
import sys
from collections import Counter

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

csv.field_size_limit(10_000_000)


def norm_decision(v):
    """Map a raw decision cell to include / exclude / '' (unknown)."""
    s = (v or "").strip().lower()
    if s.startswith("inc") or s.startswith("unc") or s == "maybe":
        return "include"   # unclear → include (conservative, retrieve it)
    if s.startswith("exc") or s in ("no", "out"):
        return "exclude"
    return ""


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        return list(csv.DictReader(f))


ZERO_CONFLICT_MIN_N = 20   # 低于这个量，零分歧还算正常；到这个量就不可能了


def cohens_kappa(pairs):
    """pairs: list of (r1, r2) in {include, exclude}. Returns (kappa, n) or (None, 0).

    零分歧检测：两列判定逐行完全一致且样本量不小时，返回 (None, n) 而不是 1.0。
    真做双人独立筛选，n>=20 时几乎不可能一条分歧都没有；而"一次判定复制成两列"必然零分歧
    —— 实测就是后者，κ=1.000 被写进了 PRISMA 图和稿件 Methods。
    报不出 κ 比报一个假的 κ 好：前者只是少一个数，后者是虚假的方法学陈述。"""
    pairs = [(a, b) for a, b in pairs if a in ("include", "exclude")
             and b in ("include", "exclude")]
    n = len(pairs)
    if n == 0:
        return None, 0
    cats = ("include", "exclude")
    po = sum(1 for a, b in pairs if a == b) / n
    pe = sum((sum(1 for a, _ in pairs if a == c) / n) *
             (sum(1 for _, b in pairs if b == c) / n) for c in cats)
    if n >= ZERO_CONFLICT_MIN_N and po == 1.0:
        return None, n            # 零分歧 → 判定这两列并非独立产生，拒绝报 κ
    if pe == 1:
        return 1.0, n
    return (po - pe) / (1 - pe), n


def kappa_line(k, n, stage):
    """κ 那一行的成稿措辞。报不出来时给出可直接照抄的如实写法，别留空让模型自己发挥。"""
    if k is not None:
        return "**%.3f** (%s, n=%d)" % (k, kappa_label(k), n)
    if n >= ZERO_CONFLICT_MIN_N:
        honest = ("%s screening was performed by a single reviewer; "
                  "inter-rater reliability was therefore not assessed." % stage)
        return (
            "**not reportable** — %d 条判定逐行完全一致、零分歧。" % n
            + "双人独立筛选在这个量级上不可能零分歧，故判定这两列并非独立产生"
            + "（多半是一次判定复制成了两列）。\n"
            + "  > **Methods 必须如实写**：`" + honest + "`\n"
            + "  > **不得**写成 two reviewers independently / κ=1.000 / "
            + "discrepancies resolved by discussion —— 没有第二位评审者时那是虚假的方法学陈述。")
    return "n/a (n=%d)" % n

def kappa_label(k):
    if k is None:
        return "n/a"
    if k < 0.20:
        return "slight"
    if k < 0.40:
        return "fair"
    if k < 0.60:
        return "moderate"
    if k < 0.80:
        return "substantial"
    return "almost perfect"


def check(ok):
    return "PASS" if ok else "**FAIL**"


def main():
    ap = argparse.ArgumentParser(description="SR PRISMA counter")
    ap.add_argument("--identification", required=True)
    ap.add_argument("--ta", required=True, help="02_title_abstract_screen.csv")
    ap.add_argument("--ft", help="03_fulltext_screen.csv (optional)")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    with open(args.identification, encoding="utf-8") as f:
        ident = json.load(f)
    db_counts = ident.get("db_counts", {})
    total_identified = ident.get("total_identified", sum(db_counts.values()))
    duplicates_removed = ident.get("duplicates_removed", 0)
    records_after_dedup = ident.get("records_after_dedup",
                                    total_identified - duplicates_removed)

    ta = read_csv(args.ta)
    records_screened = len(ta)
    ta_consensus = [norm_decision(r.get("consensus_decision")) for r in ta]
    ta_excluded = sum(1 for d in ta_consensus if d == "exclude")
    reports_sought = sum(1 for d in ta_consensus if d == "include")
    ta_kappa, ta_n = cohens_kappa(
        [(norm_decision(r.get("reviewer1_decision")),
          norm_decision(r.get("reviewer2_decision"))) for r in ta])
    ta_conflicts = sum(1 for r in ta if (r.get("conflict") or "").strip().upper() == "Y")

    ft = read_csv(args.ft) if args.ft and os.path.isfile(args.ft) else None

    lines = []
    lines.append("# PRISMA 2020 Flow — Computed Counts\n")
    lines.append("> Auto-generated by sr_prisma_count.py. Copy these numbers "
                 "into the PRISMA flow diagram and the kappa values into the Methods "
                 "selection-process paragraph.\n")

    lines.append("## Identification\n")
    lines.append("| Source | Records |")
    lines.append("|--------|---------|")
    for db, c in db_counts.items():
        lines.append(f"| {db} | {c} |")
    lines.append(f"| **Total identified** | **{total_identified}** |")
    lines.append(f"| Duplicate records removed | {duplicates_removed} |")
    lines.append(f"| **Records after de-duplication** | **{records_after_dedup}** |\n")

    lines.append("## Screening — Title/Abstract\n")
    lines.append(f"- Records screened: **{records_screened}**")
    lines.append(f"- Records excluded (title/abstract): **{ta_excluded}**")
    lines.append(f"- Reports sought for retrieval: **{reports_sought}**")
    lines.append(f"- Conflicts flagged for human resolution: {ta_conflicts}")
    lines.append(f"- Inter-rater reliability (Cohen's κ): "
                 f"{kappa_line(ta_kappa, ta_n, 'Title/abstract')}\n")

    checks = []
    checks.append(("Total identified = Σ database records",
                   total_identified == sum(db_counts.values()) if db_counts else True))
    checks.append(("Records after dedup = identified − duplicates",
                   records_after_dedup == total_identified - duplicates_removed))
    checks.append(("Records screened = records after dedup",
                   records_screened == records_after_dedup))
    checks.append(("TA-excluded + reports sought = records screened",
                   ta_excluded + reports_sought == records_screened))

    if ft is not None:
        retrieved_col = any((r.get("pdf_retrieved") or "").strip() for r in ft)
        if retrieved_col:
            # 只有“已获取全文(pdf_retrieved=Y)”的报告才进入全文合格性评定；
            # 未获取(N)的报告单列在“未获取”里，不计入全文纳入/排除——否则计数口径
            # 不一致（reports_assessed 过滤了 N，而纳入/排除若不过滤就会对不上，误报 FAIL）。
            assessed = [r for r in ft if (r.get("pdf_retrieved") or "").strip().upper() == "Y"]
            reports_assessed = len(assessed)
            reports_not_retrieved = sum(1 for r in ft
                                        if (r.get("pdf_retrieved") or "").strip().upper() == "N")
            # ★ 外部事实核对（不可绕过）：声称「已获取全文」的条数必须与磁盘上真实的 PDF 数对得上。
            #   自洽校验只验加减法，验不了数字真不真 —— 实测出现过 agent 为了让校验从 FAIL 变 PASS，
            #   把全部 165 行的 pdf_retrieved 改成 Y，而一篇全文都没下过，PRISMA 于是印出
            #   「Reports not retrieved: 0」。这条数的是文件系统，改 CSV 绕不过去。
            _base = os.path.dirname(os.path.abspath(args.ft)) or "."
            _on_disk = 0
            for _root, _dirs, _files in os.walk(_base):
                _dirs[:] = [d for d in _dirs if not d.startswith('.')]
                _on_disk += sum(1 for _f in _files if _f.lower().endswith('.pdf'))
            checks.append((
                "pdf_retrieved=Y 的条数 ≤ 目录里真实的 PDF 数"
                "（%d 声称 / %d 实存；对不上说明这是摘要级筛选，PRISMA 须如实印"
                " Abstract-level screening，差额计入 Reports not retrieved）" % (reports_assessed, _on_disk),
                reports_assessed <= _on_disk))
        else:
            assessed = ft
            reports_assessed = len(ft)
            reports_not_retrieved = max(0, reports_sought - reports_assessed)
        assessed_consensus = [norm_decision(r.get("consensus_decision")) for r in assessed]
        ft_excluded = sum(1 for d in assessed_consensus if d == "exclude")
        studies_included = sum(1 for d in assessed_consensus if d == "include")
        reasons = Counter((r.get("exclusion_reason_category") or "Unspecified").strip()
                          for r, d in zip(assessed, assessed_consensus) if d == "exclude")
        ft_kappa, ft_n = cohens_kappa(
            [(norm_decision(r.get("reviewer1_decision")),
              norm_decision(r.get("reviewer2_decision"))) for r in assessed])
        ft_conflicts = sum(1 for r in assessed
                           if (r.get("conflict") or "").strip().upper() == "Y")

        lines.append("## Screening — Full Text\n")
        lines.append(f"- Reports not retrieved: **{reports_not_retrieved}**")
        lines.append(f"- Reports assessed for eligibility: **{reports_assessed}**")
        lines.append(f"- Reports excluded (full text): **{ft_excluded}**")
        lines.append(f"- **Studies included in review: {studies_included}**")
        lines.append(f"- Conflicts flagged for human resolution: {ft_conflicts}")
        lines.append(f"- Inter-rater reliability (Cohen's κ): "
                     f"{kappa_line(ft_kappa, ft_n, 'Full-text')}\n")
        lines.append("### Full-text exclusions by reason\n")
        lines.append("| Reason | n |")
        lines.append("|--------|---|")
        for reason, c in reasons.most_common():
            lines.append(f"| {reason} | {c} |")
        lines.append(f"| **Total excluded** | **{ft_excluded}** |\n")

        checks.append(("Not retrieved + assessed = reports sought",
                       reports_not_retrieved + reports_assessed == reports_sought))
        checks.append(("FT-excluded + included = reports assessed",
                       ft_excluded + studies_included == reports_assessed))
        checks.append(("Σ exclusion reasons = FT-excluded",
                       sum(reasons.values()) == ft_excluded))
    else:
        lines.append("## Screening — Full Text\n")
        lines.append("_Full-text stage not yet run (no --ft file)._\n")

    lines.append("## Internal-consistency checks\n")
    lines.append("| Check | Result |")
    lines.append("|-------|--------|")
    for desc, ok in checks:
        lines.append(f"| {desc} | {check(ok)} |")
    lines.append("")

    all_pass = all(ok for _, ok in checks)
    lines.append(f"**Overall: {'ALL CHECKS PASS' if all_pass else 'CHECKS FAILED — review counts above'}**\n")

    out = "\n".join(lines)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(out)

    print(out)
    print(f"\nWrote {args.output}")
    if not all_pass:
        sys.exit(1)


if __name__ == "__main__":
    main()
