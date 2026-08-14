---
name: clinical-stats
description: 临床研究两个高频刚需——基线特征表(Table 1)与样本量/把握度计算。Table 1 按变量类型自动选呈现与检验（均数±SD / 中位数[IQR] / n(%)，两组并出效应量95%CI 与 SMD）；样本量覆盖两组均数、两组率、生存、单组。当用户说"做个 Table 1""基线特征表""SMD""算样本量""把握度/power""要多少例"时使用。通用统计分析用 data-analysis，出版级图用 nature-figure。
---

# 临床统计技能：Table 1 + 样本量

面向临床科研的两个高频、易错刚需：**基线特征表**（几乎每篇临床论文的表 1）和**样本量估算**（伦理审查、标书、投稿都要）。脚本只用已装的 pandas/scipy/statsmodels，无需额外依赖。

## 定位（本技能在套件中的位置）
顶层主控（AGENTS.md 常驻指令）负责判意图、定范围、派发；派到本技能就**直接做，别回绕**。产物直接写**当前工作目录**——网关已把本会话的 cwd 指到该会话的产物目录，用裸文件名即可（如 `table1.csv`），别再拼 `outputs/…` 前缀，也别写到仓库根。

## Python 环境
> **报「找不到 `.venv` / 缺 Python」先查命令里的引号**：安装目录含空格（`.../Niuma Science/bundle/app`），路径不加引号会被 bash 从空格处切断、报 `No such file or directory`——**那不是缺环境**。Python 环境随安装包/镜像装好，**不要重建 `.venv`、也不要重装依赖**（白烧十几分钟还可能弄坏包版本）；确认解释器真的不存在时，才在仓库根跑 `install.ps1`（Windows）/ `install.sh`。
```
"${REPO_ROOT:-/app}/.venv/bin/python"
```

## 一、Table 1 基线特征表
> ⚠️ **先跑数据体检再出 Table 1**（`data-analysis/scripts/data_profile.py --input <文件> --group <分组列>`，用法见 [../data-analysis/SKILL.md](../data-analysis/SKILL.md) §第一步）。**重复患者ID 没去掉、分类水平（男/M/1/尾空格）没归一、分组变量有缺失时，Table 1 的每一个 n(%) 与每个组间 p 都是错的**，而这种错在表里看不出异常。体检的"必须处置"项清完、`cleaning_log.md` 记好，再跑 `table1.py`。

按变量类型**自动选择**呈现与检验（连续变量先做 Shapiro 正态性判断）：
- 连续+正态 → `均数±标准差` + t 检验(两组)/ANOVA(多组)
- 连续+非正态 → `中位数[IQR]` + Mann-Whitney(两组)/Kruskal-Wallis(多组)
- 分类 → `n (%)` + **未校正 Pearson 卡方**（与 R tableone/SAS 默认口径一致，便于读者复核；旧版 scipy 默认对 2×2 加 Yates 会对不上）；2×2 且期望频数 <5 → Fisher 精确检验

**自动推断会跳过这几类列**（跳了会在 stdout 逐条打印哪列、为什么）：列名像标识列的（`患者ID` / `住院号` / `编号` / `case_no`…）、日期时间列（原始日期不是基线特征，先派生成年龄 / 住院天数 / 随访时长）、几乎每行一个取值的、以及 >20 个不同取值的文本列。**这不是可有可无的清洁工作**：不跳的话表里会多出「住院号 3841029.4±221.7」这样一行，或者备注列铺开两百行 n(%)——每一行看起来都很正常（有均值、有 p 值），错得毫无异常迹象。要强行纳入某列就用 `--continuous` / `--categorical` **显式指定**（显式指定的一律照做，不跳），要额外排除几列用 `--exclude a,b`。**跳过清单要转述给用户**——万一它把真变量当标识列跳了，只有用户看得出来。

```bash
# 自动推断变量类型（数值且取值多→连续，其余→分类；标识列/日期列/自由文本自动跳过并打印）
"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/clinical-stats/scripts/table1.py" \
  --input uploads/data.csv --group arm --out table1.csv

# 显式指定变量类型（更稳）
"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/clinical-stats/scripts/table1.py" \
  --input uploads/data.csv --group arm \
  --continuous age,bmi,sbp --categorical sex,smoker --out table1.csv
```
产出 `outputs/table1.csv`（含各组数值 + P 值 + 所用检验列），可直接贴进论文或交 `render-docx`/`render-pdf-doc` 排版。
**恰好两组时额外输出 `效应量(95%CI)` 与 `SMD` 两列**（顶刊要求，别只给 p）：
- 效应量：连续正态→均值差(95%CI, Welch)；连续非正态→中位数差(95%CI, bootstrap)；二分类 2 水平→OR(95%CI, 必要时 Haldane 校正)。方向=首组−次组。
- **SMD（标准化差异）**：连续用 Cohen's d 式 `(m1−m2)/√((s1²+s2²)/2)`；分类（含多水平）用 Yang & Dalton 向量式（与 R `tableone` 口径一致）。**倾向评分匹配/观察性研究看组间均衡性**常要它：|SMD|>0.1 通常提示该协变量不均衡（不依赖样本量，比 p 值更适合看均衡）。
> ⚠️ **RCT 基线表 Table 1 不放组间 p 值**（随机化后组间差异按定义即偶然，报 p 概念上错误）——RCT 场景生成时去掉 `--group` 或只保留描述列。观察性研究才需要组间比较。
> 写进论文前统计报告格式过一遍 [../data-analysis/references/stat-reporting-checklist.md](../data-analysis/references/stat-reporting-checklist.md)。

## 二、样本量 / 把握度
**研究开展前的先验估算**（伦理/标书用）。参数（差值、SD、率、HR）应来自预实验或既往文献。
```bash
S="${REPO_ROOT:-/app}/.opencode/skills/clinical-stats/scripts/samplesize.py"
# 两组均数（连续结局）：预期差 6，SD 10
"${REPO_ROOT:-/app}/.venv/bin/python" "$S" two-means --diff 6 --sd 10 --power 0.8 --dropout 0.1
# 两组率（二分类结局）：30% vs 15%
"${REPO_ROOT:-/app}/.venv/bin/python" "$S" two-props --p1 0.30 --p2 0.15 --power 0.8
# 生存（log-rank，Freedman 近似）：HR 0.7，总体事件比例 0.5
"${REPO_ROOT:-/app}/.venv/bin/python" "$S" survival --hr 0.7 --p-event 0.5 --power 0.8
# 单组对比已知值
"${REPO_ROOT:-/app}/.venv/bin/python" "$S" one-mean --diff 5 --sd 12
```
`--dropout` 按预计脱落率上调样本量；`--ratio` 设非 1:1 分配。

## 硬约束与诚实边界
- ⚠️ **不要做事后功效分析 (post-hoc power)**：本工具用于**设计阶段的先验估算**。研究已完成后，用观察到的效应量倒推 power 在方法学上被认为无意义甚至误导——已完成研究应报效应量+95%CI，而不是补算 power（与 `write-paper`/`data-analysis` 口径一致）。
- **只支持双侧优效性设计**：样本量按双侧 α 算。**非劣效/等效/单侧设计不能直接套用**（它们要非劣效界值 δ、单侧 z 值、TOST 等），请用 R `pwr`/`TrialSize` 或专业软件。
- **两组率用标准正态近似（Fleiss）**：比例接近 0 或 1 时（罕见事件/高有效率）会打印警告，建议用 R `pwr`/精确法复核。生存样本量是 Freedman 近似、未建模随访时间/删失，关键研究用 R `gsDesign`/`powerSurvEpi` 复核。
- **Table 1 的自动检验只是起点**：正态性**逐组判断**后选参数/非参数；但**配对/重复测量、协变量调整、分层、竞争风险**需人工另做。**≥3 组只给总体 p，不含事后两两比较**（需要请另跑 Tukey/Dunn/Bonferroni）。RxC 表期望频数<5 时会在"检验"列标 `卡方⚠期望<5`（scipy 无 Fisher-Freeman-Halton，提示你合并类别或改用 R 精确检验）。
- **任何 n 都只能取自代码输出**：总例数、各组例数及正文里出现的每一个 n，一律来自脚本打印结果（`df.shape`、`df.groupby(组变量).size()`、`value_counts()`）或 `table1.py` 产出的"样本量 n"行，**禁止目测 / 手数 / 按数据文件行数推断**（文件行数含表头，直接用会多算 1 例）。向用户汇报或写进报告的 n 必须与脚本打印值逐一一致；发现不一致以脚本输出为准，重跑核对后再成文。
- **样本量参数要真实**：差值/SD/率/HR 应来自预实验或文献，别凭空取值凑一个好看的样本量。
- 复杂建模（Cox、logistic、倾向评分、诊断试验 ROC/AUC）用 `data-analysis`；本技能聚焦 Table 1 与样本量这两件最高频的事。
