---
name: data-analysis
description: 用于任何数据分析、统计计算、画图、读写 CSV/Excel 的任务。使用项目自带的 Python 虚拟环境（内含 pandas / numpy / scipy / matplotlib / scikit-learn / seaborn / statsmodels）。当用户上传数据文件或要求分析、统计、探索性可视化时使用。边界：**探索性看数与 150dpi 预览图**用本技能；要**投稿级出版图**（森林图/KM/火山图，300dpi+矢量）用 nature-figure。
---

# 数据分析技能

本项目自带一个已配置好的 Python 虚拟环境，装了科学计算包。**运行 Python 必须用这个解释器**，不要用系统 `python`（系统没装 Python）。

## 解释器
```
.venv/Scripts/python.exe   # Windows（正斜杠写法，bash 与 PowerShell 都能用）
.venv/bin/python           # Linux / macOS
```
已安装：pandas、numpy、scipy、matplotlib、scikit-learn、seaborn、statsmodels、openpyxl，另有 lifelines（生存分析）等。

> 要出**出版级图表**（森林图/KM/火山图，300dpi + 矢量）时，改用 `nature-figure` 技能。

## 运行方式
把代码写到一个 `.py` 文件，再用 bash 执行：
```
.venv/Scripts/python.exe analysis.py
```

## 医学统计方法选择（护栏，动手前先对号入座）
非程序员医学用户最常被审稿人挑的就是"检验用错"。按数据类型选，别默认套 t 检验：
- **两组连续变量**：先看正态性（Shapiro–Wilk / QQ 图）与方差齐性 → 正态且齐 → 独立样本 t；否则 → Mann–Whitney U。配对设计 → 配对 t / Wilcoxon 符号秩。
- **≥3 组连续变量**：正态 → 单因素 ANOVA（+ 事后两两比较且校正）；非正态 → Kruskal–Wallis（+ Dunn 校正）。
- **分类变量**：卡方检验；**任一期望频数 <5 或总样本小 → Fisher 精确检验**；有序分类 → 趋势卡方 / Mann–Whitney。
- **多重比较必校正**：一次比多对/多终点 → Bonferroni（保守）或 Benjamini–Hochberg FDR（推荐用于多终点），别只报一堆未校正 p。
- **相关/回归**：连续 → Pearson（正态）/ Spearman（非正态或有序）；结局二分类 → logistic 回归报 OR+95%CI；计数 → 泊松/负二项。
- **生存数据**：Kaplan–Meier 画曲线 + log-rank 比较；多因素 → Cox 比例风险，**并检验 PH 假设**（Schoenfeld 残差）。用 `lifelines`（已装）。
- **诊断试验**：报敏感度/特异度/PPV/NPV/LR + ROC-AUC（含 95%CI），别只报准确率。
- **Meta 分析（系统综述定量合并）**：用 `statsmodels.stats.meta_analysis`（`combine_effects`：DerSimonian-Laird 随机效应、I²/τ²/Q 异质性）+ 自绘森林图；亚组/敏感性分析。⚠️ **Egger 发表偏倚检验/漏斗图不对称、REML、网络 Meta/多水平 statsmodels 无内置**——需手写加权回归或用 R `metafor`；**别声称能做其实做不了的**。系统综述全流程(筛选/RoB/GRADE/PRISMA)走 `systematic-review` 技能。

## 报告规范（写进结论）
> **交付统计结论 / 写 Methods/Results 前，逐条过 [references/stat-reporting-checklist.md](references/stat-reporting-checklist.md)（顶刊统计报告清单，强制）。** 下面是要点，细则与格式看清单。
- 始终报**效应量 + 95% 置信区间 + 精确 p 值 + 样本量 n**，不要只写 `p<0.05`（95%CI 优先于单独 p）。
- 数字格式统一：p 值 2–3 位有效数字、`<0.001` 不写 0.000；OR/RR/HR 保留 2 位小数 + 95%CI；百分比 1 位小数 + 分子/分母。
- 连续变量按分布报 `均数±标准差` 或 `中位数[IQR]`；分类变量报 `n (%)`。
- 说明缺失值如何处理、是否做了多重比较校正；软件及版本、显著性水平与单双侧写进 Methods。
> **基线特征表 Table 1 与样本量/把握度计算**用 `clinical-stats` 技能（已封装好，按变量类型自动选检验）；本技能做通用/自定义分析与建模。

## 数据治理（可复现的底线，动分析前先立规矩）
- **原始数据只读**：`raw/` 里的原始文件**绝不就地修改**；清洗/派生一律写到 `processed/`、分析产物写 `analysis/`（或 `outputs/`）。原始数据进 `.gitignore`（含患者信息更要）。
- **数据字典**：给每个变量登记 类型/取值范围或类别/单位/缺失编码，一份 `data_dictionary.md`——防"把分类当连续、把 9 当真值"。
- **处理日志**：每步清洗/转换记一行（日期、做了什么、输入→输出文件），可回溯。
- **脚本可复现**：用**相对路径**、**固定随机种子**（`np.random.default_rng(0)` 等）、记录 Python 与关键包版本；别把结果依赖于运行环境或随机性。

## 约定
- 输入数据文件在工作目录，或 `uploads/` 目录里。**若数据含患者姓名/身份证/住院号/手机号等可识别信息，先提醒用户脱敏再分析。**
- **所有产出（图表 PNG、结果 CSV/Excel）写到 `outputs/` 目录**，方便前端用户下载。
- 画图用无界面后端：脚本开头 `import matplotlib; matplotlib.use("Agg")`，再 `plt.savefig("outputs/xxx.png", dpi=150, bbox_inches="tight")`。
- 分析完，用一段话向用户总结关键结论（带效应量+CI+p+n）+ 列出生成的文件路径。
