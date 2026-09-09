---
name: render-docx
description: 把 Markdown 稿件渲染成 Word (.docx) 投稿版：内置期刊预设（--journal nejm/lancet/jama/bmj/cmj/generic-submission）一键落齐字体/行距/行号/CSL，也可单独指定参数或套 Word 模板。触发："出 Word""转 docx""按 XX 期刊排版""双倍行距加行号"。出 PDF 用 render-pdf-doc；只说"排版"先问 PDF 还是 Word。
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
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md --journal generic-submission
```
预设落齐：Times New Roman（中文宋体）12pt / **1.5 倍行距** / **不加行号** / 页脚居中页码 /
正文首行缩进 4 个英文字符 / 图题表题 10.5pt 居中且序号加粗 / 表内 10pt 单倍行距 /
三线表（顶底 1.5 磅、表头下 0.5 磅）且**表宽拉满版心** / 论文标题 16pt、一级标题 14pt、其余标题 12pt 全加粗 /
作者与机构 10.5pt 居中 / 1in 边距（`--margin 0.75in` 可换窄边距）。

目标刊明确要求双倍行距 + 连续行号（NEJM/JAMA/Lancet/BMJ 系送审稿）时，用对应期刊预设，
或在默认预设上补 `--line-spacing double --line-numbers`。

**用户指定了期刊** → 先看 `--journal list` 有无现成预设；没有就 **WebFetch 该刊的
Instructions for Authors** 取其字体字号/行距/行号/图表位置/参考文献风格，再用下面的单项参数落，
或照 `presets/README.md` 存成新预设。查不到就如实说明、退回 `generic-submission`，
**别凭印象编该刊要求**。

## 用法
脚本在 `/app/.opencode/skills/render-docx/scripts/`（容器内的实际路径；命令行里写 `"${REPO_ROOT:-/app}/..."` 由 shell 展开，但**散文里的路径要能直接拿去 Read/ls**，所以这里写实路径）（Windows 经 Git Bash 跑 .sh）：
```bash
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md --journal nejm
```
- `--journal`：可用预设 nejm lancet jama bmj cmj(中华系列) generic-submission(通用送审)，`--journal list` 列出；预设值可被单项覆盖，如 `--journal lancet --line-spacing 1.5`；图表后置加 `--figures-at-end`；套期刊/机构 Word 模板用 `--ref 模板.docx`（模板先套、参数后覆盖）。
- 全部参数看 `bash scripts/render_docx.sh --help`；辅助脚本参数看 `python scripts/normalize_md.py --help`、`python scripts/postprocess_docx.py --help`、`python scripts/figures_at_end.py --help`。
- 完整命令示例（最简转换、手动指定送审格式、细排单项、图表置文末、中文字体、模板、GB/T 7714 CSL）与内置 CSL 清单已搬至 `references/command-examples.md`。

## 说明
- **排版参数细则**（期刊/标书预设 `--journal`、分级标题字号、页码/首行缩进/题注/表内字号/作者块、标题与正文分开设字体字号、格式参数的实现、中文字体、期刊模板、参考文献两种情形、图表）已搬至 `references/layout-parameters.md`。其中硬约束：**中文投稿至少用 `--journal cmj` 或 `--cjk-font 宋体`**；稿件已是写好的 `[n]` 编号引用文本时 `--csl` **用不上、不要传**；格式参数后处理失败会报错退出（exit 5），不会静默给没格式的产物。
- **渲染前规范化（`normalize_md.py`，默认开）、表格自动排版、跨页表兜底、宽表转横向（`--landscape-wide-tables`）** 已搬至 `references/normalize-and-tables.md`。其中硬约束：**交稿前务必核对 docx 里表格数与稿件一致**（表没被识别时静默丢表、不报错）；**表按内容连保底宽都放不下时打印 WARN——见到这警告别硬交，回稿件改表**。

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
