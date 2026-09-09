> 来源：search-lit/SKILL.md 原「Workflow」Phase 1 / 2 / 3 / 6 全文（Phase 2.5、4、4b、5 另见同目录其它文件」节原样搬出（渐进披露）。执行对应 Phase 时读：检索策略细项、结果表格式、深读要提取的字段与文献矩阵、缺口分析步骤。

# Workflow 各 Phase 细则（Phase 1 / 2 / 3 / 6）

### Phase 1: Search Strategy

1. **Understand the need**: Get the research topic, specific question, or manuscript section
   that needs references.
2. **Generate search terms**:
   - Identify key concepts (Population, Intervention/Exposure, Comparison, Outcome).
   - Generate MeSH terms for PubMed queries.
   - Build Boolean queries: `(concept1 OR synonym1) AND (concept2 OR synonym2)`.
3. **Define scope**:
   - Date range (default: last 10 years unless user specifies).
   - Article types (original research, review, meta-analysis, etc.).
   - Language filter (default: English).
4. **Present the search plan** to the user before executing. Include the Boolean query,
   databases to search, and filters.

**Gate:** Wait for user approval before running searches.

### Phase 2: Execute Search

1. **Search PubMed** using `search_articles` with the Boolean query.
2. **Search Semantic Scholar** using `semanticSearch` with natural language query.
3. **Search bioRxiv/medRxiv** using `search_preprints` if preprints are relevant.
4. **Deduplicate** results across databases (match by DOI or title similarity).
5. **Present results** in a structured table:

```
| # | Title | Authors (first + last) | Year | Journal | PMID/DOI | Relevance |
|---|-------|----------------------|------|---------|----------|-----------|
| 1 | ...   | Kim J, ... Lee S     | 2024 | Radiology | 12345678 | High      |
```

6. Ask the user to select which papers to include.

### Phase 3: Deep Read

For each selected paper:

1. **Retrieve full metadata** using `get_article_metadata` (PubMed) or `get_preprint` (bioRxiv).
2. **Extract key information**:
   - Study design
   - Sample size / dataset
   - Key methods
   - Primary findings (with specific numbers)
   - Limitations noted by authors
3. **Build a literature matrix** if multiple papers selected:

```
| Paper | Design | N | Key Finding | Limitation | Relevance to Our Study |
|-------|--------|---|-------------|------------|----------------------|
```

4. Present the matrix to the user for review.

### Phase 6: Gap Analysis

When called during manuscript or review writing:

1. **Read the manuscript** to extract all inline citations.
2. **Compare** cited references against the search results.
3. **Identify gaps**:
   - Key papers in the field that are not cited.
   - Outdated references when newer versions exist.
   - Missing methodological references (e.g., statistical methods, reporting guidelines).
4. **Report** findings to the user with specific suggestions.
