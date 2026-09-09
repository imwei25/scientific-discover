> Moved verbatim from SKILL.md section "Anti-Patterns"; read when a render looks wrong (uniform sans CJK, cramped columns, dropped box-drawing chars, leaked change history) to match the symptom to its cause.

## Anti-Patterns

| Anti-pattern | Consequence |
|---|---|
| Rendering Chinese through bare `article` + one sans CJK font | No 宋体/黑体 distinction, no punctuation kerning/indent — looks like a screen dump, not a 标书. Use the ctex path (automatic on Han detection). |
| Hard-coding `python3` in the detect step | On Windows (no `python3`) CJK detection silently returns none → Chinese falls back to the article path. The script auto-resolves an interpreter instead. |
| Equal dash split (`\|---\|---\|---\|`) | A column with only a short label gets the same width → cramped data columns |
| Missing box-drawing chars in a code fence | Default Latin Modern Mono lacks `├└│─`; set a covering monofont (the Chinese path does). |
| Change history / version (e.g. v3.2.2) / PI attribution exposed in a circulation PDF | Confuses the first recipient; leaks internal information |
| Quarto `tbl-colwidths` for PDF | PDF regression in Quarto 1.4+ — trust HTML only |
