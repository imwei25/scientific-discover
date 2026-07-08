---
name: render-pdf-doc
description: >
  Render academic Markdown documents (English or Korean) to publication-quality PDF via pandoc + xelatex.
  Targets non-bibliography artifacts: research proposals, IRB cover letters, briefing
  handouts, anchor docs (Q&A grids), and reference tables. Auto-infers pipe-table column
  widths from content (label column shrinks to fit, data columns share remaining width).
  CJK-aware font fallback: Chinese (Microsoft YaHei / Noto Sans CJK SC) and Korean (Apple SD Gothic Neo / Noto Sans CJK KR).
  NOT for: verifying citations (use the reference-check skill) or figures/plots (use the nature-figure skill).
  For Word (.docx) submission use render-docx; if the user just says "排版/typeset" without a format, ask PDF vs Word first.
triggers: render PDF, PDF 렌더, korean PDF, 한글 PDF, anchor doc PDF, briefing PDF, proposal PDF, 연구계획서 PDF, 표 정렬 PDF, 표 폭 자동, tbl-colwidths, 학술 PDF
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---

> **本仓库运行环境（先读）**：Python 用 `.venv/Scripts/python.exe`（Windows）/ `.venv/bin/python`（Linux/macOS）（项目根 `.venv`；没有先跑 `env-setup` 技能）；本技能脚本在 `.opencode/skills/render-pdf-doc/` 下，运行时先 `cd` 到该目录或用全路径；产出写仓库根 `outputs/`。需要 **pandoc + xelatex**（仓库根 install.ps1 -WithPdf / install.sh --with-pdf 已装）；先跑 `bash scripts/check_deps.sh` 自检。**中文字体已自动处理**：`render_pdf.sh` 会扫描稿件，含汉字时默认用 Microsoft YaHei（Windows）/ Noto Sans CJK SC（Linux）/ PingFang SC（macOS），含韩文时用 Malgun Gothic / Noto CJK KR / Apple SD Gothic Neo——无需再手动加 `--cjk-font`。若 frontmatter 里写了 `CJKmainfont`，脚本会尊重它、不再覆盖。以下为上游技能原文（vendored，方法论未改；字体默认与 `redact_internal` 已按本仓库需求修正）。

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

1. **Pipe table column widths must be inferred from content.** No equal splitting. Size the first column (label) to the longest label, and distribute the remaining width content-proportionally across the data columns.
2. **CJK font is auto-selected by content** — the script detects Han vs Hangul and picks a covering font per OS (Chinese → Microsoft YaHei / Noto Sans CJK SC / PingFang SC; Korean → Malgun Gothic / Noto CJK KR / Apple SD Gothic Neo). Set `mainfont` / `CJKmainfont` in frontmatter only to override; the script will not clobber a frontmatter font with `-V`.
3. **For circulation PDFs, remove change history / version numbers / PI attribution** — set frontmatter `redact_internal: true` and the script strips those lines before rendering.
4. **No Quarto dependency** — raw pandoc + xelatex. Quarto's `tbl-colwidths` has reported PDF regressions (issues 6089/9200).

## Dependencies

```bash
# macOS
brew install pandoc
brew install --cask mactex-no-gui          # xelatex + xeCJK (~5 GB)

# Linux
sudo apt-get install pandoc texlive-xetex texlive-lang-cjk fonts-noto-cjk

# Windows (PowerShell) — run in Git Bash afterwards
winget install --id JohnMacFarlane.Pandoc
winget install --id MiKTeX.MiKTeX          # xelatex; installs missing LaTeX packages on demand
# No CJK font download needed: Microsoft YaHei (Chinese) + Malgun Gothic (Korean) both ship with Windows.
```

Detection:
```bash
bash scripts/check_deps.sh
```

**Windows / Git Bash note.** MiKTeX's binary directory
(`%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin\x64`) is often not on the Git Bash `PATH`,
so `xelatex` can read as `[MISS]` even after install. Both `check_deps.sh` and
`render_pdf.sh` now auto-probe that location; if `xelatex` still isn't found, add the
directory to your `PATH` (or run from the *MiKTeX Console → Settings*-configured shell).
The Windows CJK/main font default is **content-detected**: Microsoft YaHei (msyh.ttc,
preinstalled) for Chinese, Malgun Gothic for Korean. Override per document via frontmatter,
or with `--font` / `--cjk-font`.

## Workflow

### Step 1 — Author markdown with frontmatter

```yaml
---
title: "Paper 2 Calibration Anchor — Q&A Grid"
author: "<Author Group>"
date: "2026-05-01"
mainfont: "Apple SD Gothic Neo"        # macOS default
CJKmainfont: "Apple SD Gothic Neo"
geometry: "margin=0.85in"
fontsize: 11pt
linestretch: 1.25
colorlinks: true
---
```

The render script auto-detects the default per OS **and per script** (Chinese vs Korean) — the frontmatter above is only needed to override. For a Chinese doc on Windows the default is `Microsoft YaHei`; on Linux, `Noto Sans CJK SC`.

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
python3 scripts/scan_glyph_coverage.py input.md --strict
# real cmap check when you have the font file + fonttools:
python3 scripts/scan_glyph_coverage.py input.md --font "/path/to/body.otf" --strict
```

It groups the risky glyphs by class (advisory), or — with `--font` + `fonttools`
— reports which are genuinely absent from the font's cmap. If risky glyphs are
present, ensure `mainfont`/`CJKmainfont` cover them (a CJK-capable font such as
*Apple SD Gothic Neo* / *Noto Sans CJK* usually covers arrows + Hangul but can
still miss the true-minus `−` U+2212 and `★`). **The DOCX is authoritative; the
PDF is a convenience copy** — never let a PDF render drop a glyph the document
needs.

### Step 4 — Visual verify

Open the PDF. Check:
- The first-column labels do not wrap and stay on a single line
- Data columns have sufficient width
- No broken Korean glyphs (a Times New Roman fallback means CJKmainfont was not applied)
- No missing scientific symbols (arrows, −, ≤, ±, √) — the Step 3.5 scan flags candidates
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
| Equal dash split (`\|---\|---\|---\|`) | A column with only a short label gets the same width → cramped data columns |
| `CJKmainfont` not set | Hangul falls back to Times New Roman (broken Latin glyphs or blanks) |
| Change history / version (e.g. v3.2.2) / PI attribution exposed in a circulation PDF | Confuses the first recipient; leaks internal information |
| Quarto `tbl-colwidths` for PDF | PDF regression in Quarto 1.4+ — trust HTML only |

## Files

- `scripts/render_pdf.sh` — pandoc + xelatex wrapper, OS font detection
- `scripts/infer_colwidths.py` — auto-generates pipe-table separator dash ratios
- `scripts/check_deps.sh` — checks for pandoc / xelatex / CJK font
- `templates/` — 4 starters (English) + their `*_ko.md` Korean variants
- `references/pandoc_korean_cheatsheet.md` — collection of frontmatter patterns (Korean-PDF reference)
- `references/known_pitfalls.md` — em-dash line breaks, smart quotes, etc. (Korean-PDF reference)

## Anti-Hallucination

- **Numerical content in tables**: read numbers from the source CSV/data file — never retype or invent values.
- **Citations**: this skill only lays out the document; verify references with the `reference-check` skill separately.
- **Circulation PDFs**: preserve the primary source; do not fabricate authorship, dates, or approvals. If `redact_internal: true` is set in frontmatter, keep change history / version numbers / PI attribution out of the body (see Core Principle 3 — the render script honors this flag as of the F6 fix).
