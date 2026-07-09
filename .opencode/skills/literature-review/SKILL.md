---
name: literature-review
description: 写**叙述性**文献综述。围绕一个主题多路检索文献，去重、按研究类型(RCT/队列等)和主题归类，综合成有结构、有引用的综述（引言→分主题证据→争议与空白→结论），并给出参考文献表。当用户说"写综述""文献综述""某主题研究进展""帮我综述一下"时使用。边界：本技能产出**成文的、有引用的叙述性综述**；**系统综述/Meta（要双人筛选/偏倚风险/GRADE/PRISMA）用 systematic-review**；只要一份**文献清单/BibTeX**用 search-lit；只要**快速摸底不成文**用 research-scan。
---

# 文献综述技能

> **决策规约（照 AGENTS.md §六）**：本技能任何要用户拍板的抉择——方向 / 方案 / 目标刊 / 作图后端 / 纳排标准 / 下一步等——一律**在正文里列 2–4 个编号候选**（推荐项放第 1 个并写明“推荐 X，因为……”），让用户**回一个数字即推进**；**别用开放式提问逼用户打字，也别弹交互选项卡（如 AskUserQuestion）**。只有无法枚举的纯事实（手上的数据文件、伦理批号、代表作清单等）才开放式问。

先用脚本把证据收齐、去重、分好类，再据实综合成综述。**只综合检索到的真实文献，不编造。**

## 定位（本技能在套件中的位置）
顶层主控（AGENTS.md 常驻指令）判意图、定范围、派发；派到本技能就**直接做，别回绕**（本技能已覆盖 检索→成文→参考文献）。
- **体裁自检**：要**系统综述 / Meta**（双人独立筛选、偏倚风险 RoB、GRADE、PRISMA 流程）的 → 不是本技能，提醒改用 `systematic-review`；本技能只做**叙述性综述**。
产物写 `outputs/`（主控注入了会话专属目录 `outputs/<会话id>/` 时以它为准、勿写仓库根固定名——多用户共享会 clobber）。

## Python 环境
> 没有项目根 `.venv`？先运行 `env-setup` 技能建好并装依赖。
```
.venv/Scripts/python.exe   # Windows（正斜杠写法，bash 与 PowerShell 都能用）
.venv/bin/python           # Linux / macOS
```

## 流程
1. **拆概念**：把主题拆成 2-4 个检索式（如 PICO 的 P/I/O）。
2. **检索建证据表**：
   ```
   .venv/Scripts/python.exe .opencode/skills/literature-review/search.py "概念1" "概念2" --limit 25 --since 2018
   ```
   产出 `outputs/evidence_table.csv`（含 design 研究类型列）和 `outputs/evidence.md`。
3. **读证据写综述**：读 `outputs/evidence.md`，据此撰写：
   - 引言（背景+为什么综述这个题）
   - 分主题/按证据等级组织的正文（meta > RCT > 队列 > … ；每条论断都引具体文献）
   - 争议、局限、研究空白
   - 结论与展望
   - 参考文献（编号，与正文 [n] 对应）
4. **出 PDF（正式报告默认交付版）**：综述写完后，把 `outputs/review.md` 交给 `render-pdf-doc` 技能渲染成 `outputs/review.pdf`。中文报告务必指定中文字体（`--cjk-font`：本地 `Microsoft YaHei`，服务器 `Noto Sans CJK SC`），否则会漏字。需要更多文献用 `search-lit`（检索）/`fulltext-retrieval`（下全文）。

## 引用溯源到原句（`ground_claim.py`，写完自查转述是否忠于原文）
证据表把论断追溯到**论文级** `[n]`；`ground_claim.py` 再往下追一层到**句子级**——给一句论断 + 它引的 DOI/PMID，取回该文献摘要、拆句、捞出**最能支撑这句的原文句子**并打分。补 `reference-check` 的盲区：那个只验"文献真实存在"，这个验"你的转述对不对得上原文那句话"（转述失真是综述/讨论里最隐蔽的幻觉）。

```
# 单条：论断 + 它引的一个或多个 DOI/PMID
.venv/Scripts/python.exe .opencode/skills/literature-review/ground_claim.py "他汀降低卒中复发风险" 10.1056/NEJMoa1615664 PMID:27295427
# 批量：CSV 两列 claim,ref，把综述里每个"论断→引用"对逐条核
.venv/Scripts/python.exe .opencode/skills/literature-review/ground_claim.py --input outputs/<会话>/claims.csv
```
- 产出 `claim_grounding.md` / `.csv`。分档：**GROUNDED**（≥0.45，措辞高度相关）、**CHECK**（0.25–0.45，请人工确认）、**WEAK**（<0.25，⚠️ 摘要里找不到支撑句——可能转述失真，或支撑点在全文正文）、**NOTFOUND/NOABSTRACT**（取不到文献/无摘要）。
- **关键在"捞出的原句"，分数只用来排优先级**：TF-IDF 对短转述天然保守，忠实的转述常落 CHECK 档但会把**正确的原句**摆到你面前——照着确认措辞即可。WEAK 且无相关句才是真信号。
- 摘要没有的支撑点 → 用 `fulltext-retrieval` 下全文再核（本脚本只看摘要）。

## 约定
- 所有产出写 `outputs/`。综述正文可存 `outputs/review.md`。
- **图要"真嵌入"，不只文字提及**：综述若配图（汇总示意图、证据分布/时间线图等，用 `nature-figure` 生成到 `outputs/`），在正文对应处用 `![图注……](outputs/xxx.png)` **真正插入图片**（路径指向真实位置 `outputs/`，渲染从仓库根跑）；只写"如图所示"而不嵌入，渲染出来是空的。
- 每个论断都要能追溯到证据表里的某篇（用 [n] 或 (作者, 年)）。
- 明确区分"强证据(meta/RCT)"与"弱证据(个案/临床前)"。
- 联网失败时如实说明，不要凭空写文献。**绝不虚构标题/DOI/结论。**
- 写完汇报：覆盖多少篇、研究类型分布、主要结论、空白点，并列出文件路径。
