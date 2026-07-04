import type { Reference, EvidenceItem } from "./sse";

/** Match backend _ref_key: pmid > doi > url > title. */
export function refKey(r: Reference): string {
  if (r.pmid) return `pmid:${r.pmid}`;
  if (r.doi) return `doi:${r.doi}`;
  if (r.url) return `url:${r.url}`;
  return `title:${(r.title || "").trim().slice(0, 60)}`;
}

interface ExtractedRow {
  key: string;
  pop: string;
  design: string;
  finding: string;
  gap: string;
  rel?: number;
  rel_why?: string;
  _ev_status: "ok" | "no_abstract" | "extract_error";
}

/** POST /api/refs/extract-evidence in client-side batches of 8. Merges partial
 *  successes so one failing chunk doesn't fail the whole call. Returns a map
 *  from refKey → EvidenceItem shape (with _ev_status attached). */
export async function extractEvidenceForRefs(
  refs: Reference[],
  onProgress?: (done: number, total: number) => void,
  fetchMissingAbstracts: boolean = true,
): Promise<Record<string, EvidenceItem & { _ev_status?: string }>> {
  const total = refs.length;
  const out: Record<string, EvidenceItem & { _ev_status?: string }> = {};
  if (!total) return out;

  const CHUNK = 8;
  let done = 0;

  for (let i = 0; i < total; i += CHUNK) {
    const chunk = refs.slice(i, i + CHUNK);
    try {
      const r = await fetch("/api/refs/extract-evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs: chunk, fetch_missing_abstracts: fetchMissingAbstracts }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const rows: ExtractedRow[] = (data && data.evidence) || [];
      rows.forEach((row, j) => {
        const ref = chunk[j];
        if (!ref) return;
        out[row.key || refKey(ref)] = {
          index: i + j,
          first_author: ref.first_author,
          year: ref.year,
          title: ref.title,
          journal: ref.journal,
          url: ref.url,
          source: ref.source || "",
          cited_by_count: ref.cited_by_count || 0,
          oa_url: ref.oa_url,
          pop: row.pop,
          design: row.design,
          finding: row.finding,
          gap: row.gap,
          _ev_status: row._ev_status,
        } as EvidenceItem & { _ev_status?: string };
      });
    } catch {
      // Chunk failure: mark all as extract_error so UI can show retry affordance.
      chunk.forEach((ref, j) => {
        out[refKey(ref)] = {
          index: i + j,
          first_author: ref.first_author,
          year: ref.year,
          title: ref.title,
          journal: ref.journal,
          url: ref.url,
          source: ref.source || "",
          cited_by_count: ref.cited_by_count || 0,
          pop: "", design: "", finding: "", gap: "",
          _ev_status: "extract_error",
        } as EvidenceItem & { _ev_status?: string };
      });
    }
    done = Math.min(total, i + CHUNK);
    onProgress?.(done, total);
  }
  return out;
}
