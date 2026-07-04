import { extractFile } from "./extract";

export interface ParsedAttachment {
  name: string;
  text: string;
  truncated: boolean;
}

export interface ParseProgress {
  index: number;   // 从 1 开始
  total: number;
  name: string;
}

// 串行解析所有附件；任一失败抛出 Error，由调用方 catch 后 setError。
// signal 用于用户点"停止"时中止解析上传。
export async function parseAttachments(
  files: File[],
  opts?: { signal?: AbortSignal; onProgress?: (p: ParseProgress) => void },
): Promise<ParsedAttachment[]> {
  const results: ParsedAttachment[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    opts?.onProgress?.({ index: i + 1, total: files.length, name: f.name });
    const res = await extractFile(f, opts?.signal);
    if (!res.ok || !res.text) {
      throw new Error(`附件 ${f.name} 解析失败：${res.error || "未知错误"}`);
    }
    results.push({ name: f.name, text: res.text, truncated: !!res.truncated });
  }
  return results;
}

// 把解析文本拼到用户输入的 base 后面；沿用现有 `[附加文档：xxx]` 分隔符格式。
// 若 base 为空，直接从第一段附加文档开始。
export function appendAttachmentsToField(
  base: string,
  parsed: ParsedAttachment[],
  label = "附加文档",
): string {
  if (parsed.length === 0) return base;
  const segments = parsed.map((p) => `[${label}：${p.name}]\n${p.text}`);
  const joined = segments.join("\n\n");
  return base ? `${base}\n\n${joined}` : joined;
}
