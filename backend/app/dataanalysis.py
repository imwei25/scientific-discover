"""AI 驱动的数据分析。

流程(deep-analysis):
  1) 读数据 → 生成"数据画像"(列名/类型/样例) 供 AI 理解;
  2) AI 结合数据画像 + 用户研究用途, 写出针对性的 Python 分析代码;
  3) 在本地子进程沙箱执行该代码(超时保护), 捕获打印结果与图表;
  4) 若执行报错, 把错误回灌给 AI 自动修正一次;
  5) AI 基于"真实执行结果"流式写出结论(数字只来自执行输出, 不编造)。

对外是异步生成器, 逐步 yield (event, data):
  status / code / charts / output / delta / error / done
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import re
import sys
import tempfile
from typing import AsyncIterator

import pandas as pd

from .config import settings
from .llm import stream_chat
from .textio import read_csv_bytes

EXEC_TIMEOUT = 60  # 秒

# 轻量安全护栏: 命中这些明显危险的调用则拒绝执行(本地用户环境, 主要防误伤)。
# eval/exec/open 仅拦截“内置函数”形式(前面不是 . 或字母): 这样既挡住注入/读文件,
# 又不会误伤合法的 pandas 方法 df.eval()/df.query() 等(它们前面有 . )。
_DANGER = re.compile(
    r"\b(?:subprocess|os\.system|os\.popen|os\.remove|os\.rmdir|os\.unlink|shutil\.(?:rmtree|move|copy)|"
    r"socket|requests|urllib|httpx|Popen|__import__)\b"
    r"|(?<![\w.])(?:eval|exec|open)\s*\(",
)

# 危险扫描前先剥掉字符串字面量与注释: 否则出现在 print 文本/图表标题/注释里的
# "open("、"eval(" 等会被误判为危险调用, 导致整段分析被拒、白白失败。
_NONCODE = re.compile(
    r'""".*?"""|\'\'\'.*?\'\'\'|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|#[^\n]*',
    re.DOTALL,
)


def _strip_noncode(code: str) -> str:
    return _NONCODE.sub(" ", code)


# 未被 pandas 识别、但常见于中文脏表的缺失哨兵(文本形式)。
_MISSING_TOKENS = {
    "", "-", "--", "/", "na", "n/a", "n.a.", "nan", "null", "none",
    "缺失", "未知", "无", "空", "?", "？", "暂无", "待查",
}
# 常见数值哨兵缺失(问卷/临床表遗留)。
_SENTINEL_NUMS = {"999", "9999", "-999", "-9999", "99", "888", "9998"}


def _looks_numeric_frac(vals) -> float:
    """样本中"去掉千分位/百分号/货币/删失符后能当数字解析"的比例。"""
    ok = tot = 0
    for v in vals:
        s = str(v).strip()
        if not s:
            continue
        tot += 1
        s2 = s.lstrip("<>≤≥").replace(",", "").replace("%", "").replace("$", "").replace("￥", "").replace("元", "").strip()
        try:
            float(s2)
            ok += 1
        except ValueError:
            pass
    return ok / tot if tot else 0.0


def _column_flags(s: pd.Series) -> list[str]:
    """对单列做启发式体检, 返回给 AI 看的清洗提示(命中才返回)。"""
    flags: list[str] = []
    n = len(s)
    nun = int(s.nunique(dropna=True))
    non_null = s.dropna()
    if s.dtype == object and len(non_null):
        sample = non_null.astype(str).head(200)
        if _looks_numeric_frac(sample) >= 0.9:
            joined = " ".join(sample.head(30))
            kinds = []
            if "%" in joined:
                kinds.append("百分号")
            if re.search(r"\d,\d", joined):
                kinds.append("千位逗号")
            if re.search(r"[<>≤≥]", joined):
                kinds.append("删失阈值(<、>)")
            if re.search(r"[$￥元]", joined):
                kinds.append("货币符号")
            hint = "含" + "/".join(kinds) if kinds else "被存成文本"
            flags.append(f"⚠疑似数值列({hint})，需清洗后 pd.to_numeric 再分析")
        else:
            try:
                import warnings as _w
                with _w.catch_warnings():
                    _w.simplefilter("ignore")
                    parsed = pd.to_datetime(non_null.head(50), errors="coerce")
                if parsed.notna().mean() >= 0.8:
                    flags.append("⚠疑似日期列，建议 pd.to_datetime")
            except Exception:  # noqa: BLE001
                pass
    if n and nun / n >= 0.95 and nun >= 10:
        flags.append("⚠疑似ID/编号列(近乎唯一)，一般不作分析变量")
    if len(non_null):
        as_str = non_null.astype(str).str.strip()
        hit = as_str.str.lower().isin(_MISSING_TOKENS)
        if 0 < float(hit.mean()) <= 0.5 and int(hit.sum()) >= 1:
            toks = sorted(set(as_str[hit.values]))[:4]
            flags.append(f"⚠疑似缺失标记 {toks} 未被当作缺失，建议替换为 NaN")
        if pd.api.types.is_numeric_dtype(s):
            sent = non_null.astype(str).isin(_SENTINEL_NUMS)
            if 0 < float(sent.mean()) <= 0.3 and int(sent.sum()) >= 2:
                flags.append("⚠数值列疑似含哨兵缺失(如 999/9999)，请确认是否代表缺失")
    return flags


def _sanity_checks(stdout: str) -> list[str]:
    """对执行输出做确定性体检(不调用 LLM)。返回告警, 喂给结论环节让 AI 据实修正/说明。"""
    warns: list[str] = []
    if not stdout:
        return warns
    if re.search(r"(?i)\bp\s*[=＝:]\s*0\.0{3,}\b", stdout):
        warns.append("输出把 p 值写成 0.000 之类，规范应写为 p<0.001。")
    for m in re.finditer(r"(?i)\bp\s*(?:[-_]?val(?:ue)?)?\s*[=＝:]\s*(\d+\.\d+)", stdout):
        try:
            if float(m.group(1)) > 1:
                warns.append(f"检测到疑似 p 值 {m.group(1)} 超出 [0,1]，请核对。")
                break
        except ValueError:
            pass
    for block in ("【方法选择】", "【假设检查】", "【数据质量】"):
        if block not in stdout:
            warns.append(f"输出缺少必需的『{block}』透明化区块。")
    return warns


def _dedup_columns(df: pd.DataFrame) -> pd.DataFrame:
    """重命名重复列名(脏临床表常见), 避免 df[col] 返回 DataFrame 触发 .dtype 等崩溃。"""
    seen: dict = {}
    cols = []
    for c in df.columns:
        if c in seen:
            seen[c] += 1
            cols.append(f"{c}.{seen[c]}")
        else:
            seen[c] = 0
            cols.append(c)
    df.columns = cols
    return df


def _load(filename: str, content: bytes) -> pd.DataFrame:
    # CSV 用共享的健壮解码(兼容中文用户常见的 GBK/带BOM 编码), 见 textio.read_csv_bytes。
    if filename.lower().endswith((".xlsx", ".xls")):
        return _dedup_columns(pd.read_excel(io.BytesIO(content)))
    return _dedup_columns(read_csv_bytes(content))


def profile_data(df: pd.DataFrame) -> str:
    """生成给 AI 看的数据画像(简洁)。"""
    lines = [f"数据规模：{df.shape[0]} 行 × {df.shape[1]} 列。", "列信息："]
    for col in df.columns:
        dtype = str(df[col].dtype)
        nuniq = df[col].nunique(dropna=True)
        miss = int(df[col].isna().sum())
        sample = ", ".join(map(str, df[col].dropna().unique()[:5]))
        line = f"  - {col}（{dtype}，唯一值{nuniq}，缺失{miss}）样例: {sample}"
        flags = _column_flags(df[col])
        if flags:
            line += "  【" + "；".join(flags) + "】"
        lines.append(line)
    numeric = list(df.select_dtypes(include="number").columns)
    categorical = [c for c in df.columns if c not in numeric]
    lines.append(f"\n数值型列：{', '.join(map(str, numeric)) or '无'}")
    lines.append(f"分类型列：{', '.join(map(str, categorical)) or '无'}")
    # 数值列描述统计: 让 AI 一眼看到量纲/分布/离群迹象, 减少臆测。
    if numeric:
        try:
            lines.append("\n数值列描述统计：")
            lines.append(df[numeric].describe().round(3).to_string())
        except Exception:  # noqa: BLE001
            pass
    # 分类列主要取值: 关键是让 AI 看清"分组列到底几组、各组多少例", 避免把多组当两组。
    if categorical:
        lines.append("\n分类列主要取值(取值(计数))：")
        for c in categorical[:12]:
            vc = df[c].value_counts(dropna=True).head(6)
            pairs = ", ".join(f"{k}({int(v)})" for k, v in vc.items())
            lines.append(f"  - {c}: {pairs}")
    lines.append("\n前 5 行：")
    lines.append(df.head(5).to_string())
    return "\n".join(lines)


def _extract_code(text: str) -> str:
    m = re.search(r"```(?:python)?\s*(.*?)```", text, re.DOTALL)
    return (m.group(1) if m else text).strip()


async def _complete(messages: list[dict], max_tokens: int = 1500) -> str:
    buf = ""
    async for piece in stream_chat(messages, max_tokens=max_tokens):
        buf += piece
    return buf


_LIBS_NOTE = (
    "可用库（已预装，且已为你导入好同名变量）：pandas as pd、numpy as np、"
    "matplotlib.pyplot as plt、scipy.stats as stats、statsmodels.api as sm、"
    "pingouin as pg（统计，优先用它，能一次给出效应量/置信区间/检验功效；"
    "注意 pingouin 0.6.x 的结果列名是下划线形式，如 p_val、cohen_d、CI95，"
    "没有连字符或百分号；获取数值时建议直接 print 整个结果表，或用 .iloc 按位置取，"
    "不要硬编码诸如 'p-val' 这类可能不存在的列名）、"
    "lifelines（生存分析：lifelines.KaplanMeierFitter、CoxPHFitter、"
    "lifelines.statistics.logrank_test）。scikit-learn 可自行 import sklearn。"
    "画图用 matplotlib 默认样式即可（运行环境已配置为出版级清晰度）；"
    "切勿使用需要 LaTeX 的绘图样式（如 plt.style.use(['science'])）或设置 text.usetex=True。"
    "数据已加载为 DataFrame `df`，无需也不要读取任何文件或访问网络。"
)


def _gen_code_messages(profile: str, question: str) -> list[dict]:
    system = (
        "你是资深的医学/药学/生物医学数据分析专家。"
        "请根据【数据画像】与【研究用途】，判断这份数据适合做什么分析，"
        "并写出一段 Python 代码来完成分析。\n" + _LIBS_NOTE + "\n"
        "代码必须**先 print 出三个透明化区块**，让非专业读者看懂你为什么这么分析（用这些确切标题）：\n"
        "  『【方法选择】』：逐个研究问题说明——每个变量是连续/有序/分类、各组样本量，"
        "据此选了哪种统计检验或模型、为什么（如：两组连续+正态→独立样本 t 检验；偏态/小样本→Mann-Whitney）；\n"
        "  『【假设检查】』：对所选方法实际跑前提检验并 print 结果数值（如正态性 Shapiro-Wilk 的 W/p、"
        "方差齐性 Levene 的 p），并据结果说明是否改用非参数/稳健方法；\n"
        "  『【数据质量】』：print 每个分析变量的缺失数与处理策略（成对/整行删除/插补，说明理由），"
        "并报告是否有异常值(如 IQR 法)及如何处理；\n"
        "之后再 print 主分析结果。\n"
        "要求：\n"
        "① 依据研究用途和变量类型选择恰当的统计方法（t检验/方差分析/卡方/相关/回归/逻辑回归/生存分析等），"
        "先检查前提假设（正态性、方差齐性等）并据此在参数与非参数方法间选择，妥善处理缺失值（缺失/异常处理须可见于上面的【数据质量】区块）；\n"
        "② 统计报告要规范：除 p 值外，必须给出效应量与 95% 置信区间，p 值给精确值（如 p=0.003）；"
        "优先使用 pingouin（pg）以便一次得到效应量/CI/功效；\n"
        "③ 涉及多组多次比较时，必须做多重比较校正（如 pg.pairwise_tests(..., padjust='holm')）；\n"
        "④ 若数据包含时间到事件（生存/随访）变量，使用 lifelines 做 Kaplan-Meier 曲线与 log-rank 检验、必要时 Cox 回归；\n"
        "⑤ 区分相关与因果，不要据观察性数据下因果结论；\n"
        "⑥ 用 print() 清晰打印每个关键结果并配中文说明；\n"
        "⑦ 画出出版级质量的图（**每张图都要有信息明确的标题、带单位的轴标签、必要时图例**；"
        "组间比较图在显著的两组之间标注显著性，如 * p<0.05/** p<0.01 或直接标出精确 p 值；"
        "用 matplotlib 默认样式，不要用需要 LaTeX 的样式，不要调用 plt.show()）；"
        "若用户在【研究用途】中明确要求了某种图（如箱线图、小提琴图、KM 生存曲线、森林图、相关热图、ROC 曲线、带误差棒柱状图等），务必画出该图；"
        "配色已由运行环境统一设置，无需手动指定颜色（除非用户特别要求）；\n"
        "⑧ 只使用已加载的 df，列名务必使用上面【数据画像】中真实存在的列名，不要臆造列名。\n"
        "pingouin 注意：当前版本结果列名为下划线（如 p_val、cohen_d、CI95），没有连字符或百分号；"
        "获取数值建议先 print(整个结果表)，再用 res['p_val'].iloc[0] 这类按位置取值，切勿硬编码 'p-val' 等不存在的列名。\n"
        "只输出一个 Python 代码块，不要额外解释。"
    )
    user = f"【数据画像】\n{profile}\n\n【研究用途】\n{question or '（用户未填写，请你根据数据自行判断最有价值的分析方向）'}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _fix_code_messages(profile: str, question: str, code: str, error: str) -> list[dict]:
    system = (
        "你之前写的 Python 数据分析代码执行报错了。请修正它，仍只输出一个 Python 代码块。\n"
        + _LIBS_NOTE
    )
    user = (
        f"【数据画像】\n{profile}\n\n【研究用途】\n{question}\n\n"
        f"【原代码】\n```python\n{code}\n```\n\n【报错信息】\n{error}\n\n请给出修正后的完整代码。"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _clip_output(text: str, head: int = 9000, tail: int = 3000) -> str:
    """结论只喂真实输出; 过长时保留头尾(尾部常含主分析结果/p值), 避免整段截断丢数字。"""
    if len(text) <= head + tail:
        return text
    return text[:head] + "\n…（中间省略以控制长度）…\n" + text[-tail:]


def _conclusion_messages(question: str, code: str, output: str, warnings: list[str] | None = None) -> list[dict]:
    system = (
        "你是医学/药学/生物医学论文写作助手。下面是针对用户数据实际执行分析代码后得到的【真实输出】。"
        "请基于这些真实结果撰写结论，严禁编造或改动其中的数字；若某结论缺乏数据支撑请说明。"
        "请用中文、Markdown 输出：① **方法与前提**（一句话说明选用了什么统计方法、为何适用，并复述输出中"
        "【假设检查】的关键结果——正态性/方差齐性是否满足、是否据此改用了非参数方法）；"
        "② 核心发现（引用输出中的具体数值/统计量/p值，并区分相关与因果）；"
        "③ 结果解读与意义；④ 主要局限（样本量、缺失/异常值处理、偏倚、混杂、假设是否满足等）。"
    )
    parts = [f"【研究用途】\n{question}", f"【分析代码】\n```python\n{code}\n```", f"【代码真实输出】\n{_clip_output(output)}"]
    if warnings:
        parts.append(
            "【自动核对提示（系统对输出的确定性检查，请在结论中据实说明或据此修正，勿忽略）】\n"
            + "\n".join(f"- {w}" for w in warnings)
        )
    return [{"role": "system", "content": system}, {"role": "user", "content": "\n\n".join(parts)}]


_RUNNER = r'''
import sys, io, json, base64, traceback
import pandas as pd, numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import stats
try:
    import statsmodels.api as sm
except Exception:
    sm = None
try:
    import pingouin as pg
except Exception:
    pg = None
try:
    import lifelines
except Exception:
    lifelines = None
# 出版级清晰度的默认样式(本机无 LaTeX, 不使用任何需要 LaTeX 的样式)
plt.rcParams.update({
    "font.sans-serif": ["Microsoft YaHei", "SimHei", "DejaVu Sans"],
    "axes.unicode_minus": False,
    "savefig.dpi": 150,
    "font.size": 11,
    "axes.titlesize": 12,
    "axes.labelsize": 11,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.grid": True,
    "grid.alpha": 0.3,
    "text.usetex": False,
})

# 图表导出格式与期刊配色(由命令行传入)
_FMT = (sys.argv[4] if len(sys.argv) > 4 else "png").lower()
_PAL = (sys.argv[5] if len(sys.argv) > 5 else "default").lower()
_PALETTES = {
    # 色盲友好(Okabe-Ito)
    "colorblind": ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#F0E442", "#56B4E9", "#E69F00", "#000000"],
    # Nature 风格(NPG)
    "nature": ["#E64B35", "#4DBBD5", "#00A087", "#3C5488", "#F39B7F", "#8491B4", "#91D1C2", "#DC0000"],
    # Lancet 风格
    "lancet": ["#00468B", "#ED0000", "#42B540", "#0099B4", "#925E9F", "#FDAF91", "#AD002A", "#ADB6B6"],
}
if _PAL in _PALETTES:
    try:
        from cycler import cycler
        plt.rcParams["axes.prop_cycle"] = cycler(color=_PALETTES[_PAL])
    except Exception:
        pass

# 主进程已用统一的健壮解码(textio.read_csv_bytes)读入并完成列名去重, 这里直接反序列化
# 同一个 DataFrame: 确保 AI 看到的数据画像与实际执行的数据完全一致, 消除两套解码导致的
# 列名不一致 KeyError。
df = pd.read_pickle(sys.argv[1])
with open(sys.argv[2], "r", encoding="utf-8") as f:
    code = f.read()

buf = io.StringIO()
_old = sys.stdout
sys.stdout = buf
result = {"ok": True, "error": None}
g = {"df": df, "pd": pd, "np": np, "plt": plt, "stats": stats, "sm": sm, "pg": pg, "lifelines": lifelines}
try:
    exec(compile(code, "analysis.py", "exec"), g)
except Exception:
    result["ok"] = False
    result["error"] = traceback.format_exc()
finally:
    sys.stdout = _old

# 即便代码用了需要 LaTeX 的样式, 也强制关闭 usetex, 避免本机无 LaTeX 时出图失败
plt.rcParams["text.usetex"] = False
# 每张图: 始终产出用于网页内联展示的 png(120dpi); 另产出用户所选格式的可下载资产
# (高清 png 300dpi / svg 矢量 / pdf 矢量), 满足投稿需求。
charts = []
for num in plt.get_fignums():
    fig = plt.figure(num)
    bd = io.BytesIO()
    try:
        fig.savefig(bd, format="png", dpi=120, bbox_inches="tight")
        disp = base64.b64encode(bd.getvalue()).decode()
    except Exception:
        continue
    data, ext = disp, "png"
    try:
        be = io.BytesIO()
        if _FMT in ("svg", "pdf"):
            fig.savefig(be, format=_FMT, bbox_inches="tight")
            ext = _FMT
        else:
            fig.savefig(be, format="png", dpi=300, bbox_inches="tight")
            ext = "png"
        data = base64.b64encode(be.getvalue()).decode()
    except Exception:
        data, ext = disp, "png"
    charts.append({"png": disp, "data": data, "ext": ext})
result["stdout"] = buf.getvalue()
result["charts"] = charts
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False)
'''


def _execute(code: str, df: pd.DataFrame, chart_format: str = "png", palette: str = "default") -> dict:
    """在子进程沙箱里执行 AI 生成的分析代码, 返回 {ok, stdout, charts, error}。

    df 是主进程已用统一解码读入并去重列名后的 DataFrame; 以 pickle 传给子进程,
    保证执行用的数据与生成画像时完全一致(消除两套解码导致的列名不一致 KeyError)。
    """
    if _DANGER.search(_strip_noncode(code)):
        return {"ok": False, "error": "生成的代码包含不被允许的操作（文件/网络/系统调用），已拒绝执行。", "stdout": "", "charts": []}
    with tempfile.TemporaryDirectory() as d:
        data_path = os.path.join(d, "data.pkl")
        code_path = os.path.join(d, "user_code.py")
        runner_path = os.path.join(d, "runner.py")
        out_path = os.path.join(d, "out.json")
        df.to_pickle(data_path)
        with open(code_path, "w", encoding="utf-8") as f:
            f.write(code)
        with open(runner_path, "w", encoding="utf-8") as f:
            f.write(_RUNNER)
        import subprocess

        try:
            subprocess.run(
                [sys.executable, runner_path, data_path, code_path, out_path,
                 (chart_format or "png"), (palette or "default")],
                cwd=d,
                timeout=EXEC_TIMEOUT,
                capture_output=True,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"分析执行超时（>{EXEC_TIMEOUT}s）。", "stdout": "", "charts": []}
        if not os.path.exists(out_path):
            return {"ok": False, "error": "执行未产生结果（代码可能崩溃）。", "stdout": "", "charts": []}
        with open(out_path, "r", encoding="utf-8") as f:
            return json.load(f)


async def _mock_flow(question: str) -> AsyncIterator[tuple[str, dict]]:
    yield ("status", {"message": "正在理解数据并生成分析代码…"})
    yield ("code", {"code": "# [MOCK] 示例分析代码\nprint('组间差异 p=0.01')"})
    yield ("status", {"message": "正在本地执行分析…"})
    yield ("charts", {"items": []})
    yield ("output", {"text": "组间差异 p=0.01"})
    yield ("status", {"message": "正在总结结论…"})
    for ch in "## 核心发现\n[MOCK] 两组差异显著（p=0.01）。":
        yield ("delta", {"text": ch})


async def analyze_data(
    filename: str, content: bytes, question: str,
    chart_format: str = "png", palette: str = "default",
) -> AsyncIterator[tuple[str, dict]]:
    if settings.mock:
        async for ev in _mock_flow(question):
            yield ev
        yield ("done", {})
        return

    try:
        yield ("status", {"message": "正在读取数据…"})
        try:
            df = _load(filename, content)
        except Exception as e:  # noqa: BLE001
            yield ("error", {"message": f"无法读取数据文件：{e}"})
            return
        if df.empty:
            yield ("error", {"message": "数据为空。"})
            return
        profile = profile_data(df)

        yield ("status", {"message": "正在理解数据并生成分析代码…"})
        code = _extract_code(await _complete(_gen_code_messages(profile, question)))

        yield ("code", {"code": code})
        yield ("status", {"message": "正在本地执行分析…"})
        run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        # 自动纠错: 最多重试 3 次(共 4 次执行)。AI 写的统计代码(尤其 pingouin 版本相关的
        # 列名/函数签名)首次常报错, 2 次重试有时不够、导致整次分析失败; 多给一次显著提高成功率。
        for attempt in range(3):
            if run.get("ok"):
                break
            yield ("status", {"message": f"执行出错，正在自动修正代码（第 {attempt + 1} 次）…"})
            code = _extract_code(
                await _complete(_fix_code_messages(profile, question, code, run.get("error", "")))
            )
            yield ("code", {"code": code})
            yield ("status", {"message": "正在重新执行…"})
            run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        if run.get("stdout"):
            yield ("output", {"text": run["stdout"]})

        if not run.get("ok"):
            yield ("error", {"message": "分析代码执行失败：\n" + (run.get("error") or "未知错误")})
            return

        # 确定性体检(不调用 LLM): 把可疑处作为提示喂给结论环节, 让 AI 据实修正/说明。
        warnings = _sanity_checks(run.get("stdout", ""))

        yield ("status", {"message": "正在总结结论…"})
        async for piece in stream_chat(_conclusion_messages(question, code, run.get("stdout", ""), warnings)):
            yield ("delta", {"text": piece})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"分析过程出错：{e}"})
