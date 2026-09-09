---
name: render-pdf-doc
description: Render academic Markdown (Chinese/English/Korean) to publication-quality PDF via pandoc + xelatex: proposals (含国自然标书), cover letters, handouts, reference tables; CJK-aware, auto table widths. Not for citation checks or plots. Word output → render-docx; bare "排版" → ask PDF vs Word first.
triggers: render PDF, PDF 렌더, korean PDF, 한글 PDF, anchor doc PDF, briefing PDF, proposal PDF, 연구계획서 PDF, 표 정렬 PDF, 표 폭 자동, tbl-colwidths, 학술 PDF
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---

> **本仓库运行环境（先读）**：Python 由 `render_pdf.sh` 自动解析（优先项目根 `.venv`，再回退 `python3/python/py`——不再写死 `python3`，否则 Windows 上中文检测会失灵）；本技能脚本在 `"${REPO_ROOT:-/app}/.opencode/skills/render-pdf-doc/"` 下，运行时先 `cd` 到该目录或用全路径；产出写 `outputs/`（有会话专属目录时以它为准、勿写仓库根固定名）。需要 **pandoc + xelatex + ctex**（仓库根 install.ps1 -WithPdf / install.sh --with-pdf 已装；Linux 需 `texlive-lang-chinese`，Windows MiKTeX 首次渲染自动补装 ctex）；先跑 `bash scripts/check_deps.sh` 自检。
>
> **中文全自动、零参数**：`render_pdf.sh` 扫描稿件，**含汉字时自动走 `ctexart` 文档类**——宋体正文 / 黑体标题、标点避头尾、首行缩进、页眉页码，英文数字用 Times，代码框等宽字体覆盖制表符 `├└│─`（Windows Consolas / macOS Menlo / Linux DejaVu Sans Mono）。含韩文时走原 article 路径（Malgun Gothic / Noto CJK KR / Apple SD Gothic Neo）。**中文稿不必再加 `--cjk-font`**。若 frontmatter 写了 `CJKmainfont` 或命令行传了 `--cjk-font`，脚本会尊重覆盖。
>
> **默认送审格式（用户没指定期刊时用它）**：`--journal generic-submission` 一键落齐——Times New Roman 12pt、1.5 倍行距、不加行号（目标刊要求双倍行距+行号时补 `--line-spacing double --line-numbers` 或用该刊预设）、页码（LaTeX 本就有）、正文首行缩进 4 个英文字符、图题表题 10.5pt 居中且序号加粗、表内 10pt、论文标题 16pt / 一级标题 14pt / 其余 12pt 全加粗、作者与机构 10.5pt 居中、1in 边距。**用户指定了期刊**则先看有无现成预设，没有就 WebFetch 该刊 Instructions for Authors 后按其要求给参数；查不到就如实说明并退回本预设，别编该刊要求。**注意 PDF 侧几处硬限制见下方「送审细排参数」**——要求严格时优先出 Word（`render-docx`），医学期刊投稿系统本来也多只收 .docx。
>
> **期刊送审格式**：`render_pdf.sh` 支持 `--journal nejm|lancet|jama|bmj|cmj|generic-submission`（预设与 render-docx 共用，`--journal list` 列出）一键落齐边距/字号/行距/行号/参考文献 CSL；也可单项指定 `--margin 1in`、`--fontsize 12`（LaTeX 只认 10/11/12）、`--line-spacing double`（或数字倍数）、`--line-numbers`（lineno 连续行号）、`--figures-at-end`（图表搬到正文末，NEJM/JAMA/Lancet 要求）、`--csl vancouver --bib refs.bib`（稿件须用 `[@key]` 引用；无 `[@key]` 却传 CSL 会 WARN 提示不生效）。优先级：命令行 > 预设 > frontmatter > 默认；**只要用户在 `--` 后透传了同名 `-V geometry/fontsize/linestretch`，脚本一律不再注入同名值（透传最优先），彻底避免重复 `-V` 拼接（`\setstretch{1.42.0}`）导致的编译崩溃**——无论我方值来自默认、命令行还是预设。例：`bash scripts/render_pdf.sh -i ms.md --journal nejm --figures-at-end --bib refs.bib`。
>
> **送审细排参数**（`--indent-chars`、`--caption-fontsize`、`--table-fontsize`、标题/作者字号等）、改代码前必看的三个 LaTeX 坑，及「手写表题自动转 pandoc 题注」：见 `references/submission-fine-tuning.md`。
>
> **PDF 侧做不到、需如实告知用户的**：① 正文基准字号 **LaTeX 只认 10/11/12pt**（10.5pt 这类中文字号做不到，要精确字号出 Word）；② 表注 / 图注段（`表注：`/`Note.`）在 PDF 里保持正文字号——它不是 `\caption`，docx 侧才会按题注字号处理；③ 页数不统计（"≤30 页"要用户自己看）；④ 参考文献的期刊全称与 et al. 规则由写作阶段保证，排版层不重排 `[n]` 文本引用。
>
> 以下为上游技能原文（vendored）；本仓库对 `render_pdf.sh` 做了实质增强：中文 ctex 版式、期刊预设与送审格式参数、Python 解释器自动解析、pandoc/xelatex 的 winget/MiKTeX 路径自探测、`redact_internal` 落地。

# Render-PDF-Doc Skill

Markdown + frontmatter → publication-quality academic PDF (English or Korean).

## Boundary (separation from other skills in this repo)

| Task | Skill |
|---|---|
| Verify the document's citations | `reference-check` |
| Figures / scientific plots | `nature-figure` |
| Draft the proposal / review / report text | `grant-proposal` / `literature-review` / `deep-research` |
| **This skill**: academic markdown → publication-quality PDF | `render-pdf-doc` |

## Core Principles

Why this skill exists, plus the six principles (ctex for Chinese, inferred column widths, auto CJK detection, ① routing, `redact_internal: true`, no Quarto): see `references/design-rationale.md`.

## Dependencies

Install commands per OS, the one-click installers (`install.ps1 -WithPdf` / `install.sh --with-pdf`) and the Windows / Git Bash PATH note: see `references/dependencies-install.md`.

Detection:
```bash
bash scripts/check_deps.sh
```

## Workflow

### Step 1 — Author markdown with frontmatter

Frontmatter is **optional** — a bare Chinese markdown (no frontmatter at all) renders
correctly through ctex. Add frontmatter only to override defaults:

Example frontmatter and script defaults (`margin=1in`, 12pt, `linestretch=1.4`, `colorlinks=true`): see `references/frontmatter-options.md`.

### Step 2 — Infer column widths

```bash
python scripts/infer_colwidths.py input.md > input.colwidths.md
```

`--help` for options; width algorithm and per-table `{tbl-colwidths}` override: see `references/column-width-inference.md`.

### Step 3 — Render

```bash
bash scripts/render_pdf.sh -i input.colwidths.md -o output.pdf
```

Or one-shot:
```bash
bash scripts/render_pdf.sh -i input.md -o output.pdf --infer-colwidths
```

### Step 3.5 — Scientific-symbol + CJK glyph scan (before render)

xelatex **silently drops** any glyph the font lacks — no error, no warning. Scan first (`--help` for the `--font` cmap check):

```bash
python scripts/scan_glyph_coverage.py input.md --strict
```

Details: `references/glyph-coverage-scan.md`. **The DOCX is authoritative; the PDF is a convenience copy** — never let a PDF render drop a glyph the document needs.

### Step 4 — Visual verify

First confirm the render log line: `cjk_kind=han mode=[chinese/ctexart ...]` for a Chinese
doc. If it says `cjk_kind=none` on a clearly-Chinese file, the Python interpreter didn't
resolve and it fell back to the article path — check `.venv` exists or `python` is on PATH.

Then open the PDF and check:
- Chinese body is 宋体 (serif), headings 黑体 — **not** a single uniform sans font
- The first-column labels do not wrap and stay on a single line; data columns have room
- Code fences show intact box-drawing `├└│─` (dropped box chars = monofont didn't cover)
- Enclosed numbers ① ② ③ render (not blank) in 纳入/排除标准-style lists
- No missing scientific symbols (arrows, −, ≤, ±, √) — the Step 3.5 scan flags candidates;
  note ⚠ U+26A0-class emoji are in no standard font and will drop — replace them in source
- No change history / internal version numbers exposed

## Templates

Starter markdown in `templates/` (English + `*_ko.md` Korean variants): list in `references/templates.md`.

## Anti-Patterns

Symptom → cause table: see `references/anti-patterns.md`.

## Files

- `scripts/render_pdf.sh` — pandoc + xelatex wrapper; Chinese→ctexart path, OS font/fontset detection, interpreter + binary auto-resolution
- `scripts/infer_colwidths.py` — auto-generates pipe-table separator dash ratios
- `scripts/check_deps.sh` — checks for pandoc / xelatex / ctex class / CJK font
- `templates/` — 4 starters (English) + their `*_ko.md` Korean variants
- `references/pandoc_korean_cheatsheet.md` — collection of frontmatter patterns (Korean-PDF reference)
- `references/known_pitfalls.md` — em-dash line breaks, smart quotes, etc. (Korean-PDF reference)
- `references/` — sections moved out of this file: design-rationale, dependencies-install, frontmatter-options, column-width-inference, glyph-coverage-scan, templates, anti-patterns, submission-fine-tuning

## Anti-Hallucination

- **Numerical content in tables**: read numbers from the source CSV/data file — never retype or invent values.
- **Citations**: this skill only lays out the document; verify references with the `reference-check` skill separately.
- **Circulation PDFs**: preserve the primary source; do not fabricate authorship, dates, or approvals. If `redact_internal: true` is set in frontmatter, keep change history / version numbers / PI attribution out of the body (see Core Principle 3 — the render script honors this flag as of the F6 fix).
