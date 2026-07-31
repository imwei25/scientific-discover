---
name: render-docx
description: 把 Markdown 稿件渲染成 Word (.docx) 投稿版。医学期刊投稿绝大多数要 Word（不是 PDF），国自然正文、中文核心期刊也多用 .docx 模板。内置期刊格式预设（--journal nejm/lancet/jama/bmj/cmj/generic-submission：字体、字号、边距、双倍行距、连续行号、参考文献 CSL 一键落齐），也可单独指定 --font/--fontsize/--margin/--line-spacing/--line-numbers，或套用期刊 Word 模板（--reference-doc）；可按 GB/T 7714 等 CSL 渲染参考文献（仅当稿件用 pandoc `[@key]` 引用+.bib 时生效，本套件默认的 `[n]` 文本引用不适用）。用 pandoc，中文比 xelatex PDF 路线更不容易漏字。当用户说"出 Word""转 docx""投稿要 Word 版""按 XX 期刊格式排版""双倍行距加行号""生成 .docx"时使用。要出 PDF 用 render-pdf-doc；要查引用真实性用 reference-check。用户只说"排版"没指明格式时，先问要 PDF 还是投稿系统要的 Word。
---

# Markdown → Word (.docx) 投稿排版技能

> **产物位置**：所有产物一律写到主控注入的**会话专属目录** 当前工作目录（每轮开头会给出确切前缀，照抄即可）。
> 别写仓库根的固定名，也别写 `/app` 下的任意目录——`/app` 根不在任何数据卷上，容器一重建（改档位、重部署技能都会重建）产物就没了。

> 注：`<会话id>` 是**占位符**，执行前替换成主控给出的实际会话 id（原样复制进 shell 会因 `<` `>` 是重定向符而报错）。

医学期刊投稿系统绝大多数**只收 Word**，编辑修订、Turnitin 查重、作者返修也都基于 .docx。本技能把 Markdown 稿件转成 Word。相比 PDF（xelatex）路线，Word 有个好处：**中文更不容易漏字**——Word 存的是 UTF-8 文本、由系统字体自动候补，不像 xelatex 缺字就静默丢掉（但若 `--reference-doc` 模板把正文样式锁死成不含中文字形的西文字体，仍可能异常，一般 Word 会自动候补）。

## 依赖
需要 **pandoc**（仓库根 `install.ps1 -WithPdf` / `install.sh --with-pdf` 已装；单独装：`winget install JohnMacFarlane.Pandoc` / `apt-get install pandoc` / `brew install pandoc`）。**不需要 xelatex/MiKTeX**（那是 PDF 才要的）。

## 用法
脚本在 `/app/.opencode/skills/render-docx/scripts/`（容器内的实际路径；命令行里写 `${REPO_ROOT:-/app}/...` 由 shell 展开，但**散文里的路径要能直接拿去 Read/ls**，所以这里写实路径）（Windows 经 Git Bash 跑 .sh）：
```bash
# 最简：Markdown → Word
bash ${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh -i manuscript.md -o manuscript.docx

# ★ 按指定期刊格式排版（预设一键落：字体/字号/边距/行距/行号/参考文献样式）
bash ${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh -i manuscript.md --journal nejm
#   可用预设：nejm lancet jama bmj cmj(中华系列) generic-submission(通用送审)；--journal list 列出
#   预设值可被单项覆盖，如：--journal lancet --line-spacing 1.5

# 手动指定送审格式（不套预设）：双倍行距 + 连续行号 + Times 12pt + 1in 边距
bash ${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh -i manuscript.md \
  --font "Times New Roman" --fontsize 12 --margin 1in --line-spacing double --line-numbers

# 图表置于正文末尾（NEJM/JAMA/Lancet 送审稿要求，原位留"见文末"占位）
bash ${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh -i manuscript.md \
  --journal nejm --figures-at-end

# 中文稿指定中文字体（docx 的 eastAsia 字体，如宋体）
bash ${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh -i manuscript.md --journal cmj
#   （cmj 预设已含 宋体正文 + Times 西文 + 1.5 倍行距 + 2.5cm 边距 + GB/T 7714）

# 套用期刊/机构的 Word 模板（继承其样式与字体）；可与格式参数叠加，模板先套、参数后覆盖
bash ${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh -i manuscript.md --ref templates/journal_template.docx

# 按 GB/T 7714 渲染参考文献（仅当稿件用 pandoc @citekey 引用、配 .bib 时；见下方限制）
bash ${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh -i manuscript.md \
  --csl china-national-standard-gb-t-7714-2015-numeric --bib refs.bib
```
> **常用 CSL 已内置** 在 `presets/csl/`（vancouver / the-lancet / the-new-england-journal-of-medicine / american-medical-association / bmj / china-national-standard-gb-t-7714-2015-numeric），`--csl` 直接写名字即可（不必带路径和 .csl 后缀）；期刊预设配 `--bib` 时自动选用对应样式。要别的样式：本仓库 `backend/.venv/Lib/site-packages/citeproc_styles/styles/` 内置 5 万+ 官方 CSL 可拷进 `presets/csl/`，或从 `citation-style-language/styles` / `zotero-chinese/styles` 下载后 `--csl` 指绝对路径。

## 说明
- **期刊/标书预设（`--journal`）**：预设文件在 `presets/*.env`（与 render-pdf-doc 共用），一个参数落齐页面格式 + 参考文献样式；渲染完会打印该预设的 `PRESET_NOTE` 提醒预设覆盖不到的要求（字数、结构式摘要、图表数等）。预设值可被命令行单项覆盖。除期刊外另有标书预设：`most-key-rd`（重点研发）/`municipal-sci`（市科局）/`nih-forms-i`（NIH）/`hospital-fund`（院内基金）。加新预设见 `presets/README.md`。
- **标题与正文分开设字体字号**：`--heading-cjk-font 黑体 --heading-fontsize 14` 单独控制 Heading 1-6 的中文字体与字号（各级统一；Title/Subtitle 不动）——中式标书"标题黑体四号、正文宋体小四"靠这对参数（标书预设已内置）。仅 docx 侧支持，PDF 侧忽略。
- **格式参数的实现**：pandoc 本身不管字体/边距/行距，脚本在 pandoc 之后用 python-docx（项目根 `.venv`）后处理落格式——改 Normal/Body Text/标题样式的字体（含 eastAsia 中文字体）、字号、行距，改节属性的边距与 `w:lnNumType` 连续行号。**格式参数后处理失败会报错退出（exit 5）**，不会静默给你一个没格式的产物。
- **中文字体**：不给 `--journal`/`--cjk-font`/`--reference-doc` 时 pandoc 用内置默认模板，中文能显示但字体是"等线"之类、并非期刊要求的宋体/黑体/仿宋。**中文投稿至少用 `--journal cmj` 或 `--cjk-font 宋体`**；有期刊官方 Word 模板则 `--reference-doc` 更优——参考文献悬挂缩进、表格线型、题注这些更细的格式仍以模板为准。
- **期刊模板**：多数中华系列/SCI 期刊提供 Word 模板。把模板作为 `--reference-doc` 传入，pandoc 套用其"Normal/标题/表格"等样式——比手动排版稳。用户有目标刊模板就优先用它。
- **参考文献两种情形（重要，先分清）**：
  - **稿件里已是写好的 `[n]` 编号引用文本**（本套件 `search-lit`/`write-paper` 的默认产出形态）→ 直接转，`--csl` **用不上**、不要传。想改成 GB/T 7714 格式得手工调或让写作阶段就按国标写。
  - 稿件用 pandoc 引用键 `[@Smith2024]` + 提供 `.bib` → 加 `--csl`（见上方下载说明）+ `--bib`，pandoc 自动生成文末参考文献表并按国标格式化。
- **图表**：Markdown 里 `![标题](图片路径)` 的图会嵌入 docx；出版级图先用 `nature-figure` 生成 PNG/TIFF 再引用。注意嵌入的图标题只是普通文字，**不是 Word 自动编号的"题注域"**，增删图后编号要手工核对。
- **渲染前规范化（默认开，最先跑，`normalize_md.py`）**：关闭用 `--no-normalize`。做两件事，围栏代码块内一律不碰。
  1. **块级补空行**：pandoc 要求 pipe 表格**前面有空行**。而写作阶段极常见地把表题贴着表格写（`**表1 …**` 下一行直接 `| 列 | 列 |`），此时 pandoc 把整张表当成表题那一段的"懒续行"——**表被摊平成纯文本、docx 里一个 `<w:tbl>` 都没有，且全程不报错**。标题、列表贴着正文写也一样会被吞。
  2. **Unicode 上下标 → 真上下标**：`FT₃`、`10⁻⁴`、`10⁹` 这类写法**不是格式、是普通字符**，渲染全看字体里有没有那个字形——而**宋体/等线只有 ² ³ ¹，缺 ⁻ ⁴ ⁵ ⁹ 和全部下标 ₀-₉**（微软雅黑也缺 ⁻ ⁹ ₃ ₄）。缺字形时 Word 临时换字体去顶，于是「10」是宋体、「⁻⁴」是另一套字体，字重/大小/基线全对不上。这解释了为什么 `m²` 正常而 `10⁹` 就坏——**症状时有时无，最难排查**。转成 pandoc 的 `^-4^`／`~3~` 后生成 `w:vertAlign` 真上下标，字符是普通 ASCII、任何字体都有，字号随正文自动缩放。
  > 实测（2026-07-31）：一份 123 行、含 3 张结果表的中文稿，不补空行 → **0 张表、53 段**；补了 → **4 张表、260 段**。注意 `infer_colwidths` 与三线表后处理都以"能认出这是张表"为前提，表没被识别时那两层兜底全部空转——所以这一步必须排在最前面。**交稿前务必核对 docx 里表格数与稿件一致**，这个失败模式是静默的。
  > **写作阶段就该写对**：正文里请直接用 `FT~3~`、`10^9^/L`、`m^2^`，别用 Unicode 上下标字符，也别平排写成 `FT3`/`10^9/L`（后者连上下标都没有）。
  > 实测（2026-07-31，一份 123 行、含 3 张结果表的中文稿）：不补 → **0 张表、53 段**；补了 → **4 张表、260 段**。注意后面的 `infer_colwidths` 与三线表后处理都以"能认出这是张表"为前提，表没被识别时那两层兜底全部空转——所以这一步必须排在最前面。**交稿前务必核对 docx 里表格数与稿件一致**，这个失败模式是静默的。
- **表格自动排版（默认开）**：pandoc 直转的 docx 表格要么 autofit（Word 自动布局、宽度不可预测）要么按分隔行均分列宽，长列名必然排丑。脚本默认做两层兜底：① 渲染前跑 `infer_colwidths.py`（借用 render-pdf-doc 的，CJK 按 2 格计宽）按内容重写 pipe 表分隔行比例；② 渲染后 python-docx 后处理：**三线表**（顶/底 1.5pt、表头下线 0.75pt、去竖线）、按内容分配**固定列宽**（tblLayout fixed + gridCol/tcW 双写，超长列封顶靠换行、短列保底）、表内字号比正文降 1.5pt（下限 9pt）、表头加粗居中、表内单倍行距（不吃正文双倍行距）。含合并单元格的表只调样式不动列宽。**表按内容连保底宽都放不下时打印 WARN**（建议列名改缩写/转置/拆表，见 write-paper 表格排版铁律）——见到这警告别硬交，回稿件改表。关闭用 `--no-infer-colwidths` / `--no-table-tune`（用期刊官方 `--ref` 模板且其表格样式更权威时可关后者）。

## 当前限制（如实告知用户，别假装能做）
- **修订模式 (track changes)**：返修阶段期刊常要保留修订痕迹，本脚本裸转不产生 track changes；需要的话在 Word 里开启修订后再改。
- **双栏**：送审稿几乎都是单栏（双栏是期刊出版排版，投稿不需要）；确需双栏靠 `--reference-doc` 模板。
- **`[n]` 文本引用不能被 CSL 重排**：本套件 `write-paper` 默认产出 `[n]` 编号文本引用，`--csl` 对它无效（只认 `[@key]`+.bib）。要换参考文献样式得回写作层改，或手工调。
- **题注自动编号**：嵌入图/表的编号非 Word 域，增删后要手工核对。
- **图表置文末**：用 `--figures-at-end` 自动把独占行的图与 pipe 表格搬到正文末的"# 图表"下、原位留占位提示（只搬独占行图/标准 pipe 表，行内图与代码块内伪表不动）。表格上方的 `**表n**` 题注随表一并搬走，题注与表间自动补空行（否则 pandoc 不识别为表格、会渲染成裸竖线文本）。与 `--csl` 并用时自动插文献锚点，令参考文献表排在图表之前（正文→参考文献→图表）。
- **`[n]` 引用传 CSL 会警告不改写**：稿件无 `[@key]` 却传 `--csl/--bib` 时脚本打印 WARN 并原样保留引用（不再静默 no-op）；要按期刊样式重排须用 `[@key]`+.bib。

## 衔接
- 上游：`write-paper`（论文）、`grant-proposal`（标书）、`literature-review`（综述）等写完 `.md`，交本技能出 Word。
- 引用真实性：出稿前把参考文献交 `reference-check` 核查（本技能只排版、不核查）。
- 要 PDF 版：用 `render-pdf-doc`。

## 约定
- 产出写 `outputs/`（或工作区约定路径）。
- 渲染后**打开 Word 抽查**：中文显示正常、表格未错位、图已嵌入、参考文献格式对。
- 不虚构内容：本技能只做格式转换，不改写、不补数据。
