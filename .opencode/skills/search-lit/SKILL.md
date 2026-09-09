---
name: search-lit
description: 医学文献检索与引用管理：检索 PubMed、Semantic Scholar、bioRxiv/medRxiv，每条引用经 API 验证后才纳入（防假引用），生成 BibTeX。触发："查文献""找几篇参考文献""要 BibTeX""literature search"。写成文综述用 literature-review。
triggers: literature search, find papers, citation, references, bibliography, PubMed search, related work
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---

> **本仓库运行环境（先读）**：Python 用 `"${REPO_ROOT:-/app}/.venv/bin/python"`（项目根 `.venv`，随包装好；报错先查路径引号，别重建）；本技能脚本在 `"${REPO_ROOT:-/app}/.opencode/skills/search-lit/"` 下，运行时先 `cd` 到该目录或用全路径；产出写 `outputs/`（有会话专属目录时以它为准、勿写仓库根固定名）。每条引用须经 API 核实（勿凭记忆造引用）。**注意：PubMed 走 NCBI E-utilities，从中国大陆网络常被阻断（curl/requests 都会 SSL 失败）；服务器在境外或配代理才稳。国内拿不到时改用 `fulltext-retrieval`/`reference-check`（走 Europe PMC/Crossref，国内可达）。** 以下为上游技能原文（vendored，未改方法论）。

# Literature Search Skill

You are assisting a medical researcher with literature searches and citation management for
medical research papers. Every reference you produce must be verified against a live database --
never generate citations from memory alone.

## Communication Rules

- Communicate with the user in their preferred language.
- All citation content (titles, abstracts, BibTeX) in English.
- Medical terminology is always in English.

### 筛选条件没生效，必须【明说它没生效】

用户勾了「影响力 / 档位」这类筛选，而取指标的源（OpenAlex，按额度计费）拿不到数时，
**不能只说"限流未能获取指标"就把结果照常交出去** —— 那句话用户读成"少了一列元数据"，
而真实含义是"**你勾的筛选条件根本没起作用，这份结果没按它过滤过**"。

实测踩过：用户勾了 Q1，交付的 20 篇里 18 篇指标为空、2 篇是 `0.0` 的垃圾值，池子里混着
Cureus ×2、Frontiers ×3 —— 一个都不像 Q1，而汇报里只有一句轻描淡写的"限流"。

正确做法：在结果表**之前**单独一行写清楚，例如
`⚠️ 本次未能获取期刊影响力指标（OpenAlex 额度不可用），因此「Q1」这个筛选条件没有生效——下面 20 篇未经该条件过滤，请自行判断刊物层次。`
同理适用于任何"某个源没打通 → 某个条件没执行"的情形。**取不到 ≠ 悄悄不筛**。

另：某个检索源要求等待很久（`Retry-After` 以小时计，OpenAlex 额度耗尽时就是如此）时，
脚本会直接判它本轮不可用并抛错（不再真的 sleep 下去）。**换源继续，并在报告里注明少了哪个源**。

## Key Directories

- **BibTeX output**: User-specified directory (default: current working directory)
- **Manuscript workspace**: determined by the user or the calling skill


## 一个会话里做多轮检索：第 2 次起必须带 `--tag`（否则前一次的证据表就没了）

- **每一轮检索都给一个短标签**：`--tag drug` → `evidence_table__drug.csv` /
  `evidence__drug.md`；也可以 `--out my_pool.csv` 显式指定（`.md` 用同一 stem）。
- 只有本会话**第一次也是唯一一次**检索时才可以不带 `--tag`（保持默认名，下游省事）。
- 汇报与交给下游时，**明确说清用的是哪张表**（带标签的文件名），别笼统说"证据表"。
- 机制（不带 `--tag` 旧表被改名 `.bak`、下游只读固定名、多概念合表一次传多个检索式）见 `references/multi-round-tag.md`。

## 检索路径选择（先读，尤其中国大陆网络）

三条路径，按当前环境自动挑：

1. **claude.ai 远程 MCP**（表见 references/pubmed-eutils.md）——仅当运行框架确实提供 `mcp__claude_ai_PubMed__*` 等工具时可用；Claude Code 本地 CLI、OpenCode 等**通常没有**，跳过。
2. **Europe PMC 直连**（`references/pubmed_eutils.sh` 的 `epmc_*` 子命令，走 ebi.ac.uk）——**中国大陆可达，作为无 MCP 时的首选**。它覆盖 PubMed（`SRC:MED`），无需梯子、无 NCBI 封锁问题。
3. **NCBI E-utilities**（同脚本的 `search/fetch/...` 子命令，走 eutils.ncbi.nlm.nih.gov）——功能最全但**大陆常被 SSL 阻断**；仅在境外/有代理时用。

判定：无 MCP 工具 → 先试 Europe PMC（`epmc_search`）；确认在境外或已配代理再用 NCBI。全自动模式下，若某源连续失败就自动换下一条，不要卡住等用户。

4. **多源增强检索**（`references/enhanced_search.py`，参数看 `--help`）——要更全召回时用：Europe PMC + Semantic Scholar + arXiv + OpenAlex 四源跨源去重，单源失败只跳过并报告；**条数默认不限**（别随手 `--limit`）；产出仍须经 Phase 4 核实。详见 `references/enhanced-search.md`。
5. **期刊影响力补列与筛选**（`references/journal_metrics.py`，参数看 `--help`）——⚠️ **措辞铁律**：`journal_impact` 是 OpenAlex 两年篇均被引、`journal_quartile` 是结果集内四分位，**绝不能**说成"影响因子 X 分""X 区"；查不到留空不拿 0 当真值。详见 `references/enhanced-search.md`。

## Search Tools: MCP (Primary) + E-utilities / Europe PMC (Fallback)

**Detection**: If any `mcp__claude_ai_PubMed__*` call returns an error containing
"terminated", "not found", "not available", or "not connected", switch ALL subsequent
PubMed calls in this session to E-utilities. Do not retry MCP after a disconnect — it
will not recover within the same conversation.

MCP 工具表、`pubmed_eutils.sh`（命令清单 `bash pubmed_eutils.sh help`）/ `parse_pubmed.py`（无参打印用法）示例、限速、MCP↔E-utilities 对照见 `references/pubmed-eutils.md`。

---

## Workflow

Phase 1/2/3/6 细项与表格模板见 `references/workflow-details.md`。

### Phase 1: Search Strategy

1. **Understand the need**. 2. **Generate search terms** (PICO concepts, MeSH, Boolean query). 3. **Define scope** (date range, article types, language). 4. **Present the search plan** (query, databases, filters) to the user before executing.

**Gate:** Wait for user approval before running searches.

### Phase 2: Execute Search

1.–3. **Search PubMed** (`search_articles`), **Semantic Scholar** (`semanticSearch`), **bioRxiv/medRxiv** (`search_preprints`, if preprints are relevant). 4. **Deduplicate** across databases (DOI or title similarity). 5. **Present results** in a structured table. 6. Ask the user to select which papers to include.

### Phase 2.5: Citation Searching (Snowballing)

Optional (PRISMA item 7, citation searching). `references/snowball.py`（参数看 `--help`）appends `verified=false` candidates to `outputs/refs.bib` only — confirm via Phase 4 before citing; record its dedup count for PRISMA. See `references/snowballing.md`.

### Phase 3: Deep Read

1. **Retrieve full metadata** (`get_article_metadata` / `get_preprint`). 2. **Extract key information** (design, N, methods, findings, limitations). 3. **Build a literature matrix** if multiple papers selected. 4. Present the matrix to the user for review.

### Phase 4: Citation Management

#### Anti-Hallucination Protocol

This is the most critical part of the skill. Follow these rules without exception:

1. **NEVER generate a reference from memory alone.** Every reference must come from an API search result.
2. **NEVER fabricate DOIs or PMIDs.** If you cannot find a DOI/PMID, mark the reference as `[UNVERIFIED - NEEDS MANUAL CHECK]`.
3–5. Cross-check every field against the API result, flag any mismatch, verify DOIs via CrossRef — full protocol: `references/anti-hallucination.md`.

#### BibTeX Generation

Every entry carries `verified` (`true`/`false`/`manual`) + `verified_by` + `verified_on`; key `FirstAuthorLastName_Year_OneWord`. Template: `references/bibtex-verified-flag.md`.

#### Output

1. Save BibTeX entries to the specified .bib file (append, do not overwrite).
   Target: `outputs/refs.bib` (the candidate pool; the user can import it into Zotero/EndNote).

### Phase 4b: Zotero Library Integration

Via the **`zotero-library` skill** (same machine only): `probe` first; `running=false` → skip silently (record `status: "skipped"`); `running=true` → push is irreversible, ask first (numbered options), then write the sync audit. See `references/zotero-integration.md`.

### Phase 5: Full-Text Retrieval

Delegated to **`/fulltext-retrieval`** (the single home of the OA cascade); do **not** re-implement OA fetching here. Commands and legitimate alternative sources (never bypass paywalls): `references/fulltext-retrieval.md`.

### Phase 6: Gap Analysis

1. **Read the manuscript** to extract all inline citations.
2. **Compare** cited references against the search results.
3. **Identify gaps**:
4. **Report** findings to the user with specific suggestions.

---

## Specialized Search Modes

五个模式的完整步骤见 `references/search-modes.md`：

- **Mode: Manuscript Paper Reference Pool** — **25–40** 篇经核实候选、按六类覆盖；只产候选、只追加 `outputs/refs.bib`，不写进稿件。
- **Mode: Systematic Search** — PRISMA 记录，**并记 `esearch` 打印的 `Query translation:` 行**；见 `⚠` 告警别把结果当数。
- **Mode: Quick Cite** — 给 top 3 让用户确认；⚠️ `cite_lookup` 第 1 条不保证精确匹配，逐条比对标题，权威判定交 `reference-check`。
- **Mode: Related Papers** — 由 PMID/DOI 扩展；要可计 PRISMA 数用 Phase 2.5。
- **Mode: Embase Browser Automation** — 无公开 API，走 Chrome 自动化导出 CSV；含 PubMed→Embase 检索式转换。

---

## Error Handling

0 命中放宽检索式；CrossRef 403/303 不重试、改走 PubMed 标题核验、末尾汇总一行——细目见 `references/error-handling.md`。
- Never silently include an unverified reference.

## What This Skill Does NOT Do

- Does not download from paywalled journals without user-provided credentials or institutional access.
- Does not assess the quality of evidence (use the `data-analysis` or `peer-review` skill for that).
- Does not write the review text itself (use the `literature-review` skill for that).
- Does not fabricate any part of a citation.
