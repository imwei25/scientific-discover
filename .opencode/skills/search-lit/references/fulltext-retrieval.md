> 来源：search-lit/SKILL.md 原「Phase 5: Full-Text Retrieval」节原样搬出（渐进披露）。要为候选池取全文 PDF 时读：fetch_oa.py 调用示例、Zotero 内取 PDF、合法替代渠道。

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
