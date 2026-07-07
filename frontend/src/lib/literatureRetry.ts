import type { Reference, RetryContext } from "./sse";

/** 论文源 key → 展示名, 与后端 literature.SOURCE_LABELS 对齐(重试按钮/提示用)。 */
export const SOURCE_LABELS: Record<string, string> = {
  pubmed: "PubMed",
  europepmc: "Europe PMC",
  openalex: "OpenAlex",
  crossref: "Crossref",
};

export function sourceLabels(sources: string[]): string {
  return sources.map((s) => SOURCE_LABELS[s] || s).join("、");
}

export interface RetryResult {
  references: Reference[];
  failed_sources: string[];
}

/** POST /api/literature/retry: 只对 failedSources(连不上的那几个源)按 retry 上下文重跑检索。
 *  返回新检索到的文献(已富集影响力/分区/OA)与仍失败的源。网络/服务异常时抛出。 */
export async function retryLiteratureSources(
  retry: RetryContext,
  failedSources: string[],
): Promise<RetryResult> {
  const r = await fetch("/api/literature/retry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      queries: retry.queries || [],
      sources: failedSources,
      per_query: retry.per_query ?? 8,
      cap: retry.cap ?? 18,
      filters: retry.filters || {},
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (!data || data.ok === false) throw new Error(data?.error || "重试失败");
  return {
    references: (data.references || []) as Reference[],
    failed_sources: (data.failed_sources || []) as string[],
  };
}
