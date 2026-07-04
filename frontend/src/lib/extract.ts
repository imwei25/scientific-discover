import { apiUrl } from "./api";

export interface ExtractResult {
  ok: boolean;
  text?: string;
  kind?: string;
  truncated?: boolean;
  error?: string;
}

// 上传文档到后端抽取纯文本(Word/PDF/Excel/CSV/txt)。
// signal: 传入 AbortSignal 后可通过 controller.abort() 中止上传。
export async function extractFile(file: File, signal?: AbortSignal): Promise<ExtractResult> {
  const fd = new FormData();
  fd.append("file", file);
  try {
    const resp = await fetch(apiUrl("/api/extract"), { method: "POST", body: fd, signal });
    return await resp.json();
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return { ok: false, error: "已取消" };
    }
    return { ok: false, error: `上传失败：${(e as Error).message}` };
  }
}
