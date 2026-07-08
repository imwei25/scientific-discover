#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成临床论文的 Table 1（基线特征表）。

按变量类型自动选择呈现与检验方式：
  - 连续变量：正态(Shapiro) → 均数±标准差 + t/ANOVA；非正态 → 中位数[IQR] + Mann-Whitney/Kruskal
  - 分类变量：n (%) + 卡方；期望频数 <5 或样本小 → Fisher 精确检验（2x2）
两组比较时**额外报效应量 + 95%CI**（专业期刊要求，别只给 p）：
  - 连续正态 → 均值差 (95%CI, Welch)
  - 连续非正态 → 中位数差 (95%CI, 百分位 bootstrap)
  - 二分类(2 水平) → OR (95%CI, 必要时 Haldane-Anscombe 0.5 校正)
分组列可选（--group）；给了就出组间比较 p 值列（两组再加效应量列）。

只用已安装的 pandas/numpy/scipy，无需额外依赖。

用法：
  python table1.py --input data.csv --group arm \
      --continuous age,bmi,sbp --categorical sex,smoker \
      --out outputs/table1.csv
  # 不指定变量类型时自动推断（数值→连续，其余→分类）
  python table1.py --input data.csv --group arm --out outputs/table1.csv
"""
import argparse
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import numpy as np
    import pandas as pd
    from scipy import stats
except ImportError:
    sys.exit("缺少 pandas/numpy/scipy：请先运行 install.ps1 / install.sh（或 env-setup 技能）")


def is_normal(x):
    x = x.dropna()
    if len(x) < 3:
        return True
    if len(x) > 5000:
        x = x.sample(5000, random_state=0)
    try:
        return stats.shapiro(x)[1] > 0.05
    except Exception:
        return False


def fmt_p(p):
    if p is None or (isinstance(p, float) and np.isnan(p)):
        return "—"
    return "<0.001" if p < 0.001 else f"{p:.3f}"


def mean_diff_ci(a, b):
    """两组均值差 (a-b) 及 95%CI（Welch，不假设方差齐）。"""
    a, b = np.asarray(a, float), np.asarray(b, float)
    n1, n2 = len(a), len(b)
    if n1 < 2 or n2 < 2:
        return None
    v1, v2 = a.var(ddof=1), b.var(ddof=1)
    se = np.sqrt(v1 / n1 + v2 / n2)
    if se == 0:
        return None
    diff = a.mean() - b.mean()
    df = se ** 4 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1))
    t = stats.t.ppf(0.975, df)
    return diff, diff - t * se, diff + t * se


def median_diff_ci(a, b, n_boot=2000):
    """两组中位数差 (a-b) 及 95%CI（百分位 bootstrap，种子固定→可复现）。"""
    a, b = np.asarray(a, float), np.asarray(b, float)
    if len(a) < 5 or len(b) < 5:
        return None  # 样本太小，bootstrap 不稳，不给 CI
    rng = np.random.default_rng(0)
    diffs = [
        np.median(rng.choice(a, len(a), replace=True))
        - np.median(rng.choice(b, len(b), replace=True))
        for _ in range(n_boot)
    ]
    diff = np.median(a) - np.median(b)
    lo, hi = np.percentile(diffs, [2.5, 97.5])
    return diff, lo, hi


def odds_ratio_ci(a, b, c, d):
    """2x2 的 OR 及 95%CI。表格为 [[a,b],[c,d]]，OR=(a*d)/(b*c)。
    任一格为 0 时用 Haldane-Anscombe 加 0.5 校正。"""
    if min(a, b, c, d) == 0:
        a, b, c, d = a + 0.5, b + 0.5, c + 0.5, d + 0.5
    orr = (a * d) / (b * c)
    se = np.sqrt(1 / a + 1 / b + 1 / c + 1 / d)
    lo = np.exp(np.log(orr) - 1.96 * se)
    hi = np.exp(np.log(orr) + 1.96 * se)
    return orr, lo, hi


def fmt_effect(val):
    if val is None:
        return "—"
    est, lo, hi = val
    return f"{est:.2f} ({lo:.2f}, {hi:.2f})"


def summarize_continuous(df, var, group, groups, two):
    x_all = pd.to_numeric(df[var], errors="coerce")
    if x_all.notna().sum() == 0:
        print(f"⚠️ 变量 {var!r} 指定为连续但无有效数值（可能类型指定反了）——已跳过。")
        return None
    # 逐组分别判正态：组间均值差异大时，合并数据会呈双峰而被误判为非正态，
    # 从而把本该 t 检验的正态变量错切成非参数。各组都正态才按正态处理。
    if group:
        per_group = [pd.to_numeric(df.loc[df[group] == g, var], errors="coerce") for g in groups]
        normal = all(is_normal(x) for x in per_group if x.notna().sum() > 0)
    else:
        normal = is_normal(x_all)
    row = {"变量": f"{var}" + ("（均数±SD）" if normal else "（中位数[IQR]）")}
    cells = []
    for g in groups:
        x = pd.to_numeric(df.loc[df[group] == g, var], errors="coerce").dropna() if group else x_all.dropna()
        if normal:
            cells.append((g, f"{x.mean():.2f}±{x.std():.2f}"))
        else:
            q1, q3 = x.quantile(0.25), x.quantile(0.75)
            cells.append((g, f"{x.median():.2f}[{q1:.2f}, {q3:.2f}]"))
    for g, v in cells:
        row[str(g)] = v
    # p 值
    p = None
    if group and len(groups) >= 2:
        samples = [pd.to_numeric(df.loc[df[group] == g, var], errors="coerce").dropna() for g in groups]
        samples = [s for s in samples if len(s) > 0]
        try:
            if len(samples) == 2:
                p = stats.ttest_ind(*samples, equal_var=False)[1] if normal else stats.mannwhitneyu(*samples)[1]
            elif len(samples) > 2:
                p = stats.f_oneway(*samples)[1] if normal else stats.kruskal(*samples)[1]
        except Exception:
            p = None
    row["P"] = fmt_p(p)
    row["检验"] = ("" if not group or len(groups) < 2 else
                   ("t/Welch" if normal and len(groups) == 2 else
                    "ANOVA" if normal else
                    "Mann-Whitney" if len(groups) == 2 else "Kruskal-Wallis"))
    # 效应量 + 95%CI（仅两组）：均值差(正态) / 中位数差(非正态)，方向 = 首组 − 次组
    if two:
        a = pd.to_numeric(df.loc[df[group] == groups[0], var], errors="coerce").dropna().values
        b = pd.to_numeric(df.loc[df[group] == groups[1], var], errors="coerce").dropna().values
        try:
            eff = mean_diff_ci(a, b) if normal else median_diff_ci(a, b)
        except Exception:
            eff = None
        row["效应量(95%CI)"] = ("均值差 " if normal else "中位数差 ") + fmt_effect(eff)
    return row


def summarize_categorical(df, var, group, groups, two):
    rows = []
    cats = sorted(df[var].dropna().unique().tolist(), key=str)
    # 列联表用于检验
    p, test = None, ""
    ct = None
    if group and len(groups) >= 2:
        ct = pd.crosstab(df[var], df[group])
        try:
            chi2, p_chi, dof, expected = stats.chi2_contingency(ct)
            if ct.shape == (2, 2) and (expected < 5).any():
                p = stats.fisher_exact(ct.values)[1]
                test = "Fisher 精确"
            else:
                p = p_chi
                test = "卡方"
                # RxC 表期望频数偏低时卡方近似不可靠——scipy 无 Fisher-Freeman-Halton，如实标注。
                if (expected < 5).any():
                    test = "卡方⚠期望<5"
        except Exception:
            p, test = None, ""
    header = {"变量": f"{var}, n(%)"}
    for g in groups:
        header[str(g)] = ""
    header["P"] = fmt_p(p)
    header["检验"] = test
    # 效应量 OR(95%CI)：仅当两组 + 恰好 2 水平（2x2）。方向：以次水平为“阳性”，首组 vs 次组。
    if two:
        eff_txt = "—"
        if len(cats) == 2:
            pos, ref = cats[1], cats[0]  # “阳性”结局取排序后第二个水平，首水平为参照
            g0 = df[df[group] == groups[0]][var]
            g1 = df[df[group] == groups[1]][var]
            a = int((g0 == pos).sum()); b = int((g0 == ref).sum())
            c = int((g1 == pos).sum()); d = int((g1 == ref).sum())
            try:
                orr = odds_ratio_ci(a, b, c, d)
                eff_txt = f"OR[{pos}] " + fmt_effect(orr)
            except Exception:
                eff_txt = "—"
        header["效应量(95%CI)"] = eff_txt
    rows.append(header)
    for c in cats:
        r = {"变量": f"　{c}"}
        for g in groups:
            sub = df[df[group] == g] if group else df
            n = (sub[var] == c).sum()
            denom = sub[var].notna().sum()
            r[str(g)] = f"{n} ({100*n/denom:.1f})" if denom else "0 (0.0)"
        r["P"] = ""
        r["检验"] = ""
        if two:
            r["效应量(95%CI)"] = ""
        rows.append(r)
    return rows


def main():
    ap = argparse.ArgumentParser(description="生成 Table 1 基线特征表")
    ap.add_argument("--input", required=True)
    ap.add_argument("--group", default=None, help="分组列名（可选）")
    ap.add_argument("--continuous", default="", help="连续变量，逗号分隔（默认自动推断）")
    ap.add_argument("--categorical", default="", help="分类变量，逗号分隔（默认自动推断）")
    ap.add_argument("--out", default="outputs/table1.csv")
    args = ap.parse_args()

    try:
        df = pd.read_csv(args.input) if args.input.lower().endswith(".csv") else pd.read_excel(args.input)
    except Exception as e:
        sys.exit(f"读不了输入文件 {args.input}：{e}（确认是有内容的 CSV/Excel）")
    if df.empty or len(df.columns) == 0:
        sys.exit("输入文件没有数据。")
    group = args.group
    if group and group not in df.columns:
        sys.exit(f"分组列 {group!r} 不在数据里。可用列：{list(df.columns)}")
    groups = sorted(df[group].dropna().unique().tolist()) if group else ["总体"]
    if group and len(groups) < 2:
        print(f"⚠️ 分组列 {group!r} 只有 1 个取值，不会做组间检验（只出各变量描述）。")
    two = bool(group) and len(groups) == 2  # 恰好两组才报效应量+95%CI

    cont = [c.strip() for c in args.continuous.split(",") if c.strip()]
    cat = [c.strip() for c in args.categorical.split(",") if c.strip()]
    if not cont and not cat:  # 自动推断
        for c in df.columns:
            if c == group:
                continue
            if pd.api.types.is_numeric_dtype(df[c]) and df[c].nunique() > 6:
                cont.append(c)
            else:
                cat.append(c)
    else:
        # 显式指定时做合理性检查，防用反
        for c in cont:
            if c in df.columns and not pd.api.types.is_numeric_dtype(pd.to_numeric(df[c], errors="coerce")):
                print(f"⚠️ {c!r} 被指定为连续变量，但转不成数值——可能类型指定反了。")
        for c in cat:
            if c in df.columns and df[c].nunique() > 20:
                print(f"⚠️ {c!r} 被指定为分类变量，但有 {df[c].nunique()} 个不同取值——可能应是连续变量。")

    out_rows = []
    # 首行：各组 n
    nrow = {"变量": "样本量 n"}
    for g in groups:
        nrow[str(g)] = str((df[group] == g).sum() if group else len(df))
    nrow["P"] = ""
    nrow["检验"] = ""
    if two:
        nrow["效应量(95%CI)"] = ""
    out_rows.append(nrow)

    for v in cont:
        if v in df.columns:
            r = summarize_continuous(df, v, group, groups, two)
            if r is not None:
                out_rows.append(r)
    for v in cat:
        if v in df.columns:
            out_rows.extend(summarize_categorical(df, v, group, groups, two))

    cols = ["变量"] + [str(g) for g in groups] + (["效应量(95%CI)", "P", "检验"] if two else (["P", "检验"] if group else []))
    result = pd.DataFrame(out_rows)
    for c in cols:
        if c not in result.columns:
            result[c] = ""
    result = result[cols]
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    result.to_csv(args.out, index=False, encoding="utf-8-sig")

    print(f"Table 1 已生成：{args.out}（{len(cont)} 连续 + {len(cat)} 分类变量，分组={group or '无'}）")
    if two:
        print(f"效应量方向：均值差/中位数差 = {groups[0]} − {groups[1]}；OR 以“次水平”为阳性、{groups[0]} 对 {groups[1]}。")
    print("⚠️ 自动选择检验只是起点：请人工核对每个变量的检验是否合适（如配对/重复测量、协变量调整需另做）。")
    print(result.to_string(index=False))


if __name__ == "__main__":
    main()
