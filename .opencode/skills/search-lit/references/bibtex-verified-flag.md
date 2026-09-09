> 来源：search-lit/SKILL.md 原「Phase 4」BibTeX Generation + Output」节原样搬出（渐进披露）。生成/追加 BibTeX 条目时读：条目模板、verified 标志三档含义、verified_by/verified_on、键名约定、汇总打印格式。

# BibTeX 生成与 verified 标志（Phase 4）

#### BibTeX Generation

For each reference (verified or not), generate a BibTeX entry with an explicit
`verified` flag so the downstream `reference-check` skill (and any later writing step)
can reason about trust without re-running verification:

```bibtex
@article{FirstAuthorLastName_Year_ShortKey,
  author    = {Last1, First1 and Last2, First2 and Last3, First3},
  title     = {Full Title As Retrieved From Database},
  journal   = {Journal Name},
  year      = {2024},
  volume    = {310},
  number    = {2},
  pages     = {e234567},
  doi       = {10.1001/jama.2024.12345},
  pmid      = {12345678},
  verified  = {true},
  verified_by = {pubmed+crossref},
  verified_on = {2026-04-24},
}
```

**`verified` flag values** (required on every entry):

| Value | Meaning | Downstream behavior |
|---|---|---|
| `true` | DOI or PMID confirmed via PubMed/CrossRef; title, authors, year all match | Safe to cite |
| `false` | Parsed from text but API lookup failed or returned mismatch | `reference-check` 技能 flags as UNVERIFIED; manuscript MUST show `[UNVERIFIED - NEEDS MANUAL CHECK]` |
| `manual` | User explicitly added despite lookup failure | Treated as verified=false by `reference-check` 技能 but suppresses repeat warnings |

`verified_by` lists the data sources that confirmed the entry (e.g., `pubmed`,
`crossref`, `semantic_scholar`, or a combination). `verified_on` is the ISO date
of the most recent successful verification.

**BibTeX key convention**: `FirstAuthorLastName_Year_OneWord` (e.g., `Kim_2024_Validation`).

#### Output

1. Save BibTeX entries to the specified .bib file (append, do not overwrite).
   Target: `outputs/refs.bib` (the candidate pool; the user can import it into Zotero/EndNote).
2. Print a summary of all references with verification status:

```
Verified:    12 references (verified=true)
Unverified:   1 reference  (verified=false) [NEEDS MANUAL CHECK]
Total:       13 references
```
