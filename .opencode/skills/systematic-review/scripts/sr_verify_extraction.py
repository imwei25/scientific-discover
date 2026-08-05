#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提取表数值回查：每个数字都必须能在来源文本里找到，找不到的逐条列出来。

═══════════════════════════════════════════════════════════════════
为什么需要这个脚本
═══════════════════════════════════════════════════════════════════
实测（2026-08-05，一次完整的系统综述跑批）：8 篇纳入研究里 **4 篇的样本量在原文摘要中查无此数**——

    Huang 2020       提取表写 36241   摘要写的是 "a cohort of 16,676 diabetic patients"
    Al Omari 2018    提取表写 285     摘要里是 1902 / 349 / 321 / 192 / 129，没有 285
    Vernieri 2019    提取表写 82      摘要里是 3759 / 133 / 1319，没有 82
    Tarhini 2022     提取表写 170     摘要里是 290 / 144，没有 170

而那一轮**一篇全文都没下载过**，所以这些数只能来自模型记忆 = 编造。它们进了 GRADE 证据表的
"~69,000" 和森林图每一行的标签。**同一批的 HR/CI 反而全是准确的**——错的只有样本量，
而样本量恰恰是读者判断证据分量的第一眼指标，这让它更隐蔽。

光靠提示词拦不住："不虚构"本来就写在硬约束里。这里做成机制：**数字必须能在来源文本里找到**。

═══════════════════════════════════════════════════════════════════
定位是 signal，不是 verdict
═══════════════════════════════════════════════════════════════════
提取表里合法地存在**算出来的**数字（SE、权重、换算后的 log HR、合并效应量……），它们本来就不会
出现在原文里。所以本脚本只出**待核清单**，不下"编造"的结论——但凡列出来的，作者必须回原文核对
或说明来源。用 --computed-cols 把已知的计算列排除掉，剩下的就都该在原文里找得到。

用法
----
    PY=${REPO_ROOT:-/app}/.venv/bin/python
    S=${REPO_ROOT:-/app}/.opencode/skills/systematic-review/scripts/sr_verify_extraction.py

    # 只有摘要时（没下全文）——最常见，也最需要查
    "$PY" "$S" --extraction extraction_table.csv --records 01_deduplicated.csv

    # 下了全文：把全文文本目录一并给它，能核的范围大得多
    "$PY" "$S" --extraction extraction_table.csv --records 01_deduplicated.csv --fulltext-dir pdfs/

    # 排除计算列
    "$PY" "$S" --extraction extraction_table.csv --records 01_deduplicated.csv \
        --computed-cols se,weight,log_hr,variance
"""
import argparse
import csv
import os
import re
import sys

# 数字：整数/小数，可带千分位逗号。单个 0/1 之类太短的不查（假阳性太多，且没有信息量）
NUM_RE = re.compile(r"\d[\d,]*\.?\d*")
MIN_DIGITS = 2          # 少于 2 位有效数字的不查（0、1、5 这类到处都是）
ID_COLS = ("record_id", "id", "study_id", "doi", "pmid")


def norm_num(x):
    """归一化成可比字符串：去千分位逗号、去末尾无意义的 0。16,676 与 16676 要能对上。"""
    x = x.replace(",", "").strip()
    if "." in x:
        x = x.rstrip("0").rstrip(".")
    return x


def digits_of(x):
    return len(re.sub(r"\D", "", x))


def numbers_in(text):
    """文本里出现过的所有数字（归一化后）。"""
    return {norm_num(m.group()) for m in NUM_RE.finditer(text or "")}


def load_sources(records_path, fulltext_dir):
    """record 标识 → 可核对的来源文本（摘要，外加全文若有）。"""
    src = {}
    with open(records_path, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            text = " ".join(str(row.get(k) or "") for k in ("title", "abstract"))
            for key in ID_COLS:
                v = (row.get(key) or "").strip().lower()
                if v:
                    src.setdefault(v, "")
                    src[v] += " " + text
    if fulltext_dir and os.path.isdir(fulltext_dir):
        # 全文文本（.txt/.md，通常是 fulltext-retrieval 的 PDF 转写产物）按文件名里的标识匹配
        for name in os.listdir(fulltext_dir):
            if not name.lower().endswith((".txt", ".md")):
                continue
            try:
                body = open(os.path.join(fulltext_dir, name), "r", encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            stem = os.path.splitext(name)[0].lower()
            for key in list(src):
                if key and key in stem:
                    src[key] += " " + body
    return src


def main():
    ap = argparse.ArgumentParser(description="提取表数值回查（找不到出处的逐条列出）")
    ap.add_argument("--extraction", required=True, help="extraction_table.csv")
    ap.add_argument("--records", required=True, help="01_deduplicated.csv（须含 abstract 列）")
    ap.add_argument("--fulltext-dir", default=None, help="全文文本目录（.txt/.md），有就一起核")
    ap.add_argument("--computed-cols", default="",
                    help="逗号分隔：本来就是算出来的列（se,weight,log_hr…），跳过不查")
    ap.add_argument("--allow-truncated", action="store_true",
                    help="来源表被截断也照跑（报告会充满无信息量的待核项，慎用）")
    ap.add_argument("--output", default="extraction_verify.md")
    args = ap.parse_args()

    if not os.path.exists(args.extraction) or not os.path.exists(args.records):
        sys.exit("找不到输入文件：--extraction / --records 都必须存在")
    skip = {c.strip().lower() for c in args.computed_cols.split(",") if c.strip()}
    src = load_sources(args.records, args.fulltext_dir)
    if not src:
        sys.exit("来源表里读不到任何记录（--records 需要 record_id/doi/pmid 之一 + abstract 列）")

    # ★ 来源表体检：来源本身残缺时，这个脚本会把【每一个】数字都报成待核 —— 一堆没有信息量的
    #   告警反而会让人放弃看它。实测 agent 绕开 sr_dedup.py 手搓 01_deduplicated.csv：
    #   249/249 标题全空、摘要一律截断到 500 字（HR/CI 所在的 Results 段正好被切掉），
    #   于是回查 71/71 全部待核，闸的信噪比被自己毁掉，而稿件里 10 篇研究连标题都没有、
    #   参考文献表里一条都对应不上。这种情况必须【先说来源不可用】，别让人以为是数据在造假。
    _texts = [] if args.allow_truncated else [v for v in src.values() if v]
    if _texts:
        _short = sum(1 for v in _texts if len(v.strip()) < 600)
        if _short / len(_texts) >= 0.8:
            sys.exit(
                "!! 来源表看起来【被截断过】：%d/%d 条的可比文本不足 600 字。\n"
                "   摘要里 HR/95%%CI/样本量通常出现在 Results 段，截断后回查会把每个数字都报成待核，\n"
                "   这份报告就没有信息量了。\n"
                "   请用 sr_dedup.py 产出的完整 01_deduplicated.csv（带 title 与未截断的 abstract），\n"
                "   不要手工另存/截断。确实要按当前来源硬跑，加 --allow-truncated。"
                % (_short, len(_texts)))

    findings, checked, rows_total = [], 0, 0
    with open(args.extraction, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            rows_total += 1
            key = next((str(row.get(k) or "").strip().lower() for k in ID_COLS
                        if str(row.get(k) or "").strip()), "")
            text = src.get(key, "")
            label = key or (str(row.get("study") or row.get("author") or "?"))
            if not text:
                findings.append((label, "(整行)", "",
                                 "在来源表里找不到这条记录，全行数值都无从核对"))
                continue
            pool = numbers_in(text)
            for col, val in row.items():
                if not col or col.lower() in skip or col.lower() in ID_COLS:
                    continue
                for m in NUM_RE.finditer(str(val or "")):
                    raw = m.group()
                    if digits_of(raw) < MIN_DIGITS:
                        continue
                    checked += 1
                    if norm_num(raw) not in pool:
                        findings.append((label, col, raw, "该数字未在来源文本（摘要"
                                         + ("＋全文" if args.fulltext_dir else "")
                                         + "）中出现"))

    with open(args.output, "w", encoding="utf-8") as f:
        f.write("# 提取表数值回查\n\n")
        f.write(f"共 {rows_total} 条研究，核对 {checked} 个数字，"
                f"**{len(findings)} 个找不到出处**。\n\n")
        if not args.fulltext_dir:
            f.write("> 本次只比对了**摘要**（未提供 --fulltext-dir）。"
                    "全文里才有的数字必然落进下面的清单，这是预期内的；"
                    "但**没下全文时提取表本就不该出现摘要里没有的数字**——"
                    "那只能来自记忆，不是来自文献。\n\n")
        if findings:
            f.write("| 研究 | 列 | 数值 | 说明 |\n|---|---|---|---|\n")
            for a, b, c, d in findings:
                f.write(f"| {a} | {b} | {c} | {d} |\n")
            f.write("\n**这是待核信号，不是造假结论**：算出来的列（SE、权重、合并效应量）"
                    "本就不会出现在原文里，用 `--computed-cols` 排除掉。"
                    "剩下的每一条都必须回原文核对或说明来源，**不得直接写进稿件**。\n")
        else:
            f.write("所有数值均可在来源文本中找到。\n")

    print("-" * 50)
    print(f"核对 {checked} 个数字，{len(findings)} 个找不到出处。报告见 {args.output}")
    if findings:
        for a, b, c, _ in findings[:10]:
            print(f"  待核  {a}  {b}={c}")
        if len(findings) > 10:
            print(f"  …另有 {len(findings) - 10} 条，见报告")
        sys.exit(1)          # 非零退出：让它成为一道过不去就得处理的闸


if __name__ == "__main__":
    main()
