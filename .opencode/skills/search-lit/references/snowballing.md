> 来源：search-lit/SKILL.md 原「Phase 2.5: Citation Searching (Snowballing)」节原样搬出（渐进披露）。做系统综述/详尽背景检索、要沿引文图谱扩展种子集时读；含 snowball.py 命令、方向、去重、trust flag 与 PRISMA 记数。

### Phase 2.5: Citation Searching (Snowballing)

Optional but recommended for systematic reviews and thorough background work
(PRISMA item 7, "records identified through citation searching"). Expands a
seed set along the citation graph instead of relying on Boolean recall alone.

Use the deterministic helper `references/snowball.py` (Semantic Scholar Graph
API; nothing generated from memory):

```bash
# Expand seed DOIs/PMIDs in all directions, dedup against the existing pool,
# append verified candidates to outputs/refs.bib
python3 references/snowball.py \
  --seed DOI:10.1148/radiol.2024123,PMID:38000001 \
  --direction all \
  --pool refs.bib \
  --out refs.bib
```

- **Directions**: `backward` (references the seeds cite), `forward` (papers
  citing the seeds), `similar` (S2 recommendations), or `all` (default).
- **Dedup**: against the current `outputs/refs.bib` by DOI and
  normalized title, and within the harvested set.
- **Trust flag**: snowball candidates are written `verified=false` +
  `verified_by=semantic_scholar`. They are candidates, not confirmed
  citations — run `reference-check` 技能 (or Phase 4 verification) to confirm each
  against PubMed/CrossRef before citing.
- **Output contract**: appends to `outputs/refs.bib` only (the candidate pool).
- **PRISMA line**: the script prints, e.g., `Records identified through
  citation searching (snowballing): N raw (backward=…, forward=…, similar=…);
  after dedup against existing pool: M new candidates.` — record M in the
  PRISMA flow's citation-searching box.
