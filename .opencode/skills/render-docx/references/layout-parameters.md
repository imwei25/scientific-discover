> 本文件从 SKILL.md「说明」搬出（前 9 条：期刊/标书预设 … 图表），由 SKILL.md 在需要各排版参数的完整说明、中文字体/期刊模板/参考文献处理细则时引用。

# 排版参数细则（原 SKILL.md「说明」）

- **期刊/标书预设（`--journal`）**：预设文件在 `presets/*.env`（与 render-pdf-doc 共用），一个参数落齐页面格式 + 参考文献样式；渲染完会打印该预设的 `PRESET_NOTE` 提醒预设覆盖不到的要求（字数、结构式摘要、图表数等）。预设值可被命令行单项覆盖。除期刊外另有标书预设：`most-key-rd`（重点研发）/`municipal-sci`（市科局）/`nih-forms-i`（NIH）/`hospital-fund`（院内基金）。加新预设见 `presets/README.md`。
- **分级标题字号**：`--heading-fontsize` 管 Heading 1-6（统一值），`--h1-fontsize` 单独覆盖一级标题，`--title-fontsize` 管稿件 YAML `title:` 生成的论文标题。**给了任一标题字号，就顺带把 Title/Heading 1-6 统一改成加粗 + 黑色**——pandoc 默认模板的标题是主题蓝且不加粗，送审稿不能是蓝的。
- **页码 / 首行缩进 / 题注 / 表内字号 / 作者块**（`--page-numbers` `--indent-chars N` `--caption-fontsize PT` `--table-fontsize PT` `--author-fontsize PT`）：
  - `--page-numbers` 在页脚居中插 PAGE 域（pandoc 默认模板不带页码，审稿人没法按页提意见）。
  - `--indent-chars N` 按 0.5em/字符折算首行缩进（4 字符 ≈ 24pt @12pt 正文）。**pandoc 模板里几乎所有样式都 base=Normal**，所以脚本会把标题、题名块、题注、列表、代码块、页眉页脚的首行缩进显式清零——不清就会被继承，标题整体被顶进去 4 个字符。
  - `--caption-fontsize` 同时作用于 pandoc 题注样式与稿件里手写的 `**表1. …**` 题注段：设字号、单倍行距、**只加粗序号前缀**（说明文字改常规）、图表题居中、去掉 pandoc 默认的斜体；表注 / 图注（`表注：`/`注：`/`Note.` 开头）跟着用同一字号但不居中。表题另加"与下段同页"，否则分页时表题留在上一页页脚、表格甩到下一页。
    - ⚠️ 手写题注**必须整段加粗**（`**表1. 基线特征**`）才会被认出来——否则以"表2 显示……"开头的正文段会被误判成题注拉去居中。
  - `--table-fontsize` 显式定表内字号；不给则沿用旧行为（正文 −1.5pt、下限 9pt）。
- **标题与正文分开设字体字号**：`--heading-cjk-font 黑体 --heading-fontsize 14` 单独控制 Heading 1-6 的中文字体与字号（各级统一；Title/Subtitle 不动）——中式标书"标题黑体四号、正文宋体小四"靠这对参数（标书预设已内置）。仅 docx 侧支持，PDF 侧忽略。
- **格式参数的实现**：pandoc 本身不管字体/边距/行距，脚本在 pandoc 之后用 python-docx（项目根 `.venv`）后处理落格式——改 Normal/Body Text/标题样式的字体（含 eastAsia 中文字体）、字号、行距，改节属性的边距与 `w:lnNumType` 连续行号。**格式参数后处理失败会报错退出（exit 5）**，不会静默给你一个没格式的产物。
- **中文字体**：不给 `--journal`/`--cjk-font`/`--reference-doc` 时 pandoc 用内置默认模板，中文能显示但字体是"等线"之类、并非期刊要求的宋体/黑体/仿宋。**中文投稿至少用 `--journal cmj` 或 `--cjk-font 宋体`**；有期刊官方 Word 模板则 `--reference-doc` 更优——参考文献悬挂缩进、表格线型、题注这些更细的格式仍以模板为准。
- **期刊模板**：多数中华系列/SCI 期刊提供 Word 模板。把模板作为 `--reference-doc` 传入，pandoc 套用其"Normal/标题/表格"等样式——比手动排版稳。用户有目标刊模板就优先用它。
- **参考文献两种情形（重要，先分清）**：
  - **稿件里已是写好的 `[n]` 编号引用文本**（本套件 `search-lit`/`write-paper` 的默认产出形态）→ 直接转，`--csl` **用不上**、不要传。想改成 GB/T 7714 格式得手工调或让写作阶段就按国标写。
  - 稿件用 pandoc 引用键 `[@Smith2024]` + 提供 `.bib` → 加 `--csl`（见上方下载说明）+ `--bib`，pandoc 自动生成文末参考文献表并按国标格式化。
- **图表**：Markdown 里 `![标题](图片路径)` 的图会嵌入 docx；出版级图先用 `nature-figure` 生成 PNG/TIFF 再引用。注意嵌入的图标题只是普通文字，**不是 Word 自动编号的"题注域"**，增删图后编号要手工核对。
