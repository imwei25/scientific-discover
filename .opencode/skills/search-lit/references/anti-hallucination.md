> 来源：search-lit/SKILL.md 原「Phase 4」Anti-Hallucination Protocol 全文（SKILL.md 保留前两条铁律」节原样搬出（渐进披露）。核对每条引用字段、做 DOI 核验时读：逐字段交叉核对清单与 CrossRef DOI 核验法。

# Anti-Hallucination Protocol（Phase 4，全文）

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
