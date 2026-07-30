# -*- coding: utf-8 -*-
"""数据体检（pre-flight QC）——进推断统计之前先给数据做一次体检。

只依赖 pandas / numpy（+ openpyxl 读 xlsx）。产出：
  - data_quality.md    人读报告（按 必须处置 / 建议核对 / 记录备查 分级）
  - data_quality.json  机读结构化结果（下游脚本或 agent 引用）
  - stdout 摘要        含"必须回答的问题"清单

定位：这一步只**发现并量化**问题，不替用户改数据。清洗决策要么由用户确认、
要么写进报告的"已做假设"里，绝不静默修数。

用法：
  python data_profile.py --input data.xlsx
  python data_profile.py --input data.csv --id-col 住院号 --group 手术方式
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

try:  # Windows 控制台默认 gbk，中文报告会崩
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# ---------------------------------------------------------------- 常量与词表
ID_PAT = re.compile(r"(住院号|门诊号|病案号|标本号|样本号|patient|subject|sample|_?id$|编号|卡号)", re.I)
DATE_PAT = re.compile(r"(日期|时间|date|time|dob|生日|出生)", re.I)
NONNEG_PAT = re.compile(r"(年龄|age|天数|days|时长|时间|量|浓度|计数|count|数目|个数|剂量|dose|长度|面积|体积|价格|费用|身高|体重|height|weight|bmi)", re.I)
START_PAT = re.compile(r"(入院|入组|手术|开始|起始|admit|start|baseline|randomi)", re.I)
END_PAT = re.compile(r"(出院|结束|终止|末次|随访|discharge|end|last|death|死亡)", re.I)
LIMIT_PAT = re.compile(r"^\s*[<>≤≥]\s*=?\s*[\d.]+\s*$")  # "<0.05" ">100" "≤0.5"
FREETEXT_PAT = re.compile(r"(备注|说明|注释|意见|描述|诊断名|主诉|remark|comment|note|desc|memo)", re.I)
SEXLIKE = {
    "男": "M", "女": "F", "m": "M", "f": "F", "male": "M", "female": "F",
    "1": "?", "2": "?", "0": "?",
}
# 医学常识区间（仅用于"明显不可能"的硬闸，不做临床判断）
IMPOSSIBLE = {
    "年龄": (0, 120), "age": (0, 120),
    "身高": (50, 250), "height": (50, 250),
    "体重": (1, 400), "weight": (1, 400),
    "bmi": (8, 90),
}


def _norm_key(s: str) -> str:
    return str(s).strip().lower().replace(" ", "").replace("_", "")


def _norm_level(v) -> str:
    """分类水平归一：去首尾空白、全角转半角、大小写折叠。"""
    s = str(v)
    s = "".join(chr(ord(c) - 0xFEE0) if 0xFF01 <= ord(c) <= 0xFF5E else c for c in s)
    return s.strip().lower()


def _is_numlike(v) -> bool:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return False
    try:
        float(str(v).strip())
        return True
    except Exception:
        return False


def robust_outliers(s: pd.Series, k: float = 5.0):
    """基于中位数/MAD 的稳健离群（不受离群自身影响，优于 mean±3SD）。"""
    x = pd.to_numeric(s, errors="coerce").dropna()
    if len(x) < 8:
        return [], np.nan
    med = float(x.median())
    mad = float((x - med).abs().median())
    if mad == 0:
        return [], np.nan
    z = (x - med).abs() / (1.4826 * mad)
    hits = x[z > k]
    return [(int(i), float(v), round(float(z.loc[i]), 1)) for i, v in hits.items()], med


def magnitude_split(s: pd.Series):
    """单位混用嫌疑：少数值与主体差 ≥2 个数量级（如 172cm 混进 1.72m、mg/L 混 μg/L）。"""
    x = pd.to_numeric(s, errors="coerce").dropna()
    x = x[x > 0]
    if len(x) < 12:
        return []
    lg = np.log10(x)
    med = float(np.median(lg))
    off = x[(lg - med).abs() >= 1.7]           # ≥ ~50 倍
    # 只有"少数派"偏离才算单位混用；整列统一换算不该报
    if 0 < len(off) <= max(3, int(0.15 * len(x))):
        return [(int(i), float(v)) for i, v in off.items()]
    return []


# ---------------------------------------------------------------- 主体
def profile(df: pd.DataFrame, id_col=None, group=None) -> dict:
    findings = {"must": [], "check": [], "note": []}   # 必须处置 / 建议核对 / 记录备查
    n_rows, n_cols = df.shape
    cols = []

    # ---- 0. 行数 ≠ 样本量 提醒
    # ---- 1. 重复行 / 重复 ID
    dup_full = int(df.duplicated(keep=False).sum())
    if dup_full:
        rows = df.index[df.duplicated(keep=False)].tolist()
        findings["must"].append({
            "type": "duplicate_rows",
            "msg": f"存在 {dup_full} 行完全重复（{dup_full // 2 if dup_full % 2 == 0 else dup_full} 组），"
                   f"行号 {rows[:12]}{'…' if len(rows) > 12 else ''}",
            "action": "确认是重复录入还是同一患者多次入院；重复录入须去重，n 会随之变化",
        })

    id_candidates = [c for c in df.columns if ID_PAT.search(str(c))]
    if id_col and id_col in df.columns:
        id_candidates = [id_col] + [c for c in id_candidates if c != id_col]
    for c in id_candidates[:2]:
        d = df[c][df[c].duplicated(keep=False)]
        if len(d):
            vals = sorted(map(str, d.unique()))
            # 同 ID 是否整行一致
            inconsist = []
            for v in d.unique():
                sub = df[df[c] == v]
                if sub.drop_duplicates().shape[0] > 1:
                    inconsist.append(str(v))
            m = f"标识列「{c}」有 {len(vals)} 个重复取值：{vals[:10]}{'…' if len(vals) > 10 else ''}"
            if inconsist:
                m += f"；其中 {inconsist[:6]} **同号但数值不一致**（更危险：不知该保留哪条）"
            findings["must"].append({
                "type": "duplicate_id", "msg": m,
                "action": "去重后重新统计 n；同号不一致的须回原始病历核对",
            })

    # ---- 2. 逐列体检
    for c in df.columns:
        s = df[c]
        nn = int(s.notna().sum())
        miss = 1 - nn / n_rows if n_rows else 0
        info = {"col": str(c), "dtype": str(s.dtype), "n_valid": nn,
                "missing_pct": round(miss * 100, 1), "n_unique": int(s.nunique(dropna=True))}

        if nn == 0:
            findings["note"].append({"type": "empty_col", "msg": f"「{c}」整列为空", "action": "分析前剔除"})
            cols.append(info); continue
        if info["n_unique"] == 1:
            findings["note"].append({"type": "constant_col",
                                     "msg": f"「{c}」是常量（恒为 {s.dropna().iloc[0]!r}）",
                                     "action": "不能作为分析变量/协变量"})

        # 自由文本列：不作分析变量，但常藏关键线索（"外送/单位ug/L"、"溶血"、"复测"）
        is_freetext = s.dtype == object and not ID_PAT.search(str(c)) and (
            FREETEXT_PAT.search(str(c))
            or (info["n_unique"] > 0.5 * max(nn, 1) and s.dropna().astype(str).str.len().mean() > 8
                and not s.dropna().map(_is_numlike).any())
        )
        if is_freetext:
            samples = [v for v in s.dropna().astype(str).unique() if v.strip()][:6]
            findings["check"].append({
                "type": "freetext_col",
                "msg": f"「{c}」是自由文本列，非空 {nn} 条，例：{samples}",
                "action": "**不作为分析变量**，但必须逐条读一遍——单位/外送/溶血/复测这类线索通常只写在这里，"
                          "会决定某些病例要不要换算或排除",
            })

        # 缺失率（自由文本列的"缺失"无意义，跳过）
        if not is_freetext:
            if miss >= 0.15:
                findings["must"].append({
                    "type": "high_missing",
                    "msg": f"「{c}」缺失 {n_rows - nn}/{n_rows}（{miss*100:.1f}%）",
                    "action": "≥15% 缺失不能默认删除了事：须说明缺失机制（MCAR/MAR）与处理方式"
                              "（完整病例分析 vs 多重插补），并写进 Methods；仅按例删除会损失把握度且可能引入选择偏倚",
                })
            elif miss > 0:
                findings["check"].append({
                    "type": "missing",
                    "msg": f"「{c}」缺失 {n_rows - nn}/{n_rows}（{miss*100:.1f}%）",
                    "action": "在 Methods 交代缺失例数与处理方式；配对/重复测量按例删除会连带丢掉配对的另一半，"
                              "须报实际进入分析的配对数",
                })

        # 数值列被字符串污染（检测限、区间、单位后缀）
        if s.dtype == object:
            vals = s.dropna()
            numlike = vals.map(_is_numlike)
            if len(vals) >= 8 and numlike.mean() >= 0.7 and (~numlike).any():
                bad = vals[~numlike]
                limit = [v for v in bad.unique() if LIMIT_PAT.match(str(v))]
                other = [v for v in bad.unique() if not LIMIT_PAT.match(str(v))]
                m = (f"「{c}」看似数值列但混有 {len(bad)} 个非数值："
                     f"{[str(v) for v in list(bad.unique())[:8]]}")
                act = ("**禁止直接 pd.to_numeric(errors='coerce') 了事**——那会把它们静默变成 NaN、"
                       "样本量凭空缩水且不留痕。")
                if limit:
                    act += (f" 其中 {limit[:5]} 是**检测限（censored）值**：须明确替代规则"
                            "（如 <LoD 取 LoD/2 或 LoD/√2）并写进 Methods，或改用生存分析/Tobit 处理左删失；"
                            "剔除也要报剔除例数。")
                if other:
                    act += f" 其余 {[str(v) for v in other[:5]]} 须回原始记录核对。"
                findings["must"].append({"type": "numeric_polluted", "msg": m, "action": act})

        # 分类变量：水平变体
        looks_cat = (s.dtype == object or info["n_unique"] <= 10) and info["n_unique"] <= 30
        if looks_cat and not DATE_PAT.search(str(c)):
            raw_levels = list(map(str, s.dropna().unique()))
            norm_map = {}
            for v in raw_levels:
                norm_map.setdefault(_norm_level(v), []).append(v)
            collapsed = {k: v for k, v in norm_map.items() if len(v) > 1}
            if collapsed:
                findings["must"].append({
                    "type": "level_variant",
                    "msg": f"「{c}」同一水平有多种写法（空白/大小写/全角）：" +
                           "；".join(f"{v} → {k}" for k, v in list(collapsed.items())[:6]),
                    "action": "先 strip+统一大小写归一，否则分组数虚增、Table 1 与组间检验全错",
                })
            # 编码体系混用（男/M/1）
            fam = {SEXLIKE.get(_norm_level(v)) for v in raw_levels if _norm_level(v) in SEXLIKE}
            if len(raw_levels) > 2 and len(fam) >= 1 and len(norm_map) > 2:
                sys_hit = [v for v in raw_levels if _norm_level(v) in SEXLIKE]
                if len(set(map(_norm_level, sys_hit))) >= 3:
                    findings["must"].append({
                        "type": "coding_mix",
                        "msg": f"「{c}」混用了多套编码：{sorted(set(sys_hit))}",
                        "action": "映射到同一套编码后再统计（如 男/M/1 → M），否则该变量的每个 n(%) 都是错的",
                    })
            info["levels"] = {str(k): int(v) for k, v in s.value_counts(dropna=False).head(12).items()}

        # 连续变量：范围 / 不可能值 / 负值 / 离群 / 单位混用
        num = pd.to_numeric(s, errors="coerce")
        if num.notna().sum() >= 8 and not DATE_PAT.search(str(c)):
            x = num.dropna()
            info["summary"] = {"min": float(x.min()), "p25": float(x.quantile(.25)),
                               "median": float(x.median()), "p75": float(x.quantile(.75)),
                               "max": float(x.max()), "mean": round(float(x.mean()), 3),
                               "sd": round(float(x.std(ddof=1)), 3)}
            key = _norm_key(c)
            flagged_idx = set()
            for pat, (lo, hi) in IMPOSSIBLE.items():
                if pat in key:
                    bad = x[(x < lo) | (x > hi)]
                    if len(bad):
                        flagged_idx |= set(map(int, bad.index))
                        findings["must"].append({
                            "type": "impossible_value",
                            "msg": f"「{c}」有 {len(bad)} 个超出生理可能区间 [{lo}, {hi}] 的值："
                                   f"{[(int(i), float(v)) for i, v in list(bad.items())[:8]]}",
                            "action": "多为录入错误或缺失哨兵值（999/-1）；须回原始记录核对或改记为缺失，不得直接入均值",
                        })
                    break
            if NONNEG_PAT.search(str(c)):
                neg = x[x < 0]
                if len(neg):
                    findings["must"].append({
                        "type": "negative_value",
                        "msg": f"「{c}」应非负却有 {len(neg)} 个负值：{[(int(i), float(v)) for i, v in list(neg.items())[:8]]}",
                        "action": "回原始记录核对（常见于日期相减方向错、缺失哨兵）",
                    })
            mix = [t for t in magnitude_split(num) if t[0] not in flagged_idx]
            if mix:
                findings["must"].append({
                    "type": "unit_mix",
                    "msg": f"「{c}」有 {len(mix)} 个值与主体差 ≥50 倍（量级异常）："
                           f"{mix[:8]}（该列中位数 {float(x.median())}）",
                    "action": "三种常见来源：① 单位混用（cm/m、mg/μg、g/L 与 mg/dL）→ 确认后统一换算；"
                              "② 9999/99999 型缺失哨兵 → 改记为缺失；③ 录入错位（多打一位）→ 回原始记录核对。"
                              "混着算会让均值/SD/回归与图的坐标轴全部失真。若数据里有备注列，先去那里找线索",
                })
            outs, med = robust_outliers(num)
            if outs and not mix:
                findings["check"].append({
                    "type": "extreme_outlier",
                    "msg": f"「{c}」稳健离群（|MAD-z|>5）{len(outs)} 个：{outs[:6]}（中位数 {med}）",
                    "action": "逐个核对是真实极值还是录入错误；保留则考虑非参数方法或敏感性分析，剔除要报剔除数",
                })
            # 分布形态（供选检验参考）
            if len(x) >= 12:
                sk = float(x.skew())
                info["skew"] = round(sk, 2)
                if abs(sk) > 1:
                    findings["note"].append({
                        "type": "skewed",
                        "msg": f"「{c}」明显偏态（skew={sk:.2f}）",
                        "action": "组间比较优先非参数检验或先做正态性检验，别默认 t 检验；描述用 中位数[IQR]",
                    })
        cols.append(info)

    # ---- 3. 日期逻辑
    date_cols = [c for c in df.columns if DATE_PAT.search(str(c))]
    parsed = {}
    for c in date_cols:
        try:
            p = pd.to_datetime(df[c], errors="coerce")
        except Exception:
            continue
        if p.notna().sum() >= max(5, 0.5 * n_rows):
            parsed[c] = p
            fut = p[p > pd.Timestamp.today()]
            if len(fut):
                findings["check"].append({
                    "type": "future_date",
                    "msg": f"「{c}」有 {len(fut)} 个未来日期：{[str(v.date()) for v in fut[:5]]}",
                    "action": "核对录入",
                })
    starts = [c for c in parsed if START_PAT.search(str(c))]
    ends = [c for c in parsed if END_PAT.search(str(c))]
    for a in starts:
        for b in ends:
            bad = df.index[(parsed[b] < parsed[a])]
            if len(bad):
                findings["must"].append({
                    "type": "date_order",
                    "msg": f"「{b}」早于「{a}」共 {len(bad)} 例，行号 {list(bad)[:8]}",
                    "action": "回原始病历核对；由日期相减派生的时长变量（住院天数/随访时间）会连带出错",
                })

    # ---- 4. 分组变量
    if group and group in df.columns:
        g = df[group]
        vc = g.value_counts(dropna=False)
        findings["note"].append({
            "type": "group_sizes",
            "msg": f"分组「{group}」各组例数（含缺失）：{ {str(k): int(v) for k, v in vc.items()} }",
            "action": "报告里的每个 n 用这里的数，别目测",
        })
        if g.isna().any():
            findings["must"].append({
                "type": "group_missing",
                "msg": f"分组变量「{group}」有 {int(g.isna().sum())} 例缺失",
                "action": "无法归组的病例须明确排除并在流程图/正文交代排除例数",
            })
    return {"n_rows": n_rows, "n_cols": n_cols, "columns": cols, "findings": findings}


LEVELS = [("must", "❌ 必须处置（未处置不得进入推断统计）"),
          ("check", "⚠️ 建议核对"),
          ("note", "ℹ️ 记录备查（写进 Methods 用）")]


def to_markdown(res: dict, src: str) -> str:
    L = [f"# 数据体检报告：`{src}`", "",
         f"- 表格形状：**{res['n_rows']} 行 × {res['n_cols']} 列**",
         f"- ⚠️ **行数 ≠ 样本量**：去重、剔除无法归组/关键变量缺失的病例后才是分析样本量 n；"
         f"报告里的每个 n 必须来自代码输出。", ""]
    for key, title in LEVELS:
        items = res["findings"][key]
        L.append(f"## {title}（{len(items)} 项）")
        if not items:
            L.append("\n无。\n")
            continue
        for i, f in enumerate(items, 1):
            L.append(f"\n**{i}. [{f['type']}]** {f['msg']}")
            L.append(f"   → 处置：{f['action']}")
        L.append("")
    L.append("## 逐列概览\n")
    L.append("| 变量 | dtype | 有效n | 缺失% | 唯一值 | 中位数[IQR] 或 主要水平 |")
    L.append("|---|---|---|---|---|---|")
    for c in res["columns"]:
        if "summary" in c:
            s = c["summary"]
            desc = f"{s['median']:g} [{s['p25']:g}, {s['p75']:g}]（min {s['min']:g} / max {s['max']:g}）"
        elif "levels" in c:
            desc = ", ".join(f"{k}: {v}" for k, v in list(c["levels"].items())[:5])
        else:
            desc = "—"
        L.append(f"| {c['col']} | {c['dtype']} | {c['n_valid']} | {c['missing_pct']} | {c['n_unique']} | {desc} |")
    L.append("")
    must = res["findings"]["must"]
    L.append("## 必须回答的问题（逐条答完再往下做）\n")
    if must:
        for i, f in enumerate(must, 1):
            L.append(f"{i}. {f['msg']} —— 打算怎么处理？（处理方式要写进 Methods）")
    else:
        L.append("无必须处置项；仍需在 Methods 交代缺失值处理与排除标准。")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser(description="数据体检（pre-flight QC）")
    ap.add_argument("--input", required=True)
    ap.add_argument("--sheet", default=0)
    ap.add_argument("--id-col", default=None, help="患者/标本唯一标识列（不传则按列名自动猜）")
    ap.add_argument("--group", default=None, help="分组变量列名")
    ap.add_argument("--out", default="data_quality.md")
    a = ap.parse_args()

    p = Path(a.input)
    if not p.exists():
        sys.exit(f"找不到输入文件：{p}")
    if p.suffix.lower() in (".xlsx", ".xls", ".xlsm"):
        sh = int(a.sheet) if str(a.sheet).isdigit() else a.sheet
        df = pd.read_excel(p, sheet_name=sh)
    else:
        df = pd.read_csv(p, sep=None, engine="python", encoding="utf-8-sig")
    df.columns = [str(c).strip() for c in df.columns]

    res = profile(df, id_col=a.id_col, group=a.group)
    out = Path(a.out)
    out.write_text(to_markdown(res, p.name), encoding="utf-8")
    out.with_suffix(".json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")

    f = res["findings"]
    print(f"数据体检：{res['n_rows']} 行 × {res['n_cols']} 列  →  {out} / {out.with_suffix('.json')}")
    print(f"❌ 必须处置 {len(f['must'])} 项 | ⚠️ 建议核对 {len(f['check'])} 项 | ℹ️ 备查 {len(f['note'])} 项\n")
    for key, title in LEVELS[:2]:
        for i, item in enumerate(f[key], 1):
            print(f"{'❌' if key == 'must' else '⚠️ '} [{item['type']}] {item['msg']}")
    if f["must"]:
        print(f"\n【闸】以上 {len(f['must'])} 项须先处置或明确假设，再做 Table 1 / 组间检验 / 建模；"
              f"处理方式写进 Methods 与最终报告。")


if __name__ == "__main__":
    main()
