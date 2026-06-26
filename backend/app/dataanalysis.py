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

EXEC_TIMEOUT = 60  # 秒

# 轻量安全护栏: 命中这些明显危险的调用则拒绝执行(本地用户环境, 主要防误伤)。
_DANGER = re.compile(
    r"\b(subprocess|os\.system|os\.remove|os\.rmdir|os\.unlink|shutil\.(rmtree|move|copy)|"
    r"socket|requests|urllib|httpx|Popen|__import__|eval\s*\(|open\s*\()",
)


# 中文用户常从 Excel 导出 GBK/ANSI 编码的 CSV, 默认 utf-8 会直接 UnicodeDecodeError。
# 依次尝试这些编码, gb18030 是 gbk/gb2312 的超集, latin-1 作为永不报错的兜底。
_CSV_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "latin-1")


def _read_csv_bytes(content: bytes) -> pd.DataFrame:
    last: Exception | None = None
    for enc in _CSV_ENCODINGS:
        try:
            return pd.read_csv(io.BytesIO(content), encoding=enc)
        except UnicodeDecodeError as e:
            last = e
            continue
    raise last if last else ValueError("无法解析 CSV 文件。")


def _load(filename: str, content: bytes) -> pd.DataFrame:
    if filename.lower().endswith((".xlsx", ".xls")):
        return pd.read_excel(io.BytesIO(content))
    return _read_csv_bytes(content)


def profile_data(df: pd.DataFrame) -> str:
    """生成给 AI 看的数据画像(简洁)。"""
    lines = [f"数据规模：{df.shape[0]} 行 × {df.shape[1]} 列。", "列信息："]
    for col in df.columns:
        dtype = str(df[col].dtype)
        nuniq = df[col].nunique(dropna=True)
        miss = int(df[col].isna().sum())
        sample = ", ".join(map(str, df[col].dropna().unique()[:5]))
        lines.append(f"  - {col}（{dtype}，唯一值{nuniq}，缺失{miss}）样例: {sample}")
    numeric = list(df.select_dtypes(include="number").columns)
    categorical = [c for c in df.columns if c not in numeric]
    lines.append(f"\n数值型列：{', '.join(map(str, numeric)) or '无'}")
    lines.append(f"分类型列：{', '.join(map(str, categorical)) or '无'}")
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
        "要求：\n"
        "① 依据研究用途和变量类型选择恰当的统计方法（t检验/方差分析/卡方/相关/回归/逻辑回归/生存分析等），"
        "先检查前提假设（正态性、方差齐性等）并据此在参数与非参数方法间选择，妥善处理缺失值；\n"
        "② 统计报告要规范：除 p 值外，必须给出效应量与 95% 置信区间，p 值给精确值（如 p=0.003）；"
        "优先使用 pingouin（pg）以便一次得到效应量/CI/功效；\n"
        "③ 涉及多组多次比较时，必须做多重比较校正（如 pg.pairwise_tests(..., padjust='holm')）；\n"
        "④ 若数据包含时间到事件（生存/随访）变量，使用 lifelines 做 Kaplan-Meier 曲线与 log-rank 检验、必要时 Cox 回归；\n"
        "⑤ 区分相关与因果，不要据观察性数据下因果结论；\n"
        "⑥ 用 print() 清晰打印每个关键结果并配中文说明；\n"
        "⑦ 画出出版级质量的图（清晰的轴标签、图例、单位；用 matplotlib 默认样式，不要用需要 LaTeX 的样式，不要调用 plt.show()）；\n"
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


def _conclusion_messages(question: str, code: str, output: str) -> list[dict]:
    system = (
        "你是医学/药学/生物医学论文写作助手。下面是针对用户数据实际执行分析代码后得到的【真实输出】。"
        "请基于这些真实结果撰写结论，严禁编造或改动其中的数字；若某结论缺乏数据支撑请说明。"
        "请用中文、Markdown 输出：① 核心发现（引用输出中的具体数值/统计量/p值，并区分相关与因果）；"
        "② 结果解读与意义；③ 主要局限（样本量、偏倚、混杂、假设是否满足等）。"
    )
    user = f"【研究用途】\n{question}\n\n【分析代码】\n```python\n{code}\n```\n\n【代码真实输出】\n{output[:6000]}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


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

def _load(p):
    if p.lower().endswith((".xlsx", ".xls")):
        return pd.read_excel(p)
    for enc in ("utf-8-sig", "utf-8", "gb18030", "latin-1"):
        try:
            return pd.read_csv(p, encoding=enc)
        except UnicodeDecodeError:
            continue
    return pd.read_csv(p, encoding="latin-1")

df = _load(sys.argv[1])
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
charts = []
for num in plt.get_fignums():
    fig = plt.figure(num)
    b = io.BytesIO()
    try:
        fig.savefig(b, format="png", dpi=120, bbox_inches="tight")
        charts.append(base64.b64encode(b.getvalue()).decode())
    except Exception:
        pass
result["stdout"] = buf.getvalue()
result["charts"] = charts
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False)
'''


def _execute(code: str, filename: str, content: bytes) -> dict:
    """在子进程沙箱里执行 AI 生成的分析代码, 返回 {ok, stdout, charts, error}。"""
    if _DANGER.search(code):
        return {"ok": False, "error": "生成的代码包含不被允许的操作（文件/网络/系统调用），已拒绝执行。", "stdout": "", "charts": []}
    with tempfile.TemporaryDirectory() as d:
        ext = ".xlsx" if filename.lower().endswith((".xlsx", ".xls")) else ".csv"
        data_path = os.path.join(d, "data" + ext)
        code_path = os.path.join(d, "user_code.py")
        runner_path = os.path.join(d, "runner.py")
        out_path = os.path.join(d, "out.json")
        with open(data_path, "wb") as f:
            f.write(content)
        with open(code_path, "w", encoding="utf-8") as f:
            f.write(code)
        with open(runner_path, "w", encoding="utf-8") as f:
            f.write(_RUNNER)
        import subprocess

        try:
            subprocess.run(
                [sys.executable, runner_path, data_path, code_path, out_path],
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


async def analyze_data(filename: str, content: bytes, question: str) -> AsyncIterator[tuple[str, dict]]:
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
        run = await asyncio.to_thread(_execute, code, filename, content)

        # 自动纠错: 最多重试 2 次
        for attempt in range(2):
            if run.get("ok"):
                break
            yield ("status", {"message": f"执行出错，正在自动修正代码（第 {attempt + 1} 次）…"})
            code = _extract_code(
                await _complete(_fix_code_messages(profile, question, code, run.get("error", "")))
            )
            yield ("code", {"code": code})
            yield ("status", {"message": "正在重新执行…"})
            run = await asyncio.to_thread(_execute, code, filename, content)

        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        if run.get("stdout"):
            yield ("output", {"text": run["stdout"]})

        if not run.get("ok"):
            yield ("error", {"message": "分析代码执行失败：\n" + (run.get("error") or "未知错误")})
            return

        yield ("status", {"message": "正在总结结论…"})
        async for piece in stream_chat(_conclusion_messages(question, code, run.get("stdout", ""))):
            yield ("delta", {"text": piece})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"分析过程出错：{e}"})
