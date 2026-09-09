> 来源：search-lit/SKILL.md 原「Search Tools: MCP (Primary) + E-utilities / Europe PMC (Fallback)」节原样搬出（渐进披露）。要实际调用 MCP 工具或 pubmed_eutils.sh / parse_pubmed.py 时读：MCP 工具表、E-utilities 与 Europe PMC 命令示例、限速、MCP↔E-utilities 对照。

## Search Tools: MCP (Primary) + E-utilities / Europe PMC (Fallback)

### Primary: MCP Tools (Claude.ai Remote)

| Database | MCP Tool | Purpose |
|----------|----------|---------|
| PubMed | `mcp__claude_ai_PubMed__search_articles` | Search by query, MeSH terms |
| PubMed | `mcp__claude_ai_PubMed__get_article_metadata` | Full metadata for a PMID |
| PubMed | `mcp__claude_ai_PubMed__find_related_articles` | Related articles for a PMID |
| PubMed | `mcp__claude_ai_PubMed__lookup_article_by_citation` | Verify a citation |
| PubMed | `mcp__claude_ai_PubMed__convert_article_ids` | Convert between PMID/DOI/PMCID |
| Semantic Scholar | `mcp__claude_ai_Scholar_Gateway__semanticSearch` | Semantic search across all fields |
| bioRxiv/medRxiv | `mcp__claude_ai_bioRxiv__search_preprints` | Search preprint servers |
| bioRxiv/medRxiv | `mcp__claude_ai_bioRxiv__get_preprint` | Full preprint metadata |
| CrossRef | WebFetch with `https://api.crossref.org/works/{DOI}` | DOI verification |

### Fallback: NCBI E-utilities (Direct API via Bash)

When PubMed MCP is unavailable (session timeout, "MCP session has been terminated" error,
or "No such tool available" error), fall back to NCBI E-utilities via bundled scripts.

**Detection**: If any `mcp__claude_ai_PubMed__*` call returns an error containing
"terminated", "not found", "not available", or "not connected", switch ALL subsequent
PubMed calls in this session to E-utilities. Do not retry MCP after a disconnect — it
will not recover within the same conversation.

**Scripts** (in `"${REPO_ROOT:-/app}/.opencode/skills/search-lit/references/"` — run from repo root or use the full path):
- `pubmed_eutils.sh` — Bash wrapper for NCBI E-utilities **and** Europe PMC (`epmc_*` commands)
- `parse_pubmed.py` — Python parser for E-utilities responses

**China-network fallback (reachable):**
```bash
S="${REPO_ROOT:-/app}/.opencode/skills/search-lit/references/pubmed_eutils.sh"
bash "$S" epmc_search "sglt2 inhibitor AND heart failure" 20   # Europe PMC, JSON records
bash "$S" epmc_cite_lookup "Bivariate analysis of sensitivity and specificity"
bash "$S" epmc_fetch "16168343,38000001"                        # by PMIDs
```

**Usage patterns:**

```bash
EUTILS="${REPO_ROOT:-/app}/.opencode/skills/search-lit/references/pubmed_eutils.sh"
PARSER="${REPO_ROOT:-/app}/.opencode/skills/search-lit/references/parse_pubmed.py"

# Search PubMed (returns PMIDs)
bash "$EUTILS" search "diagnostic test accuracy meta-analysis radiology" 20 \
  | python3 "$PARSER" esearch

# Get article summaries as markdown table
bash "$EUTILS" fetch_json "16168343,16085191,31462531" \
  | python3 "$PARSER" esummary

# Get detailed metadata
bash "$EUTILS" fetch "16168343" \
  | python3 "$PARSER" efetch

# Generate BibTeX entries
bash "$EUTILS" fetch "16168343,16085191" \
  | python3 "$PARSER" bibtex

# Verify a citation by exact title
bash "$EUTILS" cite_lookup "Bivariate analysis of sensitivity and specificity" \
  | python3 "$PARSER" esearch

# Find related articles for a PMID
bash "$EUTILS" related "16168343" 10 \
  | python3 "$PARSER" esummary
```

**Rate limiting**: 3 requests/second without API key, 10/sec with NCBI_API_KEY.
The script auto-sleeps 350ms between calls. For batch operations, keep calls sequential.

**E-utilities → MCP equivalence:**

| MCP Tool | E-utilities Command | Parser Mode |
|----------|-------------------|-------------|
| `search_articles` | `search <query> [retmax]` | `esearch` |
| `get_article_metadata` | `fetch <pmids>` | `efetch` or `bibtex` |
| `find_related_articles` | `related <pmid> [retmax]` | `esummary` |
| `lookup_article_by_citation` | `cite_lookup <title>` | `esearch` → `fetch` |
| `convert_article_ids` | Not available (use CrossRef DOI lookup) | — |
