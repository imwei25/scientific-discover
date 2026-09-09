---
name: literature-review
description: 写叙述性文献综述：多路检索→去重→按研究类型与主题归类→有结构、有引用的综述（引言→分主题证据→争议与空白→结论）+参考文献表。触发："写综述""文献综述""某主题研究进展"。系统综述/Meta 用 systematic-review，只要文献清单用 search-lit，快速摸底用 research-scan。
---

# 文献综述技能

> **决策规约（照 AGENTS.md §六）**：本技能任何要用户拍板的抉择——方向 / 方案 / 目标刊 / 作图后端 / 纳排标准 / 下一步等——一律**在正文里列 2–4 个编号候选**（推荐项放第 1 个并写明“推荐 X，因为……”），让用户**回一个数字即推进**；**别用开放式提问逼用户打字，也别弹交互选项卡（如 AskUserQuestion）**。只有无法枚举的纯事实（手上的数据文件、伦理批号、代表作清单等）才开放式问。

**多步、回合制**地把证据收齐——不是"检索一次就写"，而是缺口驱动地补检、爬证据等级、扫矛盾，再据实综合。**只综合检索到的真实文献，不编造。**

> **单步 vs 多步**：主题窄、只要一版快综述 → 可退化成单轮（拆概念→检索一次→写）。**主题稍宽或要投稿级综述 → 走下面的多步循环**（覆盖更全、证据分级更硬、争议不再是空话）。多步循环的编排/停止判据/覆盖批判与 `deep-research` **共用一份引擎**：[references/iterative-retrieval.md](references/iterative-retrieval.md)（先读它）。差别只在产出：本技能出**结构化综述 + 证据分级 + 参考文献表**，deep-research 出**带置信度的问答报告**。

## 定位（本技能在套件中的位置）
顶层主控（AGENTS.md 常驻指令）判意图、定范围、派发；派到本技能就**直接做，别回绕**（本技能已覆盖 检索→成文→参考文献）。
- **体裁自检**：要**系统综述 / Meta**（双人独立筛选、偏倚风险 RoB、GRADE、PRISMA 流程）的 → 不是本技能，提醒改用 `systematic-review`；本技能只做**叙述性综述**。
- **上游故事线定案（paper 流水线内，有就照单干）**：开工先扫当前工作目录有无 `design_brief.md`（idea-forge 故事线锻打的出件）——有，综述就**围绕它聚焦**：检索式从其「下游任务清单 · 综述检索式建议」起手，成文围绕核心主张与「与最接近论文的差异」组织（这是 write-paper 引言缺口段与讨论对比段要用的），其证据台账里的文献直接并入证据表，**别抛开定案另做一篇泛综述**。没有该文件则照常。
产物直接写**当前工作目录**——网关已把本会话的 cwd 指到该会话的产物目录，用裸文件名即可（如 `table1.csv`），别再拼 `outputs/…` 前缀，也别写到仓库根。

## Python 环境
> **报「找不到 `.venv` / 缺 Python」先查命令里的引号**：安装目录含空格（`.../Niuma Science/bundle/app`），路径不加引号会被 bash 从空格处切断、报 `No such file or directory`——**那不是缺环境**。Python 环境随安装包/镜像装好，**不要重建 `.venv`、也不要重装依赖**（白烧十几分钟还可能弄坏包版本）；确认解释器真的不存在时，才在仓库根跑 `install.ps1`（Windows）/ `install.sh`。
```
"${REPO_ROOT:-/app}/.venv/bin/python"   # Windows（正斜杠写法，bash 与 PowerShell 都能用）
"${REPO_ROOT:-/app}/.venv/bin/python"
```

## 多步流程（五阶段循环）
> 循环的通用规矩（编排决策、回合制检索、停止判据、覆盖批判、反向核查）在 [references/iterative-retrieval.md](references/iterative-retrieval.md)，本节只写综述特有的落法。

### 阶段 1 — 主题测绘 + 多视角展开（先搭骨架，再检索）
不要一上来就拍 2–4 个检索式。先对该主题的**已有综述**做一轮定向检索（`search.py "主题 AND review"`；这一轮只是摸骨架，可以用 `--limit 10` 少取几篇），从中归纳这篇综述**必须覆盖的子面**——医学主题的标准子面：机制 / 流行病学 / 诊断 / 干预疗效 / 预后 / 争议 / 指南（按题裁剪）。产出一份**覆盖大纲**存 `outputs/outline.md`——它既是综述骨架、又是检索计划。

### 阶段 2 — 缺口驱动的迭代检索（把"检索一次"改成回合制）
把 `search.py` 当**可反复调用的检索原语**，一回合一回合补：
> 完整参数看 `python search.py --help`。各参数的落法与命令示例——**`--tag` 每回合必带**（各轮并存、不带会被后一轮挤走）、多概念默认 AND、**默认不限条数**（别随手 `--limit`）与大结果的筛读法、首屏「研究设计」→ **`--design` 必传**、「时间范围」→ **`--since` 必传**、`--landmark` 奠基文献补捞（默认开、别关；「‼ 没跑成」先重跑）、`--budget-sec` 截断处理、检索源不收录中文期刊的当面提醒——**已搬至 [references/search-rounds.md](references/search-rounds.md)，开跑前先读一遍。**

每回合产出 `evidence_table__<tag>.csv`（含 design 列 + MeSH 词可作归一化信号）和 `evidence__<tag>.md`
——**脚本不会自动追加合并**，各轮各一份。**所有回合跑完后合成一张总表**再进阶段 3（合并脚本见 [references/search-rounds.md](references/search-rounds.md)「合并各轮证据表」）。
合并表多一列 `source_round` 标明这篇来自哪一轮（PRISMA 记数、汇报覆盖面时要用）。下游
（`ground_claim.py`、`idea-forge`、`zotero push`）读的就是这张合并后的 `evidence_table.csv`。
**每回合读完摘要后自评缺口**（照共享 doc）：哪个子面证据稀薄→补检；哪条论断只靠单一/弱证据→**沿证据等级爬升**（只有队列就去找 RCT/meta）；冒出的新药名/标志物→单独一轮。**停止判据**：每个子面在相关等级上取到 ≥3–5 篇、或连续两回合无新增、或到回合上限（默认 3–4 轮）。逐轮记 `outputs/search_log.md`。

### 阶段 3 — 论断台账 + 跨文献矛盾扫描
1. **建台账**：读 `evidence.md`，逐篇抽 0..N 条结构化论断到 `outputs/claims_ledger.csv`，列：
   `claim_id, ref, canon_i, canon_o, direction, design, quote`（可选 `population/intervention/comparator/outcome/effect/qualifiers`）。
   - ⚠️ **建账前先定一张受控词表**（canon_i/canon_o 的归一是矛盾扫描成败关键，**必须先定、边建边对**，否则真矛盾被拆进多个"一致"组、你误以为"没什么争议"——这是本流程头号陷阱）。做法、医学归一示例表与"暴露 vs 干预别混"见 [references/claims-ledger.md](references/claims-ledger.md)。
   - `direction`：该文对 (i→o) 的方向，`increase/decrease/no_effect/mixed`。
   - **`quote` 强制**：填摘要里支撑该方向的**原句**；抽不到原句就**不登记这条**（护栏：防幻觉矛盾。这一列同时就是句级溯源，见下 `ground_claim.py`）。⚠️ `evidence.md` 的摘要**截断到 400 字**、支撑句常在其后——取 quote 时回 `evidence_table.csv` 拿**完整摘要**，别只从 `evidence.md` 截取。
2. **扫矛盾**：`contradiction.py --input claims_ledger.csv`（参数看 `--help`，完整命令见 [references/claims-ledger.md](references/claims-ledger.md)）。
   产出 `contradiction_candidates.md`（按 (canon_i→canon_o) 分组，方向冲突组在前、组内按证据等级排序）。**脚本会审计归一词表**：若报 `⚠️ 疑似归一碎片化`（列出看着同义却写成不同 canon 值的标签），说明上一步词表没收敛——回去统一这些标签、重跑，别拿碎片化的结果往下走。
3. **逐个裁定**（脚本只标候选、不下判决；这步是主代理的活）：对每个 ⚠️ 冲突组判四选一——**TRUE 真矛盾 / RECONCILABLE 可调和 / WEIGHT 证据分级可解 / SPURIOUS 伪冲突**，写 `outputs/contradiction_matrix.md`；四档判据见 [references/claims-ledger.md](references/claims-ledger.md)。**默认偏向 RECONCILABLE**；判 TRUE 前用 `fulltext-retrieval` 读全文再定；**绝不静默删掉冲突一方**。

### 阶段 4 — 按大纲成文
读 `evidence.md` + `contradiction_matrix.md`，按阶段 1 大纲、按证据等级组织：
- 引言（背景 + 为什么综述这个题）
- 分主题/按证据等级的正文（meta > RCT > 队列 > … ；每条论断引具体文献）
- **争议与空白**：直接用 `contradiction_matrix.md`——具名研究 + 调和轴，别写"尚存争议"这种空话
- 结论与展望
- 参考文献（编号，与正文 [n] 对应）
存 `outputs/review.md`。

**参考文献列表务必写成 `[1] 著录…` 的编号形式**（与正文 `[n]` 一一对应，否则下一步 `reference-check` 的「正文引用位置」失效）；**交付时字数两个口径都报**（"正文 X 字符（不计空格）／其中纯汉字 Y 字"，并说明目标篇幅按哪个算）。两条的缘由见 [references/writing-delivery.md](references/writing-delivery.md)。

### 阶段 5 — 覆盖批判 + 引用核查 + 出件
1. **覆盖批判者**（成稿前一轮，照共享 doc）：还缺哪个子面？有没有公认重磅研究没引？哪条论断只有单来源？命中 → 回阶段 2 补一轮再定稿。
2. **查假引用**：把参考文献交 `reference-check` 核真实性（**把正文一并传给它** `--manuscript review.md`），
   标红项按其报告处理。
   - **闸红了就回来改稿重跑，不许在报告里写一段"人工复核已通过"再去出件**——那是绕闸，网关会拦停整轮。
   - 顺手验几篇**候选替换文献**时加 `--scope adhoc`（或把候选放在 `.scratch/` 下），
     它会另存 `adhoc_refcheck.md`、不碰本稿的核查结论与闸。
3. **句级转述自查**：可疑转述用下节 `ground_claim.py` 逐句核。
4. **出 PDF**：把 `outputs/review.md` 交 `render-pdf-doc` 渲染成 `outputs/review.pdf`。中文务必指定中文字体（`--cjk-font`：本地 `Microsoft YaHei`，服务器 `Noto Sans CJK SC`），否则漏字。需要更多文献用 `search-lit`/`fulltext-retrieval`。

## 引用溯源到原句（`ground_claim.py`，写完自查转述是否忠于原文）
证据表把论断追溯到**论文级** `[n]`；`ground_claim.py` 再往下追一层到**句子级**——给一句论断 + 它引的 DOI/PMID，取回该文献摘要、拆句、捞出**最能支撑这句的原文句子**并打分。补 `reference-check` 的盲区：那个只验"文献真实存在"，这个验"你的转述对不对得上原文那句话"（转述失真是综述/讨论里最隐蔽的幻觉）。

用法（单条 / `--input claims.csv` 批量，参数看 `python ground_claim.py --help`）、产出 `claim_grounding.md` / `.csv` 与 **GROUNDED / CHECK / WEAK / NOTFOUND** 分档及"看原句、分数只排优先级"的解读见 [references/ground-claim.md](references/ground-claim.md)。
- ⚠️ **只对英文论断有效（TF-IDF 词面匹配、不跨语言）**：Europe PMC 摘要基本全英文，**中文论断对英文摘要会恒判 WEAK/0.0，与转述是否准确无关**——分数失去意义。所以核对时**把该条论断先translate成英文再传给脚本**（用你自己译的英文短句）；若坚持传中文论断，则 WEAK 一律当"未测"、必须人工回原文核，别信这个分。
- 摘要没有的支撑点 → 用 `fulltext-retrieval` 下全文再核（本脚本只看摘要）。

## 约定
- 所有产出写 `outputs/`。综述正文可存 `outputs/review.md`。
- **图要"真嵌入"，不只文字提及**：综述若配图（汇总示意图、证据分布/时间线图等，用 `nature-figure` 生成到 `outputs/`），在正文对应处用 `![图注……](outputs/xxx.png)` **真正插入图片**（路径指向真实位置 `outputs/`，渲染从仓库根跑）；只写"如图所示"而不嵌入，渲染出来是空的。
- 每个论断都要能追溯到证据表里的某篇（用 [n] 或 (作者, 年)）。
- 明确区分"强证据(meta/RCT)"与"弱证据(个案/临床前)"。
- 联网失败时如实说明，不要凭空写文献。**绝不虚构标题/DOI/结论。**
- 写完汇报：覆盖多少篇、研究类型分布、**几轮检索/是否达饱和**、主要结论、**方向冲突几组及裁定**、空白点，并列出文件路径。
