---
name: fulltext-retrieval
description: 按 DOI/PMID/标题批量下载全文 PDF。第一级走合法 OA API（Unpaywall/PMC/OpenAlex/Crossref）；第二级挂用户本机已登录 CARSI/机构 SSO 的 Chrome 取订阅全文——不碰凭证，遇登录墙等用户操作。PMID/标题先自动解析成 DOI；逐条崩溃隔离；可选 PDF→Markdown 转换。
triggers: PDF download, fulltext retrieval, open access PDF, batch download papers, meta-analysis PDF, PDF to markdown, convert PDF, 机构订阅全文, CARSI, 校园网下文献, institutional access PDF
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---

> **本仓库运行环境（先读）**：Python 用 `${REPO_ROOT:-/app}/.venv/bin/python`（项目根 `.venv`；没有先跑 `env-setup` 技能）；本技能脚本在 `${REPO_ROOT:-/app}/.opencode/skills/fulltext-retrieval/` 下，运行时先 `cd` 到该目录或用全路径；产出写 `outputs/`（有会话专属目录时以它为准、勿写仓库根固定名）。`--email` 必须填**真实邮箱**（Unpaywall 会拒掉 example.com，报 HTTP 422）；DOI 列表可来自 `search-lit` 或用户；已装 pymupdf/pymupdf4llm。以下为上游技能原文（vendored，未改方法论）。

# Fulltext Retrieval Skill

> **决策规约（照 AGENTS.md §六）**：本技能任何要用户拍板的抉择——方向 / 方案 / 目标刊 / 作图后端 / 纳排标准 / 下一步等——一律**在正文里列 2–4 个编号候选**（推荐项放第 1 个并写明“推荐 X，因为……”），让用户**回一个数字即推进**；**别用开放式提问逼用户打字，也别弹交互选项卡（如 AskUserQuestion）**。只有无法枚举的纯事实（手上的数据文件、伦理批号、代表作清单等）才开放式问。

Batch download open-access full-text PDFs from a DOI list using legitimate OA APIs only.

## Pipeline

```
第一梯队（fetch_oa.py，纯 OA，可无人值守）：
  输入 DOI / PMID / 标题 →（PMID/标题先解析成 DOI）→ arXiv → Unpaywall → PMC (Europe PMC render / OA FTP / web) → OpenAlex → Crossref → landing page
  ↓ 失败的进 manual_needed.txt
第二梯队（fetch_institutional.py，机构通道，需本机已登录 Chrome，见下节）：
  manual_needed.txt → CDP 挂接用户已登录 CARSI/SSO 的 Chrome → doi.org 落地 → （遇登录墙等用户人工过）→ 带机构会话取 PDF
```

Each DOI goes through these sources in order until a valid PDF (≥10 KB, `%PDF-` header) is found. arXiv DOIs (`10.48550/arXiv.2401.01234`, version suffixes, old-style `hep-th/9901001`, or a bare `arXiv:` id) resolve directly to the arXiv PDF first.

**输入不止 DOI**：worklist 的一行只有 PMID 或只有标题也能下——脚本先 PMID→DOI（Europe PMC）、标题→DOI（Crossref 书目检索，标题吻合度 ≥0.6 才采纳，防张冠李戴），解析出的 DOI 再进主管线。三者皆无则记 FAIL 并列入 `manual_needed.txt`。

**健壮性**：① 每条独立隔离——任一条下载被截断（`IncompleteRead`）/超时/异常都只记该条 FAIL 并继续，绝不中断整批、报告照常生成（旧版遇截断会崩全批、连报告都没有）；② `fetch_bytes` 对瞬时网络错误退避重试 2 次；③ 拿到 HTML 拦截页（Nature/Springer 对非浏览器 UA 常见）时用浏览器 UA + Referer 兜底重取，并优先走 PMC render 端点（`europepmc.org/articles/PMCID?pdf=render`，比旧的 ptpmcrender 稳）。这些让金标 OA 的 Nature Communications 等也能稳定取到。

## Quick Start

```bash
# Prepare a DOI list (one per line)
cat > dois.txt << 'EOF'
10.1007/s00330-010-1783-x
10.1002/mp.12524
10.1148/radiol.13131265
EOF

# Run
python fetch_oa.py dois.txt --output pdfs/ --email your@email.com

# Verbose mode for debugging
python fetch_oa.py dois.txt -o pdfs/ -e your@email.com --verbose
```

## Input Formats

**Plain text** — one DOI per line:
```
10.1007/s00330-010-1783-x
10.1002/mp.12524
```

**TSV / CSV with header** — must contain a `DOI` column; optional `PMID` and `Title` columns:
```tsv
ID	Title	DOI	PMID	Year
1	Some paper	10.1007/s00330-010-1783-x	20628747	2010
```

**Markdown table** — a pipe table with a `DOI` column also works:
```markdown
| DOI | PMID | Title |
|-----|------|-------|
| 10.1007/s00330-010-1783-x | 20628747 | Some paper |
```

When a PMID is available, the PMC lookup is more reliable (PMID → PMCID conversion). When a `Title` column is present, downloaded PDFs get a best-effort title cross-check (see *Retrieval report* below).

## PMC Download (JS-Challenge Resistant)

PMC web pages may block automated downloads with JavaScript proof-of-work challenges. This tool uses three fallback methods:

### Method A: Europe PMC REST API (most reliable)

```bash
PMCID="PMC9733600"
curl -sLo output.pdf \
  "https://europepmc.org/backend/ptpmcrender.fcgi?accid=${PMCID}&blobtype=pdf"
```

### Method B: PMC OA FTP Service

```bash
curl -s "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=${PMCID}" | \
    grep -oE 'href="[^"]*\.pdf"' | head -1 | \
    sed 's/href="//;s/"//' | xargs curl -sLo output.pdf
```

### DOI/PMID → PMCID Conversion

```bash
# Works with both DOI and PMID
curl -s "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${DOI}&format=json" | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['records'][0].get('pmcid',''))"
```

## Output

- PDFs saved as `{DOI_safe}.pdf` (slashes replaced with underscores)
- `pdfs/retrieval_report.json` — structured per-DOI report (see below)
- `manual_needed.txt` — DOIs that could not be retrieved via OA
- Summary with arXiv/OA/PMC/fail/skip counts

## Retrieval report (`--report`)

Every run writes a structured report (default `<output>/retrieval_report.json`,
override with `--report PATH`):

```json
{
  "schema_version": 1,
  "generated_by": "fetch_oa.py",
  "counts": {"total": 10, "retrieved": 6, "not_retrieved": 4, "title_mismatch": 1},
  "items": [
    {"doi": "10.1007/...", "pmid": "20628747", "title": "...",
     "status": "oa", "source": "unpaywall", "file": "10.1007_....pdf",
     "size_bytes": 482113, "title_match": "match"}
  ]
}
```

- `status` ∈ `arxiv | oa | pmc | skip | fail`; `source` names the resolver that succeeded.
- `title_match` ∈ `match | mismatch | unavailable` (tri-state). It is **best-effort**:
  it needs a `Title` column **and** `pdftotext` (poppler). When either is missing it is
  `unavailable`; a `mismatch` is **flagged** for review and **never** auto-rejects a PDF
  (guards against a publisher serving a wrong/redirect PDF that still passes the `%PDF-` check).

## 机构通道（CARSI / 浏览器登录态）— `fetch_institutional.py`

OA 渠道天然拿不到「付费墙内但**机构已订购**」的文献。第二梯队借鉴 nature-downloader 的思路：**不启动新浏览器，而是通过 CDP 挂接用户本机已登录 CARSI / 机构 SSO 的真实 Chrome**，复用其合法授权会话取全文。这是用用户自己的订阅权限，不是绕付费墙。

### 前置（一次性）

```bash
# 1. 用专用资料目录启动 Chrome 并开 CDP（Chrome 136+ 禁止对默认资料目录开远程调试）
#    Windows (PowerShell)：
#    & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\sci-scholar-chrome"
#    Linux/macOS 命令见脚本 --help / CDP_HELP；没有 Chrome 用 Edge（msedge）也行。
# 2. 在该窗口经图书馆 / CARSI（www.carsi.edu.cn）登录一次——会话存在专用资料目录，之后直接复用
# 3. 装可选依赖（只挂接现有 Chrome，不需要 playwright install 下载浏览器内核）
${REPO_ROOT:-/app}/.venv/bin/python -m pip install playwright
```

### 用法

```bash
# 典型：接在 fetch_oa.py 之后，吃它的 manual_needed.txt，写同一个 pdfs/ 和同一份报告
python fetch_institutional.py pdfs/manual_needed.txt -o pdfs/

# 也接受 fetch_oa 支持的任何 worklist 格式；限量/限速/CDP 地址可调
python fetch_institutional.py worklist.tsv -o pdfs/ --max 10 --delay 8 --cdp http://127.0.0.1:9222
```

行为要点：

- **遇登录墙 / 人机验证只等人**：检测到 CARSI/Shibboleth/OpenAthens/EZproxy/验证页时暂停，提示用户去 Chrome 窗口自己完成（默认最多等 240s，`--login-timeout` 可调），**脚本绝不读取、存储、代填任何密码/OTP**，也绝不自动过验证码。
- **限量限速是硬闸**：单次默认 ≤20 条（`--max`）、逐条间隔默认 5s（下限 3s）。出版商对批量下载有风控，触发会**连累全机构的访问权限**——别为省事拉高上限做全刊批量抓取。
- **结果并回同一份报告**：成功条目在 `retrieval_report.json` 里记 `status: "institutional"`（`counts.institutional` 单独计数），已下到的自动从 `manual_needed.txt` 划掉；同样做标题交叉核对。**向用户汇报时如实区分哪些走 OA、哪些走机构通道、哪些仍失败及原因**。
- **优雅降级**：探测不到 CDP（服务器多用户部署、无浏览器环境）→ 打印启动指引后 exit 2，不影响 OA 主管线——与 `zotero-library` 的同机降级策略一致；此时失败清单仍走人工/馆际互借。
- 每条独立隔离（同 fetch_oa），单条超时/异常绝不拖垮整批。

## Attach PDFs into Zotero ("Find Available PDF")

OA-only resolvers miss paywalled-but-licensed papers. To attach full text **inside
Zotero** at a much higher yield, use `references/find_available_pdf.js` — a user-run
snippet for Zotero's *Tools → Developer → Run JavaScript*. It triggers Zotero's own
`addAvailablePDF` / `addAvailablePDFs` and therefore reuses **your** OpenURL resolver /
institutional proxy config; **no credentials, proxy hosts, or institutional identifiers
are hard-coded or leave your Zotero client**. The no-code equivalent is right-click →
"Find Available PDF".

This path is **user-initiated** and depends on your live Zotero session, so its results
are recorded manually. Run the two routes yourself when needed: disk OA via `fetch_oa.py`
here, plus the in-library `find_available_pdf.js` snippet inside Zotero.

## Requirements

- Python 3.10+ (stdlib only, no pip dependencies)
- Contact email (required by Unpaywall Terms of Service)

## API Policies

| Source | Rate Limit | Notes |
|--------|-----------|-------|
| Unpaywall | 100 req/sec | Email required |
| NCBI PMC | 3 req/sec without API key | Add `&api_key=` for higher limits |
| OpenAlex | 100k req/day | Polite pool with email in User-Agent |
| Crossref | 50 req/sec with email | Plus service with `mailto:` in UA |
| Europe PMC | No documented limit | Be polite, ≤1 req/sec recommended |

The script uses 0.3–0.5 second delays between requests.

## PDF → Markdown Conversion (Optional)

After downloading PDFs, convert them to LLM-friendly Markdown for token-efficient repeated analysis. Uses [pymupdf4llm](https://github.com/pymupdf/RAG) — optimized for academic papers with two-column layout handling and table preservation.

### Quick Start

```bash
# Install (one-time)
pip install pymupdf4llm

# Convert all PDFs in a directory
python pdf_to_md.py pdfs/

# Convert with verbose output
python pdf_to_md.py pdfs/ -v

# Custom output directory
python pdf_to_md.py pdfs/ -o markdown/

# First 10 pages only (useful for long supplements)
python pdf_to_md.py pdfs/ --pages 0-9

# Overwrite existing conversions
python pdf_to_md.py pdfs/ --force
```

### Combined Workflow

```bash
# Step 1: Download PDFs
python fetch_oa.py dois.txt -o pdfs/ -e your@email.com

# Step 2: Convert to Markdown (only successful downloads)
python pdf_to_md.py pdfs/ -v
```

After conversion, `.md` files sit alongside `.pdf` files. Claude Code can then use `Read` for full content or `Grep` for targeted extraction — significantly more token-efficient than re-reading PDFs.

### When to Convert

| Scenario | Recommendation |
|----------|---------------|
| Screening/triage (read once) | Skip — read PDF directly |
| Data extraction from k≥5 studies | Convert — repeated reads save tokens |
| Meta-analysis full pipeline | Convert — papers referenced across multiple phases |
| Single paper deep review | Optional — marginal benefit |

### Academic Paper Defaults

- **Images**: Skipped (saves tokens; figures referenced by caption text)
- **Tables**: `lines_strict` strategy (preserves grid-line tables accurately)
- **Layout**: Two-column academic layout handled automatically
- **Headers/footers**: Removed by pymupdf4llm

### Dependency Note

`pdf_to_md.py` requires [pymupdf4llm](https://pypi.org/project/pymupdf4llm/) (AGPL-3.0). This is an **optional** dependency — `fetch_oa.py` remains stdlib-only with zero external dependencies. The AGPL license applies to pymupdf4llm itself, not to this skill.

## Limitations

- `fetch_oa.py` only retrieves **open-access** articles. Paywalled-but-subscribed articles go through `fetch_institutional.py` (requires a same-machine logged-in Chrome; unavailable on the multi-user server — expected, not a bug). Articles the user's institution has **not** licensed fail in both tiers by design.
- The institutional tier is **interactive**: login walls and bot checks are handed to the user, never automated. It is deliberately rate-limited and batch-capped.
- Landing page scraping may fail on publisher-specific JavaScript-heavy pages.
- Some recent articles may not yet be indexed by OA sources.
- PDF→Markdown quality depends on the PDF's text layer. Scanned-only PDFs may produce poor output.

## Anti-Hallucination

- **Never fabricate file paths, URLs, DOIs, or package names.** Verify existence before recommending.
- **Never invent journal metadata, impact factors, or submission policies** without verification at the journal's website.
- If a tool, package, or resource does not exist or you are unsure, say so explicitly rather than guessing.
