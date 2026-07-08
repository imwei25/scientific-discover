---
name: systematic-review
description: 系统综述 / Meta 分析的**方法学全流程**（区别于叙述性综述）：预注册(PROSPERO) → 系统检索(PICO 概念表 + PRESS 自查) → 去重 → **双人独立筛选 + κ 一致性** → 偏倚风险评估(RoB2/ROBINS-I/NOS/QUADAS-2/JBI) → 数据提取(含效应量换算) → **GRADE 证据分级** → PRISMA 2020 流程图计数。带审计链、量化质控、确定性脚本。当用户说"做系统综述""系统评价""Meta 分析""PRISMA""双人筛选""偏倚风险/RoB""GRADE 分级""PROSPERO 注册""森林图合并"时使用。边界：**叙述性综述**（不需双人筛选/RoB/GRADE）用 literature-review；把 SR 结果**写成投稿稿**用 write-paper（其报告规范自检含 PRISMA 2020）；只做一次统计合并用 data-analysis。
---

# 系统综述 / Meta 分析（方法学流程）

系统综述与叙述性综述的**分水岭**：有预注册、双人独立裁决、量化偏倚与证据质控、可复现的检索与计数。本技能以**确定性脚本为骨、方法学规则为肉**——脚本负责去重/计数/κ（零 LLM、可审计），规则负责筛选/RoB/GRADE/提取的人类裁决标准。

> **绝不用一次 LLM pass 当最终筛选决定**。筛选必须双人独立 + 冲突人工消解；协议必须在筛文献前注册；PRISMA 流程图是硬性产出。缺的真实信息（纳排、注册号、评审者）向用户要，不替编。

## Python 环境（脚本用，纯标准库，无需额外依赖）
> 没有项目根 `.venv`？先运行 `env-setup` 技能。
```
.venv/Scripts/python.exe   # Windows
.venv/bin/python           # Linux / macOS
```

## 全流程（八步）

### 0. 先对齐（停下问用户）
研究问题（PICO/PECO）、综述类型（干预/诊断/预后/患病率）、是否已有 PROSPERO 注册、有几位评审者、目标数据库、语言范围、时间窗。写清纳入/排除标准（这决定后面每一步）。

### 1. 预注册协议（筛文献前，必做）
按 PROSPERO 字段清单备好协议、去 PROSPERO 注册、回填真实注册号。字段清单见 [references/protocol-extraction.md](references/protocol-extraction.md)。⚠️ **注册在筛选之前**，否则丧失系统综述的核心信誉；与 `research-design` 的预注册锁同源（防事后改纳排）。

### 2. 系统检索（可复现是硬指标）
按 **PICO 概念表**建检索式（每概念 MeSH + 自由词，概念内 OR、概念间 AND）、按综述类型定敏感度目标、过 **PRESS 6 项**同行评议自查、用 **PRISMA-S** 记录检索。详见 [references/search-and-screen.md](references/search-and-screen.md)。检索执行走 `literature-review` 的 `search.py`（Europe PMC 国内可达）/`search-lit`（PubMed 系）；各库导出（.nbib/.ris/.bib/.csv）放进一个 `imported/` 文件夹。

### 3. 去重（identification 阶段）
```bash
PY=.venv/Scripts/python.exe   # Linux/mac: .venv/bin/python
SR=.opencode/skills/systematic-review/scripts
$PY $SR/sr_dedup.py --input imported/ --output outputs/01_deduplicated.csv --counts outputs/counts/identification.json
```
纯确定性三段去重（DOI 精确 → 标题精确 → 同年 difflib 模糊，阈值 `--fuzzy` 默认 0.92）。**保留每条记录可审计**：被删记录的 `dup_of` 指向合并到的 canonical 记录。产出去重 CSV + identification 计数。

### 4. 双人独立筛选 + κ（screening 阶段）
两位评审者**各自独立**判定，再消解冲突。筛选 CSV 的列规范（喂给计数脚本）见 [references/search-and-screen.md](references/search-and-screen.md)：`reviewer1_decision / reviewer2_decision / consensus_decision / conflict`（全文阶段另加 `pdf_retrieved / exclusion_reason_category`）。**不确定 → 纳入**（保守，留到下一阶段再看）。全文获取用 `fulltext-retrieval`。

### 5. PRISMA 计数 + 一致性校验
```bash
$PY $SR/sr_prisma_count.py --identification outputs/counts/identification.json \
   --ta outputs/02_title_abstract_screen.csv --ft outputs/03_fulltext_screen.csv \
   --output outputs/counts/prisma-summary.md
```
自动算出流程图每个框的数字 + 每阶段 **Cohen's κ**（附一致性等级）+ **8 条内部自洽校验**（如 排除+纳入=评估数）。任一校验 FAIL 会退出码 1、提示回去核数。数字交 `nature-figure` 画 **PRISMA 2020 流程图**。

### 6. 偏倚风险评估（RoB）
按研究设计选工具（RCT→RoB2、非随机干预→ROBINS-I、观察性→NOS、诊断→QUADAS-2、患病率→JBI），逐 domain 回答 signaling questions（Y/PY/PN/N/NI）→ 按决策算法给 domain 判定 → 汇总总体偏倚。完整规则见 [references/rob-grade.md](references/rob-grade.md)。偏倚图（traffic-light / summary）交 `nature-figure`。

### 7. 数据提取 + Meta 合并（如做定量合并）
按预定义 schema 提取；缺数据联系作者；需要时用 [references/protocol-extraction.md](references/protocol-extraction.md) 的**效应量换算公式**（如 中位数[IQR]→均值±SD、SE↔SD、OR↔RR）统一口径。**Meta 统计合并走 `data-analysis`**——用 `statsmodels.stats.meta_analysis`（`combine_effects`：DerSimonian-Laird 随机效应、I²/τ²/Q 异质性、森林图）+ 亚组/敏感性分析。⚠️ **发表偏倚 Egger 检验/漏斗图不对称、REML、网络 Meta/多水平/剂量-反应 statsmodels 均无内置**——研究数够(≥10)时手写加权回归或用 R `metafor`/`netmeta`，**如实告知用户哪些走 Python、哪些需 R，别声称能做其实做不了的**。

### 8. GRADE 证据分级
对每个主要结局，从五个降级域（偏倚风险/不一致性/间接性/不精确性/发表偏倚）起评，观察性研究可用三个升级因素（大效应/剂量反应/混杂方向）→ 得 high/moderate/low/very low。规则与打分表见 [references/rob-grade.md](references/rob-grade.md)。产出证据概要表（Summary of Findings）。

## 交付与衔接
- 产物写工作区 `outputs/`（去重 CSV、筛选 CSV、PRISMA 计数、RoB 表、提取表、GRADE SoF 表）。
- **写成投稿稿**交 `write-paper`（走其报告规范自检的 PRISMA 2020，含流程图硬性产出）；参考文献查 `reference-check`；出 PDF/Word 走 `render-pdf-doc`/`render-docx`。
- 在 `sci-pilot` 的 review 流水线里，涉及"系统综述/Meta"时先走本技能，再交 write-paper 成文。
- 中文报告出图/排版记得指定中文字体。

## 硬约束
- **协议先注册后筛选**；**双人独立筛选**（不得单次 LLM pass 定稿）；**PRISMA 流程图必出**。
- 去重/计数用脚本（可复现、可审计），别手数；κ 低时说明并加强培训/校准后重筛。
- 不虚构注册号、纳入研究、提取数据、偏倚判定；缺就标"待补充"或"待人工复核"。
- GRADE/RoB 判定是**人类方法学裁决**，脚本与规则只是辅助；关键降级/升级要有据可依。
