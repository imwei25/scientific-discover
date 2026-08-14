#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
跨文献矛盾扫描（确定性脚手架）：吃一份"论断台账"，按可比的 (干预/暴露 → 结局)
分组，标出组内**方向相反**的候选冲突，供主代理逐个裁定（真矛盾 / 可调和 /
证据分级可解 / 伪冲突）。

分工（照套件惯例）：**Python 只做确定性分组 + 方向冲突标记**，不下"矛盾"结论；
**是不是真矛盾、为什么，由主代理读候选冲突后裁定**（见 SKILL.md「阶段 3」）。

台账（claims_ledger）怎么来：主代理读 evidence.md 的摘要，逐篇抽 0..N 条论断，
每条**必须带 quote（摘要原句）**，抽不到原句就不登记——从源头杜绝"幻觉出来的矛盾"。

用法：
  python contradiction.py --input claims_ledger.csv
产出（--outdir，默认取 input 同目录）：
  contradiction_candidates.md   人读：按 (canon_i→canon_o) 分组，冲突组在前
  contradiction_candidates.csv  逐条明细（含 group_id / conflict 标记）

台账 CSV 必需列（表头，缺列会报错并提示）：
  claim_id, ref, canon_i, canon_o, direction, design, quote
可选列（有则带进报告，帮裁定）：
  population, intervention, comparator, outcome, effect, qualifiers
direction 取值（大小写/中文都认）：
  increase(升/正相关/有效/升高) | decrease(降/负相关/降低) |
  no_effect(无效/无差异/无关联) | mixed(混合/不一致)
"""
import argparse
import csv
import os
import re
import sys
from collections import defaultdict, Counter

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

REQUIRED = ["claim_id", "ref", "canon_i", "canon_o", "direction", "design", "quote"]

# 证据等级权重（越大越强）——只用于排序展示，帮主代理裁定"证据分级可解"，不替它下判决。
DESIGN_WEIGHT = {
    "meta-analysis": 6, "meta": 6, "systematic review": 6, "guideline": 6,
    "rct": 5, "randomized": 5, "randomised": 5,
    "cohort": 4, "prospective": 4, "longitudinal": 4,
    "case-control": 3, "case control": 3,
    "cross-sectional": 2, "survey": 2,
    "case-report": 1, "case report": 1, "case series": 1,
    "preclinical": 1, "in vitro": 1, "in vivo": 1, "animal": 1,
    "other": 0, "": 0,
}

# direction 归一（中英/同义 → 三态 + mixed）
_DIR_MAP = [
    ("increase", r"increase|\bup\b|higher|positive|risk|harm|有效|升高?|正相关|增加|升"),
    ("decrease", r"decrease|\bdown\b|lower|reduc|protect|benefit|降低?|负相关|减少|下降|降"),
    ("no_effect", r"no[_\s-]?effect|no[_\s-]?assoc|null|no[_\s-]?diff|nonsignificant|无效|无差异|无关联|无相关|不显著"),
    ("mixed", r"mixed|inconsistent|conflict|混合|不一致|矛盾"),
]


def norm_dir(v):
    t = (v or "").strip().lower()
    if not t:
        return "unknown"
    for name, pat in _DIR_MAP:
        if re.search(pat, t):
            return name
    return "unknown"


# 医学常见缩写↔全称映射（双向都归到右侧规范全称）。用于分组前把 aki 与
# "acute kidney injury"、sglt2i 与 "sglt2 inhibitor" 折叠到同一 key——否则真矛盾
# (一方登记缩写、一方登记全称)会被拆进两个"一致"组、静默漏标（旧版最大盲区）。
_ABBREV = {
    "aki": "acute kidney injury", "ckd": "chronic kidney disease",
    "eskd": "end stage kidney disease", "esrd": "end stage kidney disease",
    "eskf": "end stage kidney disease", "mace": "major adverse cardiovascular events",
    "mi": "myocardial infarction", "hf": "heart failure",
    "hfref": "heart failure with reduced ejection fraction",
    "hfpef": "heart failure with preserved ejection fraction",
    "cvd": "cardiovascular disease", "cv": "cardiovascular",
    "t2dm": "type 2 diabetes", "t2d": "type 2 diabetes", "dm": "diabetes",
    "egfr": "estimated glomerular filtration rate", "gfr": "glomerular filtration rate",
    "uacr": "urine albumin to creatinine ratio", "acr": "albumin to creatinine ratio",
    "sglt2i": "sglt2 inhibitor", "sglt2": "sglt2 inhibitor",
    "sglt-2": "sglt2 inhibitor", "sglt2is": "sglt2 inhibitor",
    "glp1ra": "glp-1 receptor agonist", "glp1": "glp-1 receptor agonist",
    "glp-1ra": "glp-1 receptor agonist", "acei": "ace inhibitor",
    "arb": "angiotensin receptor blocker", "raas": "renin angiotensin aldosterone system",
    "bp": "blood pressure", "sbp": "systolic blood pressure",
    "dbp": "diastolic blood pressure", "ldl": "ldl cholesterol",
    "hba1c": "hemoglobin a1c", "os": "overall survival",
    "pfs": "progression free survival", "ci": "confidence interval",
    "hr": "hazard ratio", "or": "odds ratio", "rr": "relative risk",
    "af": "atrial fibrillation", "copd": "chronic obstructive pulmonary disease",
    "nafld": "non-alcoholic fatty liver disease", "hcc": "hepatocellular carcinoma",
}
# 复数→单数（关键实义词），去连字符后再比。
_PLURAL = {"inhibitors": "inhibitor", "agonists": "agonist", "events": "event",
           "outcomes": "outcome", "levels": "level", "blockers": "blocker",
           "diseases": "disease", "injuries": "injury"}


def canonicalize(v):
    """把 canon_i/canon_o 归一到规范全称：小写→压空白→整体查缩写表→逐词展开缩写，
    再统一做一遍复数→单数 + 去相邻重复词。让缩写、全称、单复数变体折叠到同一 key。"""
    s = re.sub(r"\s+", " ", (v or "").strip().lower()).strip(" .;:")
    if not s:
        return ""
    # 1) 整体命中缩写表（aki / mace / sglt2i …）
    expanded = _ABBREV.get(s) or _ABBREV.get(s.replace("-", ""))
    if expanded is None:
        # 2) 逐词展开（某词可能展成短语，如 sglt2→"sglt2 inhibitor"）
        expanded = " ".join(_ABBREV.get(t) or _ABBREV.get(t.replace("-", ""), t)
                            for t in s.split(" "))
    # 3) 统一收尾：每个词复数→单数（"events"/"inhibitors" 与 "event"/"inhibitor" 对齐），
    #    并去掉相邻重复词（"sglt2 inhibitor" 展开时产生的 "inhibitor inhibitor"）。
    words = [_PLURAL.get(w, w) for w in expanded.split(" ") if w]
    out = []
    for w in words:
        if not out or out[-1] != w:
            out.append(w)
    return " ".join(out)


def norm_key(v):
    """canon_i / canon_o 分组归一：现走 canonicalize（缩写/全称/单复数折叠）。"""
    return canonicalize(v)


def design_weight(design):
    d = (design or "").strip().lower()
    for k, w in DESIGN_WEIGHT.items():
        if k and k in d:
            return w
    return 0


def load_ledger(path):
    ext = os.path.splitext(path)[1].lower()
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        if ext in (".csv", ".tsv"):
            rd = csv.DictReader(f, delimiter="\t" if ext == ".tsv" else ",")
            miss = [c for c in REQUIRED if c not in (rd.fieldnames or [])]
            if miss:
                sys.exit(f"台账缺必需列：{miss}\n必需列：{REQUIRED}\n表头见 contradiction.py 顶部说明。")
            for r in rd:
                if not (r.get("quote") or "").strip():
                    # 无原句的论断丢弃（护栏：防幻觉矛盾）
                    continue
                rows.append(r)
        else:
            sys.exit("台账请用 .csv 或 .tsv。")
    return rows


CONFLICT_DIRS = {"increase", "decrease", "no_effect"}


def analyze(rows):
    """按 (canon_i, canon_o) 分组，判每组是否有方向冲突。"""
    groups = defaultdict(list)
    for r in rows:
        r["_dir"] = norm_dir(r.get("direction"))
        r["_w"] = design_weight(r.get("design"))
        gid = (norm_key(r.get("canon_i")), norm_key(r.get("canon_o")))
        groups[gid].append(r)

    analyzed = []
    for gid, items in groups.items():
        dirs = set(x["_dir"] for x in items) & CONFLICT_DIRS
        # 冲突 = 组内出现相反方向：升 vs 降，或 (升/降) vs 无效
        has_up_down = "increase" in dirs and "decrease" in dirs
        has_effect_null = ("no_effect" in dirs) and bool(dirs & {"increase", "decrease"})
        conflict = has_up_down or has_effect_null
        # 组内还有 mixed 的，也提请注意（单篇自称结论不一致）
        any_mixed = any(x["_dir"] == "mixed" for x in items)
        items.sort(key=lambda x: x["_w"], reverse=True)
        analyzed.append(dict(gid=gid, items=items, conflict=conflict,
                             any_mixed=any_mixed, n=len(items),
                             dirs=sorted(dirs)))
    # 冲突组在前；组内证据越强、条目越多的靠前
    analyzed.sort(key=lambda g: (g["conflict"], g["n"],
                                 max((x["_w"] for x in g["items"]), default=0)),
                  reverse=True)
    return analyzed


def write_reports(analyzed, outdir, i_vals=None, o_vals=None,
                  i_clusters=None, o_clusters=None):
    os.makedirs(outdir, exist_ok=True)
    optional = ["population", "intervention", "comparator", "outcome", "effect", "qualifiers"]

    csv_path = os.path.join(outdir, "contradiction_candidates.csv")
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        cols = ["group_id", "conflict", "canon_i", "canon_o", "direction_norm",
                "design", "design_weight", "ref", "claim_id"] + optional + ["quote"]
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for i, g in enumerate(analyzed, 1):
            for x in g["items"]:
                row = {"group_id": i, "conflict": "YES" if g["conflict"] else "",
                       "canon_i": x.get("canon_i"), "canon_o": x.get("canon_o"),
                       "direction_norm": x["_dir"], "design": x.get("design"),
                       "design_weight": x["_w"], "ref": x.get("ref"),
                       "claim_id": x.get("claim_id"), "quote": x.get("quote")}
                for c in optional:
                    row[c] = x.get(c, "")
                w.writerow(row)

    n_conf = sum(1 for g in analyzed if g["conflict"])
    md_path = os.path.join(outdir, "contradiction_candidates.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# 跨文献矛盾候选（{len(analyzed)} 组，其中方向冲突 {n_conf} 组）\n\n")
        f.write("> **候选、非判决**：本表只做确定性分组 + 方向冲突标记。每个 ⚠️ 冲突组，"
                "主代理须逐个裁定 **TRUE 真矛盾 / RECONCILABLE 可调和 / WEIGHT 证据分级可解 / "
                "SPURIOUS 伪冲突**，写进 `contradiction_matrix.md`。默认偏向可调和——"
                "只有 P/I/C/O/时点可比且证据强度相当才判真矛盾；判 TRUE 前对涉事文献"
                "用 `fulltext-retrieval` 读全文再定。**裁定时不许静默删掉冲突一方。**\n\n")
        # 归一词表审计：让"同义没合并"的碎片化一眼可见
        if i_clusters or o_clusters:
            f.write("> ⚠️ **疑似归一碎片化**——下列标签看着像同义却写成了不同 canon 值，"
                    "会把本该同组的相反方向拆进多个\"一致\"组、漏标真矛盾。若指同一"
                    "干预/结局，请在台账里统一后重跑：\n>\n")
            for grp in (i_clusters or []):
                f.write(f"> - `canon_i`: {' | '.join(grp)}\n")
            for grp in (o_clusters or []):
                f.write(f"> - `canon_o`: {' | '.join(grp)}\n")
            f.write("\n")
        if i_vals or o_vals:
            f.write(f"<sub>canon_i 取值（{len(i_vals or [])}）：{', '.join(i_vals or []) or 'n/a'}　｜　"
                    f"canon_o 取值（{len(o_vals or [])}）：{', '.join(o_vals or []) or 'n/a'}</sub>\n\n")
        for i, g in enumerate(analyzed, 1):
            ci, co = g["gid"]
            tag = "⚠️ 方向冲突" if g["conflict"] else ("· mixed" if g["any_mixed"] else "· 一致")
            f.write(f"## 组 {i} [{tag}] {ci or '?'} → {co or '?'}　（{g['n']} 条，方向：{', '.join(g['dirs']) or 'n/a'}）\n\n")
            for x in g["items"]:
                f.write(f"- **{x['_dir']}** | {x.get('design','?')}(权重{x['_w']}) | {x.get('ref','?')}"
                        f" | claim `{x.get('claim_id','')}`\n")
                quals = x.get("qualifiers", "") or ""
                if quals:
                    f.write(f"  - 条件：{quals}\n")
                if x.get("effect"):
                    f.write(f"  - 效应：{x.get('effect')}\n")
                f.write(f"  - 原句：> {x.get('quote','')}\n")
            f.write("\n")
    return md_path, csv_path, n_conf


_VOCAB_STOP = {"the", "and", "for", "with", "level", "levels", "status",
               "risk", "effect", "outcome", "outcomes", "disease"}


def vocab_audit(rows, field):
    """列出某字段（canon_i / canon_o）的全部不同值，并把**共享实义词**的值聚成
    一簇——一簇里 >1 个值多半是**本该合并却写岔了的同义标签**（归一碎片化，会让
    真矛盾被拆进多个"一致"组而漏标）。返回 (distinct_values, suspicious_clusters)。"""
    vals = sorted({norm_key(r.get(field)) for r in rows if norm_key(r.get(field))})
    def toks(v):
        return {t for t in re.findall(r"[a-z0-9]+", v) if len(t) >= 4 and t not in _VOCAB_STOP}
    clusters = []
    used = set()
    for i, a in enumerate(vals):
        if a in used:
            continue
        grp, ta = [a], toks(a)
        for b in vals[i + 1:]:
            if b in used:
                continue
            if ta & toks(b):
                grp.append(b); used.add(b)
        if len(grp) > 1:
            used.add(a); clusters.append(grp)
    return vals, clusters


def main():
    ap = argparse.ArgumentParser(description="跨文献矛盾扫描（确定性脚手架）")
    ap.add_argument("--input", required=True, help="论断台账 CSV/TSV")
    ap.add_argument("--outdir", help="产物目录（默认 input 同目录）")
    args = ap.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f"找不到台账：{args.input}")
    outdir = args.outdir or os.path.dirname(os.path.abspath(args.input))

    rows = load_ledger(args.input)
    if not rows:
        sys.exit("台账里没有带 quote 的有效论断（护栏：无原句不登记）。")
    analyzed = analyze(rows)
    i_vals, i_clusters = vocab_audit(rows, "canon_i")
    o_vals, o_clusters = vocab_audit(rows, "canon_o")
    md, csvp, n_conf = write_reports(analyzed, outdir, i_vals, o_vals,
                                     i_clusters, o_clusters)

    dist = Counter(r["_dir"] for r in rows)
    print(f"读入 {len(rows)} 条论断（带原句），归 {len(analyzed)} 组。")
    print(f"方向分布：{dict(dist)}")
    print(f"⚠️ 方向冲突组：{n_conf} —— 待主代理裁定。")
    # 归一碎片化护栏：把"看着像同义、却被写成不同 canon 值"的簇报出来。
    frag = i_clusters + o_clusters
    if frag:
        print("─" * 50)
        print("⚠️ 疑似归一碎片化（同义标签没合并 → 真矛盾可能被拆散漏标）：")
        for grp in i_clusters:
            print(f"   canon_i: {' | '.join(grp)}")
        for grp in o_clusters:
            print(f"   canon_o: {' | '.join(grp)}")
        print("   若这些指同一干预/结局，请在台账里统一成同一个 canon 值后重跑。")
    print(f"已写：{md}\n      {csvp}")


if __name__ == "__main__":
    main()
