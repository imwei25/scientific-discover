---
name: clinical-stats
description: 临床研究常用统计——基线特征表(Table 1) 与 样本量/把握度计算。生成论文第一张表 Table 1（分组基线，按变量类型自动选 均数±SD/中位数[IQR]/n(%) 与组间检验），以及研究设计/伦理/标书要的样本量估算（两组均数、两组率、生存、单组）。当用户说"做个 Table 1""基线特征表""三线表基线""算样本量""把握度/power""要多少例""sample size""这个研究需要多少患者"时使用。通用统计分析用 data-analysis，出版级图用 nature-figure。
---

# 临床统计技能：Table 1 + 样本量

面向临床科研的两个高频、易错刚需：**基线特征表**（几乎每篇临床论文的表 1）和**样本量估算**（伦理审查、标书、投稿都要）。脚本只用已装的 pandas/scipy/statsmodels，无需额外依赖。

## 定位（本技能在套件中的位置）
顶层主控（AGENTS.md 常驻指令）负责判意图、定范围、派发；派到本技能就**直接做，别回绕**。产物写 `outputs/`（主控注入了会话专属目录 `outputs/<会话id>/` 时以它为准、勿写仓库根固定名——多用户共享会 clobber）。

## Python 环境
> 没有项目根 `.venv`？先运行 `env-setup` 技能。
```
.venv/Scripts/python.exe   # Windows
.venv/bin/python           # Linux / macOS
```

## 一、Table 1 基线特征表
按变量类型**自动选择**呈现与检验（连续变量先做 Shapiro 正态性判断）：
- 连续+正态 → `均数±标准差` + t 检验(两组)/ANOVA(多组)
- 连续+非正态 → `中位数[IQR]` + Mann-Whitney(两组)/Kruskal-Wallis(多组)
- 分类 → `n (%)` + 卡方；2×2 且期望频数 <5 → Fisher 精确检验

```bash
# 自动推断变量类型（数值且取值多→连续，其余→分类）
SCI_OUTPUT_DIR=outputs/<会话id> .venv/bin/python .opencode/skills/clinical-stats/scripts/table1.py \
  --input uploads/data.csv --group arm --out outputs/table1.csv

# 显式指定变量类型（更稳）
SCI_OUTPUT_DIR=outputs/<会话id> .venv/bin/python .opencode/skills/clinical-stats/scripts/table1.py \
  --input uploads/data.csv --group arm \
  --continuous age,bmi,sbp --categorical sex,smoker --out outputs/table1.csv
```
产出 `outputs/table1.csv`（含各组数值 + P 值 + 所用检验列），可直接贴进论文或交 `render-docx`/`render-pdf-doc` 排版。
**恰好两组时额外输出 `效应量(95%CI)` 列**（顶刊要求，别只给 p）：连续正态→均值差(95%CI, Welch)；连续非正态→中位数差(95%CI, bootstrap)；二分类 2 水平→OR(95%CI, 必要时 Haldane 校正)。方向见脚本打印的说明（均值差/中位数差=首组−次组）。
> ⚠️ **RCT 基线表 Table 1 不放组间 p 值**（随机化后组间差异按定义即偶然，报 p 概念上错误）——RCT 场景生成时去掉 `--group` 或只保留描述列。观察性研究才需要组间比较。
> 写进论文前统计报告格式过一遍 [../data-analysis/references/stat-reporting-checklist.md](../data-analysis/references/stat-reporting-checklist.md)。

## 二、样本量 / 把握度
**研究开展前的先验估算**（伦理/标书用）。参数（差值、SD、率、HR）应来自预实验或既往文献。
```bash
S=".opencode/skills/clinical-stats/scripts/samplesize.py"
# 两组均数（连续结局）：预期差 6，SD 10
.venv/bin/python $S two-means --diff 6 --sd 10 --power 0.8 --dropout 0.1
# 两组率（二分类结局）：30% vs 15%
.venv/bin/python $S two-props --p1 0.30 --p2 0.15 --power 0.8
# 生存（log-rank，Freedman 近似）：HR 0.7，总体事件比例 0.5
.venv/bin/python $S survival --hr 0.7 --p-event 0.5 --power 0.8
# 单组对比已知值
.venv/bin/python $S one-mean --diff 5 --sd 12
```
`--dropout` 按预计脱落率上调样本量；`--ratio` 设非 1:1 分配。

## 硬约束与诚实边界
- ⚠️ **不要做事后功效分析 (post-hoc power)**：本工具用于**设计阶段的先验估算**。研究已完成后，用观察到的效应量倒推 power 在方法学上被认为无意义甚至误导——已完成研究应报效应量+95%CI，而不是补算 power（与 `write-paper`/`data-analysis` 口径一致）。
- **只支持双侧优效性设计**：样本量按双侧 α 算。**非劣效/等效/单侧设计不能直接套用**（它们要非劣效界值 δ、单侧 z 值、TOST 等），请用 R `pwr`/`TrialSize` 或专业软件。
- **两组率用标准正态近似（Fleiss）**：比例接近 0 或 1 时（罕见事件/高有效率）会打印警告，建议用 R `pwr`/精确法复核。生存样本量是 Freedman 近似、未建模随访时间/删失，关键研究用 R `gsDesign`/`powerSurvEpi` 复核。
- **Table 1 的自动检验只是起点**：正态性**逐组判断**后选参数/非参数；但**配对/重复测量、协变量调整、分层、竞争风险**需人工另做。**≥3 组只给总体 p，不含事后两两比较**（需要请另跑 Tukey/Dunn/Bonferroni）。RxC 表期望频数<5 时会在"检验"列标 `卡方⚠期望<5`（scipy 无 Fisher-Freeman-Halton，提示你合并类别或改用 R 精确检验）。
- **样本量参数要真实**：差值/SD/率/HR 应来自预实验或文献，别凭空取值凑一个好看的样本量。
- 复杂建模（Cox、logistic、倾向评分、诊断试验 ROC/AUC）用 `data-analysis`；本技能聚焦 Table 1 与样本量这两件最高频的事。
- （可选增强，暂未内置）大样本基线均衡建议看**标准化差值 SMD** 而非 p 值——如需可用 `data-analysis` 计算。
