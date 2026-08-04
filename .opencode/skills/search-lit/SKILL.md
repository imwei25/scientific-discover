---
name: search-lit
description: Literature search and citation management for medical research. Searches PubMed, Semantic Scholar, and bioRxiv/medRxiv with verified citations. Anti-hallucination — every reference verified via API before inclusion. Generates BibTeX entries.
triggers: literature search, find papers, citation, references, bibliography, PubMed search, related work
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---

> **本仓库运行环境（先读）**：Python 用 `${REPO_ROOT:-/app}/.venv/bin/python`（项目根 `.venv`；没有先跑 `env-setup` 技能）；本技能脚本在 `${REPO_ROOT:-/app}/.opencode/skills/search-lit/` 下，运行时先 `cd` 到该目录或用全路径；产出写 `outputs/`（有会话专属目录时以它为准、勿写仓库根固定名）。每条引用须经 API 核实（勿凭记忆造引用）。**注意：PubMed 走 NCBI E-utilities，从中国大陆网络常被阻断（curl/requests 都会 SSL 失败）；服务器在境外或配代理才稳。国内拿不到时改用 `fulltext-retrieval`/`reference-check`（走 Europe PMC/Crossref，国内可达）。** 以下为上游技能原文（vendored，未改方法论）。

# Literature Search Skill

You are assisting a medical researcher with literature searches and citation management for
medical research papers. Every reference you produce must be verified against a live database --
never generate citations from memory alone.

## Communication Rules

- Communicate with the user in their preferred language.
- All citation content (titles, abstracts, BibTeX) in English.
- Medical terminology is always in English.

## Key Directories

- **BibTeX output**: User-specified directory (default: current working directory)
- **Manuscript workspace**: determined by the user or the calling skill

## 检索路径选择（先读，尤其中国大陆网络）

三条路径，按当前环境自动挑：

1. **claude.ai 远程 MCP**（下表）——仅当运行框架确实提供 `mcp__claude_ai_PubMed__*` 等工具时可用；Claude Code 本地 CLI、OpenCode 等**通常没有**，跳过。
2. **Europe PMC 直连**（`references/pubmed_eutils.sh` 的 `epmc_*` 子命令，走 ebi.ac.uk）——**中国大陆可达，作为无 MCP 时的首选**。它覆盖 PubMed（`SRC:MED`），无需梯子、无 NCBI 封锁问题。
3. **NCBI E-utilities**（同脚本的 `search/fetch/...` 子命令，走 eutils.ncbi.nlm.nih.gov）——功能最全但**大陆常被 SSL 阻断**；仅在境外/有代理时用。

判定：无 MCP 工具 → 先试 Europe PMC（`epmc_search`）；确认在境外或已配代理再用 NCBI。全自动模式下，若某源连续失败就自动换下一条，不要卡住等用户。

4. **多源增强检索**（`references/enhanced_search.py`）——需要**更全的召回**时（交叉学科、
   预印本、按被引/机构补充）用它。一次打通 **Europe PMC + Semantic Scholar + arXiv +
   OpenAlex** 四源，**跨源按 DOI→标题去重**后汇成统一证据表。以 Europe PMC 为国内可达
   骨干：**任一增强源失败（限流/被墙）只跳过并在末尾报告，不中断整体**，境外/代理下四源
   齐发效果最佳。产出对齐 `literature-review/search.py`（`outputs/evidence_table.csv` +
   `evidence.md`，多一列 `sources` 标每篇命中的源）。

   ```bash
   PY=${REPO_ROOT:-/app}/.venv/bin/python   # Linux/macOS: ${REPO_ROOT:-/app}/.venv/bin/python
   S=${REPO_ROOT:-/app}/.opencode/skills/search-lit/references/enhanced_search.py
   # 默认四源全开，跨源去重
   "$PY" "$S" "graph neural network drug discovery" --limit 25 --since 2021 --email you@example.com
   # 只要预印本+跨学科（跳过 PubMed 系）
   "$PY" "$S" "protein language model" --sources semantic_scholar,arxiv,openalex --limit 20
   ```

   - **OpenAlex 鉴权**：默认走 polite pool，只需 `--email`（或环境变量 `OPENALEX_MAILTO`）
     一个联系邮箱即可**匿名调通，不需要 API key**（与 openscience 同法）；设了环境变量
     `OPENALEX_API_KEY` 会自动带上进 premium pool。**Semantic Scholar** 同理：共享池会
     429 限流（脚本已指数退避），设 `S2_API_KEY` 提限额。
   - 用途边界：`enhanced_search.py` 是**广召回 + 跨源去重**的证据池生成器，产出的 `doi/pmid`
     仍须经 Phase 4 反幻觉协议 / `reference-check` 技能逐条核实后才能进正文引用。

5. **期刊影响力补列与筛选**（`references/journal_metrics.py`）——用户要求"只看高分杂志 /
   某分区以上"时用它给 `evidence_table.csv` 补 `journal_impact` / `journal_quartile` /
   `is_oa` 列，并可直接按条件筛掉。

   ```bash
   PY=${REPO_ROOT:-/app}/.venv/bin/python
   S=${REPO_ROOT:-/app}/.opencode/skills/search-lit/references/journal_metrics.py
   "$PY" "$S" evidence_table.csv --email you@example.com            # 只补列
   "$PY" "$S" evidence_table.csv --min-impact 3 --quartile Q1,Q2    # 补列 + 筛选
   "$PY" "$S" evidence_table.csv --table /path/中科院分区表.csv      # 用机构分区表覆盖成官方真值
   ```

   > ⚠️ **措辞铁律（违反即为编造数据，见 AGENTS.md §五）**：`journal_impact` 是 OpenAlex 的
   > **两年篇均被引**，与 JCR 影响因子算法思路相近但**口径不同、数值不同**；`journal_quartile`
   > 是**本次结果集内部**的四分位，**不是**中科院/JCR 分区。向用户汇报时一律说
   > "期刊影响力（近似）""结果集内四分位"，**绝不能**说成"影响因子 X 分""X 区"。
   > 官方 IF 与中科院分区是授权数据，本套件没有；用户要精确值就请他提供本机构的分区表，
   > 用 `--table` 覆盖（覆盖过的行 `impact_source` 列会标出来源，如实告诉用户哪些是官方值）。
   > 查不到的期刊 `journal_impact` **留空**，不要拿 0 当真值去排序或筛选。

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

**Scripts** (in `${REPO_ROOT:-/app}/.opencode/skills/search-lit/references/` — run from repo root or use the full path):
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

---

## Workflow

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

### Phase 4: Citation Management

#### Anti-Hallucination Protocol

This is the most critical part of the skill. Follow these rules without exception:

1. **NEVER generate a reference from memory alone.** Every reference must come from an API search result.
2. **NEVER fabricate DOIs or PMIDs.** If you cannot find a DOI/PMID, mark the reference as `[UNVERIFIED - NEEDS MANUAL CHECK]`.
3. **Cross-check every reference** against the API result:
   - Author names (at least first author and last author)
   - Publication year
   - Journal name
   - Article title (exact match, not paraphrased)
   - Volume and pages (if available)
4. **If any field does not match**, flag the specific mismatch.
5. **For DOI verification**, use WebFetch with `https://api.crossref.org/works/{DOI}` to confirm the DOI resolves correctly.

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

### Phase 4b: Zotero Library Integration

Integration goes through the **`zotero-library` skill** (local Zotero 7 API at
`127.0.0.1:23119` via its `references/zotero_read.py` — there is no Zotero MCP server
in this suite). It only works when this suite runs **on the same machine** as the
user's Zotero desktop app.

1. **Probe silently**:
   `zotero_read.py probe` → `{"running": true/false, ...}`.
2. **`running=false`** (central multi-user server, Zotero closed, or local API
   disabled): **skip this phase without telling the user** — do not report
   "Zotero not connected" for a search they never framed around Zotero. Just record
   `status: "skipped"` + reason in `references/zotero_collection.json` and move on.
   Only surface Zotero if the user explicitly asked to use their library.
3. **`running=true`**: offer to save the verified candidates into Zotero. Pushing is a
   **write** operation into the user's currently selected collection, and Zotero's
   local API has **no delete endpoint** (a wrong push cannot be rolled back
   programmatically) — so ask first with numbered options per AGENTS.md §六, e.g.:
   "**1)** 不导入，只留 `refs.bib`（推荐，可稍后手动导入） **2)** 把这批题录存进
   Zotero 当前选中分类". On "2", run
   `zotero_read.py push --bib outputs/refs.bib` (or `--csv evidence_table.csv`);
   it merges in-payload duplicates and skips items that came from Zotero, but does
   **not** dedupe against the rest of the library — say so when offering.
4. **Write sync audit**: record collection, pushed/skipped/failed counts in
   `references/zotero_collection.json` so Zotero status is auditable rather than a
   hidden optional side effect.

### Phase 5: Full-Text Retrieval

Full-text PDF retrieval is **delegated to `/fulltext-retrieval`** — the single authored
home of the open-access cascade (arXiv → Unpaywall → PMC → OpenAlex → Crossref → landing
page, each validated with a `%PDF-` header + ≥10 KB size). Do **not** re-implement OA
fetching here.

Pass the verified candidate DOIs from `outputs/refs.bib`:

```bash
ENGINE="${REPO_ROOT:-/app}/.opencode/skills/fulltext-retrieval/fetch_oa.py"
# extract DOIs from outputs/refs.bib → dois.txt (one per line)
python3 "$ENGINE" dois.txt -o pdfs/ -e <contact-email> --report pdfs/retrieval_report.json
```

For Zotero-resident PDFs and higher-yield, proxy-aware retrieval, run the
`fulltext-retrieval` skill's `references/find_available_pdf.js` snippet inside Zotero
to trigger its native "Find Available PDF".

#### Alternative sources (legitimate only)

For DOIs that open access cannot reach (listed in `pdfs/manual_needed.txt`):

- **Institutional access / proxy / VPN** — through your library's own subscriptions.
- **Interlibrary loan (ILL)** — request via library services.
- **Author contact** — email the corresponding author for a copy or preprint.

Never bypass paywalls or publisher access controls, and do not configure unauthorized
PDF mirrors. Rate limits and PDF validation are handled inside `/fulltext-retrieval`.

### Phase 6: Gap Analysis

When called during manuscript or review writing:

1. **Read the manuscript** to extract all inline citations.
2. **Compare** cited references against the search results.
3. **Identify gaps**:
   - Key papers in the field that are not cited.
   - Outdated references when newer versions exist.
   - Missing methodological references (e.g., statistical methods, reporting guidelines).
4. **Report** findings to the user with specific suggestions.

---

## Specialized Search Modes

### Mode: Manuscript Paper Reference Pool

For supplying a manuscript's reference pool — useful when the draft is under its reference target
or a named method is uncited, and directly when building out an original-research bibliography.

This mode is deliberately **broad**: for an original-research article, return **25–40** verified
candidates, not the ~10 a quick search settles on. Do not stop early unless the field is genuinely
sparse — and if it is, say so explicitly rather than returning a thin list silently. Respect a
narrower journal reference cap or user scope when one is given.

Structure the pool across **six candidate categories** so the gaps the adequacy gate cares about
are all covered:

1. **Background / disease burden / clinical context** — establishes why the question matters.
2. **Gap-defining prior studies** — the work the manuscript extends or contradicts.
3. **Comparator / comparable-design cohorts** — studies the Results will be measured against.
4. **Methods / statistical canonical sources** — the originating reference for every named method,
   model, score, equation, or diagnostic criterion (e.g. competing-risk model, multiple
   imputation, E-value, eGFR equation, concordance statistic). This is the category that clears
   Methods named-method gaps.
5. **Reporting-guideline sources** — STROBE, TRIPOD(+AI), CONSORT, PRISMA(-DTA), STARD, etc.
6. **Interpretation / mechanism / limitation support** — grounds Discussion claims.

For each candidate, report: **PMID/DOI**, **verification status**, **candidate category**, the
**target manuscript section** it belongs in, and a one-line **why it is needed**.

Boundary: every entry is API-verified before inclusion, and BibTeX is appended **only**
to `outputs/refs.bib` — the candidate pool. This mode produces candidates; it does not
decide inclusion (the user does) and it does not insert references into any manuscript.

### Mode: Systematic Search

For systematic reviews or comprehensive literature sections:

1. Document the full search strategy (PRISMA-compliant).
2. Record: database, date of search, query string, number of results，**并记下 `esearch` 打印的
   `Query translation:` 行**——那是 PubMed 自动词映射后【实际执行】的 MeSH 展开式，
   与你输入的原始式往往不同；PRISMA 附录要的是这条可复现的实际检索式，不是你敲的那句。
3. **留意 `⚠` 告警**：`esearch` 现在会打印 NCBI 的 warninglist/errorlist（引号短语被丢弃、
   字段拼错被当全字段重解释导致海量结果等）。命中告警说明查询被悄悄改写，**别把结果当数**，
   修正检索式重跑。
4. Track inclusion/exclusion at each screening step.
5. Output a PRISMA flow diagram data summary.

### Mode: Quick Cite

For quickly finding a single reference the user describes:

1. User says something like "that 2023 paper by Smith about AI in chest X-ray."
2. Search PubMed and Semantic Scholar with the described details.
3. Present top 3 candidates.
4. User confirms which one.
5. Generate BibTeX entry.

> ⚠️ **`cite_lookup <title>` 只返回按相关度排序的候选，不保证第 1 条就是精确标题匹配**（实测过
> 精确匹配排在第 4/5、第 1 条是无关论文）。**别默认取 top hit 当确认**——逐条比对标题是否逐字吻合
> 再采用。要**权威判定某条引用真伪 / 标题是否对得上**，交 `reference-check` 技能（它做归一化标题
> 相似度与 DOI/PMID 核验，正是为此设计），别用 cite_lookup 的排序结果下结论。

### Mode: Related Papers

For expanding from a known paper:

1. User provides a PMID or DOI.
2. Use `find_related_articles` to get related papers.
3. Use Semantic Scholar for citation-based recommendations.
4. Present results ranked by relevance.

For a **structured, dedup-aware, PRISMA-countable** expansion (backward +
forward + similar) prefer **Phase 2.5: Citation Searching** with
`references/snowball.py`, which appends verified candidates to
`outputs/refs.bib` and reports a citation-searching count.

### Mode: Embase Browser Automation

Embase has no public API. Use Chrome browser automation (MCP) to search and export:

1. Navigate to `embase.com` — institutional SSO authenticates automatically.
   If cookie error (`login?error#`), clear Elsevier/Embase cookies and retry.
2. Go to **Advanced Search** tab.
3. Enter Embase-syntax query (Emtree `/exp` + `:ab,ti` field tags).
   Uncheck "Map to preferred term in Emtree" when using explicit `/exp` terms.
4. After results appear, use "Select number of items" dropdown → select total count.
5. Click **Export** (in Results section) → choose **CSV** format → check fields:
   Title, Author names, Source, Publication year, Publication type, DOI, Abstract,
   Language of article, Medline PMID.
6. Click Export → Download tab opens → click Download.
7. CSV is in **row format** (records separated by blank rows) — parse with:
   ```python
   # Each record = consecutive rows until blank row
   # Row format: [FIELD_NAME, value1, value2, ...]
   # AUTHOR NAMES row has multiple values (one per author)
   ```

**PubMed → Embase query translation:**
- MeSH `[Mesh]` → Emtree `/exp`
- `[tiab]` → `:ab,ti`
- `[Title/Abstract]` → `:ab,ti`
- Boolean operators stay the same (AND, OR)
- Phrase search: use single quotes in Embase (`'artificial ascites'`)

---

## Error Handling

- If a search returns 0 results, broaden the query (remove one concept or use broader MeSH terms) and retry.
- **CrossRef HTTP errors (token-saving rules):**
  - **403 (rate-limited):** Do NOT retry. Skip CrossRef silently → verify via PubMed title search instead.
  - **303 (redirect):** Follow the redirect if possible. If not, skip CrossRef → PubMed fallback.
  - **Any repeated failure:** After the first CrossRef 403/303 in a session, assume CrossRef is
    rate-limiting and skip CrossRef for ALL remaining references. Go directly to PubMed title
    verification. This avoids N×retry token waste.
  - **Never print raw error messages** like "Request failed with status code 403." Collect
    failures silently and report a single summary line at the end:
    `CrossRef unavailable for {N} references (rate-limited). Verified via PubMed instead.`
- If a DOI does not resolve via CrossRef (after applying the rules above), try searching PubMed by title to confirm the reference exists.
- If the user provides a reference that cannot be verified by any method, clearly state: "This reference could not be verified. Please check manually before submission."
- Never silently include an unverified reference.

## What This Skill Does NOT Do

- Does not download from paywalled journals without user-provided credentials or institutional access.
- Does not assess the quality of evidence (use the `data-analysis` or `peer-review` skill for that).
- Does not write the review text itself (use the `literature-review` skill for that).
- Does not fabricate any part of a citation.
