"""本地数据分析引擎。

读取用户上传的 CSV/Excel, 在本地用 pandas/scipy 计算统计量, 用 matplotlib 出图。
所有数字都由程序算出, 之后交给 LLM 写作时严禁其改动或编造。
返回: 描述统计、检验结果、图表(base64 PNG), 以及给 LLM 的 facts 文本。
"""
from __future__ import annotations

import base64
import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy import stats  # noqa: E402

# 让图表能正常显示中文标签(Windows 常见字体)
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

MAX_SHAPIRO = 5000


def _load(filename: str, content: bytes) -> pd.DataFrame:
    bio = io.BytesIO(content)
    if filename.lower().endswith((".xlsx", ".xls")):
        return pd.read_excel(bio)
    return pd.read_csv(bio)


def _coerce_numeric(df: pd.DataFrame, threshold: float = 0.8) -> pd.DataFrame:
    """把“看起来是数字的文本列”转成数值列。

    真实数据常把数字存成字符串(带空格、千分位逗号、引号)。若某文本列在去除这些
    干扰后, 有至少 threshold 比例的非空值能成功转为数字, 就替换为数值列。
    """
    for col in df.columns:
        if df[col].dtype != object:
            continue
        s = df[col].astype(str).str.strip().str.replace(",", "", regex=False)
        s = s.replace({"": None, "nan": None, "NaN": None, "None": None, "NA": None})
        converted = pd.to_numeric(s, errors="coerce")
        non_null = s.notna().sum()
        if non_null > 0 and converted.notna().sum() / non_null >= threshold:
            df[col] = converted
    return df


def _fig_to_b64(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=120, bbox_inches="tight")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def analyze(filename: str, content: bytes, question: str = "") -> dict:
    try:
        df = _load(filename, content)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"无法读取数据文件：{e}"}

    if df.empty:
        return {"ok": False, "error": "数据为空。"}

    df = _coerce_numeric(df)
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    cat_cols = [c for c in df.columns if c not in numeric_cols]

    facts: list[str] = []
    charts: list[dict] = []
    stats_lines: list[str] = []

    facts.append(f"数据规模：{df.shape[0]} 行 × {df.shape[1]} 列。")
    facts.append(f"数值型列：{', '.join(numeric_cols) if numeric_cols else '无'}。")
    facts.append(f"分类型列：{', '.join(map(str, cat_cols)) if cat_cols else '无'}。")

    # 缺失值
    missing = df.isna().sum()
    missing = missing[missing > 0]
    if len(missing) > 0:
        facts.append("缺失值：" + "；".join(f"{k} 缺 {v} 个" for k, v in missing.items()) + "。")

    # 描述性统计
    describe_md = ""
    if numeric_cols:
        desc = df[numeric_cols].describe().round(4)
        describe_md = "描述性统计：\n" + desc.to_string()
        for col in numeric_cols:
            s = df[col].dropna()
            facts.append(
                f"{col}: 均值={s.mean():.4g}, 标准差={s.std():.4g}, "
                f"中位数={s.median():.4g}, 最小={s.min():.4g}, 最大={s.max():.4g}, n={s.count()}。"
            )

    # 正态性检验
    for col in numeric_cols:
        s = df[col].dropna()
        if 3 <= len(s) <= MAX_SHAPIRO:
            try:
                w, p = stats.shapiro(s)
                normal = p > 0.05
                stats_lines.append(f"[正态性] {col}: Shapiro W={w:.4f}, p={p:.4g} → {'近似正态' if normal else '非正态'}")
                facts.append(f"{col} 正态性检验 p={p:.4g}（{'近似正态' if normal else '非正态'}）。")
            except Exception:  # noqa: BLE001
                pass

    # 相关性(数值列 >=2)
    if len(numeric_cols) >= 2:
        corr = df[numeric_cols].corr().round(3)
        stats_lines.append("[相关系数矩阵 Pearson]\n" + corr.to_string())
        # 显著相关对
        for i in range(len(numeric_cols)):
            for j in range(i + 1, len(numeric_cols)):
                a, b = numeric_cols[i], numeric_cols[j]
                pair = df[[a, b]].dropna()
                if len(pair) >= 3:
                    try:
                        r, p = stats.pearsonr(pair[a], pair[b])
                        if p < 0.05:
                            facts.append(f"{a} 与 {b} 显著相关：r={r:.3f}, p={p:.4g}。")
                    except Exception:  # noqa: BLE001
                        pass
        # 热图
        try:
            fig, ax = plt.subplots(figsize=(5, 4))
            im = ax.imshow(corr.values, cmap="coolwarm", vmin=-1, vmax=1)
            ax.set_xticks(range(len(numeric_cols)))
            ax.set_yticks(range(len(numeric_cols)))
            ax.set_xticklabels(numeric_cols, rotation=45, ha="right", fontsize=8)
            ax.set_yticklabels(numeric_cols, fontsize=8)
            for i in range(len(numeric_cols)):
                for j in range(len(numeric_cols)):
                    ax.text(j, i, f"{corr.values[i, j]:.2f}", ha="center", va="center", fontsize=7)
            fig.colorbar(im, ax=ax, fraction=0.046)
            ax.set_title("相关系数热图")
            charts.append({"title": "相关系数热图", "b64": _fig_to_b64(fig)})
        except Exception:  # noqa: BLE001
            pass

    # 直方图(前两个数值列)
    for col in numeric_cols[:2]:
        try:
            fig, ax = plt.subplots(figsize=(5, 3.2))
            ax.hist(df[col].dropna(), bins=20, color="#2f6df6", alpha=0.8)
            ax.set_title(f"{col} 分布")
            ax.set_xlabel(col)
            ax.set_ylabel("频数")
            charts.append({"title": f"{col} 分布直方图", "b64": _fig_to_b64(fig)})
        except Exception:  # noqa: BLE001
            pass

    # 分组比较: 找一个 2-10 类的分类列 + 第一个数值列
    if numeric_cols and cat_cols:
        ycol = numeric_cols[0]
        for gcol in cat_cols:
            groups_unique = df[gcol].dropna().unique()
            if 2 <= len(groups_unique) <= 10:
                grouped = [df[df[gcol] == g][ycol].dropna() for g in groups_unique]
                grouped = [g for g in grouped if len(g) >= 2]
                if len(grouped) >= 2:
                    # 箱线图
                    try:
                        fig, ax = plt.subplots(figsize=(5.5, 3.5))
                        ax.boxplot(grouped, labels=[str(g) for g in groups_unique if len(df[df[gcol] == g][ycol].dropna()) >= 2])
                        ax.set_title(f"{ycol} 按 {gcol} 分组")
                        ax.set_ylabel(ycol)
                        charts.append({"title": f"{ycol} 按 {gcol} 分组箱线图", "b64": _fig_to_b64(fig)})
                    except Exception:  # noqa: BLE001
                        pass
                    # 检验
                    try:
                        if len(grouped) == 2:
                            t, p = stats.ttest_ind(grouped[0], grouped[1], equal_var=False)
                            u, pu = stats.mannwhitneyu(grouped[0], grouped[1], alternative="two-sided")
                            stats_lines.append(
                                f"[两组比较] {ycol} 按 {gcol}: Welch t={t:.3f}, p={p:.4g}; "
                                f"Mann-Whitney U p={pu:.4g}"
                            )
                            facts.append(
                                f"{ycol} 在 {gcol} 两组间：t检验 p={p:.4g}，"
                                f"Mann-Whitney p={pu:.4g}（{'差异显著' if p < 0.05 else '差异不显著'}）。"
                            )
                        else:
                            f, p = stats.f_oneway(*grouped)
                            h, ph = stats.kruskal(*grouped)
                            stats_lines.append(
                                f"[多组比较] {ycol} 按 {gcol}: ANOVA F={f:.3f}, p={p:.4g}; "
                                f"Kruskal-Wallis p={ph:.4g}"
                            )
                            facts.append(
                                f"{ycol} 在 {gcol} 各组间：ANOVA p={p:.4g}，"
                                f"Kruskal p={ph:.4g}（{'差异显著' if p < 0.05 else '差异不显著'}）。"
                            )
                    except Exception:  # noqa: BLE001
                        pass
                break  # 只做第一个合适的分组列

    stats_md = "统计检验：\n" + ("\n".join(stats_lines) if stats_lines else "（无适用的统计检验）")
    facts_text = "\n".join(f"- {f}" for f in facts)

    return {
        "ok": True,
        "rows": int(df.shape[0]),
        "cols": int(df.shape[1]),
        "describe_md": describe_md or "（无数值型列可统计）",
        "stats_md": stats_md,
        "charts": charts,
        "facts": facts_text,
    }
