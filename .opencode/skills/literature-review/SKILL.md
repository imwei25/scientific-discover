---
name: literature-review
description: 写**叙述性**文献综述：围绕主题多路检索、去重、按研究类型与主题归类，综合成有结构、有引用的综述（引言→分主题证据→争议与空白→结论）+参考文献表。当用户说"写综述""文献综述""某主题研究进展"时使用。边界：系统综述/Meta（双人筛选/RoB/GRADE/PRISMA）用 systematic-review；只要文献清单/BibTeX 用 search-lit；快速摸底不成文用 research-scan。
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
```
"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/literature-review/search.py" "概念1" "概念2" --since 2018 --design rct,cohort --landmark "IMbrave150,HIMALAYA" --tag r1
```
> ⚠️ **每一回合都必须带 `--tag`（`r1` / `r2` / `机制` / `诊断` …）**。产物默认是**固定名**
> `evidence_table.csv` / `evidence.md`，脚本**不会追加合并**——回合制检索不带 tag，后一轮就把
> 前一轮挤走：旧表会被改名成 `evidence_table.csv.bak` / `.bak2` / `.bak3`… 保命（数据不会真丢），
> 但你手上那张固定名的表只剩最后一轮。带 tag 后写成 `evidence_table__r1.csv` /
> `evidence__r1.md`，各轮并存、可直接合表（见下）；不带 tag 而文件已存在时脚本会在 stderr
> 报出把哪些文件改名成了什么。
>
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

> **首屏表单勾了「纳入的研究设计」→ 必须把它传给 `--design`**（`rct,cohort,casecontrol,crosssection,review,meta,basic`，
> 逗号分隔，与表单选项同名）。脚本会给每一类各跑一趟**按被引降序**的定向检索并入结果
> （主检索照旧宽召回，不做过滤），跑完打印「勾选的研究设计在表里占百分之几」。
> **不传等于那个勾选框没起作用**——实测一次勾了「RCT+队列」的检索回来 106 篇里 RCT 只有 8 篇，
> 用户会认为这个表单是摆设。定向趟按被引降序取，顺带把**领域里程碑试验**捞回来
> （普通主题检索按相关度排序，排在前面的多是评论与真实世界研究，Ⅲ期原始论文常常一篇都排不上来）。
>
> **首屏的「参考文献时间范围」→ 必须传 `--since`**，否则那个选项同样等于没填（脚本会就此告警）。
>
> **奠基文献补捞（`--landmark`，默认就开，别关）**：里程碑试验有两种漏法，脚本各堵一条 ——
> ① **被年限卡掉**（「近 5 年」会把 2020 年的 IMbrave150 排除）；
> ② **被 AND 掉**（主检索 `HCC AND (PD-1 OR PD-L1) AND first-line` 三概念取交集，
> 而 IMbrave150 那篇 NEJM 的题录里既没有 "PD-L1" 也没有 "first-line"，一 AND 就没它了）。
> 所以奠基趟**只用第一个概念**（病种/领域）+ 试验/指南限定 + 被引降序、**不套 `--since`**。
> 实测这一趟的前几名就是 SHARP(10144 引)、IMbrave150 NEJM(5854)、REFLECT(4299)——
> 任何一篇该方向综述都要引的那几篇。
> **你已经知道试验叫什么名字时，把名字列上**：`--landmark "IMbrave150,CheckMate 9DW,HIMALAYA"`，
> 每个名字另跑一趟精确补捞（检索式里出现过的试验名会自动认，但你脑子里的那些得你自己给）。
> 这一步就是为了**替掉"凭记忆写 DOI"**——两轮实测里模型都干过这件事，其中一次自述"我编造了 DOI"。
> 补回来的奠基文献**豁免时间范围过滤**；汇报时说明"这几篇超出你选的年限，因为它们是本方向的
> 原始Ⅲ期试验/领域基石"，不必请示。
> 只有"确实只要某个时间窗内的新文"（如"近一年有什么新进展"）才加 `--no-landmark`。
>
> **看到「‼ 奠基文献补捞没跑成」就先把那一趟重跑，跑通了再往下写。** 这一趟整趟失败时，
> 证据表**表面上完全正常**（条数照样几百条），只是前排被高被引泛综述占满、地基文献一篇不在
> —— 实测一次 SSL 握手失败就造成 225 条里零篇 NEJM。**别把这种表当成"这个方向就这些文献"**，
> 更不要凭记忆把缺掉的原始试验补写进参考文献（那是假引用最高发的场景，引用核查会当场打回）。
>
> **`--budget-sec`（默认 90 秒）是墙钟护栏**：到点就停止翻页、把已取回的写出来并**响亮报告截断**。
> 宁可少而有产物，也不要超时零产物（实测一次宽检索式把调用超时耗光、两轮检索什么都没写下来）。
> 看到"因时间预算被截断"就收窄检索式或加大预算重跑，**别把那份结果当成"这个方向就这么多文献"**。
>
> ⚠️ **语种：这套检索源（Europe PMC / PubMed / Crossref）不收录 CNKI / 万方 / 维普，检索不到中文期刊文献。**
> 目标刊是**中文核心**时（用户说"投中华系/国内核心"，或首屏语言选了中文），**开工时就当面告诉用户**：
> 中文参考文献要他自己补，或用 `zotero-library` 从他本机文献库取。中文核心综述普遍要求引一定比例国内研究，
> 到送审才被编辑指出"参考文献全是外文"，返工的是整份稿子。脚本在 0 篇中文命中时也会打印同款提醒。

每回合产出 `evidence_table__<tag>.csv`（含 design 列 + MeSH 词可作归一化信号）和 `evidence__<tag>.md`
——**脚本不会自动追加合并**，各轮各一份。**所有回合跑完后合成一张总表**再进阶段 3：

```bash
"${REPO_ROOT:-/app}/.venv/bin/python" - <<'EOF'
import csv, glob, pathlib
rows, seen = [], set()
for p in sorted(glob.glob("evidence_table__*.csv")):
    for r in csv.DictReader(open(p, encoding="utf-8-sig")):
        k = (r.get("doi") or "").lower() or (r.get("title") or "").lower().strip(" .")
        if k and k in seen:
            continue
        seen.add(k); r["source_round"] = pathlib.Path(p).stem.split("__", 1)[1]; rows.append(r)
cols = list(rows[0].keys())
with open("evidence_table.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(rows)
with open("evidence.md", "w", encoding="utf-8") as f:
    f.write(f"# 证据清单（{len(rows)} 篇，各轮合并去重）\n\n")
    for i, r in enumerate(rows, 1):
        f.write(f"{i}. **{r['title']}** ({r['year']}, {r['journal']}) — *{r['design']}*, "
                f"cited {r['cites']}x, round={r['source_round']}. DOI:{r['doi'] or 'NA'}\n")
        if r.get("abstract"):
            f.write(f"   > {r['abstract'][:400]}\n")
        f.write("\n")
print(f"合并 {len(seen)} 篇 → evidence_table.csv / evidence.md")
EOF
```
合并表多一列 `source_round` 标明这篇来自哪一轮（PRISMA 记数、汇报覆盖面时要用）。下游
（`ground_claim.py`、`idea-forge`、`zotero push`）读的就是这张合并后的 `evidence_table.csv`。
**每回合读完摘要后自评缺口**（照共享 doc）：哪个子面证据稀薄→补检；哪条论断只靠单一/弱证据→**沿证据等级爬升**（只有队列就去找 RCT/meta）；冒出的新药名/标志物→单独一轮。**停止判据**：每个子面在相关等级上取到 ≥3–5 篇、或连续两回合无新增、或到回合上限（默认 3–4 轮）。逐轮记 `outputs/search_log.md`。

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
   "${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/literature-review/contradiction.py" --input claims_ledger.csv
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

**参考文献列表务必写成 `[1] 著录…` 的编号形式**（与正文 `[n]` 一一对应）。裸著录（不带方括号号）
会让下一步 `reference-check` 的「正文引用位置」一列失效——它靠编号把正文标记与列表对上，
对不上就查不出「列表里躺着正文从没引过的文献」与「正文引了表里没有的悬空编号」这两类硬伤。
（脚本现在会在能确认的情况下按列表顺序自动补号，但那是兜底，不是让你少写。）

**交付时把字数口径说清**：中文期刊常用"字符数（不计空格）"，而"纯汉字数"通常明显更小
（一篇含大量英文术语与缩写的稿子，两个口径能差三到四成）。只报一个数字会让用户以为达标/没达标，
**两个都报**："正文 X 字符（不计空格）／其中纯汉字 Y 字"，并说明目标篇幅按哪个口径算。

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

```
# 单条：论断 + 它引的一个或多个 DOI/PMID
"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/literature-review/ground_claim.py" "他汀降低卒中复发风险" 10.1056/NEJMoa1615664 PMID:27295427
# 批量：CSV 两列 claim,ref，把综述里每个"论断→引用"对逐条核
"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/literature-review/ground_claim.py" --input claims.csv
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
