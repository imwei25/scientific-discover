#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""样本量 / 把握度计算（先验设计用，供伦理与标书）。

支持常见临床设计：
  two-means       两组均数比较（连续结局，t 检验）
  two-props       两组率比较（二分类结局）
  survival        生存/事件率比较（log-rank，Freedman 近似所需事件数与样本量）
  one-mean        单组均数对比已知值

用已安装的 statsmodels/numpy/scipy。**这是研究开展前的先验估算**；不要用它对已完成研究做
事后功效(post-hoc power)——那被认为无意义（见 write-paper/data-analysis 的护栏）。

用法：
  python samplesize.py two-means --diff 6 --sd 10 --alpha 0.05 --power 0.8 [--ratio 1] [--dropout 0.1]
  python samplesize.py two-props --p1 0.30 --p2 0.15 --alpha 0.05 --power 0.8
  python samplesize.py survival --hr 0.7 --p-event 0.5 --alpha 0.05 --power 0.8
  python samplesize.py one-mean --diff 5 --sd 12 --alpha 0.05 --power 0.8
"""
import argparse
import math
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    from scipy import stats
    from statsmodels.stats.power import TTestIndPower, TTestPower
except ImportError:
    sys.exit("缺少 statsmodels/scipy：请先运行 install.ps1 / install.sh（或 env-setup 技能）")


def _inflate(n, dropout):
    return math.ceil(n / (1 - dropout)) if dropout and dropout > 0 else math.ceil(n)


def two_means(a):
    d = abs(a.diff) / a.sd  # Cohen's d
    n1 = TTestIndPower().solve_power(effect_size=d, alpha=a.alpha, power=a.power,
                                     ratio=a.ratio, alternative="two-sided")
    n1 = math.ceil(n1)
    n2 = math.ceil(n1 * a.ratio)
    print(f"两组均数比较（t 检验，双侧 α={a.alpha}，power={a.power}）")
    print(f"  预期组间差 Δ={a.diff}，标准差 SD={a.sd} → Cohen's d={d:.3f}")
    print(f"  每组样本量：组1 = {_inflate(n1, a.dropout)}，组2 = {_inflate(n2, a.dropout)}"
          + (f"（已按脱落率 {a.dropout:.0%} 上调）" if a.dropout else ""))
    print(f"  合计 ≈ {_inflate(n1, a.dropout) + _inflate(n2, a.dropout)}")


def two_props(a):
    # 标准正态近似公式（Fleiss，未做连续性校正），支持分配比 ratio=n2/n1。
    # 不用 arcsine/Cohen's h + t-power——那在 p 接近 0 或 1 时会系统性低估样本量（可达 -19%）。
    p1, p2, r = a.p1, a.p2, a.ratio
    pbar = (p1 + r * p2) / (1 + r)
    qbar = 1 - pbar
    za = stats.norm.ppf(1 - a.alpha / 2)
    zb = stats.norm.ppf(a.power)
    num = (za * math.sqrt((1 + 1.0 / r) * pbar * qbar)
           + zb * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2) / r)) ** 2
    n1 = math.ceil(num / (p1 - p2) ** 2)
    n2 = math.ceil(n1 * r)
    print(f"两组率比较（双侧 α={a.alpha}，power={a.power}，标准正态近似 Fleiss）")
    print(f"  p1={p1}，p2={p2}，分配比 组2/组1={r}")
    print(f"  每组样本量：组1 = {_inflate(n1, a.dropout)}，组2 = {_inflate(n2, a.dropout)}"
          + (f"（已按脱落率 {a.dropout:.0%} 上调）" if a.dropout else ""))
    print(f"  合计 ≈ {_inflate(n1, a.dropout) + _inflate(n2, a.dropout)}")
    if min(p1, p2) < 0.05 or max(p1, p2) > 0.95:
        print("  ⚠️ 比例接近 0/1，正态近似误差增大，建议用 R pwr/精确法复核。")


def survival(a):
    # Freedman 近似：所需事件总数 d = (z_a/2 + z_b)^2 * ((1+HR)/(1-HR))^2
    za = stats.norm.ppf(1 - a.alpha / 2)
    zb = stats.norm.ppf(a.power)
    hr = a.hr
    events = (za + zb) ** 2 * ((1 + hr) / (1 - hr)) ** 2
    events = math.ceil(events)
    n = math.ceil(events / a.p_event) if a.p_event else None
    print(f"生存/事件比较（log-rank，双侧 α={a.alpha}，power={a.power}）")
    print(f"  预期风险比 HR={hr}，总体事件发生比例 p_event={a.p_event}")
    print(f"  所需事件总数 ≈ {events}")
    if n:
        print(f"  所需总样本量 ≈ {_inflate(n, a.dropout)}"
              + (f"（已按脱落率 {a.dropout:.0%} 上调）" if a.dropout else ""))
    print("  注：Freedman 近似、假设两组等分随访充分；精确计算建议用 R gsDesign/powerSurvEpi 复核。")


def one_mean(a):
    d = abs(a.diff) / a.sd
    n = TTestPower().solve_power(effect_size=d, alpha=a.alpha, power=a.power, alternative="two-sided")
    n = math.ceil(n)
    print(f"单组均数对比已知值（单样本 t，双侧 α={a.alpha}，power={a.power}）")
    print(f"  预期差 Δ={a.diff}，SD={a.sd} → d={d:.3f}")
    print(f"  样本量 = {_inflate(n, a.dropout)}"
          + (f"（已按脱落率 {a.dropout:.0%} 上调）" if a.dropout else ""))


def main():
    ap = argparse.ArgumentParser(description="样本量/把握度计算（先验设计）")
    sub = ap.add_subparsers(dest="design", required=True)

    common = dict()
    for name in ("two-means", "two-props", "survival", "one-mean"):
        p = sub.add_parser(name)
        p.add_argument("--alpha", type=float, default=0.05)
        p.add_argument("--power", type=float, default=0.8)
        p.add_argument("--dropout", type=float, default=0.0, help="预计脱落率，如 0.1，用于上调样本量")
        if name in ("two-means", "one-mean"):
            p.add_argument("--diff", type=float, required=True, help="预期组间/对比差")
            p.add_argument("--sd", type=float, required=True, help="结局标准差")
        if name in ("two-means", "two-props"):
            p.add_argument("--ratio", type=float, default=1.0, help="组2/组1 样本比，默认 1:1")
        if name == "two-props":
            p.add_argument("--p1", type=float, required=True)
            p.add_argument("--p2", type=float, required=True)
        if name == "survival":
            p.add_argument("--hr", type=float, required=True, help="预期风险比 HR")
            p.add_argument("--p-event", type=float, required=True, help="总体事件发生比例(0-1)")

    a = ap.parse_args()

    # 前置校验：给中文友好报错，而不是让底层库抛裸异常或返回哑数值
    def die(msg):
        sys.exit(f"参数错误：{msg}")
    if not 0 < a.alpha < 1:
        die("--alpha 必须在 (0,1) 之间")
    if not 0 < a.power < 1:
        die("--power 必须在 (0,1) 之间（不能取 1，1 对应无穷样本量）")
    if not 0 <= a.dropout < 1:
        die("--dropout 必须在 [0,1) 之间")
    if getattr(a, "sd", 1) is not None and hasattr(a, "sd") and a.sd <= 0:
        die("--sd 必须 >0")
    if hasattr(a, "diff") and a.diff == 0:
        die("--diff 不能为 0（检测不到 0 效应）")
    if a.design == "two-props":
        for name, p in (("p1", a.p1), ("p2", a.p2)):
            if not 0 < p < 1:
                die(f"--{name} 必须在 (0,1) 之间")
        if a.p1 == a.p2:
            die("--p1 与 --p2 不能相等（组间无差异）")
    if a.design in ("two-means", "two-props") and a.ratio <= 0:
        die("--ratio 必须 >0")
    if a.design == "survival":
        if a.hr <= 0:
            die("--hr 必须 >0")
        if a.hr == 1:
            die("--hr 不能为 1（HR=1 表示无差异，无法估算）")
        if not 0 < a.p_event <= 1:
            die("--p-event 必须在 (0,1] 之间")

    {"two-means": two_means, "two-props": two_props,
     "survival": survival, "one-mean": one_mean}[a.design](a)
    print("提醒：这是先验估算，参数（差值/SD/率/HR）应来自预实验或既往文献，不要凭空取值凑样本量。")


if __name__ == "__main__":
    main()
