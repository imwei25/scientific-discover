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

from . import statroute
from .config import settings
from .llm import stream_chat
from .logutil import log_swallow
from .textio import read_csv_bytes

EXEC_TIMEOUT = 60  # 秒

# 轻量安全护栏: 命中这些明显危险的调用则拒绝执行(本地用户环境, 主要防误伤)。
# eval/exec/open 仅拦截“内置函数”形式(前面不是 . 或字母): 这样既挡住注入/读文件,
# 又不会误伤合法的 pandas 方法 df.eval()/df.query() 等(它们前面有 . )。
#
# 扩展拦截理由(防 LLM 生成的分析代码绕过读文件/加载恶意对象/动态导入):
#   - pickle.load/loads: 反序列化任意对象 = 任意代码执行, 绝不允许在沙箱里跑。
#   - ctypes: 直接调 C 库、系统调用、内存操作, 完全绕过 Python 层护栏。
#   - importlib: __import__ 已拦, 但 importlib.import_module / __import__ 变种仍能加载 os/subprocess。
#   - runpy: run_path/run_module 等价于 exec 一个模块。
#   - pathlib 的读写方法(read_bytes/read_text/write_bytes/write_text): 等价于 open, 会被拿来读 /etc/passwd
#     或写入宿主机文件。注意只拦读写方法, 不拦 Path()/Path.exists() 等纯路径操作;
#     pandas 的 pd.read_csv/read_excel 不涉及 pathlib 方法, 不会被误伤。
_DANGER = re.compile(
    r"\b(?:subprocess|os\.system|os\.popen|os\.remove|os\.rmdir|os\.unlink|shutil\.(?:rmtree|move|copy)|"
    r"socket|requests|urllib|httpx|Popen|__import__|ctypes|importlib|runpy)\b"
    r"|\bpickle\s*\.\s*loads?\b"
    r"|\.(?:read_bytes|read_text|write_bytes|write_text)\s*\("
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


# 抓 p 值的正则: 兼容 p=、p＝、p:、p val=、p-value=、P value =… 等常见写法。
_P_VALUE_RE = re.compile(r"(?i)\bp\s*(?:[-_]?val(?:ue)?)?\s*[=＝:]\s*(\d+\.\d+)")


def _extract_p_values(text: str) -> set[float]:
    """抓出 text 中所有形如 p=0.03 的 p 值 (归一化为 float)。"""
    out: set[float] = set()
    if not text:
        return out
    for m in _P_VALUE_RE.finditer(text):
        try:
            v = float(m.group(1))
        except ValueError:
            continue
        # 只保留合法 p 值 (0 <= p <= 1); 超范围的由 _sanity_checks 单独告警。
        if 0.0 <= v <= 1.0:
            out.add(v)
    return out


def check_p_value_consistency(stdout: str, conclusion: str) -> list[str]:
    """核对结论里的 p 值是否都能在真实 stdout 中找到 (容差 0.001)。

    结论里出现、但 stdout 里没有近似值的 p 值, 视为 LLM 幻觉, 记录告警。
    stdout 里有、结论里没引用的 p 值不告警 (作者有权省略非关键结果)。
    """
    warns: list[str] = []
    stdout_ps = _extract_p_values(stdout)
    concl_ps = _extract_p_values(conclusion)
    if not concl_ps:
        return warns
    for p in sorted(concl_ps):
        if not any(abs(p - q) <= 0.001 for q in stdout_ps):
            # 格式化时避免 0.03 变 0.030000000000000002 之类
            warns.append(f"结论里 p={p:g} 未在真实输出中出现，疑似模型幻觉，请核对。")
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
    """生成给 AI 看的数据画像(隐私安全版)。

    原实现把 df.head(5) 整行原始记录塞进 LLM 提示词, 500 行病例前 5 行含
    姓名/年龄/血压/结局等直接可识别信息, 违反项目"本地不出网"承诺。
    改造后:
      - 分类列: 只披露"取值+计数"(<=20 个不同取值时), 高基数列判定为疑似 PII, 不外发原始值
      - 数值列: describe() 汇总统计(mean/std/quantile)——已是行业标准脱敏
      - 逐列样例: 仅当列被判定为低基数分类且样本量>=5 时才展示; 其余列仅回传 dtype/唯一值数/缺失
      - **删除**"前 5 行"整行披露
    """
    n_rows = int(df.shape[0])
    lines = [f"数据规模：{n_rows} 行 × {df.shape[1]} 列。", "列信息："]
    for col in df.columns:
        dtype = str(df[col].dtype)
        nuniq = int(df[col].nunique(dropna=True))
        miss = int(df[col].isna().sum())
        line = f"  - {col}（{dtype}，唯一值{nuniq}，缺失{miss}）"
        # 只对"低基数且样本量足够"的分类列外发取值样例(视作元数据), 否则一律不外发原始值。
        # 阈值: 唯一值 <= 20 且总样本 >= 10 (避免小样本单值被反推出个体身份)
        is_low_cardinality = nuniq > 0 and nuniq <= 20 and n_rows >= 10
        looks_id_like = n_rows > 0 and (nuniq / n_rows) >= 0.9  # 近乎唯一, 疑似 ID/姓名
        if is_low_cardinality and not looks_id_like:
            vc = df[col].value_counts(dropna=True).head(6)
            pairs = ", ".join(f"{k}({int(v)})" for k, v in vc.items())
            if pairs:
                line += f" 主要取值: {pairs}"
        elif looks_id_like:
            line += " [疑似ID/姓名列, 不展示样例]"
        else:
            line += " [高基数列, 不展示原始值]"
        flags = _column_flags(df[col])
        if flags:
            line += "  【" + "；".join(flags) + "】"
        lines.append(line)
    numeric = list(df.select_dtypes(include="number").columns)
    categorical = [c for c in df.columns if c not in numeric]
    lines.append(f"\n数值型列：{', '.join(map(str, numeric)) or '无'}")
    lines.append(f"分类型列：{', '.join(map(str, categorical)) or '无'}")
    # 数值列描述统计: 汇总量(count/mean/std/min/quartile/max), 不是行级数据, 保留
    if numeric and n_rows >= 5:
        try:
            lines.append("\n数值列描述统计(汇总, 非行级)：")
            lines.append(df[numeric].describe().round(3).to_string())
        except Exception as e:  # noqa: BLE001
            log_swallow("数据画像: 数值列描述统计生成失败(AI 将缺少分布信息)", e)
    # 分类列已在上方逐列展示前 6 个取值+计数, 此处不再重复。
    lines.append(
        "\n注: 出于隐私保护, 未提供行级样本; AI 若需查看真实取值分布, 请在探索代码中用 df.describe()/value_counts() 打印聚合信息。"
    )
    return "\n".join(lines)


_FENCE_OPEN = re.compile(r"```(?:python|py)?[ \t]*\n?")


def _extract_code(text: str) -> str:
    """从 LLM 输出中提取 Python 代码, 对两类真实故障保持健壮:

    1. 修复类回复的散文说明里常有内联 ``` 小片段——取"最长"的完整代码块,
       不能拿第一块就走(曾把 17 个字符的中文当代码去 exec)。
    2. 输出被 max_tokens 截断时闭合围栏丢失——退而取最后一个开围栏之后的全部,
       绝不能把带 ```python 围栏的原文整段交给 exec(必然 SyntaxError)。
    """
    blocks = [b.strip() for b in re.findall(r"```(?:python|py)?\s*(.*?)```", text, re.DOTALL)]
    best = max(blocks, key=len) if blocks else ""
    opens = list(_FENCE_OPEN.finditer(text))
    if opens:
        tail = text[opens[-1].end():]
        if "```" not in tail and len(tail.strip()) > len(best):
            best = tail.strip()
    return best if best else text.strip()


async def _complete(messages: list[dict], max_tokens: int = 1500) -> str:
    buf = ""
    async for piece in stream_chat(messages, task="analysis", max_tokens=max_tokens):
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


def _gen_explore_messages(profile: str, question: str) -> list[dict]:
    """T2 探索轮: 让 AI 先写一段**只读探索代码**看真实数据, 再据此写正式分析,
    从根上消灭"臆测列名/结构"和"前提没查"两大失败源(数据分析 agent 头号死因)。"""
    system = (
        "你是数据分析专家。在正式统计分析之前，请先写一段**只读探索代码**来真正了解这份数据，"
        "避免凭空臆测。\n" + _LIBS_NOTE + "\n"
        "严格要求：\n"
        "① 只使用已加载的 df；**只 print，绝不画图、不做正式统计检验/建模/多重比较**；\n"
        "② 打印这些内容帮助后续决策：将要用到的每个列的真实 dtype 与若干样例、缺失情况；"
        "若研究涉及分组，打印分组列的**取值与各组样本量**（务必确认到底几组、各组 n）；"
        "对将用于分析的连续变量打印基本分布（count/mean/std/min/中位数/max）与明显异常迹象；"
        "确认你打算引用的列名在 df 中**真实存在**；\n"
        "③ 代码要短、健壮，用 try/except 兜住每一步，**尽量不要报错**；\n"
        "只输出一个 Python 代码块，不要额外解释。"
    )
    user = f"【数据画像】\n{profile}\n\n【研究用途】\n{question or '（用户未填写，请你判断最有价值的分析方向并据此探索）'}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _gen_code_messages(profile: str, question: str, explore: str = "", routing: str = "") -> list[dict]:
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
        "配色已由运行环境统一设置，无需手动指定颜色（除非用户特别要求）；"
        "更贴近期刊风格的细节：柱状图给每根柱子加黑色描边（edgecolor='black', linewidth≈1.2）并画误差棒（±SD/SEM 或 95%CI，带 capsize）；"
        "表达剂量/亚组/有序等级等**有序梯度**时，用同一颜色的不同透明度（alpha 由浅到深）而非多种花色；"
        "每张图只用一套克制的配色，红/绿只留给『升高/降低、获益/损失』等方向语义，不要用于普通分类；系列不多时优先把标签直接标注在图元旁而非依赖图例；"
        "**为避免误导，柱状图/条形图的数值轴必须从 0 开始；仅当是折线/散点/箱线等非条形图、且数值集中在窄区间时，才可把坐标轴范围收紧到数据附近**；\n"
        "⑧ 只使用已加载的 df，列名务必使用上面【数据画像】中真实存在的列名，不要臆造列名。\n"
        "pingouin 注意：当前版本结果列名为下划线（如 p_val、cohen_d、CI95），没有连字符或百分号；"
        "获取数值建议先 print(整个结果表)，再用 res['p_val'].iloc[0] 这类按位置取值，切勿硬编码 'p-val' 等不存在的列名。\n"
        "⑨ 【严禁臆测“中间对象”的列名/索引标签】——这是最高频的 KeyError 来源，务必遵守：\n"
        "  · pd.get_dummies() 生成的哑变量列名随数据取值而定、且 drop_first 会丢掉基准列，"
        "**绝不要硬编码**诸如 '治疗方案_B' 的哑变量列名；需要时先 print(dummies.columns.tolist()) 或用 df.filter(like=...) 选取；\n"
        "  · 对 Kaplan-Meier 生存函数、或任何带浮点/时间索引的对象，取某时刻的值要用接口/按位置"
        "（如 kmf.survival_function_at_times(t)、.iloc[...]），**禁止用 .loc[标量标签]** 硬取（该标签往往不在索引里 → KeyError）；\n"
        "  · 送入 statsmodels 的 endog/exog（如 sm.Logit(y, X)）必须先把分类自变量全部数值化、并对 y 与 X 一起 dropna 对齐，"
        "X 不得含 object/字符串列（否则 statsmodels 抛 TypeError）；必要时用 sm.add_constant(X)。\n"
        "只输出一个 Python 代码块，不要额外解释。"
    )
    parts = [f"【数据画像】\n{profile}", f"【研究用途】\n{question or '（用户未填写，请你根据数据自行判断最有价值的分析方向）'}"]
    if explore:
        parts.append(
            "【探索结果（上一步只读探索代码在真实数据上的实际输出，请以此为准，务必使用其中确认存在的列名与真实分组）】\n"
            + explore
        )
    if routing:
        parts.append(
            "【系统判定的方法与前提（由确定性规则在真实数据上算出，请优先采用；如你有充分理由改用其他方法，请在【方法选择】中说明原因）】\n"
            + routing
        )
    return [{"role": "system", "content": system}, {"role": "user", "content": "\n\n".join(parts)}]


def _gen_draw_messages(profile: str, question: str) -> list[dict]:
    """只画图路径的代码生成 prompt。故意省掉所有统计推断/三大透明化区块要求,
    让 LLM 只输出画图代码——用户明确选了"只画图"模式,不该塞任何统计话术进来。"""
    system = (
        "你是数据可视化专家。用户明确只想**看图**,不做任何统计检验、不写文字结论。"
        "请根据【数据画像】和【绘图请求】写一段 Python 代码,只画图。\n"
        + _LIBS_NOTE + "\n"
        "严格要求:\n"
        "① 只使用已加载的 df,列名务必来自【数据画像】中真实存在的列,严禁臆造;\n"
        "② **只画图**——不做 t 检验/方差分析/相关/回归/生存分析等任何统计推断;\n"
        "③ **绝对不要** print 『【方法选择】』/『【假设检查】』/『【数据质量】』等透明化区块;\n"
        "④ 不要 print 结论性文字;必要时可 print 一两句极简说明(如 \"已生成条形图\")便于日志;\n"
        "⑤ 图要出版级质量:信息明确的标题、带单位的轴标签、必要时图例;matplotlib 默认样式,"
        "不用需要 LaTeX 的样式,不调用 plt.show();\n"
        "⑥ 若数据涉及分组,直接呈现即可,无需组间显著性标注(除非用户在【绘图请求】中显式要求);\n"
        "⑦ 柱状图/条形图的数值轴必须从 0 开始;折线/散点/箱线可按需收紧范围;\n"
        "⑧ 配色已由运行环境统一设置,无需手动指定颜色(除非用户特别要求)。\n"
        "只输出一个 Python 代码块,不要额外解释。"
    )
    user = f"【数据画像】\n{profile}\n\n【绘图请求】\n{question or '(用户未填写,请你根据数据挑一张最能揭示分布/关系的图)'}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _extract_spec_messages(profile: str, question: str, explore: str = "") -> list[dict]:
    """T3: 让 LLM 只做它擅长的"语义抽取"——把研究问题拆成结构化【分析规格】,
    交给 statroute 用确定性规则选方法(把 LLM 最弱的"适用性判断"从它手里拿走)。"""
    system = (
        "你是医学统计顾问。请把用户的研究问题拆解成结构化的【分析规格】，供后续由确定性规则"
        "跑前提检验并选择统计方法。你只需做变量与设计的语义抽取，不要自己下方法结论。\n"
        "只输出严格 JSON（无 markdown、无多余文字），结构：\n"
        "{\"analyses\": [{"
        "\"goal\": \"<该分析一句话目标>\", "
        "\"outcome\": \"<结局变量真实列名>\", "
        "\"outcome_type\": \"continuous|ordinal|binary|categorical|count|time_to_event\", "
        "\"group\": \"<分组/自变量列名，无则 null>\", "
        "\"paired\": false, "
        "\"design\": \"between|within|correlation|single\", "
        "\"x\": \"<相关分析自变量列名，否则省略>\", "
        "\"y\": \"<相关分析因变量列名，否则省略>\""
        "}]}\n"
        "铁律：① 列名必须用【数据画像】/【探索结果】中真实存在的，不得臆造；"
        "② 拿不准的分析宁可不列（宁缺毋滥）；③ 只输出 JSON。"
    )
    user = f"【数据画像】\n{profile}"
    if explore:
        user += f"\n\n【探索结果】\n{explore}"
    user += f"\n\n【研究用途】\n{question or '（未填写，请根据数据推断最有价值的分析）'}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _parse_spec(text: str) -> list[dict]:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    raw = m.group(0) if m else text
    try:
        obj = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        log_swallow("数据分析: AI 输出的分析计划无法解析为 JSON", e)
        return []
    analyses = obj.get("analyses") if isinstance(obj, dict) else None
    return [a for a in analyses if isinstance(a, dict)] if isinstance(analyses, list) else []


def _err_sig(error: str) -> str:
    """从报错里提取"错误签名"(异常类型), 用于判断是否在同一个错误上反复打转。"""
    if not error:
        return ""
    for line in reversed([ln for ln in error.splitlines() if ln.strip()]):
        m = re.match(r"([A-Za-z_][\w.]*(?:Error|Exception|Warning))\b", line.strip())
        if m:
            return m.group(1)
    return ""


def _fix_code_messages(profile: str, question: str, code: str, error: str, fresh: bool = False) -> list[dict]:
    """修复提示。研究结论: 反馈质量>转数——所以让模型先解释错因、并附上数据诊断(dtypes/shape);
    fresh=True 用于"在同一错误上反复失败"时——要求换一种完全不同的实现思路/库(策略降级)。"""
    if fresh:
        system = (
            "你之前几次尝试的数据分析代码都栽在了同一个错误上。请**换一种完全不同的实现思路或库**"
            "重新写：例如 pingouin 反复因列名/签名报错，就改用等价的 scipy.stats / statsmodels 实现；"
            "避开先前出错的那种写法。请先用一句话说明先前为什么一直失败，再给出全新的完整代码。\n"
            + _LIBS_NOTE
        )
    else:
        system = (
            "你之前写的 Python 数据分析代码执行报错了。请**先用一句话分析错误根因**，再修正代码。"
            "若错误与某个库的版本/列名/函数签名有关（如 pingouin 的结果列名与硬编码不符），"
            "可改用等价的 scipy.stats / statsmodels 实现绕开。仍只输出一个 Python 代码块。\n"
            + _LIBS_NOTE
        )
    user = (
        f"【数据画像】\n{profile}\n\n【研究用途】\n{question}\n\n"
        f"【原代码】\n```python\n{code}\n```\n\n【报错信息与数据诊断】\n{error}\n\n请给出修正后的完整代码。"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _refine_code_messages(
    profile: str, question: str, current_code: str, prev_summary: str, requirement: str,
) -> list[dict]:
    """对话式改代码: 在**已跑通的现有代码**上按用户新需求做最小改动, 而不是从头重写。

    设计要点(与用户约定): 只带三样进上下文——当前代码 + 上一轮结论摘要 + 新需求——
    不缓存完整对话历史, 因此 token 不随轮数增长; 数据仍以 df 形式实际执行(画像由真实 df 生成,
    保证列名可靠)。
    """
    system = (
        "你是资深的医学/生物医学数据分析专家。用户已经有一份**能正常运行**的分析代码，现在提出新的修改需求。"
        "请在**保留原有正确逻辑与三大透明化区块(【方法选择】【假设检查】【数据质量】)**的前提下，"
        "针对新需求做**最小必要修改**——新需求可能是换图型(如柱状图改箱线/小提琴)、改配色、加显著性标注、"
        "新增某项分析(如亚组/相关/回归)、更换分析变量或分组等。不要推倒重来，除非新需求确实要求全新分析。\n"
        + _LIBS_NOTE + "\n"
        "统计与作图仍须规范：需要检验时先查前提(正态/方差齐性)并据此在参数/非参数间选择；"
        "除 p 值外给出效应量与 95% CI，p 给精确值；多组多次比较做多重校正；"
        "每张图有信息明确的标题、带单位的轴标签、必要时图例，组间比较图在显著处标注显著性；"
        "期刊风细节：柱状图加黑色描边+误差棒、有序梯度用单色 alpha 由浅到深、每图一套克制配色（红绿只表方向）、"
        "柱状图数值轴从 0 开始（折线/散点可按需收紧范围）；"
        "只使用已加载的 df，列名用【数据画像】中真实存在的列名，不要臆造。\n"
        "**必须输出一个完整、可独立运行的 Python 代码块**(把改动整合进完整脚本，不要只给 diff 片段、"
        "不要额外解释)。"
    )
    parts = [
        f"【数据画像】\n{profile}",
        f"【原始研究用途】\n{question or '（未填写）'}",
        f"【当前分析代码（已跑通，请在此基础上改）】\n```python\n{current_code}\n```",
    ]
    if prev_summary:
        parts.append(f"【上一轮分析结论摘要（供理解语境，数字以本轮真实执行为准）】\n{prev_summary}")
    parts.append(f"【本轮新需求】\n{requirement}")
    return [{"role": "system", "content": system}, {"role": "user", "content": "\n\n".join(parts)}]


def _refine_draw_messages(
    profile: str, question: str, current_code: str, requirement: str,
) -> list[dict]:
    """只画图路径的 refine prompt。基于 _refine_code_messages 精简:
    去掉三大透明化区块保留要求、统计规范要求;只强调"在现有画图代码上按新需求最小改动"。"""
    system = (
        "你是数据可视化专家。用户已有一份**能正常运行**的画图代码,现在提出新的修改需求。"
        "请在原逻辑基础上做**最小必要修改**——新需求可能是换图型、改配色、加标注、"
        "换要画的变量或分组等。不要推倒重来,除非新需求确实要求全新的图。\n"
        + _LIBS_NOTE + "\n"
        "作图规范:每张图有信息明确的标题、带单位的轴标签、必要时图例;"
        "matplotlib 默认样式;柱状图/条形图的数值轴从 0 开始;"
        "只使用已加载的 df,列名用【数据画像】中真实存在的列名,不要臆造。\n"
        "**只画图**,不做任何统计检验;**绝对不要** print 『【方法选择】』等透明化区块。\n"
        "**必须输出一个完整、可独立运行的 Python 代码块**(把改动整合进完整脚本,"
        "不要只给 diff 片段、不要额外解释)。"
    )
    parts = [
        f"【数据画像】\n{profile}",
        f"【原始绘图请求】\n{question or '(未填写)'}",
        f"【当前画图代码(已跑通,请在此基础上改)】\n```python\n{current_code}\n```",
        f"【本轮新需求】\n{requirement}",
    ]
    return [{"role": "system", "content": system}, {"role": "user", "content": "\n\n".join(parts)}]


def _clip_output(text: str, head: int = 9000, tail: int = 3000) -> str:
    """结论只喂真实输出; 过长时保留头尾(尾部常含主分析结果/p值), 避免整段截断丢数字。"""
    if len(text) <= head + tail:
        return text
    return text[:head] + "\n…（中间省略以控制长度）…\n" + text[-tail:]


# 三个透明化标题的鲁棒匹配。允许:全/半角括号缺失、markdown 标题前缀、行首序号、
# 中英文冒号、前后 --- 或 === 装饰。每个 marker 单独匹配,按出现位置切分,允许乱序。
_TRANSPARENCY_MARKERS: dict[str, re.Pattern[str]] = {
    "method": re.compile(
        r"(?:^|\n)[\s>#\-=]*(?:[\d①-⑨][.、\s]+)?[『「]?\s*[【\[]?\s*方法选择(?![^\s\]】』」:：])\s*[】\]]?\s*[』」]?[\s::]*",
    ),
    "assumption": re.compile(
        r"(?:^|\n)[\s>#\-=]*(?:[\d①-⑨][.、\s]+)?[『「]?\s*[【\[]?\s*假设检查(?![^\s\]】』」:：])\s*[】\]]?\s*[』」]?[\s::]*",
    ),
    "quality": re.compile(
        r"(?:^|\n)[\s>#\-=]*(?:[\d①-⑨][.、\s]+)?[『「]?\s*[【\[]?\s*数据质量(?![^\s\]】』」:：])\s*[】\]]?\s*[』」]?[\s::]*",
    ),
}


def _split_transparency(stdout: str) -> dict[str, str]:
    """把三大透明化区块从 stdout 里剥出来。返回 {method, assumption, quality, main}。

    - 每个 marker 取首次匹配位置;按位置排序;相邻两 marker 之间是前者内容;
      最后一个 marker 后按空行切"最后区块内容 / main"。
    - 一个 marker 都没匹配到 → 全部落 main。
    - 优雅退化:LLM 输出格式漂移(缺括号 / md 标题 / 序号 / 乱序) 都尽量兜住。
    - 文本在首个 marker 之前的部分会被丢弃(视为噪声)。
    """
    if not stdout:
        return {"method": "", "assumption": "", "quality": "", "main": ""}

    hits: list[tuple[int, int, str]] = []
    for name, pat in _TRANSPARENCY_MARKERS.items():
        m = pat.search(stdout)
        if m:
            hits.append((m.start(), m.end(), name))
    if not hits:
        return {"method": "", "assumption": "", "quality": "", "main": stdout}

    hits.sort(key=lambda x: x[0])
    result = {"method": "", "assumption": "", "quality": "", "main": ""}

    # 相邻两个 marker 之间是前者内容
    for i in range(len(hits) - 1):
        _, end, name = hits[i]
        next_start = hits[i + 1][0]
        result[name] = stdout[end:next_start].strip("\n")

    # 最后一个 marker 之后:按空行切"最后区块内容 / main"
    _, last_end, last_name = hits[-1]
    tail = stdout[last_end:].strip("\n")
    parts = re.split(r"\n\s*\n", tail, maxsplit=1)
    if len(parts) == 2:
        result[last_name] = parts[0].strip("\n")
        result["main"] = parts[1].strip("\n")
    else:
        result[last_name] = tail
        result["main"] = ""

    return result


async def _strip_conclusion_preamble_stream(pieces: AsyncIterator[str]) -> AsyncIterator[str]:
    """吃掉结论 LLM 首个 `##` 之前的所有寒暄/开场白 chunk。

    - 见到 `##` 从其位置起原样转发;
    - 全程未见 `##` 时,收尾把缓冲整体送出兜底(总比空白好)。
    - 支持 `##` 跨 chunk 拆开(比如上一 chunk 只有 `#`,下一 chunk 是 `#`)——
      靠累计缓冲天然处理。
    """
    buf = ""
    seen = False
    async for piece in pieces:
        if seen:
            yield piece
            continue
        buf += piece
        idx = buf.find("##")
        if idx >= 0:
            yield buf[idx:]
            seen = True
    if not seen and buf.strip():
        yield buf


def _conclusion_messages(question: str, code: str, output: str, warnings: list[str] | None = None) -> list[dict]:
    system = (
        "你是医学/药学/生物医学论文写作助手。基于以下【真实输出】撰写结论,严禁编造或改动其中的数字;"
        "若某结论缺乏数据支撑请说明。\n"
        "\n"
        "【输出格式硬约束】\n"
        "- 严格 Markdown,**直接从『## 核心发现』开始**;\n"
        "- **绝对禁止**任何开场白、寒暄、\"我为您总结如下\"之类前言;\n"
        "- **绝对禁止**复述【方法选择】/【假设检查】/【数据质量】——这些已在其他区块单独展示,重复即为噪声;\n"
        "- 只输出以下三个二级标题及其内容,不多不少:\n"
        "\n"
        "## 核心发现\n"
        "引用输出中的具体数值/统计量/p 值(精确值,如 p=0.003),区分相关与因果。\n"
        "\n"
        "## 结果解读与意义\n"
        "临床/研究含义。审慎措辞:统计显著(如 p<0.05)不等于临床意义或因果,不要夸大;观察性数据只能谈关联。\n"
        "\n"
        "## 主要局限\n"
        "样本量、缺失/异常值处理、偏倚、混杂、假设是否满足等。\n"
    )
    parts = [f"【研究用途】\n{question}", f"【分析代码】\n```python\n{code}\n```", f"【代码真实输出】\n{_clip_output(output)}"]
    if warnings:
        parts.append(
            "【自动核对提示(系统对输出的确定性检查,请在结论中据实说明或据此修正,勿忽略)】\n"
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
    "grid.alpha": 0.25,       # 更淡的网格(期刊风: 网格只做辅助, 不喧宾夺主)
    "grid.linewidth": 0.6,
    "text.usetex": False,
    # 投稿刚需(借鉴 nature-figure): 矢量导出时文字保留为可编辑文本对象, 而非曲线路径,
    # 这样期刊排版/Illustrator/Inkscape 里能选中、搜索、微调标签。matplotlib 默认
    # svg.fonttype='path' 会把每个字形转成 bezier 路径 -> 文字不可编辑, 投稿常被要求返修。
    "svg.fonttype": "none",   # SVG 文字保留为 <text> 节点
    "pdf.fonttype": 42,       # PDF 内嵌 TrueType, 文字可编辑可搜索
    # 期刊极简风(借鉴 nature-figure): 无框图例 + 细坐标轴线, 让数据本身更突出
    "legend.frameon": False,
    "axes.linewidth": 0.8,
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
except KeyboardInterrupt:
    raise
except BaseException:
    # 用 BaseException(排除 KeyboardInterrupt): AI 代码里误用的 exit()/sys.exit()
    # 会抛 SystemExit(不是 Exception), 过去它会穿透到进程退出、不写 out.json ->
    # 用户只看到无信息的"未产生结果"; 现在一并捕获, 把真实 traceback 写进结果。
    result["ok"] = False
    tb = traceback.format_exc()
    # 附上真实数据诊断(列与 dtype、形状): 研究表明喂"运行时变量状态"比只喂 traceback
    # 能显著提高自动修复成功率(尤其类型/列名类错误)。
    try:
        _cols = list(df.dtypes.items())[:40]
        _diag = "df.shape=%s；列与类型: %s" % (
            df.shape, ", ".join("%s:%s" % (c, t) for c, t in _cols),
        )
        if len(df.columns) > 40:
            _diag += " …(列已截断)"
    except Exception:
        _diag = ""
    result["error"] = tb + ("\n[数据诊断] " + _diag if _diag else "")
finally:
    sys.stdout = _old

# stdout 先落进 result: 即便后续出图/序列化崩溃, 也不至于丢掉已经算好的文本结果。
result["stdout"] = buf.getvalue()

# 即便代码用了需要 LaTeX 的样式, 也强制关闭 usetex, 避免本机无 LaTeX 时出图失败
plt.rcParams["text.usetex"] = False
# 每张图: 始终产出用于网页内联展示的 png(120dpi); 另产出用户所选格式的可下载资产
# (高清 png 300dpi / svg 矢量 / pdf 矢量), 满足投稿需求。
# 整段出图再包一层 try: 出图崩溃不应连累已算好的 stdout(否则"算完了却因存图失败而全丢")。
charts = []
try:
    for num in plt.get_fignums():
        fig = plt.figure(num)
        bd = io.BytesIO()
        try:
            fig.savefig(bd, format="png", dpi=120, bbox_inches="tight")
            disp = base64.b64encode(bd.getvalue()).decode()
        except Exception:
            continue
        data, ext = disp, "png"
        downgraded = False
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
            # SVG/PDF 保存失败 → 只有 120dpi 展示 PNG. 显式告知前端, 别静默让用户以为拿到了矢量.
            data, ext = disp, "png"
            downgraded = (_FMT in ("svg", "pdf"))
        item = {"png": disp, "data": data, "ext": ext}
        if downgraded:
            item["downgraded_from"] = _FMT
            item["note"] = f"高清 {_FMT.upper()} 生成失败, 已回退为 120dpi PNG (仅适合展示, 不适合投稿)。"
        charts.append(item)
except Exception:
    pass
result["charts"] = charts
# 始终写出 out.json; 万一 result 里混入不可序列化对象导致 dump 失败, 退回只写核心字段,
# 保证主进程一定能读到 stdout 与 error(而不是拿到"未产生结果")。
try:
    with open(sys.argv[3], "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
except Exception:
    with open(sys.argv[3], "w", encoding="utf-8") as f:
        json.dump({"ok": result.get("ok", False), "error": result.get("error"),
                   "stdout": result.get("stdout", ""), "charts": []}, f, ensure_ascii=False)
'''


def _returncode_hint(rc: int | None) -> str:
    """把子进程退出码翻译成人话, 帮非技术用户看懂"崩在哪儿"。

    常见值: Windows 上 0xC00000FD(3221225725)=栈溢出(多为无限递归);
    139=段错误(SIGSEGV); 137=被 SIGKILL(常见于内存不足 OOM); 134=abort。
    """
    if rc is None:
        return "子进程未正常返回"
    known = {
        3221225725: "子进程栈溢出，可能是无限递归",
        3221225477: "子进程访问非法内存而崩溃",
        139: "子进程段错误(SIGSEGV)",
        134: "子进程被 abort(SIGABRT)",
        137: "子进程被强制结束(SIGKILL，常见于内存不足)",
        143: "子进程被终止(SIGTERM)",
    }
    if rc in known:
        return f"{known[rc]}，退出码 {rc}"
    if rc < 0:
        return f"子进程被信号 {-rc} 结束(可能内存不足或崩溃)"
    return f"子进程退出码 {rc}"


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
            proc = subprocess.run(
                [sys.executable, runner_path, data_path, code_path, out_path,
                 (chart_format or "png"), (palette or "default")],
                cwd=d,
                timeout=EXEC_TIMEOUT,
                capture_output=True,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"分析执行超时（>{EXEC_TIMEOUT}s）。可能是数据量过大或代码存在死循环/超大计算，请缩小数据或简化分析。", "stdout": "", "charts": []}
        if not os.path.exists(out_path):
            # 子进程在写出结果前就崩了: 顶层 import 失败 / pickle 反序列化失败 / matplotlib 字体崩溃 /
            # 段错误 / 栈溢出 / 被 OOM kill 等。真正的原因只在子进程 stderr 或退出码里——过去被
            # 丢弃, 用户只看到"执行未产生结果", 毫无线索。这里把退出码 + stderr(traceback)回灌:
            # 既让用户/日志看到真实原因, 也让上层自动纠错轮拿到可据以修复的错误文本。
            stderr = (proc.stderr or b"").decode("utf-8", "ignore").strip()
            stdout = (proc.stdout or b"").decode("utf-8", "ignore").strip()
            detail = stderr or stdout or "(子进程无任何输出)"
            # traceback 可能很长, 真正的异常行在末尾, 过长时保留尾部。
            if len(detail) > 4000:
                detail = "…（前略）…\n" + detail[-4000:]
            return {
                "ok": False,
                "error": (f"执行未产生结果（{_returncode_hint(proc.returncode)}，代码在生成结果前崩溃）：\n"
                          + detail),
                "stdout": "",
                "charts": [],
            }
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

        # T2 探索轮: 先让 AI 写只读探索代码在真实数据上跑一遍, 把真实观测(列是否存在、
        # 分组几组各组多少例、连续变量分布)喂回正式代码生成。执行失败则静默跳过(非致命),
        # 不比基线更差。
        explore_out = ""
        try:
            yield ("status", {"message": "正在探索数据结构（确认列名与分组，避免臆测）…"})
            # 2500(原 900): 探索提示词要求逐列 print dtype/样例/缺失 + 每步 try/except, 列一多
            # 900 token 会被拦腰截断 -> 闭合围栏/语句丢失 -> SyntaxError, 而失败又被静默吞掉,
            # 探索轮的价值(确认列名/分组/分布)白白损失, 正式代码退回盲写。放宽到 2500 留足余量。
            explore_code = _extract_code(await _complete(_gen_explore_messages(profile, question), max_tokens=2500))
            # 先编译校验: 万一仍被截断/有语法错, 直接跳过探索, 不白白起一次子进程去撞 SyntaxError。
            compile(explore_code, "explore.py", "exec")
            explore_run = await asyncio.to_thread(_execute, explore_code, df, chart_format, palette)
            if explore_run.get("ok"):
                explore_out = _clip_output(explore_run.get("stdout", ""), head=4000, tail=1000)
            else:
                log_swallow("数据分析: 探索轮执行未成功(非致命, 退回让正式代码自行判断)",
                            RuntimeError(explore_run.get("error", "") or "unknown"))
        except SyntaxError as e:
            log_swallow("数据分析: 探索轮代码编译失败(可能被截断), 跳过探索", e)
            explore_out = ""
        except Exception as e:  # noqa: BLE001
            log_swallow("数据分析: 探索轮出错(非致命), 跳过探索", e)
            explore_out = ""

        # T3 方法路由: LLM 只做结构化抽取(分析规格), 由确定性规则在真实数据上跑前提检验并选方法,
        # 生成"决策卡"给用户看、并把选定方法喂回代码生成——这样 AI 没机会"硬跑参数检验"。
        # 任一步失败都静默降级为空(退回让 AI 自行判断), 不比基线更差。
        routing = ""
        try:
            yield ("status", {"message": "正在判定统计方法与前提假设…"})
            specs = _parse_spec(await _complete(_extract_spec_messages(profile, question, explore_out), max_tokens=700))
            cards = statroute.route_analyses(df, specs)
            routing = statroute.cards_to_prompt(cards)
            if cards:
                yield ("plan", {"cards": cards})
        except Exception:  # noqa: BLE001
            routing = ""

        yield ("status", {"message": "正在理解数据并生成分析代码…"})
        # 8192: 提示词要求三大透明区块+前提检验+效应量/CI+出版级图, 认真写完轻松超 1500 token;
        # 实测 1500 会系统性拦腰截断 -> 闭围栏丢失 -> SyntaxError 死循环; 放宽到 8192 留足余量。
        # (代码由 _complete 整体接收, 用户点「停止」会取消整个 SSE 任务, 故不靠小上限控长度。)
        code = _extract_code(await _complete(
            _gen_code_messages(profile, question, explore=explore_out, routing=routing),
            max_tokens=8192,
        ))

        yield ("code", {"code": code})
        yield ("status", {"message": "正在本地执行分析…"})
        run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        # 自动纠错: 最多重试 3 次(共 4 次执行)。AI 写的统计代码(尤其 pingouin 版本相关的
        # 列名/函数签名)首次常报错, 2 次重试有时不够、导致整次分析失败; 多给一次显著提高成功率。
        # T4: 若在"同一个错误签名"上反复失败, 就换一种实现思路/库从头重写(fresh), 而不是继续贴补丁
        # ——研究表明"新开局"在同等预算下优于原地打转。
        seen_sigs: list[str] = []
        for attempt in range(3):
            if run.get("ok"):
                break
            sig = _err_sig(run.get("error", ""))
            fresh = bool(sig) and sig in seen_sigs
            seen_sigs.append(sig)
            hint = "（换一种思路重写）" if fresh else ""
            yield ("status", {"message": f"执行出错，正在自动修正代码（第 {attempt + 1} 次）{hint}…"})
            code = _extract_code(
                await _complete(
                    _fix_code_messages(profile, question, code, run.get("error", ""), fresh=fresh),
                    max_tokens=8192,
                )
            )
            yield ("code", {"code": code})
            yield ("status", {"message": "正在重新执行…"})
            run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        stdout_full = run.get("stdout", "") or ""
        if stdout_full:
            parts = _split_transparency(stdout_full)
            if parts["method"]:
                yield ("transparency_method", {"text": parts["method"]})
            if parts["assumption"]:
                yield ("transparency_assumption", {"text": parts["assumption"]})
            if parts["quality"]:
                yield ("transparency_quality", {"text": parts["quality"]})
            if parts["main"]:
                yield ("output", {"text": parts["main"]})

        if not run.get("ok"):
            yield ("error", {"message": "分析代码执行失败：\n" + (run.get("error") or "未知错误")})
            return

        # 确定性体检(不调用 LLM): 把可疑处作为提示喂给结论环节, 让 AI 据实修正/说明。
        warnings = _sanity_checks(stdout_full)

        yield ("status", {"message": "正在总结结论…"})
        conclusion_buf: list[str] = []
        async for piece in _strip_conclusion_preamble_stream(
            stream_chat(_conclusion_messages(question, code, stdout_full, warnings), task="analysis")
        ):
            conclusion_buf.append(piece)
            yield ("delta", {"text": piece})
        # p 值一致性核对: 结论里的 p 值必须能在真实 stdout 中找到 (容差 0.001)。
        # 只告警, 不拒稿 —— 避免过度干扰用户。
        for w in check_p_value_consistency(stdout_full, "".join(conclusion_buf)):
            yield ("warning", {"message": w})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"分析过程出错：{e}"})


async def draw_chart(
    filename: str, content: bytes, question: str, chart_format: str = "png", palette: str = "default",
) -> AsyncIterator[tuple[str, dict]]:
    """只画图模式:profile → 单发画图代码 → 执行 → 出图。
    不做探索、不做统计规格抽取、不写结论。绝不发 delta/transparency_*/output/plan 事件。"""
    if settings.mock:
        yield ("status", {"message": "[MOCK] 生成图…"})
        yield ("code", {"code": "# mock draw\nimport matplotlib.pyplot as plt\nplt.bar([1,2],[3,4])"})
        yield ("charts", {"items": [{"png": "", "data": "", "ext": "png"}]})
        yield ("done", {})
        return

    try:
        yield ("status", {"message": "正在读取数据…"})
        try:
            df = _load(filename, content)
        except Exception as e:  # noqa: BLE001
            yield ("error", {"message": f"无法读取数据文件:{e}"})
            return
        if df.empty:
            yield ("error", {"message": "数据为空。"})
            return
        profile = profile_data(df)

        yield ("status", {"message": "正在生成画图代码…"})
        code = _extract_code(await _complete(
            _gen_draw_messages(profile, question), max_tokens=4096,
        ))
        yield ("code", {"code": code})
        yield ("status", {"message": "正在本地执行画图…"})
        run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        seen_sigs: list[str] = []
        for attempt in range(3):
            if run.get("ok"):
                break
            sig = _err_sig(run.get("error", ""))
            fresh = bool(sig) and sig in seen_sigs
            seen_sigs.append(sig)
            hint = "(换一种思路重写)" if fresh else ""
            yield ("status", {"message": f"执行出错,正在自动修正代码(第 {attempt + 1} 次){hint}…"})
            code = _extract_code(await _complete(
                _fix_code_messages(profile, question, code, run.get("error", ""), fresh=fresh),
                max_tokens=4096,
            ))
            yield ("code", {"code": code})
            yield ("status", {"message": "正在重新执行…"})
            run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        # 注意:draw 模式不发 output 事件——用户明确只想看图, 系统日志级别的 print 不入前端
        if not run.get("ok"):
            yield ("error", {"message": "画图代码执行失败:\n" + (run.get("error") or "未知错误")})
            return
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"画图过程出错:{e}"})


async def _refine_mock(requirement: str) -> AsyncIterator[tuple[str, dict]]:
    yield ("status", {"message": "正在按新需求修改分析代码…"})
    yield ("code", {"code": f"# [MOCK] 按新需求修改: {requirement}\nprint('已按新需求重跑，p=0.008')"})
    yield ("status", {"message": "正在本地执行分析…"})
    yield ("charts", {"items": []})
    yield ("output", {"text": "已按新需求重跑，p=0.008"})
    yield ("status", {"message": "正在总结结论…"})
    for ch in f"## 更新结论\n[MOCK] 已按「{requirement}」调整，结果显著（p=0.008）。":
        yield ("delta", {"text": ch})


async def refine_analysis(
    filename: str, content: bytes, current_code: str, prev_summary: str, requirement: str,
    question: str = "", chart_format: str = "png", palette: str = "default",
) -> AsyncIterator[tuple[str, dict]]:
    """对话式续跑: 在已有分析代码上按用户新需求改一版并重新执行。

    与 analyze_data 复用同一套执行/自动纠错/结论机制, 但**跳过探索轮与方法路由**
    (现有代码已证明列名与分组存在, 无需再探索), 因此更快更省。上下文只含
    当前代码 + 上轮结论摘要 + 新需求, 不随对话轮数膨胀。
    """
    if settings.mock:
        async for ev in _refine_mock(requirement):
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
        if not (current_code or "").strip():
            yield ("error", {"message": "缺少可修改的现有分析代码，请先完成一次分析。"})
            return
        profile = profile_data(df)

        yield ("status", {"message": "正在按新需求修改分析代码…"})
        code = _extract_code(await _complete(
            _refine_code_messages(profile, question, current_code, _clip_output(prev_summary, 3000, 500), requirement),
            max_tokens=8192,
        ))
        yield ("code", {"code": code})
        yield ("status", {"message": "正在本地执行分析…"})
        run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        # 自动纠错(与首轮一致): 最多重试 3 次; 同一错误签名反复失败则换思路重写。
        seen_sigs: list[str] = []
        for attempt in range(3):
            if run.get("ok"):
                break
            sig = _err_sig(run.get("error", ""))
            fresh = bool(sig) and sig in seen_sigs
            seen_sigs.append(sig)
            hint = "（换一种思路重写）" if fresh else ""
            yield ("status", {"message": f"执行出错，正在自动修正代码（第 {attempt + 1} 次）{hint}…"})
            code = _extract_code(await _complete(
                _fix_code_messages(profile, requirement, code, run.get("error", ""), fresh=fresh),
                max_tokens=8192,
            ))
            yield ("code", {"code": code})
            yield ("status", {"message": "正在重新执行…"})
            run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        stdout_full = run.get("stdout", "") or ""
        if stdout_full:
            parts = _split_transparency(stdout_full)
            if parts["method"]:
                yield ("transparency_method", {"text": parts["method"]})
            if parts["assumption"]:
                yield ("transparency_assumption", {"text": parts["assumption"]})
            if parts["quality"]:
                yield ("transparency_quality", {"text": parts["quality"]})
            if parts["main"]:
                yield ("output", {"text": parts["main"]})

        if not run.get("ok"):
            yield ("error", {"message": "分析代码执行失败：\n" + (run.get("error") or "未知错误")})
            return

        warnings = _sanity_checks(stdout_full)
        yield ("status", {"message": "正在总结结论…"})
        # 结论以"新需求"为研究用途, 让更新后的结论紧扣本轮改动。
        conc_q = (question + "\n【本轮新需求】" + requirement) if question else requirement
        conclusion_buf: list[str] = []
        async for piece in _strip_conclusion_preamble_stream(
            stream_chat(_conclusion_messages(conc_q, code, stdout_full, warnings), task="analysis")
        ):
            conclusion_buf.append(piece)
            yield ("delta", {"text": piece})
        # p 值一致性核对: 只告警, 不拒稿。
        for w in check_p_value_consistency(stdout_full, "".join(conclusion_buf)):
            yield ("warning", {"message": w})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"续跑过程出错：{e}"})


async def refine_draw(
    filename: str, content: bytes, current_code: str, requirement: str,
    question: str = "", chart_format: str = "png", palette: str = "default",
) -> AsyncIterator[tuple[str, dict]]:
    """只画图模式的续跑:在现有画图代码上按新需求做最小改动重跑。
    与 refine_analysis 同款事件契约,但绝不发 delta/transparency_*/output/plan。"""
    if settings.mock:
        yield ("status", {"message": "[MOCK] 按新需求改图…"})
        yield ("code", {"code": f"# mock refine draw: {requirement}"})
        yield ("charts", {"items": [{"png": "", "data": "", "ext": "png"}]})
        yield ("done", {})
        return

    try:
        yield ("status", {"message": "正在读取数据…"})
        try:
            df = _load(filename, content)
        except Exception as e:  # noqa: BLE001
            yield ("error", {"message": f"无法读取数据文件:{e}"})
            return
        if df.empty:
            yield ("error", {"message": "数据为空。"})
            return
        if not (current_code or "").strip():
            yield ("error", {"message": "缺少可修改的现有画图代码,请先完成一次画图。"})
            return
        profile = profile_data(df)

        yield ("status", {"message": "正在按新需求修改画图代码…"})
        code = _extract_code(await _complete(
            _refine_draw_messages(profile, question, current_code, requirement), max_tokens=4096,
        ))
        yield ("code", {"code": code})
        yield ("status", {"message": "正在本地执行画图…"})
        run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        seen_sigs: list[str] = []
        for attempt in range(3):
            if run.get("ok"):
                break
            sig = _err_sig(run.get("error", ""))
            fresh = bool(sig) and sig in seen_sigs
            seen_sigs.append(sig)
            hint = "(换一种思路重写)" if fresh else ""
            yield ("status", {"message": f"执行出错,正在自动修正代码(第 {attempt + 1} 次){hint}…"})
            code = _extract_code(await _complete(
                _fix_code_messages(profile, requirement, code, run.get("error", ""), fresh=fresh),
                max_tokens=4096,
            ))
            yield ("code", {"code": code})
            yield ("status", {"message": "正在重新执行…"})
            run = await asyncio.to_thread(_execute, code, df, chart_format, palette)

        if run.get("charts"):
            yield ("charts", {"items": run["charts"]})
        if not run.get("ok"):
            yield ("error", {"message": "画图代码执行失败:\n" + (run.get("error") or "未知错误")})
            return
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"续跑过程出错:{e}"})
