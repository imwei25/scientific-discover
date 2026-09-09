> Moved verbatim from SKILL.md sections "Why This Skill Exists" and "Core Principles"; read when you need the reasoning behind the ctex path, column-width inference, CJK detection, glyph routing, `redact_internal`, or the no-Quarto rule.

## Why This Skill Exists

In real circulation cycles for academic PDFs, two recurring failure patterns appear:
1. v1 drafts: change-history, version numbers, and PI attribution leak into the attached PDF, confusing the first recipient.
2. v2 drafts: pandoc pipe-table dash ratios are misjudged, narrowing the first column and forcing label wrapping that hurts readability.

Manual fixes work but the same pattern recurs across proposals, briefings, IRB covers, exemption applications. This skill focuses on **layout** (CJK fonts + table column widths).

## Core Principles

1. **Chinese renders through ctex, not a bare font swap.** When the source contains Han, the script uses `documentclass=ctexart` with an OS-appropriate `fontset` (windows / macnew / fandol) → 宋体 body, 黑体 headings, punctuation kerning, no line-break-before-closing-mark, first-line indent. Latin runs use a Times-compatible serif; a box-drawing-safe monofont (`Consolas` / `Menlo` / `DejaVu Sans Mono`) keeps code-fence `├└│─` from silently dropping. Korean / non-CJK keep the article-class path. **This is the difference between "publication-quality" and "everything in one sans font".**
2. **Pipe table column widths must be inferred from content.** No equal splitting. Size the first column (label) to the longest label, and distribute the remaining width content-proportionally across the data columns.
3. **CJK is auto-selected by content** — the script detects Han vs Hangul (via an auto-resolved Python interpreter, `.venv` first) and picks the render path + fonts. Set `CJKmainfont` in frontmatter or pass `--cjk-font` only to override the Chinese font; the ctex fontset governs otherwise.
4. **Enclosed alphanumerics (① ② ③) route to the CJK font.** xeCJK classes them as Latin by default → they land in the Times serif, which lacks them, and drop. On the Chinese path the script reclassifies U+2460–24FF and U+25A0–25FF as CJK so 宋体 (which has them) renders them.
5. **For circulation PDFs, remove change history / version numbers / PI attribution** — set frontmatter `redact_internal: true` and the script strips those lines before rendering.
6. **No Quarto dependency** — raw pandoc + xelatex. Quarto's `tbl-colwidths` has reported PDF regressions (issues 6089/9200).
