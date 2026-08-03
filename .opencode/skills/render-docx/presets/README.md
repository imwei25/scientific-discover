# 期刊/标书格式预设（render-docx 与 render-pdf-doc 共用）

每个 `<名>.env` 是一个期刊送审稿或标书的格式预设，被 `render_docx.sh --journal <名>` 与
`render_pdf.sh --journal <名>` 读取（render-pdf-doc 通过相对路径引用本目录，
两技能共用同一份，别复制出第二份）。

## 字段

| 字段 | 含义 | 例 |
|---|---|---|
| `PRESET_MARGIN` | 页边距（`1in` / `2.5cm`） | `1in` |
| `PRESET_FONT` | 西文正文字体 | `Times New Roman` |
| `PRESET_CJKFONT` | 中文正文字体（docx 的 eastAsia 字体；PDF 中文走 ctex 自动宋体，一般留空） | `宋体` |
| `PRESET_FONTSIZE` | 字号 pt（PDF 侧受 LaTeX 限制只认 10/11/12） | `12` |
| `PRESET_LINESPACING` | 行距倍数（1.0/1.5/2.0） | `2.0` |
| `PRESET_LINENUMBERS` | 连续行号（1 开 / 0 关） | `1` |
| `PRESET_CSL` | 参考文献 CSL 文件名，指向本目录 `csl/`；仅当稿件用 `[@key]` 引用 + `--bib` 时生效 | `vancouver.csl` |
| `PRESET_HEADING_CJKFONT` | 标题(Heading 1-6)中文字体，与正文分开（标书"标题黑体、正文宋体"）；**仅 docx 侧生效**，PDF 侧忽略 | `黑体` |
| `PRESET_HEADING_FONTSIZE` | 标题字号 pt（各级统一；四号=14）；**仅 docx 侧生效** | `14` |
| `PRESET_TITLE_FONTSIZE` | 论文标题(Title 样式，来自稿件 YAML `title:`)字号 pt；**仅 docx 侧生效** | `16` |
| `PRESET_H1_FONTSIZE` | 一级标题(Heading 1)字号 pt，覆盖统一值；**仅 docx 侧生效** | `14` |
| `PRESET_PAGENUMBERS` | 页脚居中页码（1 开 / 0 关）；PDF 侧 LaTeX 本就带页码，忽略此项 | `1` |
| `PRESET_INDENT_CHARS` | 正文每段首行缩进的英文半角字符数；**仅 docx 侧生效**（PDF 中文走 ctex 自带 2 字缩进） | `4` |
| `PRESET_CAPTION_FONTSIZE` | 图题/表题/表注字号 pt（图表题并居中、单倍行距、序号加粗）；**仅 docx 侧生效** | `10.5` |
| `PRESET_TABLE_FONTSIZE` | 表内字号 pt（不给则正文-1.5pt）；**仅 docx 侧生效** | `10` |
| `PRESET_AUTHOR_FONTSIZE` | 作者/机构块字号 pt 并居中（稿件 YAML `author:` 生成的 Author 样式段）；**仅 docx 侧生效** | `10.5` |
| `PRESET_NOTE` | 渲染时打印给用户的提示（预设覆盖不到的期刊要求） | — |

> 动了任一标题字号字段后，docx 侧会顺带把 Title/Heading 1-6 统一**加粗 + 黑色**
> （pandoc 默认模板标题是主题蓝、非加粗，期刊送审稿不能是蓝的）。

## 现有预设

- 期刊：`nejm` `lancet` `jama` `bmj` `cmj`（中华系列） `generic-submission`（通用送审）
- 标书：`most-key-rd`（重点研发） `municipal-sci`（市科技局） `nih-forms-i`（NIH） `hospital-fund`（院内基金）——格式值取自 `grant-proposal/references/` 对应文件，无官方来源的字段留空不编

## 加新期刊

拷一个最接近的 `.env` 改字段即可；需要新参考文献样式时把 CSL 放进 `csl/`
（本仓库 `backend/.venv/Lib/site-packages/citeproc_styles/styles/` 内置 5 万+ 可拷）。
预设只覆盖"页面格式 + 参考文献样式"，字数限制、结构式摘要、图表数量等编辑性要求
写进 `PRESET_NOTE` 提醒，不由脚本处理。
