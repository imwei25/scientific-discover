import { apiUrl } from "./api";

export interface ExtractResult {
  ok: boolean;
  text?: string;
  kind?: string;
  truncated?: boolean;
  error?: string;
}

// 上传文档到后端抽取纯文本(Word/PDF/Excel/CSV/txt)。
export async function extractFile(file: File): Promise<ExtractResult> {
  const fd = new FormData();
  fd.append("file", file);
  try {
    const resp = await fetch(apiUrl("/api/extract"), { method: "POST", body: fd });
    return await resp.json();
  } catch (e) {
    return { ok: false, error: `上传失败：${(e as Error).message}` };
  }
}
