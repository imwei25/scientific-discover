---
name: literature-review
description: 写**叙述性**文献综述。围绕一个主题多路检索文献，去重、按研究类型(RCT/队列等)和主题归类，综合成有结构、有引用的综述（引言→分主题证据→争议与空白→结论），并给出参考文献表。当用户说"写综述""文献综述""某主题研究进展""帮我综述一下"时使用。边界：本技能产出**成文的、有引用的叙述性综述**；**系统综述/Meta（要双人筛选/偏倚风险/GRADE/PRISMA）用 systematic-review**；只要一份**文献清单/BibTeX**用 search-lit；只要**快速摸底不成文**用 research-scan。
---

# 文献综述技能

> **决策规约（照 AGENTS.md §六）**：本技能任何要用户拍板的抉择——方向 / 方案 / 目标刊 / 作图后端 / 纳排标准 / 下一步等——一律**在正文里列 2–4 个编号候选**（推荐项放第 1 个并写明“推荐 X，因为……”），让用户**回一个数字即推进**；**别用开放式提问逼用户打字，也别弹交互选项卡（如 AskUserQuestion）**。只有无法枚举的纯事实（手上的数据文件、伦理批号、代表作清单等）才开放式问。

**多步、回合制**地把证据收齐——不是"检索一次就写"，而是缺口驱动地补检、爬证据等级、扫矛盾，再据实综合。**只综合检索到的真实文献，不编造。**

> **单步 vs 多步**：主题窄、只要一版快综述 → 可退化成单轮（拆概念→检索一次→写）。**主题稍宽或要投稿级综述 → 走下面的多步循环**（覆盖更全、证据分级更硬、争议不再是空话）。多步循环的编排/停止判据/覆盖批判与 `deep-research` **共用一份引擎**：[references/iterative-retrieval.md](references/iterative-retrieval.md)（先读它）。差别只在产出：本技能出**结构化综述 + 证据分级 + 参考文献表**，deep-research 出**带置信度的问答报告**。

## 定位（本技能在套件中的位置）
顶层主控（AGENTS.md 常驻指令）判意图、定范围、派发；派到本技能就**直接做，别回绕**（本技能已覆盖 检索→成文→参考文献）。
- **体裁自检**：要**系统综述 / Meta**（双人独立筛选、偏倚风险 RoB、GRADE、PRISMA 流程）的 → 不是本技能，提醒改用 `systematic-review`；本技能只做**叙述性综述**。
产物直接写**当前工作目录**——网关已把本会话的 cwd 指到该会话的产物目录，用裸文件名即可（如 `table1.csv`），别再拼 `outputs/…` 前缀，也别写到仓库根。

## Python 环境
> 没有项目根 `.venv`？先运行 `env-setup` 技能建好并装依赖。
```
${REPO_ROOT:-/app}/.venv/bin/python   # Windows（正斜杠写法，bash 与 PowerShell 都能用）
${REPO_ROOT:-/app}/.venv/bin/python
```

## 多步流程（五阶段循环）
> 循环的通用规矩（编排决策、回合制检索、停止判据、覆盖批判、反向核查）在 [references/iterative-retrieval.md](references/iterative-retrieval.md)，本节只写综述特有的落法。

### 阶段 1 — 主题测绘 + 多视角展开（先搭骨架，再检索）
不要一上来就拍 2–4 个检索式。先对该主题的**已有综述**做一轮定向检索（`search.py "主题 AND review"`；这一轮只是摸骨架，可以用 `--limit 10` 少取几篇），从中归纳这篇综述**必须覆盖的子面**——医学主题的标准子面：机制 / 流行病学 / 诊断 / 干预疗效 / 预后 / 争议 / 指南（按题裁剪）。产出一份**覆盖大纲**存 `outputs/outline.md`——它既是综述骨架、又是检索计划。

### 阶段 2 — 缺口驱动的迭代检索（把"检索一次"改成回合制）
把 `search.py` 当**可反复调用的检索原语**，一回合一回合补：
```
${REPO_ROOT:-/app}/.venv/bin/python ${REPO_ROOT:-/app}/.opencode/skills/literature-review/search.py "概念1" "概念2" --since 2018
```
> **多个概念默认 AND 合成一条聚焦检索（取交集）**——脚本会打印实际合成的检索式。这样聚焦主题、
> 不掺入只命中单个概念的离题文献。要各自独立检索再并集（旧行为，会掺离题）显式加 `--union`。
> 单概念一条式最可控：`"概念1 AND 概念2 AND (同义词1 OR 同义词2)"`。
>
> **条数默认不限**（不传 `--limit`）：命中多少取多少，脚本会打印命中数（PRISMA 要记这个数）。
> **别随手加 `--limit 25`** —— 综述要的是覆盖，而不是"前 25 篇"；收窄范围请收窄检索式或用
> `--since`，别用条数上限。检索式太宽时脚本按 `SCI_SEARCH_MAX`（默认 5000）截断并**打印告警**，
> 看到告警就收窄重跑（或设 `SCI_SEARCH_MAX=0` 取消），并在汇报里如实说明被截断。
>
> ⚠️ 不限条数之后一条检索式可能回几千篇、`evidence.md` 上兆：**不要整份读进上下文**（读了也用不了，
> 摘要会把写作空间挤没）。按 `design`/`year`/`cites` 在 `evidence_table.csv` 里先筛出这一轮真正要
> 用的那部分（如只看 meta-analysis + RCT、或近 5 年被引前 100）再细读；全量表照旧留在产物里备查。

产出/追加 `outputs/evidence_table.csv`（含 design 列 + MeSH 词可作归一化信号）和 `outputs/evidence.md`。**每回合读完摘要后自评缺口**（照共享 doc）：哪个子面证据稀薄→补检；哪条论断只靠单一/弱证据→**沿证据等级爬升**（只有队列就去找 RCT/meta）；冒出的新药名/标志物→单独一轮。**停止判据**：每个子面在相关等级上取到 ≥3–5 篇、或连续两回合无新增、或到回合上限（默认 3–4 轮）。逐轮记 `outputs/search_log.md`。

### 阶段 3 — 论断台账 + 跨文献矛盾扫描
1. **建台账**：读 `evidence.md`，逐篇抽 0..N 条结构化论断到 `outputs/claims_ledger.csv`，列：
   `claim_id, ref, canon_i, canon_o, direction, design, quote`（可选 `population/intervention/comparator/outcome/effect/qualifiers`）。
   - ⚠️ **建账前先定一张受控词表**（canon_i/canon_o 的归一是矛盾扫描成败关键，**必须先定、边建边对**，否则同义标签写岔 → 真矛盾被拆进多个"一致"组、脚本只标出零星几个、你误以为"没什么争议"就发出低估争议的综述——这是本流程头号陷阱）。做法：先浏览一遍命中文献，把**同一干预/暴露、同一结局的各种写法收敛到一个标签**，落一张小表再逐条套用。医学常见归一示例：

     | 各种写法 | 统一 canon |
     |---|---|
     | vitamin D / vitamin D supplementation / vitamin D status / serum 25(OH)D | `vitamin_d` |
     | death / mortality / all-cause mortality / survival | `all_cause_mortality` |
     | CV death / cardiovascular mortality / CVD mortality | `cv_mortality` |
     | MACE / major adverse cardiovascular events / CV events | `mace` |

     **注意"暴露 vs 干预"别混**：血清 25(OH)D 水平（观察性暴露）与补充维生素D（RCT 干预）机制上是两回事——若你要比的是"补充是否有效"，把二者归到同一 canon 才能让观察性↑风险 vs RCT 无效**正面撞上**；若要分开讨论就用不同 canon，但要清楚自己在比什么。
   - `direction`：该文对 (i→o) 的方向，`increase/decrease/no_effect/mixed`。
   - **`quote` 强制**：填摘要里支撑该方向的**原句**；抽不到原句就**不登记这条**（护栏：防幻觉矛盾。这一列同时就是句级溯源，见下 `ground_claim.py`）。⚠️ `evidence.md` 的摘要**截断到 400 字**、支撑句常在其后——取 quote 时回 `evidence_table.csv` 拿**完整摘要**，别只从 `evidence.md` 截取。
2. **扫矛盾**：
   ```
   ${REPO_ROOT:-/app}/.venv/bin/python ${REPO_ROOT:-/app}/.opencode/skills/literature-review/contradiction.py --input claims_ledger.csv
   ```
   产出 `contradiction_candidates.md`（按 (canon_i→canon_o) 分组，方向冲突组在前、组内按证据等级排序）。**脚本会审计归一词表**：若报 `⚠️ 疑似归一碎片化`（列出看着同义却写成不同 canon 值的标签），说明上一步词表没收敛——回去统一这些标签、重跑，别拿碎片化的结果往下走。
3. **逐个裁定**（脚本只标候选、不下判决；这步是主代理的活）：对每个 ⚠️ 冲突组判四选一，写 `outputs/contradiction_matrix.md`——
   - **TRUE 真矛盾**：P/剂量/时点/定义可比 **且** 证据强度相当，方向仍相反 → 综述里明写争议。
   - **RECONCILABLE 可调和**：差在人群/剂量/时点/结局定义/校正 → 记下**是哪根轴**。
   - **WEIGHT 证据分级可解**：一方 meta/大 RCT 低偏倚、另一方小观察/个案 → 按等级取强弱、注明层级。
   - **SPURIOUS 伪冲突**：抽取错/其实是不同结局被误配 → 丢弃并说明。
   - **默认偏向 RECONCILABLE**；判 TRUE 前对涉事文献用 `fulltext-retrieval` 读全文再定；**绝不静默删掉冲突一方**。

### 阶段 4 — 按大纲成文
读 `evidence.md` + `contradiction_matrix.md`，按阶段 1 大纲、按证据等级组织：
- 引言（背景 + 为什么综述这个题）
- 分主题/按证据等级的正文（meta > RCT > 队列 > … ；每条论断引具体文献）
- **争议与空白**：直接用 `contradiction_matrix.md`——具名研究 + 调和轴，别写"尚存争议"这种空话
- 结论与展望
- 参考文献（编号，与正文 [n] 对应）
存 `outputs/review.md`。

### 阶段 5 — 覆盖批判 + 引用核查 + 出件
1. **覆盖批判者**（成稿前一轮，照共享 doc）：还缺哪个子面？有没有公认重磅研究没引？哪条论断只有单来源？命中 → 回阶段 2 补一轮再定稿。
2. **查假引用**：把参考文献交 `reference-check` 核真实性，标红项按其报告处理。
3. **句级转述自查**：可疑转述用下节 `ground_claim.py` 逐句核。
4. **出 PDF**：把 `outputs/review.md` 交 `render-pdf-doc` 渲染成 `outputs/review.pdf`。中文务必指定中文字体（`--cjk-font`：本地 `Microsoft YaHei`，服务器 `Noto Sans CJK SC`），否则漏字。需要更多文献用 `search-lit`/`fulltext-retrieval`。

## 引用溯源到原句（`ground_claim.py`，写完自查转述是否忠于原文）
证据表把论断追溯到**论文级** `[n]`；`ground_claim.py` 再往下追一层到**句子级**——给一句论断 + 它引的 DOI/PMID，取回该文献摘要、拆句、捞出**最能支撑这句的原文句子**并打分。补 `reference-check` 的盲区：那个只验"文献真实存在"，这个验"你的转述对不对得上原文那句话"（转述失真是综述/讨论里最隐蔽的幻觉）。

```
# 单条：论断 + 它引的一个或多个 DOI/PMID
${REPO_ROOT:-/app}/.venv/bin/python ${REPO_ROOT:-/app}/.opencode/skills/literature-review/ground_claim.py "他汀降低卒中复发风险" 10.1056/NEJMoa1615664 PMID:27295427
# 批量：CSV 两列 claim,ref，把综述里每个"论断→引用"对逐条核
${REPO_ROOT:-/app}/.venv/bin/python ${REPO_ROOT:-/app}/.opencode/skills/literature-review/ground_claim.py --input claims.csv
```
- 产出 `claim_grounding.md` / `.csv`。分档：**GROUNDED**（≥0.45，措辞高度相关）、**CHECK**（0.25–0.45，请人工确认）、**WEAK**（<0.25，⚠️ 摘要里找不到支撑句——可能转述失真，或支撑点在全文正文）、**NOTFOUND/NOABSTRACT**（取不到文献/无摘要）。
- **关键在"捞出的原句"，分数只用来排优先级**：TF-IDF 对短转述天然保守，忠实的转述常落 CHECK 档但会把**正确的原句**摆到你面前——照着确认措辞即可。WEAK 且无相关句才是真信号。
- ⚠️ **只对英文论断有效（TF-IDF 词面匹配、不跨语言）**：Europe PMC 摘要基本全英文，**中文论断对英文摘要会恒判 WEAK/0.0，与转述是否准确无关**——分数失去意义。所以核对时**把该条论断先translate成英文再传给脚本**（用你自己译的英文短句）；若坚持传中文论断，则 WEAK 一律当"未测"、必须人工回原文核，别信这个分。
- 摘要没有的支撑点 → 用 `fulltext-retrieval` 下全文再核（本脚本只看摘要）。

## 约定
- 所有产出写 `outputs/`。综述正文可存 `outputs/review.md`。
- **图要"真嵌入"，不只文字提及**：综述若配图（汇总示意图、证据分布/时间线图等，用 `nature-figure` 生成到 `outputs/`），在正文对应处用 `![图注……](outputs/xxx.png)` **真正插入图片**（路径指向真实位置 `outputs/`，渲染从仓库根跑）；只写"如图所示"而不嵌入，渲染出来是空的。
- 每个论断都要能追溯到证据表里的某篇（用 [n] 或 (作者, 年)）。
- 明确区分"强证据(meta/RCT)"与"弱证据(个案/临床前)"。
- 联网失败时如实说明，不要凭空写文献。**绝不虚构标题/DOI/结论。**
- 写完汇报：覆盖多少篇、研究类型分布、**几轮检索/是否达饱和**、主要结论、**方向冲突几组及裁定**、空白点，并列出文件路径。
