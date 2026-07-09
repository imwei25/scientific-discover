---
name: render-pdf-doc
description: >
  Render academic Markdown documents (Chinese, English, or Korean) to publication-quality PDF via pandoc + xelatex.
  Targets non-bibliography artifacts: research proposals (含 NSFC 标书), IRB cover letters, briefing
  handouts, anchor docs (Q&A grids), and reference tables. Auto-infers pipe-table column
  widths from content (label column shrinks to fit, data columns share remaining width).
  CJK-aware: Chinese renders through the ctex document class (ctexart — 宋体 body / 黑体 headings, Times Latin)
  for true Chinese academic typesetting; Korean uses Apple SD Gothic Neo / Noto Sans CJK KR (article class).
  NOT for: verifying citations (use the reference-check skill) or figures/plots (use the nature-figure skill).
  For Word (.docx) submission use render-docx; if the user just says "排版/typeset" without a format, ask PDF vs Word first.
triggers: render PDF, PDF 렌더, korean PDF, 한글 PDF, anchor doc PDF, briefing PDF, proposal PDF, 연구계획서 PDF, 표 정렬 PDF, 표 폭 자동, tbl-colwidths, 학술 PDF
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---

> **本仓库运行环境（先读）**：Python 由 `render_pdf.sh` 自动解析（优先项目根 `.venv`，再回退 `python3/python/py`——不再写死 `python3`，否则 Windows 上中文检测会失灵）；本技能脚本在 `.opencode/skills/render-pdf-doc/` 下，运行时先 `cd` 到该目录或用全路径；产出写 `outputs/`（有会话专属目录时以它为准、勿写仓库根固定名）。需要 **pandoc + xelatex + ctex**（仓库根 install.ps1 -WithPdf / install.sh --with-pdf 已装；Linux 需 `texlive-lang-chinese`，Windows MiKTeX 首次渲染自动补装 ctex）；先跑 `bash scripts/check_deps.sh` 自检。
>
> **中文全自动、零参数**：`render_pdf.sh` 扫描稿件，**含汉字时自动走 `ctexart` 文档类**——宋体正文 / 黑体标题、标点避头尾、首行缩进、页眉页码，英文数字用 Times，代码框等宽字体覆盖制表符 `├└│─`（Windows Consolas / macOS Menlo / Linux DejaVu Sans Mono）。含韩文时走原 article 路径（Malgun Gothic / Noto CJK KR / Apple SD Gothic Neo）。**中文稿不必再加 `--cjk-font`**。若 frontmatter 写了 `CJKmainfont` 或命令行传了 `--cjk-font`，脚本会尊重覆盖。
>
> 以下为上游技能原文（vendored）；本仓库对 `render_pdf.sh` 做了实质增强：中文 ctex 版式、Python 解释器自动解析、pandoc/xelatex 的 winget/MiKTeX 路径自探测、`redact_internal` 落地。

# Render-PDF-Doc Skill

Markdown + frontmatter → publication-quality academic PDF (English or Korean).

## Why This Skill Exists

In real circulation cycles for academic PDFs, two recurring failure patterns appear:
1. v1 drafts: change-history, version numbers, and PI attribution leak into the attached PDF, confusing the first recipient.
2. v2 drafts: pandoc pipe-table dash ratios are misjudged, narrowing the first column and forcing label wrapping that hurts readability.

Manual fixes work but the same pattern recurs across proposals, briefings, IRB covers, exemption applications. This skill focuses on **layout** (CJK fonts + table column widths).

## Boundary (separation from other skills in this repo)

| Task | Skill |
|---|---|
| Verify the document's citations | `reference-check` |
| Figures / scientific plots | `nature-figure` |
| Draft the proposal / review / report text | `grant-proposal` / `literature-review` / `deep-research` |
| **This skill**: academic markdown → publication-quality PDF | `render-pdf-doc` |

## Core Principles

1. **Chinese renders through ctex, not a bare font swap.** When the source contains Han, the script uses `documentclass=ctexart` with an OS-appropriate `fontset` (windows / macnew / fandol) → 宋体 body, 黑体 headings, punctuation kerning, no line-break-before-closing-mark, first-line indent. Latin runs use a Times-compatible serif; a box-drawing-safe monofont (`Consolas` / `Menlo` / `DejaVu Sans Mono`) keeps code-fence `├└│─` from silently dropping. Korean / non-CJK keep the article-class path. **This is the difference between "publication-quality" and "everything in one sans font".**
2. **Pipe table column widths must be inferred from content.** No equal splitting. Size the first column (label) to the longest label, and distribute the remaining width content-proportionally across the data columns.
3. **CJK is auto-selected by content** — the script detects Han vs Hangul (via an auto-resolved Python interpreter, `.venv` first) and picks the render path + fonts. Set `CJKmainfont` in frontmatter or pass `--cjk-font` only to override the Chinese font; the ctex fontset governs otherwise.
4. **Enclosed alphanumerics (① ② ③) route to the CJK font.** xeCJK classes them as Latin by default → they land in the Times serif, which lacks them, and drop. On the Chinese path the script reclassifies U+2460–24FF and U+25A0–25FF as CJK so 宋体 (which has them) renders them.
5. **For circulation PDFs, remove change history / version numbers / PI attribution** — set frontmatter `redact_internal: true` and the script strips those lines before rendering.
6. **No Quarto dependency** — raw pandoc + xelatex. Quarto's `tbl-colwidths` has reported PDF regressions (issues 6089/9200).

## Dependencies

```bash
# macOS
brew install pandoc
brew install --cask mactex-no-gui          # xelatex + xeCJK + ctex (~5 GB)

# Linux — texlive-lang-chinese provides the ctex class (ctexart) used for Chinese;
# it is NOT in texlive-lang-cjk, so both are required.
sudo apt-get install pandoc texlive-xetex texlive-lang-cjk texlive-lang-chinese fonts-noto-cjk

# Windows (PowerShell) — run in Git Bash afterwards
winget install --id JohnMacFarlane.Pandoc
winget install --id MiKTeX.MiKTeX          # xelatex; auto-installs ctex/xeCJK on first render
initexmf --set-config-value "[MPM]AutoInstall=1"   # so the first render doesn't hang on a prompt
# No font download needed: 宋体 SimSun / 黑体 SimHei (ctex, Chinese) + Malgun Gothic (Korean)
# + Times New Roman (Latin) all ship with Windows.
```

The repo's one-click installers cover all of this: `install.ps1 -WithPdf` (Windows) /
`bash install.sh --with-pdf` (Linux/macOS).

Detection:
```bash
bash scripts/check_deps.sh
```

**Windows / Git Bash note.** winget-installed binaries frequently land off the Git Bash
`PATH`: MiKTeX's `xelatex` (`%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin\x64`) and pandoc
(`%LOCALAPPDATA%\Microsoft\WinGet\...`) can read as `[MISS]` even after a successful install.
Both `check_deps.sh` and `render_pdf.sh` now auto-probe those locations; if either still
isn't found, add the directory to your `PATH` (or open a fresh terminal). The Windows
Chinese fonts come from the ctex `fontset=windows` (宋体 SimSun / 黑体 SimHei, both preinstalled)
— no font download needed; Korean uses Malgun Gothic. Override the Chinese font per document
via frontmatter `CJKmainfont` or `--cjk-font`.

## Workflow

### Step 1 — Author markdown with frontmatter

Frontmatter is **optional** — a bare Chinese markdown (no frontmatter at all) renders
correctly through ctex. Add frontmatter only to override defaults:

```yaml
---
title: "Paper 2 Calibration Anchor — Q&A Grid"
author: "<Author Group>"
date: "2026-05-01"
# CJKmainfont: "SimSun"        # override the ctex fontset's Chinese font (optional)
# geometry: "margin=1in"       # script defaults: margin=1in, 12pt, linestretch=1.4
# colorlinks: true
---
```

Defaults if omitted: geometry `margin=1in`, `fontsize=12pt`, `linestretch=1.4`,
`colorlinks=true`. Chinese docs auto-select `ctexart` + the OS fontset (Windows 宋体/黑体,
macOS Songti/Heiti, Linux Fandol); no font settings needed.

### Step 2 — Infer column widths

```bash
python scripts/infer_colwidths.py input.md > input.colwidths.md
```

The script:
1. Finds every pipe table block.
2. For each column, computes display width = `max(len(header), max(len(cell)))` (CJK = 2 cells, ASCII = 1).
3. Generates dash-row separator with proportional dash counts.
4. Writes a new file with separator rows replaced.

Override per-table via attribute: `{tbl-colwidths="[20,40,40]"}` after caption — passes through unchanged.

### Step 3 — Render

```bash
bash scripts/render_pdf.sh -i input.colwidths.md -o output.pdf
```

Or one-shot:
```bash
bash scripts/render_pdf.sh -i input.md -o output.pdf --infer-colwidths
```

### Step 3.5 — Scientific-symbol + CJK glyph scan (before render)

xelatex **silently drops** any character the chosen font does not cover — the PDF
renders with the glyph simply missing, no error or warning. Academic markdown
routinely carries glyphs a default Latin font misses: transition arrows (→ ↑ ↓),
math operators (− ≤ ≥ ± √ ∪ × ≈ ≠), stats Greek (κ μ σ β), bullets/marks (• ★ ✓),
and CJK. Scan the source first so a silent drop is caught before it ships:

```bash
# use the project venv python on Windows (python3 may not exist): .venv/Scripts/python.exe
python scripts/scan_glyph_coverage.py input.md --strict
# real cmap check when you have the font file + fonttools:
python scripts/scan_glyph_coverage.py input.md --font "/path/to/body.otf" --strict
```

It groups the risky glyphs by class (advisory), or — with `--font` + `fonttools`
— reports which are genuinely absent from the font's cmap. If risky glyphs are
present, ensure `mainfont`/`CJKmainfont` cover them (a CJK-capable font such as
*Apple SD Gothic Neo* / *Noto Sans CJK* usually covers arrows + Hangul but can
still miss the true-minus `−` U+2212 and `★`). **The DOCX is authoritative; the
PDF is a convenience copy** — never let a PDF render drop a glyph the document
needs.

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

Starter markdown in `templates/` (English default; a Korean variant `*_ko.md` ships alongside each):
- `anchor-doc.md` — Q&A grid
- `proposal-cover.md` — research-proposal cover page
- `briefing-handout.md` — meeting brief (1-page)
- `reference-table.md` — comparison-table format

Each template marks slots with a `<!-- TODO: -->` marker.

## Anti-Patterns

| Anti-pattern | Consequence |
|---|---|
| Rendering Chinese through bare `article` + one sans CJK font | No 宋体/黑体 distinction, no punctuation kerning/indent — looks like a screen dump, not a 标书. Use the ctex path (automatic on Han detection). |
| Hard-coding `python3` in the detect step | On Windows (no `python3`) CJK detection silently returns none → Chinese falls back to the article path. The script auto-resolves an interpreter instead. |
| Equal dash split (`\|---\|---\|---\|`) | A column with only a short label gets the same width → cramped data columns |
| Missing box-drawing chars in a code fence | Default Latin Modern Mono lacks `├└│─`; set a covering monofont (the Chinese path does). |
| Change history / version (e.g. v3.2.2) / PI attribution exposed in a circulation PDF | Confuses the first recipient; leaks internal information |
| Quarto `tbl-colwidths` for PDF | PDF regression in Quarto 1.4+ — trust HTML only |

## Files

- `scripts/render_pdf.sh` — pandoc + xelatex wrapper; Chinese→ctexart path, OS font/fontset detection, interpreter + binary auto-resolution
- `scripts/infer_colwidths.py` — auto-generates pipe-table separator dash ratios
- `scripts/check_deps.sh` — checks for pandoc / xelatex / ctex class / CJK font
- `templates/` — 4 starters (English) + their `*_ko.md` Korean variants
- `references/pandoc_korean_cheatsheet.md` — collection of frontmatter patterns (Korean-PDF reference)
- `references/known_pitfalls.md` — em-dash line breaks, smart quotes, etc. (Korean-PDF reference)

## Anti-Hallucination

- **Numerical content in tables**: read numbers from the source CSV/data file — never retype or invent values.
- **Citations**: this skill only lays out the document; verify references with the `reference-check` skill separately.
- **Circulation PDFs**: preserve the primary source; do not fabricate authorship, dates, or approvals. If `redact_internal: true` is set in frontmatter, keep change history / version numbers / PI attribution out of the body (see Core Principle 3 — the render script honors this flag as of the F6 fix).
