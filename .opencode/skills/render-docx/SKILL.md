---
name: render-docx
description: 把 Markdown 稿件渲染成 Word (.docx) 投稿版。医学期刊投稿绝大多数要 Word（不是 PDF），国自然正文、中文核心期刊也多用 .docx 模板。支持套用期刊 Word 模板（--reference-doc）；可选按 GB/T 7714 等 CSL 渲染参考文献（仅当稿件用 pandoc `[@key]` 引用+.bib 时生效，本套件默认的 `[n]` 文本引用不适用）。用 pandoc，中文比 xelatex PDF 路线更不容易漏字。当用户说"出 Word""转 docx""投稿要 Word 版""按期刊模板排版""生成 .docx"时使用。要出 PDF 用 render-pdf-doc；要查引用真实性用 reference-check。用户只说"排版"没指明格式时，先问要 PDF 还是投稿系统要的 Word。
---

# Markdown → Word (.docx) 投稿排版技能

医学期刊投稿系统绝大多数**只收 Word**，编辑修订、Turnitin 查重、作者返修也都基于 .docx。本技能把 Markdown 稿件转成 Word。相比 PDF（xelatex）路线，Word 有个好处：**中文更不容易漏字**——Word 存的是 UTF-8 文本、由系统字体自动候补，不像 xelatex 缺字就静默丢掉（但若 `--reference-doc` 模板把正文样式锁死成不含中文字形的西文字体，仍可能异常，一般 Word 会自动候补）。

## 依赖
需要 **pandoc**（仓库根 `install.ps1 -WithPdf` / `install.sh --with-pdf` 已装；单独装：`winget install JohnMacFarlane.Pandoc` / `apt-get install pandoc` / `brew install pandoc`）。**不需要 xelatex/MiKTeX**（那是 PDF 才要的）。

## 用法
脚本在 `.opencode/skills/render-docx/scripts/`，从仓库根运行或用全路径（Windows 经 Git Bash 跑 .sh）：
```bash
# 最简：Markdown → Word
bash .opencode/skills/render-docx/scripts/render_docx.sh -i outputs/manuscript.md -o outputs/manuscript.docx

# 套用期刊/机构的 Word 模板（继承其样式与字体）——中文投稿几乎必须
bash .opencode/skills/render-docx/scripts/render_docx.sh -i outputs/manuscript.md --ref templates/journal_template.docx

# 按 GB/T 7714 渲染参考文献（仅当稿件用 pandoc @citekey 引用、配 .bib 时；见下方限制）
bash .opencode/skills/render-docx/scripts/render_docx.sh -i outputs/manuscript.md \
  --csl /path/to/gb-t-7714-2015-numeric.csl --bib outputs/refs.bib
```
> **CSL 文件本仓库未内置**，需自行下载：GB/T 7714-2015 numeric CSL 见 `citation-style-language/styles` 仓库（文件名 `china-national-standard-gb-t-7714-2015-numeric.csl`），或中文社区 `zotero-chinese/styles`（含中华医学会样式）、Gitee 镜像 `redleafnew00/Chinese-STD-GB-T-7714-related-csl`。下好放任意路径，`--csl` 指过去即可。

## 说明
- **中文字体**：不给 `--reference-doc` 时 pandoc 用内置默认模板，中文能显示但字体是"等线"之类、并非期刊要求的宋体/黑体/仿宋。**中文投稿默认应配期刊 Word 模板（`--reference-doc`），不是可选优化项**——字体、参考文献悬挂缩进、表格线型、题注这些期刊在意的格式，裸转基本满足不了，裸转产物"能读"但通常不达投稿格式要求。
- **期刊模板**：多数中华系列/SCI 期刊提供 Word 模板。把模板作为 `--reference-doc` 传入，pandoc 套用其"Normal/标题/表格"等样式——比手动排版稳。用户有目标刊模板就优先用它。
- **参考文献两种情形（重要，先分清）**：
  - **稿件里已是写好的 `[n]` 编号引用文本**（本套件 `search-lit`/`write-paper` 的默认产出形态）→ 直接转，`--csl` **用不上**、不要传。想改成 GB/T 7714 格式得手工调或让写作阶段就按国标写。
  - 稿件用 pandoc 引用键 `[@Smith2024]` + 提供 `.bib` → 加 `--csl`（见上方下载说明）+ `--bib`，pandoc 自动生成文末参考文献表并按国标格式化。
- **图表**：Markdown 里 `![标题](图片路径)` 的图会嵌入 docx；出版级图先用 `nature-figure` 生成 PNG/TIFF 再引用。注意嵌入的图标题只是普通文字，**不是 Word 自动编号的"题注域"**，增删图后编号要手工核对。

## 当前限制（如实告知用户，别假装能做）
- **修订模式 (track changes)**：返修阶段期刊常要保留修订痕迹，本脚本裸转不产生 track changes；需要的话在 Word 里开启修订后再改。
- **行号 / 双倍行距 / 双栏**：多数期刊送审稿要求行号 + 双倍行距，pandoc 不会自动加，只能靠 `--reference-doc` 模板预置这些样式。
- **题注自动编号**：见上，嵌入图/表的编号非 Word 域。

## 衔接
- 上游：`write-paper`（论文）、`grant-proposal`（标书）、`literature-review`（综述）等写完 `.md`，交本技能出 Word。
- 引用真实性：出稿前把参考文献交 `reference-check` 核查（本技能只排版、不核查）。
- 要 PDF 版：用 `render-pdf-doc`。

## 约定
- 产出写 `outputs/`（或工作区约定路径）。
- 渲染后**打开 Word 抽查**：中文显示正常、表格未错位、图已嵌入、参考文献格式对。
- 不虚构内容：本技能只做格式转换，不改写、不补数据。
