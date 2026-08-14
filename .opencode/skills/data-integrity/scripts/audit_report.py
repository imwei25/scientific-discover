#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 paperconan 的 scan.json 生成人读 REPORT.md——**替代 paperconan 自带的 --md**。

为什么要自己渲染：paperconan 的 `--md`（write_markdown_report）在命中
`cross_sheet_column_duplicate`（跨表列复用，恰是最该重点核对的头号信号）时会
`KeyError: 'row'` 崩溃、CLI 非零退出，照 SKILL 字面跑的 agent 会误以为整次扫描失败。
本脚本用 `.get()` 全程容错，只读已成功落盘的 scan.json，绝不因某类 finding 缺字段而崩。

另附**汇总一致性自查**（paperconan 不覆盖）：对输入表里 含 TOTAL/合计/小计 的行核对
明细加和==汇总、百分比/构成比列核对合计≈100%——出"待核信号"（signal not verdict）。

用法：
  python audit_report.py <audit/scan.json> [--data-dir <被扫目录>] [--out audit/REPORT.md]
"""
import argparse
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_SEV_ORDER = {"high": 0, "medium": 1, "low": 2, "info": 3}
_SEV_LABEL = {"high": "🔴 High", "medium": "🟡 Medium", "low": "🔵 Low", "info": "ℹ️ Info"}


def _loc(f):
    """从任意 finding dict 里尽量拼出"文件·sheet·列"定位串（全用 .get，缺就省略）。"""
    parts = []
    # 跨表 finding 优先用 file_a/file_b（别用已含"a + b"的 file 字段，会重复）
    if f.get("file_a"):
        parts.append(str(f["file_a"]))
        if f.get("file_b") and f["file_b"] != f["file_a"]:
            parts.append("+ " + str(f["file_b"]))
    elif f.get("file"):
        parts.append(str(f["file"]))
    sh = f.get("sheet") or f.get("sheet_a")
    if sh:
        parts.append(f"[{sh}]")
    cols = [c for c in (f.get("col_a"), f.get("col_b"), f.get("column")) if c]
    if cols:
        parts.append("列 " + "↔".join(map(str, cols)))
    return " ".join(parts) or "(位置未标注)"


def collect_findings(scan):
    """把 scan.json 各段的 finding 摊平成统一 dict 列表：{severity, kind, loc, detail}。"""
    out = []
    # relations_blocks：每块内多个子列表
    for blk in scan.get("relations_blocks", []) or []:
        base = {"file": blk.get("file"), "sheet": blk.get("sheet")}
        for subkey in ("relations", "progressions", "equal_pairs", "row_pairs",
                       "within_col", "identical_after_rounding", "grim"):
            for it in blk.get(subkey, []) or []:
                if not isinstance(it, dict):
                    continue
                merged = {**base, **it}
                kind = it.get("kind") or subkey
                sev = it.get("severity") or ("high" if subkey == "grim" and it.get("inconsistent") else "medium")
                detail = _describe(kind, it)
                out.append({"severity": str(sev).lower(), "kind": kind,
                            "loc": _loc(merged), "detail": detail})
    # cross_sheet_findings：最高优先级信号
    for it in scan.get("cross_sheet_findings", []) or []:
        if not isinstance(it, dict):
            continue
        out.append({"severity": str(it.get("severity", "high")).lower(),
                    "kind": it.get("kind", "cross_sheet"),
                    "loc": _loc(it), "detail": _describe(it.get("kind", ""), it)})
    # digit_distribution：仅 FDR 显著的报
    for it in scan.get("digit_distribution", []) or []:
        if it.get("fdr_significant"):
            out.append({"severity": "medium", "kind": "last_digit_distribution",
                        "loc": str(it.get("label", "")),
                        "detail": f"末位数分布偏离均匀 χ²={it.get('chi2',0):.1f}, p_adj={it.get('p_adj',1):.3g}"})
    for it in scan.get("decimal_endings", []) or []:
        if isinstance(it, dict):
            out.append({"severity": str(it.get("severity", "medium")).lower(),
                        "kind": "decimal_ending_overrep", "loc": _loc(it),
                        "detail": _describe("decimal_ending", it)})
    return out


def _describe(kind, it):
    """给一条 finding 生成简短中文描述，全用 .get 容错。"""
    if kind == "identical_column":
        return f"两列数值完全相同（{it.get('col_a')}=={it.get('col_b')}, n={it.get('n')}）——疑复制粘贴"
    if kind == "constant_offset":
        return f"整列固定偏移：{it.get('col_b')}={it.get('col_a')}+{it.get('offset')}"
    if kind == "constant_ratio":
        return f"整列固定比例：{it.get('col_b')}={it.get('col_a')}×{it.get('ratio')}"
    if kind == "exact_linear":
        return f"精确线性派生：{it.get('col_b')}={it.get('slope')}×{it.get('col_a')}+{it.get('intercept')}"
    if kind == "cross_sheet_column_duplicate":
        return (f"跨表列复用：{it.get('col_a')}({it.get('file_a')}) 与 "
                f"{it.get('col_b')}({it.get('file_b')}) 有 {it.get('same_position_count')} "
                f"个同位置相同（占较小列 {it.get('fraction_of_smaller')}）")
    if kind == "cross_sheet_position_identical":
        return f"跨表同位置数值块完全一致（{it.get('same_position_count')} 值）"
    if kind == "grim" or it.get("grim_inconsistent"):
        return f"GRIM 不自洽：报告均值 {it.get('reported_mean')} 与 n={it.get('n')} 的可能均值不符"
    if kind == "arithmetic_progression":
        return f"等差数列列（多为序号/ID，通常良性）"
    if kind == "within_col_decimal_repetition":
        return f"列内小数尾过度重复：{it.get('detail','')}"
    if kind == "identical_after_rounding":
        return f"舍入后同值（有限精度临床值常见，多良性）"
    # 兜底：给出 kind + 少量键值
    kv = {k: v for k, v in it.items() if k not in ("severity", "kind") and not isinstance(v, (list, dict))}
    return kind + " " + "; ".join(f"{k}={v}" for k, v in list(kv.items())[:4])


# ---- 汇总一致性自查（paperconan 未覆盖）----

_TOTAL_RE = re.compile(r"total|合计|总计|小计|合\s*计", re.I)
_PCT_RE = re.compile(r"percent|构成比|占比|%|比例|pct", re.I)


def summary_consistency(data_dir):
    """对目录下 xlsx/csv 表：① 含 TOTAL/合计 的行核对明细加和==汇总；
    ② 百分比/构成比列核对合计≈100%。返回 finding 列表。"""
    try:
        import pandas as pd
    except ImportError:
        return []
    out = []
    if not data_dir or not os.path.isdir(data_dir):
        return out
    for fn in os.listdir(data_dir):
        ext = os.path.splitext(fn)[1].lower()
        if ext not in (".xlsx", ".xls", ".csv", ".tsv"):
            continue
        path = os.path.join(data_dir, fn)
        try:
            sheets = ({None: pd.read_csv(path, sep="\t" if ext == ".tsv" else ",")}
                      if ext in (".csv", ".tsv") else pd.read_excel(path, sheet_name=None))
        except Exception:
            continue
        for sh, df in sheets.items():
            tag = f"{fn}" + (f"[{sh}]" if sh else "")
            num = df.select_dtypes("number")
            # 先识别"合计/TOTAL"行，百分比合计与明细加和都要**排除**它，避免重复计入。
            first_txt = df.iloc[:, 0].astype(str) if df.shape[1] else pd.Series([], dtype=str)
            tot_mask = first_txt.str.contains(_TOTAL_RE, na=False)
            detail_num = num[~tot_mask.values] if tot_mask.any() else num
            # ① 百分比列合计（只加明细行）
            for col in df.columns:
                if _PCT_RE.search(str(col)) and col in detail_num.columns:
                    s = detail_num[col].dropna()
                    if len(s) >= 2:
                        tot = s.sum()
                        # 只在看起来是"一组构成比"（都在0..100且个数>2）时判
                        if s.between(0, 100).all() and abs(tot - 100) > 1.0 and abs(tot - 1.0) > 0.02:
                            out.append({"severity": "medium", "kind": "percent_sum_off",
                                        "loc": f"{tag} 列 {col}",
                                        "detail": f"百分比/构成比列(明细)合计={tot:.2f}（期望≈100 或≈1），差 {tot-100:+.2f}"})
            # ② TOTAL 行 vs 明细加和
            if tot_mask.any():
                detail_rows = num[~tot_mask.values]
                for idx in df.index[tot_mask.values]:
                    for col in num.columns:
                        reported = num.at[idx, col] if idx in num.index else None
                        if reported is None or pd.isna(reported):
                            continue
                        s = detail_rows[col].dropna()
                        if len(s) >= 2:
                            calc = s.sum()
                            if abs(calc - reported) > max(0.5, abs(reported) * 0.005):
                                out.append({"severity": "medium", "kind": "total_mismatch",
                                            "loc": f"{tag} 列 {col}",
                                            "detail": f"汇总行报 {reported}，明细加和 {calc}，差 {reported-calc:+.4g}"})
    return out


def render(scan, extra):
    findings = collect_findings(scan) + extra
    findings.sort(key=lambda f: _SEV_ORDER.get(f["severity"], 4))
    from collections import Counter
    dist = Counter(f["severity"] for f in findings)
    lines = ["# 数据完整性自查报告（signal not verdict）\n",
             f"- 工具：{scan.get('tool','paperconan')} {scan.get('tool_version','')}"
             f" + audit_report（自渲染，规避 paperconan --md 的 KeyError 崩溃）",
             f"- 扫描文件数：{scan.get('n_files','?')}；有发现的块：{scan.get('n_blocks_with_findings','?')}",
             f"- 信号统计：" + ("，".join(f"{_SEV_LABEL.get(k,k)} {v}" for k, v in
                                sorted(dist.items(), key=lambda kv: _SEV_ORDER.get(kv[0], 4))) or "无"),
             "",
             "> ⚠️ 这些是**待人工核对的信号，不是造假结论**。逐条回原表核对，多数有正当解释"
             "（换算/归一化/公式列/仪器量程等）。跨表复用(cross_sheet_*)最难用正当结构解释、优先核。\n"]
    if not findings:
        lines.append("未触发需关注的信号——数据在这些维度上没有会被质疑的模式。")
    for sev in ("high", "medium", "low", "info"):
        group = [f for f in findings if f["severity"] == sev]
        if not group:
            continue
        lines.append(f"\n## {_SEV_LABEL.get(sev, sev)}（{len(group)}）\n")
        for f in group:
            lines.append(f"- **[{f['kind']}]** {f['loc']}\n  - {f['detail']}")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description="从 paperconan scan.json 生成人读报告（替代坏掉的 --md）")
    ap.add_argument("scan_json")
    ap.add_argument("--data-dir", default=None, help="被扫目录（启用汇总一致性自查）")
    ap.add_argument("--out", default=None, help="输出 REPORT.md（默认 scan.json 同目录）")
    a = ap.parse_args()
    try:
        scan = json.load(open(a.scan_json, encoding="utf-8"))
    except Exception as e:
        sys.exit(f"读不了 scan.json：{e}")
    extra = summary_consistency(a.data_dir) if a.data_dir else []
    out = a.out or os.path.join(os.path.dirname(a.scan_json) or ".", "REPORT.md")
    open(out, "w", encoding="utf-8").write(render(scan, extra))
    findings = collect_findings(scan) + extra
    n = len(findings)
    # ---- 结构化裁定（.gate/data-integrity.json）----
    # 网关的质量闸优先读它（web/wf-state.mjs 的 gateVerdict）。注意：这是【信号型】闸，
    # 网关只认这里的 "fail"（High/Medium 信号非零）——"pass" 不豁免模型在 integrity_report.md
    # 里人工列出的信号（本 json 只描述机器扫描那一半，不能替整道闸作保）。
    # .gate 放会话根目录：REPORT.md 常在 audit/ 子目录里，往上提一层。
    try:
        root = os.path.dirname(os.path.abspath(out))
        if os.path.basename(root).lower() == "audit":
            root = os.path.dirname(root)
        gate_dir = os.path.join(root, ".gate")
        os.makedirs(gate_dir, exist_ok=True)
        hm = sum(1 for f in findings if f.get("severity") in ("high", "medium"))
        with open(os.path.join(gate_dir, "data-integrity.json"), "w", encoding="utf-8") as gf:
            json.dump({"skill": "data-integrity",
                       "verdict": "fail" if hm else "pass",
                       "signals": {"high_medium": hm, "total": n},
                       "note": "由 audit_report.py 生成；仅描述机器扫描信号，signal not verdict"},
                      gf, ensure_ascii=False, indent=1)
    except OSError:
        pass
    print(f"REPORT.md 已生成（{n} 条信号，含汇总一致性自查 {len(extra)} 条）→ {out}")


if __name__ == "__main__":
    main()
