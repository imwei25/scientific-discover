> 来源：search-lit/SKILL.md 原「Specialized Search Modes」节原样搬出（渐进披露）。进入某个专用模式（稿件参考文献池 / 系统检索 / Quick Cite / Related Papers / Embase 浏览器自动化）时读对应一节。

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
