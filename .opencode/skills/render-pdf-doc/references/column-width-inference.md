> Moved verbatim from SKILL.md "Step 2 — Infer column widths"; read when you need to know how `infer_colwidths.py` sizes columns or how to override a single table.

The script:
1. Finds every pipe table block.
2. For each column, computes display width = `max(len(header), max(len(cell)))` (CJK = 2 cells, ASCII = 1).
3. Generates dash-row separator with proportional dash counts.
4. Writes a new file with separator rows replaced.

Override per-table via attribute: `{tbl-colwidths="[20,40,40]"}` after caption — passes through unchanged.
