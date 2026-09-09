> 来源：search-lit/SKILL.md 原「Error Handling」节原样搬出（渐进披露）。检索 0 命中、CrossRef 报 403/303、DOI 解析失败或引用无法核实时读。

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
