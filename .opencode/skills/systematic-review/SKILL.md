---
name: systematic-review
description: 系统综述/Meta 分析的**方法学全流程**（区别于叙述性综述）：预注册(PROSPERO)→系统检索(PICO+PRESS)→去重→双人独立筛选+κ→偏倚风险评估(RoB2/ROBINS-I/NOS 等按设计选)→数据提取(含效应量换算)→GRADE 分级→PRISMA 2020 流程图计数；带审计链与确定性脚本。当用户说"做系统综述""Meta 分析""PRISMA""偏倚风险/RoB""GRADE""PROSPERO"时使用。边界：叙述性综述用 literature-review；把 SR 结果写成投稿稿用 write-paper；只做一次统计合并用 data-analysis。
---

# 系统综述 / Meta 分析（方法学流程）

> **决策规约（照 AGENTS.md §六）**：本技能任何要用户拍板的抉择——方向 / 方案 / 目标刊 / 作图后端 / 纳排标准 / 下一步等——一律**在正文里列 2–4 个编号候选**（推荐项放第 1 个并写明“推荐 X，因为……”），让用户**回一个数字即推进**；**别用开放式提问逼用户打字，也别弹交互选项卡（如 AskUserQuestion）**。只有无法枚举的纯事实（手上的数据文件、伦理批号、代表作清单等）才开放式问。

系统综述与叙述性综述的**分水岭**：有预注册、双人独立裁决、量化偏倚与证据质控、可复现的检索与计数。本技能以**确定性脚本为骨、方法学规则为肉**——脚本负责去重/计数/κ（零 LLM、可审计），规则负责筛选/RoB/GRADE/提取的人类裁决标准。

> **绝不用一次 LLM pass 当最终筛选决定**。筛选必须双人独立 + 冲突人工消解；协议必须在筛文献前注册；PRISMA 流程图是硬性产出。缺的真实信息（纳排、注册号、评审者）向用户要，不替编。

## 定位（本技能在套件中的位置）
顶层主控（AGENTS.md 常驻指令）判意图、定范围、派发；派到本技能就**直接做，别回绕**。本技能是 systematic 流水线的方法学环节（**本技能八步** → write-paper 成文 → reference-check → render-docx）；单独直呼（只对这批文献双人筛选/去重、只做一次 RoB2/GRADE）也直接做那一步。产物直接写**当前工作目录**——网关已把本会话的 cwd 指到该会话的产物目录，用裸文件名即可（如 `table1.csv`），别再拼 `outputs/…` 前缀，也别写到仓库根。

## Python 环境（脚本用，纯标准库，无需额外依赖）
> **报「找不到 `.venv` / 缺 Python」先查命令里的引号**：安装目录含空格（`.../Niuma Science/bundle/app`），路径不加引号会被 bash 从空格处切断、报 `No such file or directory`——**那不是缺环境**。Python 环境随安装包/镜像装好，**不要重建 `.venv`、也不要重装依赖**（白烧十几分钟还可能弄坏包版本）；确认解释器真的不存在时，才在仓库根跑 `install.ps1`（Windows）/ `install.sh`。
```
"${REPO_ROOT:-/app}/.venv/bin/python"
```

## 全流程（八步）

### 0. 先对齐（停下问用户；能选的照 AGENTS.md §六 给编号选项、回一个数字即定，如综述类型 1) 干预 2) 诊断 3) 预后 4) 患病率）
研究问题（PICO/PECO）、综述类型（干预/诊断/预后/患病率）、是否已有 PROSPERO 注册、有几位评审者、目标数据库、语言范围、时间窗。写清纳入/排除标准（这决定后面每一步）。

### 1. 预注册协议（筛文献前，必做）
按 PROSPERO 字段清单备好协议、去 PROSPERO 注册、回填真实注册号。字段清单见 [references/protocol-extraction.md](references/protocol-extraction.md)。⚠️ **注册在筛选之前**，否则丧失系统综述的核心信誉；与 `novelty-check` 的预注册锁同源（防事后改纳排）。

### 2. 系统检索（可复现是硬指标）
按 **PICO 概念表**建检索式（每概念 MeSH + 自由词，概念内 OR、概念间 AND）、按综述类型定敏感度目标、过 **PRESS 6 项**同行评议自查、用 **PRISMA-S** 记录检索。详见 [references/search-and-screen.md](references/search-and-screen.md)。检索执行走 `literature-review` 的 `search.py`（Europe PMC 国内可达）/`search-lit`（PubMed 系）；各库导出（.nbib/.ris/.bib/.csv）放进一个 `imported/` 文件夹。

### 3. 去重（identification 阶段）
```bash
PY="${REPO_ROOT:-/app}/.venv/bin/python"   # Linux/mac: "${REPO_ROOT:-/app}/.venv/bin/python"
SR="${REPO_ROOT:-/app}/.opencode/skills/systematic-review/scripts"
"$PY" "$SR"/sr_dedup.py --input imported/ --output 01_deduplicated.csv --counts counts/identification.json
```
纯确定性三段去重（DOI 精确 → 标题精确 → 同年 difflib 模糊，阈值 `--fuzzy` 默认 0.92）。**保留每条记录可审计**：被删记录的 `dup_of` 指向合并到的 canonical 记录。产出去重 CSV + identification 计数。

### 4. 双人独立筛选 + κ（screening 阶段）
两位评审者**各自独立**判定，再消解冲突。
> ⚠️ **两列判定必须真的独立产生**，不能一次判完复制成两列。`sr_prisma_count.py` 会检测：
> **n≥20 且两列逐行完全一致（零分歧）时拒绝报出 κ**，并给出可直接照抄的如实措辞
> （`... was performed by a single reviewer; inter-rater reliability was therefore not assessed.`）。
> 实测出现过硬编码 include 名单、把同一判定赋值给两列 → κ=1.000 被写进 PRISMA 图与稿件 Methods，
> Methods 还写了「Discrepancies were resolved by discussion」——没有第二个人时，那是**虚假方法学陈述**。
> 报不出 κ 只是少一个数；报一个假的 κ 是学术不端。
筛选 CSV 的列规范（喂给计数脚本）见 [references/search-and-screen.md](references/search-and-screen.md)：`reviewer1_decision / reviewer2_decision / consensus_decision / conflict`（全文阶段另加 `pdf_retrieved / exclusion_reason_category`）。**不确定 → 纳入**（保守，留到下一阶段再看）。全文获取用 `fulltext-retrieval`。

### 5. PRISMA 计数 + 一致性校验
```bash
"$PY" "$SR"/sr_prisma_count.py --identification counts/identification.json \
   --ta 02_title_abstract_screen.csv --ft 03_fulltext_screen.csv \
   --output counts/prisma-summary.md
```
自动算出流程图每个框的数字 + 每阶段 **Cohen's κ**（附一致性等级）+ **8 条内部自洽校验**（如 排除+纳入=评估数）。任一校验 FAIL 会退出码 1、提示回去核数。
同时落一份机读 `counts/prisma-summary.json`，供下一步画图 —— 计数只有这一个源头，别再数第二遍。

### 5b. PRISMA 2020 流程图（**用脚本，不要自己写 matplotlib**）
```bash
"$PY" "$SR"/sr_prisma_flow.py --counts counts/prisma-summary.json \
   --out prisma_flow.png --also-svg --also-pdf
```
版式已固定，数字直接读上一步的 JSON。未跑全文筛选阶段时只画到「寻求获取全文的报告」，不臆造后半程。

> ⚠️ **别再现搓画图脚本**。此前本技能没有画图脚本，每次都由模型临时写一段 matplotlib，
> 实测出来的图：右侧「去除重复记录」与「(n = 5)」两个框**叠印在一起**、数字完全读不出；
> 主干箭头从三个方框的**文字中间穿过去**；最后两步之间**没有连接箭头**。
> 更要紧的是——**当前部署的模型没有图像输入能力**（它自己会说 "I can't visually inspect the PNG"），
> 也就是"画完看一眼"这条兜底根本不存在，坏版式会一路带到投稿件里。版式必须是代码，不是每次的手艺。
> 需要改样式就改 `sr_prisma_flow.py`，让所有人一起受益。

### 6. 偏倚风险评估（RoB）
按研究设计选工具（RCT→RoB2、非随机干预→ROBINS-I、观察性→NOS、诊断→QUADAS-2、患病率→JBI），逐 domain 回答 signaling questions（Y/PY/PN/N/NI）→ 按决策算法给 domain 判定 → 汇总总体偏倚。完整规则见 [references/rob-grade.md](references/rob-grade.md)。偏倚图（traffic-light / summary）交 `nature-figure`。

### 7. 数据提取 + Meta 合并（如做定量合并）
按预定义 schema 提取；缺数据联系作者；

**提取完必跑数值回查**（`sr_verify_extraction.py`）——提取表里每个数字都要能在来源文本里找到：
```bash
"$PY" "$SR"/sr_verify_extraction.py --extraction extraction_table.csv \
   --records 01_deduplicated.csv --computed-cols se,weight,log_hr \
   --output extraction_verify.md          # 有全文再加 --fulltext-dir pdfs/
```
找不到出处的逐条列出、退出码 1。**这是待核信号不是造假结论**：算出来的列（SE、权重、合并效应量）
本就不在原文里，用 `--computed-cols` 排除；剩下的必须回原文核对或说明来源，**不得直接写进稿件**。
> 实测：8 篇纳入研究里 **4 篇的样本量在摘要中查无此数**（提取表写 36241，摘要写的是 16,676），
> 而那一轮**一篇全文都没下过**——这些数只能来自记忆。同批的 HR/CI 反而全准确，
> 错的只有样本量，因此更隐蔽，且它直接决定读者对证据分量的第一眼判断。

需要时用 [references/protocol-extraction.md](references/protocol-extraction.md) 的**效应量换算公式**（如 中位数[IQR]→均值±SD、SE↔SD、OR↔RR）统一口径。

**Meta 统计合并——用 `data-analysis/scripts/stat_extras.py` 的 `meta_pool(effects, ses=...)`**（固定/随机效应逆方差 + DerSimonian-Laird，**已内置零异质性钳制**）：
```python
import sys; sys.path.insert(0, "<repo>/.opencode/skills/data-analysis/scripts")
from stat_extras import meta_pool
r = meta_pool(log_or_list, ses=se_list)   # 效应量用 logOR/logHR/MD；返回 fixed/random_effect、Q、I2(%)、tau2、weights
```
⚠️ **别直接调 `statsmodels.combine_effects` 的 `.i2/.tau2` 报数**：它在 Q≤df（低/零异质，最常见情形）时给出**负 I²、负 τ²、且随机效应 SE 比固定效应还小**的非法结果，`.i2` 还是分数不是百分比。`meta_pool` 已把 I²=max(0,·)×100、τ²=max(0,·)、Q≤df 时随机效应塌回固定效应——直接用它。森林图用 `nature-figure/scripts/clinical_plots.py` 的 `make_forest`（合并菱形 + 权重方块）。
⚠️ **发表偏倚 Egger 检验/漏斗图不对称、REML、网络 Meta/多水平/剂量-反应 statsmodels/meta_pool 均无内置**——研究数够(≥10)时手写加权回归或用 R `metafor`/`netmeta`，**如实告知用户哪些走 Python、哪些需 R，别声称能做其实做不了的**。

### 8. GRADE 证据分级
对每个主要结局，从五个降级域（偏倚风险/不一致性/间接性/不精确性/发表偏倚）起评，观察性研究可用三个升级因素（大效应/剂量反应/混杂方向）→ 得 high/moderate/low/very low。规则与打分表见 [references/rob-grade.md](references/rob-grade.md)。产出证据概要表（Summary of Findings）。

## 交付与衔接
- 产物直接写**当前工作目录**、用裸文件名（去重 CSV、筛选 CSV、PRISMA 计数、RoB 表、提取表、GRADE SoF 表）。
  子目录可以用（如 `counts/`、`figures/`），但**别拼 `outputs/` 前缀** —— 会写成 `outputs/<会话id>/outputs/…`，而界面「产出」侧栏只递归一层，用户什么都看不到。
- **写成投稿稿**交 `write-paper`（走其报告规范自检的 PRISMA 2020，含流程图硬性产出）；参考文献查 `reference-check`；出 PDF/Word 走 `render-pdf-doc`/`render-docx`。
- 完整目标时按 AGENTS.md 的 `systematic` 流水线顺序走：本技能方法学八步 → write-paper 成文 → reference-check → render-docx。
- 中文报告出图/排版记得指定中文字体。

## 硬约束
- **协议先注册后筛选**；**双人独立筛选**（不得单次 LLM pass 定稿，脚本会检测零分歧并拒绝报 κ）；**PRISMA 流程图必出**。
- **没下全文就不是全文筛选**：一篇 PDF 都没获取时，`pdf_retrieved` 不得填 Y，PRISMA 必须如实印
  `Abstract-level screening`、差额计入 `Reports not retrieved`。`sr_prisma_count.py` 会拿声称数
  与目录里真实的 PDF 数对账（数文件系统，改 CSV 绕不过去）。**绝不要为了让校验从 FAIL 变 PASS 而改数据。**
- **提取表里的每个数字都要有出处**：跑 `sr_verify_extraction.py` 回查；查无此数的一律标「待核」，
  不得凭记忆填写（尤其样本量——它最容易被当成背景信息随手写下，却是读者判断证据分量的第一眼指标）。
- 去重/计数用脚本（可复现、可审计），别手数；κ 低时说明并加强培训/校准后重筛。
- 不虚构注册号、纳入研究、提取数据、偏倚判定；缺就标"待补充"或"待人工复核"。
- GRADE/RoB 判定是**人类方法学裁决**，脚本与规则只是辅助；关键降级/升级要有据可依。
