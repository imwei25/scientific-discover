#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
statcheck 式 p 值一致性自查：从稿件正文里抓统计检验报告
（t / F / r / z / χ²），用统计量+自由度**重算 p 值**，和作者报告的 p 比对，
标出不一致——尤其是"显著性判断被算错"（重算跨过 0.05 而报告没跨，或反之）。

定位：投稿前自查的 **signal not verdict** 工具（与 data-integrity 主线一致）。
产出的是"这几处 p 值请回原始分析核对"的待核信号，**不是**"数据造假"结论——
最常见的成因是笔误、单双尾混用、四舍五入，而非不端。

用法：
  python pcheck.py manuscript.md                 # 扫一个文件
  python pcheck.py --text "t(28)=2.05, p=.02"    # 直接给文本
  python pcheck.py results.txt --outdir audit
产出（--outdir，默认 outputs）：
  pcheck.md   人读报告（High=判断错 / Medium=数值不符 / 提示=可能单尾）
  pcheck.csv  逐条明细（类型/统计量/df/报告p/重算p/结论）

匹配的报告格式（大小写、空格容错）：
  t(28) = 2.05, p = .048        F(2, 57) = 3.11, p = .05
  r(30) = .42, p = .02          z = 1.98, p = .04
  χ²(1) = 4.10, p = .04         chi2(1, N=90) = 4.10, p = .04
只认"统计量+自由度+p 三者齐全"的句子；缺自由度的（如裸 z 之外）无法重算、跳过。
"""
import argparse
import csv
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    from scipy import stats
except ImportError:
    sys.exit("缺少 scipy：先在仓库根跑 env-setup 技能，或 .venv 里 pip install scipy")

# --- 报告 p 的解析：支持 =, <, >, 及 p=.000 / ns ---------------------------
_PNUM = r"(?P<pop>[<>=]|=)\s*(?P<pval>\d?\.\d+|\d+\.?\d*|ns)"
P_RE = re.compile(r"\bp\s*" + _PNUM, re.I)

# 数值：允许 .048 或 0.048 或 2 或 3.11
_NUM = r"[-+]?\d*\.?\d+"


# ---- 产物目录解析（8 个技能脚本统一；见 AGENTS.md §五）----
# 优先级：显式参数 > SCI_OUTPUT_DIR 环境变量 > 当前工作目录(若已在 outputs/<会话id>/ 内) > 报错中止。
# 【绝不】再默认写共享的 outputs/ 根：那里不会出现在界面"产出"侧栏，
# 且同一用户的多个会话共用一个 outputs 卷，写固定名会跨会话互相覆盖。
# 为什么必须由外部传进来：opencode 是【一个进程服务所有会话】的，
# 脚本自己读不到任何会话级上下文，只能靠主控（网关每轮注入的 preamble）用环境变量或参数告知。
def _resolve_out_dir(explicit=None):
    import os as _os, sys as _sys
    from pathlib import Path as _Path
    _cwd = _Path.cwd()
    _in_session = _cwd.parent.name == 'outputs'   # cwd 已是 outputs/<会话id>/
    if explicit:
        _p = _Path(explicit)
        # 【拦截已知的错误传法】cwd 已经是会话产物目录，却又传了以 outputs/ 开头的相对路径：
        # 那会写成 outputs/<会话id>/outputs/xxx —— 网关的 dirState 只列顶层文件，
        # 这份产物在界面“产出”侧栏里【永远看不见】，用户会以为跑成功了却什么都没拿到。
        # 这是旧文档教出来的写法，宁可响亮报错也不要静默产出不可见的文件。
        if _in_session and not _p.is_absolute() and _p.parts and _p.parts[0] == 'outputs':
            _m = [
                '!! 产物目录参数写法有误，已中止。',
                '   你传的是： ' + str(explicit),
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_cwd),
                '   再拼 outputs/ 前缀会写成 ' + str(_cwd / _p) + '，',
                '   而界面的“产出”侧栏只列顶层文件，嵌套子目录里的产物用户永远看不到。',
                '   正确写法：直接用【裸文件名】（如 --out table1.csv），或干脆不传该参数。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    _env = (_os.environ.get('SCI_OUTPUT_DIR') or '').strip()
    if _env:
        _e = _Path(_env)
        # 与 explicit 分支同样的拦截。这条尤其要紧：项目文档教的就是
        # `SCI_OUTPUT_DIR=outputs/<会话id>` 这个【相对】写法，而 cwd 已经是会话产物目录，
        # 解析出来就是 outputs/<会话id>/outputs/<会话id>/ —— 产物在界面上永远看不见。
        if _in_session and not _e.is_absolute() and _e.parts and _e.parts[0] == 'outputs':
            _m = [
                '!! 环境变量 SCI_OUTPUT_DIR 的写法有误，已中止。',
                '   当前值： SCI_OUTPUT_DIR=' + _env,
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_cwd),
                '   再拼 outputs/ 前缀会写成 ' + str(_cwd / _e) + '，',
                '   而界面的“产出”侧栏只列顶层文件，嵌套子目录里的产物用户永远看不到。',
                '   正确做法：不要设这个环境变量（脚本会自动认出当前目录），',
                '   或把它设成【绝对路径】。',
            ]
            _sys.exit(chr(10).join(_m))
        return _e
    if _in_session:
        return _cwd
    _msg = [
        '!! 未指定产物目录，已中止（不再默认写共享的 outputs/ 根）。',
        '   正常情况下不需要指定：每轮对话的当前工作目录就是本会话的产物目录，',
        '   直接用裸文件名即可（如 --out table1.csv）。现在会走到这里，说明当前工作目录是',
        '   ' + str(_cwd) + '，不在任何会话产物目录下。',
        '   请任选一种方式指定：',
        '     1) 先切回本会话的产物目录再跑（推荐）',
        '     2) 环境变量： SCI_OUTPUT_DIR=<会话产物目录绝对路径>',
        '     3) 显式参数： --outdir <会话产物目录绝对路径>',
        '   注意路径要用【绝对路径】或相对当前目录的正确路径，不要再拼 outputs/<会话id>：',
        '   那是旧架构的写法，现在会多套一层目录导致产物在界面上不可见。',
        '   原因：写到共享的 outputs/ 根会跨会话互相覆盖，且不出现在界面的“产出”侧栏里。',
    ]
    _sys.exit(chr(10).join(_msg))

def _resolve_out_file(explicit=None, default_name="output"):
    import sys as _sys
    from pathlib import Path as _Path
    if explicit:
        _p = _Path(explicit)
        # 同 _resolve_out_dir：cwd 已是会话产物目录时再拼 outputs/ 前缀，产物会落到
        # outputs/<会话id>/outputs/... —— 界面“产出”侧栏只列顶层文件，用户永远看不见。
        if (_Path.cwd().parent.name == 'outputs' and not _p.is_absolute()
                and _p.parts and _p.parts[0] == 'outputs'):
            _m = [
                '!! 产物路径写法有误，已中止。',
                '   你传的是： ' + str(explicit),
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_Path.cwd()),
                '   再拼 outputs/ 前缀会写成 ' + str(_Path.cwd() / _p) + '，',
                '   而界面的“产出”侧栏只列顶层文件，嵌套子目录里的产物用户永远看不到。',
                '   正确写法：直接用【裸文件名】（如 --out ' + default_name + '）。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    return _resolve_out_dir() / default_name


def _fmt(v):
    return f"{v:.4g}"


def parse_reported_p(text):
    """从检验句尾巴里抽 p 的算符与数值。返回 (op, value, ndecimals) 或 None。
    value 为浮点；'ns' 记为 ('ns', None, 0)；p=.000 记 ('<', 0.0005, 3) 近似。"""
    m = P_RE.search(text)
    if not m:
        return None
    op, raw = m.group("pop"), m.group("pval")
    if raw.lower() == "ns":
        return ("ns", None, 0)
    # 小数位数（决定按几位四舍五入比对）
    nd = len(raw.split(".")[1]) if "." in raw else 0
    val = float(raw)
    if op == "=" and val == 0.0:  # p = .000 —— 报告成 0 不可能，视作 < 10^-nd
        return ("<", 10 ** (-nd) if nd else 0.001, nd)
    return (op, val, nd)


# --- 各检验的重算（都算两尾/上尾，与常见报告口径一致）---------------------
def recompute(kind, stat, df1, df2):
    try:
        if kind == "t":
            return float(stats.t.sf(abs(stat), df1) * 2)
        if kind == "F":
            return float(stats.f.sf(stat, df1, df2))
        if kind == "chi2":
            return float(stats.chi2.sf(stat, df1))
        if kind == "z":
            return float(stats.norm.sf(abs(stat)) * 2)
        if kind == "r":
            if abs(stat) >= 1:
                return None
            t = stat * ((df1 / (1 - stat ** 2)) ** 0.5)
            return float(stats.t.sf(abs(t), df1) * 2)
    except Exception:
        return None
    return None


# 检验句的正则：统计量 + 自由度 + （后面某处有 p）
TESTS = [
    ("t",    re.compile(r"\bt\s*\(\s*(?P<df1>%s)\s*\)\s*[=＝]\s*(?P<stat>%s)" % (_NUM, _NUM), re.I)),
    ("F",    re.compile(r"\bF\s*\(\s*(?P<df1>%s)\s*,\s*(?P<df2>%s)\s*\)\s*[=＝]\s*(?P<stat>%s)" % (_NUM, _NUM, _NUM), re.I)),
    ("r",    re.compile(r"\br\s*\(\s*(?P<df1>%s)\s*\)\s*[=＝]\s*(?P<stat>%s)" % (_NUM, _NUM), re.I)),
    ("chi2", re.compile(r"(?:χ\s*[2²]|chi2|chi-?square|X\s*2)\s*\(\s*(?P<df1>%s)\s*(?:,\s*N\s*[=＝]\s*%s\s*)?\)\s*[=＝]\s*(?P<stat>%s)" % (_NUM, _NUM, _NUM), re.I)),
    ("z",    re.compile(r"\bz\s*[=＝]\s*(?P<stat>%s)" % _NUM, re.I)),
]


def scan_text(text):
    """返回逐条 finding dict。以"一个检验统计量 + 其后最近的 p"配对。"""
    findings = []
    # 收集所有 p 的位置，便于给每个统计量找"其后最近的 p"
    p_positions = [(m.start(), m) for m in P_RE.finditer(text)]

    def nearest_p(end):
        for pos, m in p_positions:
            if pos >= end - 2:  # p 通常紧跟在统计量后面
                # 限制在同一句/较近范围内（120 字符），避免跨句错配
                if pos - end < 120:
                    return m
                return None
        return None

    seen_spans = []
    for kind, rx in TESTS:
        for m in rx.finditer(text):
            span = (m.start(), m.end())
            # z 的正则最宽松，避免和 t()/F() 里的数字重复命中：跳过与已记检验重叠的
            if any(not (span[1] <= s or span[0] >= e) for s, e in seen_spans):
                continue
            pm = nearest_p(m.end())
            if not pm:
                continue
            rep = parse_reported_p(text[pm.start():pm.start() + 40])
            if not rep:
                continue
            stat = float(m.group("stat"))
            df1 = float(m.group("df1")) if "df1" in m.groupdict() and m.group("df1") else None
            df2 = float(m.group("df2")) if "df2" in m.groupdict() and m.group("df2") else None
            if kind in ("t", "r", "chi2") and df1 is None:
                continue
            if kind == "F" and (df1 is None or df2 is None):
                continue
            comp = recompute(kind, stat, df1, df2)
            if comp is None:
                continue
            seen_spans.append(span)
            snippet = text[m.start():pm.end()].replace("\n", " ").strip()
            findings.append(evaluate(kind, stat, df1, df2, rep, comp, snippet))
    return findings


def evaluate(kind, stat, df1, df2, rep, comp, snippet):
    op, val, nd = rep
    verdict, note = "CONSISTENT", ""
    ALPHA = 0.05

    def sig(p):
        return p <= ALPHA

    if op == "ns":
        # 报告"不显著"：重算却显著 → 判断错
        if sig(comp):
            verdict = "DECISION_ERROR"
            note = f"报告 ns（不显著），但重算 p={_fmt(comp)} ≤ .05——显著性判断可能相反"
        else:
            note = "报告 ns，重算亦不显著，一致"
    elif op == "=":
        comp_r = round(comp, nd) if nd else round(comp)
        if comp_r == round(val, nd):
            note = f"重算 p≈{_fmt(comp)}，与报告 p={val} 一致"
        else:
            # 试单尾：报告值≈重算/2 → 多半是单尾报告，不算错
            half_r = round(comp / 2, nd) if nd else round(comp / 2)
            if half_r == round(val, nd):
                verdict = "ONE_TAILED"
                note = f"重算(两尾) p≈{_fmt(comp)} 与报告 p={val} 不符，但≈重算/2——可能按单尾报告，请确认是否预先声明单尾"
            elif sig(val) != sig(comp):
                verdict = "DECISION_ERROR"
                note = f"报告 p={val}（{'显著' if sig(val) else '不显著'}），重算 p={_fmt(comp)}（{'显著' if sig(comp) else '不显著'}）——显著性判断相反"
            else:
                verdict = "INCONSISTENT"
                note = f"报告 p={val}，重算 p≈{_fmt(comp)}——数值不符（同侧于 .05，多为笔误/四舍五入）"
    elif op == "<":
        if comp < val * (1 + 1e-9):
            note = f"报告 p<{val}，重算 p≈{_fmt(comp)}，一致"
        elif val <= ALPHA and not sig(comp):
            verdict = "DECISION_ERROR"
            note = f"报告 p<{val}（宣称显著），但重算 p={_fmt(comp)} > .05——显著性判断相反"
        else:
            verdict = "INCONSISTENT"
            note = f"报告 p<{val}，但重算 p≈{_fmt(comp)} 不小于该界"
    elif op == ">":
        if comp > val * (1 - 1e-9):
            note = f"报告 p>{val}，重算 p≈{_fmt(comp)}，一致"
        elif val >= ALPHA and sig(comp):
            verdict = "DECISION_ERROR"
            note = f"报告 p>{val}（宣称不显著），但重算 p={_fmt(comp)} ≤ .05——显著性判断相反"
        else:
            verdict = "INCONSISTENT"
            note = f"报告 p>{val}，但重算 p≈{_fmt(comp)} 未大于该界"

    stat_str = (f"{kind}({_num(df1)}" + (f",{_num(df2)}" if df2 is not None else "") + f")={stat}") \
        if kind != "z" else f"z={stat}"
    return dict(verdict=verdict, kind=kind, stat=stat_str,
                reported_p=("ns" if op == "ns" else f"{op}{val}"),
                recomputed_p=_fmt(comp), note=note, snippet=snippet)


def _num(v):
    if v is None:
        return ""
    return str(int(v)) if float(v).is_integer() else str(v)


def main():
    ap = argparse.ArgumentParser(description="statcheck 式 p 值一致性自查")
    ap.add_argument("path", nargs="?", help="稿件文件（.md/.txt）")
    ap.add_argument("--text", help="直接给一段文本")
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()
    args.outdir = str(_resolve_out_dir(args.outdir))

    if args.text:
        text = args.text
    elif args.path:
        with open(args.path, encoding="utf-8") as f:
            text = f.read()
    else:
        sys.exit("给一个文件路径，或用 --text 直接传文本。")

    findings = scan_text(text)
    os.makedirs(args.outdir, exist_ok=True)

    order = {"DECISION_ERROR": 0, "INCONSISTENT": 1, "ONE_TAILED": 2, "CONSISTENT": 3}
    findings.sort(key=lambda f: order.get(f["verdict"], 9))
    from collections import Counter
    dist = Counter(f["verdict"] for f in findings)

    cols = ["verdict", "kind", "stat", "reported_p", "recomputed_p", "note", "snippet"]
    with open(os.path.join(args.outdir, "pcheck.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(findings)

    with open(os.path.join(args.outdir, "pcheck.md"), "w", encoding="utf-8") as f:
        f.write(f"# p 值一致性自查（statcheck 式，共 {len(findings)} 处检验）\n\n")
        f.write("> **signal not verdict**：以下是「报告 p 与重算 p 不一致」的**待核对信号**，"
                "常见成因是笔误 / 单双尾混用 / 四舍五入，**不是**造假结论。请回原始分析核对。\n\n")
        f.write("统计：" + ("，".join(f"{k} {v}" for k, v in dist.items()) or "无可解析的检验") + "\n\n")
        label = {"DECISION_ERROR": "🔴 显著性判断相反（最需核对）",
                 "INCONSISTENT": "🟡 数值不符", "ONE_TAILED": "🔵 可能单尾报告",
                 "CONSISTENT": "✅ 一致"}
        for v in ["DECISION_ERROR", "INCONSISTENT", "ONE_TAILED", "CONSISTENT"]:
            group = [f for f in findings if f["verdict"] == v]
            if not group:
                continue
            f.write(f"## {label[v]}（{len(group)}）\n\n")
            for r in group:
                f.write(f"- `{r['stat']}`　报告 {r['reported_p']}　重算 p≈{r['recomputed_p']}\n")
                f.write(f"  - {r['note']}\n")
                f.write(f"  - 原文：{r['snippet'][:160]}\n")
            f.write("\n")

    print(f"扫描完成：{len(findings)} 处检验。{dict(dist)}")
    flag = dist.get("DECISION_ERROR", 0) + dist.get("INCONSISTENT", 0)
    print(f"需核对 {flag} 处（显著性相反 {dist.get('DECISION_ERROR',0)} / 数值不符 {dist.get('INCONSISTENT',0)}）。")
    print(f"报告：{os.path.join(args.outdir, 'pcheck.md')} / .csv")


if __name__ == "__main__":
    main()
