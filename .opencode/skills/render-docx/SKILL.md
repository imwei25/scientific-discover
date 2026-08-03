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

## 默认送审格式：`--journal generic-submission`（用户没指定期刊时就用它）
**用户没说投哪个刊、或说"不知道投什么期刊" → 一个参数出件，别再逐项问格式**：
```bash
bash ${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh -i manuscript.md --journal generic-submission
```
预设落齐：Times New Roman（中文宋体）12pt / 双倍行距 / 连续行号 / 页脚居中页码 /
正文首行缩进 4 个英文字符 / 图题表题 10.5pt 居中且序号加粗 / 表内 10pt 单倍行距 /
三线表（顶底 1.5 磅、表头下 0.5 磅）/ 论文标题 16pt、一级标题 14pt、其余标题 12pt 全加粗 /
作者与机构 10.5pt 居中 / 1in 边距（`--margin 0.75in` 可换窄边距）。

**用户指定了期刊** → 先看 `--journal list` 有无现成预设；没有就 **WebFetch 该刊的
Instructions for Authors** 取其字体字号/行距/行号/图表位置/参考文献风格，再用下面的单项参数落，
或照 `presets/README.md` 存成新预设。查不到就如实说明、退回 `generic-submission`，
**别凭印象编该刊要求**。

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

# 细排单项（各自可单独用，也可覆盖预设值）：页码 / 首行缩进 / 图表题与表内字号 / 分级标题字号 / 作者块
bash ${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh -i manuscript.md \
  --page-numbers --indent-chars 4 --caption-fontsize 10.5 --table-fontsize 10 \
  --title-fontsize 16 --h1-fontsize 14 --heading-fontsize 12 --author-fontsize 10.5

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
- **渲染前规范化（默认开，最先跑，`normalize_md.py`）**：关闭用 `--no-normalize`。做两件事，围栏代码块内一律不碰。
  1. **块级补空行**：pandoc 要求 pipe 表格**前面有空行**。而写作阶段极常见地把表题贴着表格写（`**表1 …**` 下一行直接 `| 列 | 列 |`），此时 pandoc 把整张表当成表题那一段的"懒续行"——**表被摊平成纯文本、docx 里一个 `<w:tbl>` 都没有，且全程不报错**。标题、列表贴着正文写也一样会被吞。
  2. **Unicode 上下标 → 真上下标**：`FT₃`、`10⁻⁴`、`10⁹` 这类写法**不是格式、是普通字符**，渲染全看字体里有没有那个字形——而**宋体/等线只有 ² ³ ¹，缺 ⁻ ⁴ ⁵ ⁹ 和全部下标 ₀-₉**（微软雅黑也缺 ⁻ ⁹ ₃ ₄）。缺字形时 Word 临时换字体去顶，于是「10」是宋体、「⁻⁴」是另一套字体，字重/大小/基线全对不上。这解释了为什么 `m²` 正常而 `10⁹` 就坏——**症状时有时无，最难排查**。转成 pandoc 的 `^-4^`／`~3~` 后生成 `w:vertAlign` 真上下标，字符是普通 ASCII、任何字体都有，字号随正文自动缩放。
  > 实测（2026-07-31）：一份 123 行、含 3 张结果表的中文稿，不补空行 → **0 张表、53 段**；补了 → **4 张表、260 段**。注意 `infer_colwidths` 与三线表后处理都以"能认出这是张表"为前提，表没被识别时那两层兜底全部空转——所以这一步必须排在最前面。**交稿前务必核对 docx 里表格数与稿件一致**，这个失败模式是静默的。
  > **写作阶段就该写对**：正文里请直接用 `FT~3~`、`10^9^/L`、`m^2^`，别用 Unicode 上下标字符，也别平排写成 `FT3`/`10^9/L`（后者连上下标都没有）。
  > 实测（2026-07-31，一份 123 行、含 3 张结果表的中文稿）：不补 → **0 张表、53 段**；补了 → **4 张表、260 段**。注意后面的 `infer_colwidths` 与三线表后处理都以"能认出这是张表"为前提，表没被识别时那两层兜底全部空转——所以这一步必须排在最前面。**交稿前务必核对 docx 里表格数与稿件一致**，这个失败模式是静默的。
- **表格自动排版（默认开）**：pandoc 直转的 docx 表格要么 autofit（Word 自动布局、宽度不可预测）要么按分隔行均分列宽，长列名必然排丑。脚本默认做两层兜底：① 渲染前跑 `infer_colwidths.py`（借用 render-pdf-doc 的，CJK 按 2 格计宽）按内容重写 pipe 表分隔行比例；② 渲染后 python-docx 后处理：**三线表**（顶/底 1.5pt、表头下线 0.75pt、去竖线）、按内容分配**固定列宽**（tblLayout fixed + gridCol/tcW 双写，超长列封顶靠换行、短列保底）、表内字号比正文降 1.5pt（下限 9pt）、表头加粗居中、表内单倍行距（不吃正文双倍行距）。含合并单元格的表只调样式不动列宽。**表按内容连保底宽都放不下时打印 WARN**（建议列名改缩写/转置/拆表，见 write-paper 表格排版铁律）——见到这警告别硬交，回稿件改表。关闭用 `--no-infer-colwidths` / `--no-table-tune`（用期刊官方 `--ref` 模板且其表格样式更权威时可关后者）。
- **跨页表兜底（默认开，随 `--table-tune`）**：期刊接受表格跨页，难看的是**跨页后没表头**、或**某一行被从中间劈成两半**。故每张表默认设首行 `tblHeader`（每页重复表头）+ 各行 `cantSplit`（禁止行内断页）——不改任何内容。表超过 20 行时另打印一条提示，告诉你它必然跨页、若要求单页放下就得拆表或移入补充材料。
- **宽表转横向（`--landscape-wide-tables`，默认关）**：列太多、纵向版心按内容压不下时，把该表**连同表题与表注**单独放进一个横向节（前后各插一个分节符，只有这一节横向，正文其余部分不受影响）。A4 纵向版心约 470pt，转横向后约 720pt，多出 50%。用法：`--journal cmj --landscape-wide-tables`。
  > 转横向是排版层的最后一招，**治标不治本**：源头把列名缩短、拆表、或把次要列移进补充材料，才是投稿更稳的做法（见 `write-paper` 表格排版铁律第 1/3 条）。

## 当前限制（如实告知用户，别假装能做）
- **页数不统计**：脚本不知道成稿有多少页（分页由 Word 排版时决定）。"正文 ≤30 页"这类要求得让用户打开 Word 自己看，别口头保证。
- **参考文献的期刊全称 / et al. 规则管不了**：`[n]` 文本引用是写作阶段定死的文字，排版层不重排（`--csl` 只认 `[@key]`+.bib）。要"期刊名全称、第 3 位作者后 et al."得在 `write-paper` 阶段写对。
- **图表位置**：脚本按稿件里图表所在位置渲染（默认即"放正文对应位置"）；要后置得显式加 `--figures-at-end`。
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
