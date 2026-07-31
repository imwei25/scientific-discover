---
name: data-analysis
description: 用于任何数据分析、统计计算、画图、读写 CSV/Excel 的任务。**拿到数据先跑本技能的数据体检（scripts/data_profile.py）**——查重复ID/数值列混字符串/编码不一致/不可能值/单位混用/缺失率/日期颠倒，"必须处置"项清完才做检验与建模。使用项目自带的 Python 虚拟环境（内含 pandas / numpy / scipy / matplotlib / scikit-learn / seaborn / statsmodels）。当用户上传数据文件或要求分析、统计、探索性可视化时使用。边界：**探索性看数与 150dpi 预览图**用本技能；要**投稿级出版图**（森林图/KM/火山图，300dpi+矢量）用 nature-figure。
---

# 数据分析技能

本项目自带一个已配置好的 Python 虚拟环境，装了科学计算包。**运行 Python 必须用这个解释器**，不要用系统 `python`（系统没装 Python）。

## 定位（本技能在套件中的位置）
顶层主控（AGENTS.md 常驻指令）负责判意图、定范围、派发；派到本技能就**直接做，别回绕**。产物直接写**当前工作目录**——网关已把本会话的 cwd 指到该会话的产物目录，用裸文件名即可（如 `table1.csv`），别再拼 `outputs/…` 前缀，也别写到仓库根。

## 解释器
```
${REPO_ROOT:-/app}/.venv/bin/python   # Windows（正斜杠写法，bash 与 PowerShell 都能用）
${REPO_ROOT:-/app}/.venv/bin/python
```
已安装：pandas、numpy、scipy、matplotlib、scikit-learn、seaborn、statsmodels、openpyxl，另有 lifelines（生存分析）等。

> 要出**出版级图表**（森林图/KM/火山图，300dpi + 矢量）时，改用 `nature-figure` 技能。

## 运行方式
把代码写到一个 `.py` 文件，再用 bash 执行：
```
${REPO_ROOT:-/app}/.venv/bin/python analysis.py
```

## 第一步：数据体检（拿到数据文件先跑，强制）
**别读进来就 groupby / 画图 / 做检验。** 先跑体检脚本——它专查你最容易漏、且一漏就全盘错的那几件事：
```
${REPO_ROOT:-/app}/.venv/bin/python ${REPO_ROOT:-/app}/.opencode/skills/data-analysis/scripts/data_profile.py \
  --input <数据文件> --group <分组变量列名> --id-col <患者/标本标识列> --out data_quality.md
```
产出 `data_quality.md`（人读，分 **必须处置 / 建议核对 / 记录备查** 三级 + "必须回答的问题"清单）与 `data_quality.json`（机读）。它查：
- **重复行 / 重复患者ID**（并单独点名"同号但数值不一致"的）——**最容易漏、后果最重**：重复没去掉，n 虚高，Table 1 的每个 n(%)、每个组间 p 全建在虚高分母上，且这种错在结果里毫无异常迹象、审稿人也看不出来，只有你自己去查才会发现。
- **数值列混进字符串**（检测限 `<0.05`/`>100`、单位后缀、区间值）——**严禁 `pd.to_numeric(errors="coerce")` 一把带过**：那会把它们静默变 NaN，样本量凭空缩水且不留痕。检测限值属**左/右删失**，要明确替代规则（LoD/2 或 LoD/√2）或改用删失方法，并写进 Methods；剔除也要报剔除例数。
- **分类水平的多种写法**（`男`/`M`/`1`/尾空格/全角）——不归一则分组数虚增、Table 1 每一行都错。
- **生理不可能值与哨兵值**（年龄 999、身高 1.72「米」、应非负变量出负值、9999/99999）、**量级异常**（单位混用 cm/m、mg/μg、g/L 与 mg/dL）。
- **缺失率**（≥15% 必须交代缺失机制与处理方式，配对分析要报实际进入分析的配对数）、**日期先后颠倒**（出院早于入院 → 由日期相减派生的住院天数/随访时间连带出错）、分组变量缺失、常量列、明显偏态（提示别默认 t 检验）。
- **自由文本列**（备注/说明）——**不作分析变量，但必须逐条读一遍**：单位、外送、溶血、复测这类决定"某例要不要换算或排除"的线索，通常只写在这里。

**闸：`必须处置` 项没处置完，不许进 Table 1 / 组间检验 / 建模。** 每一项要么按用户确认的方式处理、要么写成显式假设进报告与 Methods；处理过程记进 `cleaning_log.md`（每步：做了什么、影响几例、n 从多少变到多少）。
- **体检脚本只发现和量化问题、绝不改数据**：清洗由你另写脚本做，别指望它替你静默修数。
- **体检结果要向用户汇报**，别自己悄悄处理完就过去了——"同号不同值"、"生理不可能值"这类必须回原始病历核对，只有用户能定。
- 汇报时把"原始行数 → 去重后 → 排除后 = 分析 n"这条链说清楚，别只给最终 n。

## 第二步：先定分析计划，再动第一个检验（强制，落盘 `analysis_plan.md`）
体检清完、**动第一个检验之前**，先写下 3–5 行分析计划并**在汇报里说明**——因为等结果出来再回头分主次已经不可能了，那时每个"显著"看起来都像早就想看的：
- **主要终点**（**1 个，最多 2 个**）：用户真正问的那个问题。结论主干只能由它撑。
- **次要终点**：事先就想看的其他结局。
- **探索性**：看了数据才想到要看的、用户没点名的、亚组、事后排除某些病例后重算的、换定义/换界值重算的——**一律进这栏**。
- **多重比较归属**：主要终点 1 个不校正；次要终点 ≥3 个报 BH-FDR（或说明为何不校正）；**探索性一律标"未校正、需独立验证"**，不得当主要结论呈现。
- **这批数据能回答到什么程度**：回顾性数据只能出关联、不能出因果；界值/切点从本数据里挑出来的，报出的敏感度/特异度天然乐观，须写明"需独立样本验证"。

### 铁律：别把事后决定的分析说成预设
- **"预设 / 预先设定 / 预注册 / pre-specified / prespecified / a priori"这些词，只有在用户真提供了预注册号、或采数前的方案文件时才准写。** 你自己看过数据之后定的分析计划，写成 "a pre-specified sensitivity analysis" **就是编造研究过程**——这属于虚构，性质比选错检验严重得多，且审稿人一旦对上时间线就是撤稿级问题。
  正确写法：`分析计划在数据质量核查后确定，未做前瞻性预注册`（英文：`the analysis plan was fixed after data-quality review; no prospective pre-registration was performed`）。
- 分析中途换了主要终点、改了界值、排除了某些病例 → 在报告里写明**改了什么、为什么、原计划是什么**，别悄悄替换成新的。
- 排除部分病例后指标变好（AUC 升高、p 变显著）→ 必须写成"**乐观**的敏感性分析，而非更准确的估计"，并说明被排掉的是哪些病例、为什么排除会人为拔高该指标。
- 最终报告里**每条结论都要标明它出自主要 / 次要 / 探索性哪一栏**。

## 医学统计方法选择（护栏，动手前先对号入座）
非程序员医学用户最常被审稿人挑的就是"检验用错"。按数据类型选，别默认套 t 检验：
- **两组连续变量**：先看正态性（Shapiro–Wilk / QQ 图）与方差齐性 → 正态且齐 → 独立样本 t；否则 → Mann–Whitney U。配对设计 → 配对 t / Wilcoxon 符号秩。
- **≥3 组连续变量**：正态 → 单因素 ANOVA（+ 事后两两比较且校正）；非正态 → Kruskal–Wallis（+ Dunn 校正）。
- **分类变量**：卡方检验；**任一期望频数 <5 或总样本小 → Fisher 精确检验**；有序分类 → 趋势卡方 / Mann–Whitney。
- **多重比较必校正**：一次比多对/多终点 → Bonferroni（保守）或 Benjamini–Hochberg FDR（推荐用于多终点），别只报一堆未校正 p。
- **相关/回归**：连续 → Pearson（正态）/ Spearman（非正态或有序）；结局二分类 → logistic 回归报 OR+95%CI；计数 → 泊松/负二项。
- **生存数据**：Kaplan–Meier 画曲线 + log-rank 比较；多因素 → Cox 比例风险，**并检验 PH 假设**（Schoenfeld 残差）。用 `lifelines`（已装）。
- **诊断试验**：报敏感度/特异度/PPV/NPV/LR + ROC-AUC（含 95%CI），别只报准确率。**CI 怎么算**：AUC 用 **DeLong**（解析）或 bootstrap；敏感度/特异度/PPV/NPV 这类比例用 **Wilson**（小样本/极端比例比正态近似稳）——`sklearn.roc_auc_score` 不给 CI，别省略也别凭空编，直接用 `scripts/stat_extras.py` 的 `delong_auc_ci` / `bootstrap_auc_ci` / `wilson_ci`。
- **方法比对 / 一致性（实验室方法学、新旧仪器）**：**判两方法一致性禁用相关系数 / 普通 OLS 回归**——高相关≠一致（Bland & Altman 的核心论点），且 x 有测量误差会使 OLS 斜率系统性衰减。正确做法：① **Bland-Altman**（偏倚 bias、95% 一致性界限 LoA=bias±1.96·SD、LoA 自身 CI、比例偏倚检验）；② **Passing-Bablok**（非参数稳健回归，斜率 CI 含 1 且截距 CI 含 0 → 无系统/比例偏差）或已知测量误差方差比时用 **Deming**（`deming(x,y,lambda_ratio)` 的 `lambda_ratio=σ²_ε(y)/σ²_ε(x)`，即 y 误差方差÷x 误差方差；λ=1=两方法误差相当，最常用）。直接调 `scripts/stat_extras.py` 的 `bland_altman` / `passing_bablok` / `deming`（已对照已知构造核验，勿手写 PB 易错）。
- **Meta 分析（系统综述定量合并）**：**用 `scripts/stat_extras.py` 的 `meta_pool(effects, ses=...)`**（逆方差固定/随机 + DerSimonian-Laird，**已内置零异质性钳制**：I²=max(0,·)×100、τ²=max(0,·)、Q≤df 时随机效应塌回固定效应）。⚠️ **别直接用 `statsmodels.combine_effects` 的 `.i2/.tau2` 报数**——低/零异质时它给负 I²/负 τ²、且随机 SE<固定 SE（数学上不可能），`.i2` 还是分数不是百分比。森林图用 `nature-figure/clinical_plots.py` 的 `make_forest`。⚠️ **Egger 发表偏倚检验/漏斗图不对称、REML、网络 Meta/多水平无内置**——需手写加权回归或用 R `metafor`；**别声称能做其实做不了的**。系统综述全流程(筛选/RoB/GRADE/PRISMA)走 `systematic-review` 技能。

## 报告规范（写进结论）
> **交付统计结论 / 写 Methods/Results 前，逐条过 [references/stat-reporting-checklist.md](references/stat-reporting-checklist.md)（顶刊统计报告清单，强制）。** 下面是要点，细则与格式看清单。
- 始终报**效应量 + 95% 置信区间 + 精确 p 值 + 样本量 n**，不要只写 `p<0.05`（95%CI 优先于单独 p）。**效应量怎么算**：两组均值差用 **Cohen's d / Hedges' g**（小样本用 g）、相关用 **Pearson r 的 Fisher-z 95%CI**——scipy 不直接给，用 `scripts/stat_extras.py` 的 `cohens_d` / `hedges_g` / `pearson_r_ci`。
> **固化实现 `scripts/stat_extras.py`**（只依赖 numpy/scipy/sklearn）：方法比对(Bland-Altman/Passing-Bablok/Deming)、诊断 CI(DeLong/bootstrap AUC、Wilson 比例)、效应量(Cohen's d/Hedges' g/Pearson r-CI)。这些库不直接给或手写易错，**优先 import 调用、别每次现写**。跑 `python scripts/stat_extras.py` 可看自检（已知构造能否还原）。
- **任何 n 都只能取自代码输出**：样本量、分组例数及结论里出现的每一个 n，一律来自脚本打印结果（`df.shape`、`df.groupby(组变量).size()`、`value_counts()`），**禁止目测 / 手数 / 按数据文件行数推断**（文件行数含表头，直接用会多算 1 例）。写进结论、报告或交给下游技能（write-paper / render-*）的 n 必须与脚本打印值逐一一致；发现不一致以脚本输出为准，重跑核对后再成文。
- **每个主要结果再补一句临床解读**：效应量+CI 只说"差多少、多准"，不说"这点差别临床上算不算事"。**用 MCID / 允许总误差 TEa 判定时必须同时给出处**（文献/指南/说明书/用户提供的科室标准）；**给不出出处就不准写具体阈值数字**，也不准用"通常认为""常用参照约"这类无主语口吻把凭空的数包装成共识——照实写"本次未获得可引用的阈值来源，仅报效应量与 95%CI，临床重要性由临床团队判断"，只描述幅度、不下判决。⚠️ 别拿"CI 宽 / 下限贴近 1 / 精度有限"顶替临床意义——那是估计有多准，不是值不值得改变临床决策；`Hedges' g=0.9（大效应）`同理，是统计学分级不是临床重要性。细则见清单 §一之二。
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
- **中文图别自己乱设字体**：运行环境已配好系统级 matplotlibrc 兜底，默认就能出中文，通常**什么都不用设**。
  确实要在代码里显式设字体时，**只能**用下面这一行（`font.family` 多族列表，逐字一致）：
  ```python
  plt.rcParams["font.family"] = ["Liberation Sans", "DejaVu Sans", "WenQuanYi Zen Hei", "Noto Sans CJK JP"]
  ```
  多族列表是 matplotlib **唯一**会逐字形回退的写法：拉丁取 Liberation Sans/DejaVu，中文取 WenQuanYi Zen Hei，两头都对。
  （`Liberation Sans` 与 Arial 度量兼容；**别把 `Arial` 加回链里**——镜像未装它，每图会刷 41 行 `Font family 'Arial' not found`
  假错误而渲染结果完全相同。期刊若坚持字面 Arial，须装 msttcorefonts 后插到链首。）
  **禁止**写成 `font.family = "sans-serif"` + `font.sans-serif = [...]` —— 那条路径只取第一个能解析的字体、
  不再往后找，中文必豆腐块（实测 28 条缺字警告）。
  **禁止**设 `axes.unicode_minus = False` —— 上面这条链里负号 U+2212 由 DejaVu 提供、排版正确，设 False 反而降级成连字符。
  **禁止**请求 `SimHei`、`Microsoft YaHei`、`微软雅黑`、`黑体`、`Noto Sans CJK SC` —— 这些在 Linux 服务器上
  **均不存在**，matplotlib 会静默回退 DejaVu Sans，中文全变豆腐块（本地 Windows 能看到、服务器上必坏）。
- 分析完，用一段话向用户总结关键结论（带效应量+CI+p+n）+ 列出生成的文件路径。
