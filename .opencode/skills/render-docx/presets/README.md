# 期刊格式预设（render-docx 与 render-pdf-doc 共用）

每个 `<名>.env` 是一个期刊送审稿格式预设，被 `render_docx.sh --journal <名>` 与
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
| `PRESET_NOTE` | 渲染时打印给用户的提示（预设覆盖不到的期刊要求） | — |

## 现有预设

`nejm` `lancet` `jama` `bmj` `cmj`（中华系列） `generic-submission`（通用送审）

## 加新期刊

拷一个最接近的 `.env` 改字段即可；需要新参考文献样式时把 CSL 放进 `csl/`
（本仓库 `backend/.venv/Lib/site-packages/citeproc_styles/styles/` 内置 5 万+ 可拷）。
预设只覆盖"页面格式 + 参考文献样式"，字数限制、结构式摘要、图表数量等编辑性要求
写进 `PRESET_NOTE` 提醒，不由脚本处理。
