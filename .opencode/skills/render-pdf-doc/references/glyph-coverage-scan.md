> Moved verbatim from SKILL.md "Step 3.5 — Scientific-symbol + CJK glyph scan"; read when the scan flags risky glyphs, when you have a font file for a real cmap check (`--font`), or to see which glyph classes are at risk.

xelatex **silently drops** any character the chosen font does not cover — the PDF
renders with the glyph simply missing, no error or warning. Academic markdown
routinely carries glyphs a default Latin font misses: transition arrows (→ ↑ ↓),
math operators (− ≤ ≥ ± √ ∪ × ≈ ≠), stats Greek (κ μ σ β), bullets/marks (• ★ ✓),
and CJK. Scan the source first so a silent drop is caught before it ships:

```bash
# use the project venv python on Windows (python3 may not exist): "${REPO_ROOT:-/app}/.venv/bin/python"
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
