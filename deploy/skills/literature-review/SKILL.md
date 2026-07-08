---
name: literature-review
description: 写**叙述性**文献综述。围绕一个主题多路检索文献，去重、按研究类型(RCT/队列等)和主题归类，综合成有结构、有引用的综述（引言→分主题证据→争议与空白→结论），并给出参考文献表。当用户说"写综述""文献综述""某主题研究进展""帮我综述一下"时使用。边界：本技能产出**成文的、有引用的叙述性综述**；**系统综述/Meta（要双人筛选/偏倚风险/GRADE/PRISMA）用 systematic-review**；只要一份**文献清单/BibTeX**用 search-lit；只要**快速摸底不成文**用 research-scan。
---

# 文献综述技能

先用脚本把证据收齐、去重、分好类，再据实综合成综述。**只综合检索到的真实文献，不编造。**

## 范围自检（开工第一件事）
本套件**主控优先：默认所有请求先经 `sci-pilot` 统一调度**。
- **先分清体裁**：要**系统综述 / Meta**（双人独立筛选、偏倚风险 RoB、GRADE、PRISMA 流程）的 → **不是本技能，是 `systematic-review`**；本技能只做**叙述性综述**。
- **若本次不是 `sci-pilot` 派发来的**（用户冷启动直接触发、sci-pilot 还没介入）→ **先交回 `sci-pilot`** 判意图与范围。它判为**单步**（就写这一篇叙述性综述）会立刻派回来、你再就地做（本技能已覆盖 检索→成文→参考文献）；判为**完整目标/要续跑**就走 review 流水线（检索→成文→reference-check→去AI味→排版、维护 workspace）。
- **若本次已是 `sci-pilot` 在派发你**（有 workspace 上下文，或 sci-pilot 刚决定要做"叙述性综述"这一步）→ **直接做，别再往回绕**（防兜圈）。

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
   .venv/bin/python .opencode/skills/literature-review/search.py "概念1" "概念2" --limit 25 --since 2018
   ```
   产出 `outputs/evidence_table.csv`（含 design 研究类型列）和 `outputs/evidence.md`。
3. **读证据写综述**：读 `outputs/evidence.md`，据此撰写：
   - 引言（背景+为什么综述这个题）
   - 分主题/按证据等级组织的正文（meta > RCT > 队列 > … ；每条论断都引具体文献）
   - 争议、局限、研究空白
   - 结论与展望
   - 参考文献（编号，与正文 [n] 对应）
4. **出 PDF（正式报告默认交付版）**：综述写完后，把 `outputs/review.md` 交给 `render-pdf-doc` 技能渲染成 `outputs/review.pdf`。中文报告务必指定中文字体（`--cjk-font`：本地 `Microsoft YaHei`，服务器 `Noto Sans CJK SC`），否则会漏字。需要更多文献用 `search-lit`（检索）/`fulltext-retrieval`（下全文）。

## 约定
- 所有产出写 `outputs/`。综述正文可存 `outputs/review.md`。
- 每个论断都要能追溯到证据表里的某篇（用 [n] 或 (作者, 年)）。
- 明确区分"强证据(meta/RCT)"与"弱证据(个案/临床前)"。
- 联网失败时如实说明，不要凭空写文献。**绝不虚构标题/DOI/结论。**
- 写完汇报：覆盖多少篇、研究类型分布、主要结论、空白点，并列出文件路径。
