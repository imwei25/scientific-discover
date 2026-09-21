---
name: fulltext-retrieval
description: 按 DOI/PMID/标题批量下载全文 PDF：先走合法 OA API（Unpaywall/PMC/OpenAlex/Crossref），再挂用户本机已登录机构 SSO 的 Chrome 取订阅全文（不碰凭证，登录墙交用户）；逐条崩溃隔离，可选 PDF→Markdown。触发："下全文""下载 PDF""PDF 转 md"。
triggers: PDF download, fulltext retrieval, open access PDF, batch download papers, meta-analysis PDF, PDF to markdown, convert PDF, 机构订阅全文, CARSI, 校园网下文献, institutional access PDF
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---

> **本仓库运行环境（先读）**：Python 用 `"${REPO_ROOT:-/app}/.venv/bin/python"`（项目根 `.venv`，随包装好；报错先查路径引号，别重建）；本技能脚本在 `"${REPO_ROOT:-/app}/.opencode/skills/fulltext-retrieval/"` 下，运行时先 `cd` 到该目录或用全路径；产出写 `outputs/`（有会话专属目录时以它为准、勿写仓库根固定名）。`--email` 必须填**真实邮箱**（Unpaywall 会拒掉 example.com，报 HTTP 422）；DOI 列表可来自 `search-lit` 或用户；已装 pymupdf/pymupdf4llm。以下为上游技能原文（vendored，未改方法论）。

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

### 前置：什么都不用配，脚本自己起浏览器

**别让用户去敲 `--remote-debugging-port`。** 脚本探测不到调试端口时会**自动**用专用资料目录
起一个 Chrome（没 Chrome 就用 Edge），用户只会看到弹出一个浏览器窗口。

```bash
# 想先把浏览器起起来（给用户先登录 / 先确认在校园网里），不下载任何东西：
python fetch_institutional.py --launch-browser
# 正常下载时无需任何额外动作——没端口就自动起。要关掉这个行为：--no-auto-launch
```

**必须对用户讲清楚的两句话**（否则他会奇怪"怎么又开了个 Chrome、还没我的收藏夹"）：

1. 这是个**独立的浏览器资料目录**（`%LOCALAPPDATA%\sci-scholar-chrome`），和他平时用的
   Chrome 互不影响。这不是我们想要的，是 **Chrome 136+ 的硬限制**：对默认资料目录开远程
   调试端口会被直接拒绝，绕不过去。
2. **IP 授权制（机器就在学校/医院网里）：不用登录任何东西**，空 profile 照样能下。
   **CARSI / 图书馆账号制**：在这个新窗口里登录一次，会话存在专用目录里，以后一直复用。

自动启动失败的唯一常见原因：**同一个专用资料目录已经有一个没带调试端口的窗口开着**
（脚本会明说这一条）→ 把那个窗口关掉重跑。找不到浏览器时可用环境变量 `SCI_BROWSER_PATH`
指定可执行文件路径，或按 `--help` 里的命令手动起。

依赖 playwright：桌面打包版已预装；自建部署若缺则
`"${REPO_ROOT:-/app}/.venv/bin/python" -m pip install playwright`。
**不要**跑 `playwright install` 下载浏览器内核——本通道只 attach 用户现有的 Chrome。

### 用法

```bash
# 典型：接在 fetch_oa.py 之后，吃它的 manual_needed.txt，写同一个 pdfs/ 和同一份报告
python fetch_institutional.py pdfs/manual_needed.txt -o pdfs/

# 也接受 fetch_oa 支持的任何 worklist 格式；限量/限速/CDP 地址可调
python fetch_institutional.py worklist.tsv -o pdfs/ --max 10 --delay 8 --cdp http://127.0.0.1:9222

# 纯 IP 授权制机构（机器就在校园网/机构网段内）：遇登录墙不等人，直接跳过继续
python fetch_institutional.py pdfs/manual_needed.txt -o pdfs/ --ip-only

# 机构网络自检（下不到东西时先跑这个；远程委托别人代测必用）
python fetch_institutional.py --diagnose
```

### 机构是 WebVPN（URL 改写型代理）时——自动识别，不用问用户

国内高校常见第三种机制：登录后地址栏变成
`webofscience-clarivate-cn-s.webvpn.njmu.edu.cn:8118`——原域名的点换成横杠、https 加后缀
`-s`、再接学校网关。**这类代理只对带前缀的 URL 授权**，所以光在浏览器里登录没用，
必须把目标地址改写成代理形式；而网关域名和端口各校不同、**猜不出来也不许猜**。

**我们不知道用户是哪个学校，也不去猜**（按校名拼 `webvpn.xxx.edu.cn` 这种事一律不做，
拼错了用户会当成软件坏了）。流程设计成不需要知道：

- **第一次**：弹出的窗口停在一张本地引导页，只说一句"在地址栏打开**你平时用的那个**
  图书馆 / WebVPN 地址并登录"——去哪由用户定，那个地址他天天用。
- **登录之后**：网关信息就躺在这个窗口的 cookie 和标签页里了，自动读出来，
  并记到 `%LOCALAPPDATA%\sci-institution.json`（**只记入口地址，不记任何凭据**）。
- **以后每次**：窗口直接开在他学校的门户上，会话没过期就什么都不用做。

脚本**自动识别**，三条路径（用户什么都不用提供）：

1. **已打开的标签页**——地址栏里就写着网关和端口，最准；
2. **cookie**（`.webvpn.*` 上的会话 cookie）——标签页关了也还在，更耐久；拿到域名后
   探一下门户在哪个 origin（依次试 https:443 / http:80 / http:8118）；
3. **本机记忆**（上次识别到的入口）——会话过期了地址仍然对，用它把窗口直接开到门户。

**未登录时会被 302 回门户**（实测：`https://<网关>/portal/?redirect_uri=<改写后的目标>`）。
两件事由此而来：① 门户自己在 https:443，而改写地址用的是 http:8118，所以识别要解析
**内嵌的 `redirect_uri`**，只看落地 URL 会取错协议和端口；② 落地主机等于网关主机
= 没登录，单独判成 `needs-login`，别记成"这篇没有全文链接"。

识别到就打印出来并据此改写；识别错了或根本不该走代理，用 `--no-webvpn` 关掉；
要手动指定用 `--webvpn webvpn.xxx.edu.cn:8118`（或环境变量 `SCI_WEBVPN`）。

两个实现要点：

- **入口 URL 先用 Crossref 把 DOI 解成出版商落地页再改写**，不是改写 `doi.org` 本身——
  多数 WebVPN 只放行白名单内的站点，doi.org 往往不在名单里，而且它的 302 会跳到未改写的
  真实域名、直接跳出代理。
- **只改写入口就够**：落地后页面里的链接由 WebVPN 自己服务端改写过，抓到的候选本来就是
  代理地址。
- **目标站点带非标准端口**时的编码方式各校不一，本实现**不臆造**：原样使用并打警告。
  遇到打不开，让用户在浏览器里手动打开一篇，把地址栏真实 URL 发回来对照，别猜。

### `--diagnose`：下不到时先跑它，别靠猜

"下不下来"背后至少五种互不相干的原因（不在机构网段 / 网络根本不通 / 没订这篇 /
人机验证 / 页面结构特殊），光看结果分不出来。自检跑一次约 2–3 分钟，产出
**`机构网络自检报告.md`（人看）+ `.json`（逐步轨迹）**，内容：

1. **出口 IP 及其归属**——最容易错的一环：很多人连了 VPN、或连的是单位访客网段，
   以为自己在校园网里。归属不是学校/医院，后面都不用看了。
2. **一篇 OA 文章做对照组**（分水岭）：对照成功 + 订阅篇全败 → 网络通、问题在权限；
   **对照也失败 → 是网络/代理问题，与订阅权限无关**。
3. **6 家主流出版商各一篇**（Elsevier/Wiley/Springer/T&F/SAGE/OUP，均经 Unpaywall
   核实为真付费墙），逐篇记完整轨迹：落地 URL、页面标题、判成哪一类、找到几个候选
   PDF 链接、下到多少字节。**换探针必须重新核实 `is_oa=false`**，否则对照失效。
4. 环境：浏览器起没起来、版本、CDP 通不通、playwright 版本，**以及有没有识别到 WebVPN
   网关**——这一项直接说明对方机构走的是哪种机制（识别到 = URL 改写型代理；没识别到而
   订阅篇全败 = 多半没在机构网段里或 IP 授权没生效）。

**报告里含出口 IP 与网络归属**，脚本跑之前会明说；让用户自行决定发不发给别人。
向用户交代结论时按报告第四节的读法走，别把「网络不通」说成「没订购」。

### 机构是「IP 授权制」时（机器在校园网 / 医院网段内）

这是最省事的一种情形：**出口 IP 在已订购网段内，出版商直接放行，不需要 CARSI、不需要任何登录**。
要点：

- 仍然要开那个带 CDP 的 Chrome（脚本靠它拿真实浏览器指纹与 cookie），但**不用登录任何东西**，
  专用资料目录是空的也没关系——IP 授权跟登录态无关。
- 脚本是**先取 PDF、取不到才判登录墙**（顺序是刻意的）：IP 制下不会出现登录墙，
  任何"先判认证页"的启发式都只会误判，而一次误判就是白等 `--login-timeout`（默认 240s），
  20 条能空转一个多小时。
- 无人值守批量加 `--ip-only`：命中登录墙立刻记 `needs-login` 继续下一条，不停下等人。
- **失败原因要分开读**（Summary 里有分布，别笼统说"没下到"）：
  `paywalled` = 落地页还挂着购买入口 → **本机构没订这篇**，走馆际互借；
  `challenge` = 出版商弹了人机验证（Elsevier/Cell 在非机构网络下最常见）→ **脚本绝不自动过**，
  让用户去那个 Chrome 窗口手动点一次，同站点之后一般放行，再重跑；
  `needs-login` = 这家不认 IP、要登录 → 去 Chrome 里经 CARSI/图书馆登录一次，再不带 `--ip-only` 重跑；
  `no-pdf-link` = 页面上找不到全文直链（多为重 JS 或版式特殊）；
  带 `-timeout` 后缀的（`challenge-timeout` / `needs-login-timeout`）= 等了用户但超时没处理。
- `fetch_oa.py` 的最后一步 `landing`（doi.org → 出版商落地页）**也吃 IP 授权**，且它装成普通浏览器访问
  （浏览器 UA + 逐跳 Referer + 进程内 cookie jar）。所以在机构 IP 上，**OA 主管线本身就会顺带捞回一部分订阅全文**。
  但重 JS 的站点（ScienceDirect / Wiley / T&F / SAGE 等）它基本拿不到——那些要靠本节的真实浏览器通道。

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

**已经下到磁盘的 PDF 直接入库**（不必再让 Zotero 联网找一遍）：用 `zotero-library` 的
`push --report pdfs/retrieval_report.json`，它按 DOI 把本地 PDF 挂成对应条目的附件。
先 `--dry-run` 看配上几篇；汇报时区分 `pushed`（题录数）与 `attached`（真带全文的数）。

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

- `fetch_oa.py` 主要取 **open-access** 文章；它最后一步的落地页抓取在**机构 IP 授权**下也能捞到一部分订阅全文（见上一节），但对重 JS 的出版商无效。Paywalled-but-subscribed articles go through `fetch_institutional.py` (requires a same-machine logged-in Chrome; unavailable on the multi-user server — expected, not a bug). Articles the user's institution has **not** licensed fail in both tiers by design.
- The institutional tier is **interactive**: login walls and bot checks are handed to the user, never automated. It is deliberately rate-limited and batch-capped.
- Landing page scraping may fail on publisher-specific JavaScript-heavy pages.
- Some recent articles may not yet be indexed by OA sources.
- PDF→Markdown quality depends on the PDF's text layer. Scanned-only PDFs may produce poor output.

## Anti-Hallucination

- **Never fabricate file paths, URLs, DOIs, or package names.** Verify existence before recommending.
- **Never invent journal metadata, impact factors, or submission policies** without verification at the journal's website.
- If a tool, package, or resource does not exist or you are unsure, say so explicitly rather than guessing.
