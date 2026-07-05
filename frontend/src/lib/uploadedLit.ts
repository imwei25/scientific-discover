import { apiUrl } from "./api";
import type { Reference } from "./sse";

export interface UploadedRef {
  upload_id: string;
  title: string;
  first_author: string;
  year: string;
  abstract: string;
  full_text_available: boolean;
  page_count: number;
  parse_confidence: "high" | "low";
}

export async function parseUpload(file: File, projectId: string | null): Promise<UploadedRef | { error: string }> {
  const fd = new FormData();
  fd.append("file", file);
  if (projectId) fd.append("project_id", projectId);
  const r = await fetch(apiUrl("/api/deep_research/parse_upload"), { method: "POST", body: fd });
  const data = await r.json();
  if (!r.ok || data.ok === false) return { error: data.error || `解析失败 (${r.status})` };
  return data as UploadedRef;
}

export async function lookupTitle(title: string): Promise<{ found: boolean; abstract?: string; first_author?: string; year?: string; url?: string; doi?: string }> {
  const r = await fetch(apiUrl("/api/deep_research/lookup_title"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return r.json();
}

export function uploadedToReference(u: UploadedRef): Reference & { upload_id: string; full_text_available: boolean; parse_confidence: "high" | "low" } {
  return {
    pmid: "",
    title: u.title,
    first_author: u.first_author,
    year: u.year,
    journal: "",
    url: "",
    abstract: u.abstract,
    source: "upload",
    upload_id: u.upload_id,
    full_text_available: u.full_text_available,
    parse_confidence: u.parse_confidence,
  } as Reference & { upload_id: string; full_text_available: boolean; parse_confidence: "high" | "low" };
}

/** 前端估算深读 token 成本 (~4 char/token; 章节截断预算 8k/篇)。*/
export function estimateDeepReadTokens(refs: { page_count?: number }[]): number {
  return refs.reduce((sum, r) => {
    const pages = r.page_count && r.page_count > 0 ? r.page_count : 8;
    return sum + Math.min(8000, pages * 500);
  }, 0);
}
