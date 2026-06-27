// 与本地 sidecar 通信的流式辅助函数。
// 后端用 SSE(text/event-stream) 推送 event: delta|done|error。

import { apiUrl } from "./api";

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

interface ParsedEvent {
  event: string;
  data: string;
}

function parseChunk(buffer: string): { events: ParsedEvent[]; rest: string } {
  const events: ParsedEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    events.push({ event, data: dataLines.join("\n") });
  }
  return { events, rest };
}

// 通用: 向某个 SSE 端点 POST 一个 JSON 体, 流式接收文本。
export async function streamPost(
  url: string,
  body: unknown,
  handlers: StreamHandlers,
): Promise<void> {
  const { onDelta, onDone, onError, signal } = handlers;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    onError?.(`无法连接本地服务: ${(e as Error).message}`);
    return;
  }
  if (!resp.ok || !resp.body) {
    onError?.(`服务返回错误: ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseChunk(buffer);
      buffer = rest;
      for (const ev of events) {
        if (ev.event === "delta") {
          try {
            onDelta(JSON.parse(ev.data).text ?? "");
          } catch {
            /* ignore malformed */
          }
        } else if (ev.event === "error") {
          let msg = ev.data;
          try {
            msg = JSON.parse(ev.data).message ?? ev.data;
          } catch {
            /* keep raw */
          }
          onError?.(msg);
        } else if (ev.event === "done") {
          onDone?.();
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      onError?.(`读取流出错: ${(e as Error).message}`);
    }
  }
}

export interface Reference {
  pmid: string;
  title: string;
  first_author: string;
  journal: string;
  year: string;
  url: string;
  source?: string; // "pubmed" | "preprint" | "europepmc" | "openalex"
  cited_by_count?: number;
}

export interface EvidenceItem {
  index: number;
  first_author: string;
  year: string;
  title: string;
  journal: string;
  url: string;
  source: string;
  cited_by_count: number;
  pop: string;
  design: string;
  finding: string;
  gap: string;
}

export interface Verification {
  total: number;
  verified: number;
  unverified: string[]; // URLs (PubMed / Europe PMC links)
}

export interface Trial {
  nct_id: string;
  title: string;
  status: string;
  phase: string;
  conditions: string;
  summary: string;
  year: string;
  url: string;
}

export interface RewriteSuggestion {
  field: string;
  keywords: string;
  reason: string;
}

export interface RewritePayload {
  tried_queries: string[];
  suggestion: RewriteSuggestion | null;
}

export interface IdeaHandlers {
  onStatus?: (message: string) => void;
  onReferences?: (items: Reference[]) => void;
  onTrials?: (items: Trial[]) => void;
  onEvidence?: (items: EvidenceItem[]) => void;
  onDelta: (text: string) => void;
  onVerify?: (v: Verification) => void;
  onRewriteSuggestion?: (p: RewritePayload) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

// 深度调研“找选题”: 处理 status / references / trials / delta / done / error 事件。
export async function streamIdea(
  inputs: Record<string, unknown>,
  h: IdeaHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/idea"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "idea", inputs }),
      signal: h.signal,
    });
  } catch (e) {
    h.onError?.(`无法连接本地服务: ${(e as Error).message}`);
    return;
  }
  if (!resp.ok || !resp.body) {
    h.onError?.(`服务返回错误: ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseChunk(buffer);
      buffer = rest;
      for (const ev of events) {
        let data: any = {};
        try {
          data = JSON.parse(ev.data);
        } catch {
          /* ignore */
        }
        if (ev.event === "status") h.onStatus?.(data.message ?? "");
        else if (ev.event === "references") h.onReferences?.(data.items ?? []);
        else if (ev.event === "trials") h.onTrials?.(data.items ?? []);
        else if (ev.event === "evidence") h.onEvidence?.(data.items ?? []);
        else if (ev.event === "delta") h.onDelta(data.text ?? "");
        else if (ev.event === "verify") h.onVerify?.(data as Verification);
        else if (ev.event === "rewrite_suggestion")
          h.onRewriteSuggestion?.({
            tried_queries: data.tried_queries ?? [],
            suggestion: data.suggestion ?? null,
          });
        else if (ev.event === "error") h.onError?.(data.message ?? ev.data);
        else if (ev.event === "done") h.onDone?.();
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      h.onError?.(`读取流出错: ${(e as Error).message}`);
    }
  }
}

export interface ReviewComment {
  reviewer: string;
  index: number;
  comment: string;
  type: string;
}

export interface RebuttalHandlers {
  onStatus?: (message: string) => void;
  onComments?: (items: ReviewComment[]) => void;
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

// 回复审稿意见: 拆解意见 + 流式生成 point-by-point 回复信。处理 status/comments/delta/done/error。
export async function streamRebuttal(
  inputs: Record<string, unknown>,
  h: RebuttalHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/rebuttal"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "rebuttal", inputs }),
      signal: h.signal,
    });
  } catch (e) {
    h.onError?.(`无法连接本地服务: ${(e as Error).message}`);
    return;
  }
  if (!resp.ok || !resp.body) {
    h.onError?.(`服务返回错误: ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseChunk(buffer);
      buffer = rest;
      for (const ev of events) {
        let data: any = {};
        try {
          data = JSON.parse(ev.data);
        } catch {
          /* ignore */
        }
        if (ev.event === "status") h.onStatus?.(data.message ?? "");
        else if (ev.event === "comments") h.onComments?.(data.items ?? []);
        else if (ev.event === "delta") h.onDelta(data.text ?? "");
        else if (ev.event === "error") h.onError?.(data.message ?? ev.data);
        else if (ev.event === "done") h.onDone?.();
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      h.onError?.(`读取流出错: ${(e as Error).message}`);
    }
  }
}

export interface ImradHandlers {
  onStatus?: (message: string) => void;
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

// IMRaD 初稿装配: 分段流式拼接。处理 status/delta/done/error。
export async function streamImrad(
  inputs: Record<string, unknown>,
  h: ImradHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/imrad"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "imrad", inputs }),
      signal: h.signal,
    });
  } catch (e) {
    h.onError?.(`无法连接本地服务: ${(e as Error).message}`);
    return;
  }
  if (!resp.ok || !resp.body) {
    h.onError?.(`服务返回错误: ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseChunk(buffer);
      buffer = rest;
      for (const ev of events) {
        let data: any = {};
        try {
          data = JSON.parse(ev.data);
        } catch {
          /* ignore */
        }
        if (ev.event === "status") h.onStatus?.(data.message ?? "");
        else if (ev.event === "delta") h.onDelta(data.text ?? "");
        else if (ev.event === "error") h.onError?.(data.message ?? ev.data);
        else if (ev.event === "done") h.onDone?.();
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      h.onError?.(`读取流出错: ${(e as Error).message}`);
    }
  }
}

export interface FollowupHandlers {
  onDelta: (text: string) => void;
  onVerify?: (v: Verification) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

// 对已生成的找选题报告追问/修改(基于回传文献, 不重新检索)。处理 delta / verify / done / error。
export async function streamIdeaFollowup(
  inputs: Record<string, unknown>,
  h: FollowupHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/idea-followup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "idea", inputs }),
      signal: h.signal,
    });
  } catch (e) {
    h.onError?.(`无法连接本地服务: ${(e as Error).message}`);
    return;
  }
  if (!resp.ok || !resp.body) {
    h.onError?.(`服务返回错误: ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseChunk(buffer);
      buffer = rest;
      for (const ev of events) {
        let data: any = {};
        try {
          data = JSON.parse(ev.data);
        } catch {
          /* ignore */
        }
        if (ev.event === "delta") h.onDelta(data.text ?? "");
        else if (ev.event === "verify") h.onVerify?.(data as Verification);
        else if (ev.event === "error") h.onError?.(data.message ?? ev.data);
        else if (ev.event === "done") h.onDone?.();
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      h.onError?.(`读取流出错: ${(e as Error).message}`);
    }
  }
}

// 一张图: png=用于网页内联展示的位图; data=用户所选格式的可下载资产; ext=下载扩展名。
export interface ChartItem {
  png: string;
  data: string;
  ext: string;
}

export interface AnalyzeHandlers {
  onStatus?: (message: string) => void;
  onCode?: (code: string) => void;
  onCharts?: (items: ChartItem[]) => void;
  onOutput?: (text: string) => void;
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

// 把后端可能的两种 charts 形态(老: base64 字符串; 新: {png,data,ext})统一成 ChartItem。
function normalizeCharts(items: any[]): ChartItem[] {
  return (items ?? []).map((c) =>
    typeof c === "string" ? { png: c, data: c, ext: "png" } : { png: c.png, data: c.data ?? c.png, ext: c.ext ?? "png" },
  );
}

// AI 数据分析: 上传文件(multipart), 流式接收 status/code/charts/output/delta。
export async function streamAnalyze(
  file: File,
  question: string,
  chartFormat: string,
  palette: string,
  h: AnalyzeHandlers,
): Promise<void> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("question", question);
  fd.append("chart_format", chartFormat);
  fd.append("palette", palette);
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/analyze"), { method: "POST", body: fd, signal: h.signal });
  } catch (e) {
    h.onError?.(`无法连接本地服务: ${(e as Error).message}`);
    return;
  }
  if (!resp.ok || !resp.body) {
    h.onError?.(`服务返回错误: ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseChunk(buffer);
      buffer = rest;
      for (const ev of events) {
        let data: any = {};
        try {
          data = JSON.parse(ev.data);
        } catch {
          /* ignore */
        }
        if (ev.event === "status") h.onStatus?.(data.message ?? "");
        else if (ev.event === "code") h.onCode?.(data.code ?? "");
        else if (ev.event === "charts") h.onCharts?.(normalizeCharts(data.items));
        else if (ev.event === "output") h.onOutput?.(data.text ?? "");
        else if (ev.event === "delta") h.onDelta(data.text ?? "");
        else if (ev.event === "error") h.onError?.(data.message ?? ev.data);
        else if (ev.event === "done") h.onDone?.();
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      h.onError?.(`读取流出错: ${(e as Error).message}`);
    }
  }
}

// 运行一个文本类模块(找idea / 实验规划 / 写作)。
export function runModule(
  module: string,
  inputs: Record<string, string>,
  handlers: StreamHandlers,
): Promise<void> {
  return streamPost(apiUrl("/api/run"), { module, inputs }, handlers);
}
