> 本文件从 SKILL.md 顶部「送审细排参数」与「手写表题自动转 pandoc 题注」两段搬出（原文照搬，仅去掉引用块前缀）；用到 `--indent-chars` / `--caption-fontsize` / `--table-fontsize` / 各级标题字号 / `--author-fontsize`，或要改这段 LaTeX 注入代码时读。

**送审细排参数（PDF 侧靠注入 LaTeX 实现，与 render-docx 同名参数对齐）**：
`--indent-chars N`（首行缩进，按 0.5em/字符）、`--caption-fontsize PT`（caption 宏包：题注字号、居中、标签加粗）、`--table-fontsize PT`（只钩 longtable）、`--title-fontsize` / `--h1-fontsize` / `--heading-fontsize`（中文走 `\ctexset`、西文走 titlesec）、`--author-fontsize`（titling）。这些参数只在显式给出（或预设含对应字段）时才注入宏包，不影响标书/简报等其它文档。三个已踩过的坑，改这段代码前先看：
1. **表内字号只能钩 `longtable`，不能钩 `tabular`**——LaTeX 的**作者块本身就是 tabular**（`\and` 展开成 `\end{tabular}…\begin{tabular}`），钩了作者名会被缩成表内字号。
2. **不能用 `\AtBeginEnvironment{longtable}` 塞 `\fontsize`**（打断列声明解析 → `Misplaced \crcr` 编译失败），要用 `\BeforeBeginEnvironment` + `\AfterEndEnvironment` 在环境外套 group。
3. **改 `\preauthor` 必须照 titling 默认那样自己开一个 `tabular`**、`\postauthor` 关掉它，否则多作者的 `\and` 一展开就是不配对的 tabular（报错还落在表格行上，很难联想到作者块）。

**手写表题自动转 pandoc 题注**：给了 `--caption-fontsize` 时，脚本先跑 `scripts/table_caption_to_pandoc.py`，把 write-paper 风格的 `**表1. …**`（写在表格上方的加粗段）改写成表后的 `: **表1.** …`——caption 宏包只作用于真 `\caption{}`，不转的话表题就是一段普通正文、字号和图题对不上。同时若题注自带编号（`![图1. …]`），自动加 `\captionsetup{labelformat=empty}`，避免渲染成 "Figure 1: 图1. …" 双重编号。
