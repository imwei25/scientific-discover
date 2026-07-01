// 与本地 sidecar 通信的流式辅助函数。
// 后端用 SSE(text/event-stream) 推送 event: delta|done|error。

import { apiUrl } from "./api";

// ── W2-2 LLMError 分类 ───────────────────────────────────────────
// 后端返回的错误消息(中/英)通过关键词识别为更精细的子类, 让 UI 决定如何 Toast。
export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}
export class BalanceError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "BalanceError";
  }
}
export class KeyError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}
export class TimeoutError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
export class RateLimitError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** 把后端返回的错误字符串归类为合适的 LLMError 子类。 */
export function classifyError(msg: string): LLMError {
  const m = (msg || "").toLowerCase();
  // 余额相关
  if (
    m.includes("余额") || m.includes("insufficient balance") ||
    m.includes("insufficient_quota") || m.includes("配额") ||
    m.includes("out of credit") || m.includes("balance") ||
    m.includes("402")
  ) {
    return new BalanceError(msg);
  }
  // 鉴权/key 无效
  if (
    m.includes("401") || m.includes("403") ||
    m.includes("invalid_api_key") || m.includes("invalid api key") ||
    m.includes("unauthorized") || m.includes("forbidden") ||
    m.includes("key 无效") || m.includes("key 失效") || m.includes("api key")
  ) {
    return new KeyError(msg);
  }
  // 超时
  if (
    m.includes("超时") || m.includes("timeout") || m.includes("timed out")
  ) {
    return new TimeoutError(msg);
  }
  // 限流
  if (
    m.includes("429") || m.includes("rate limit") || m.includes("ratelimit") ||
    m.includes("速率") || m.includes("过于频繁")
  ) {
    return new RateLimitError(msg);
  }
  return new LLMError(msg);
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  /** W2-2: 后端可能发送 event: progress, data: {stage, detail?} 给 UI 显示进度文案 */
  onProgress?: (stage: string, detail?: unknown) => void;
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
        } else if (ev.event === "progress") {
          let data: { stage?: string; detail?: unknown } = {};
          try { data = JSON.parse(ev.data); } catch { /* keep raw */ }
          handlers.onProgress?.(data.stage ?? "", data.detail);
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
  doi?: string;
  title: string;
  first_author: string;
  journal: string;
  year: string;
  url: string;
  source?: string; // "pubmed" | "preprint" | "europepmc" | "openalex" | "crossref"
  cited_by_count?: number;
  oa_url?: string; // Unpaywall 发现的合法 OA 全文链接(优先 PDF)
  journal_impact?: number | null; // 影响力指数(OpenAlex 近2年篇均被引); 未知为 null
  journal_quartile?: string | null; // Scimago 医学分区 Q1-Q4(仅医学刊有); 未知为 null
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
  oa_url?: string;
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

// 结构化选题卡: 报告里解析出的候选选题 + 子方向, 供按选题精准交接给实验规划。
export interface Candidate {
  n: number;
  title: string;
  feasibility: number | null;
  innovation: number | null;
  body: string;
}

export interface TopicCard {
  field: string;
  keywords: string;
  facets: string[];
  keyword_seed: string[];
  candidates: Candidate[];
  ref_count: number;
}

// 检索前澄清: 方向不够具体时, 后端回最多 3 个澄清问题(每题带候选选项)。
export interface ClarifyQuestion {
  q: string;
  options: string[];
}

export interface ClarifyResult {
  ready: boolean;
  questions: ClarifyQuestion[];
}

// 调一次非流式澄清接口; 任何失败都返回 ready=true(放行), 绝不卡住检索。
export async function clarifyTopic(
  inputs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ClarifyResult> {
  try {
    const resp = await fetch(apiUrl("/api/idea/clarify"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "idea", inputs }),
      signal,
    });
    if (!resp.ok) return { ready: true, questions: [] };
    const data = await resp.json();
    return {
      ready: !!data.ready,
      questions: Array.isArray(data.questions) ? data.questions : [],
    };
  } catch {
    return { ready: true, questions: [] };
  }
}

// 澄清回答后的「方向优化」候选: AI 改写的研究方向 + 关键词 + 理由。
export interface RefineOption {
  field: string;
  keywords: string;
  reason: string;
}

export interface RefineResult {
  options: RefineOption[];
}

// 调非流式优化接口; 任何失败都返回空 options(放行直接检索)。
export async function refineTopic(
  inputs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RefineResult> {
  try {
    const resp = await fetch(apiUrl("/api/idea/refine"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "idea", inputs }),
      signal,
    });
    if (!resp.ok) return { options: [] };
    const data = await resp.json();
    return { options: Array.isArray(data.options) ? data.options : [] };
  } catch {
    return { options: [] };
  }
}

export interface IdeaHandlers {
  onStatus?: (message: string) => void;
  onReferences?: (items: Reference[]) => void;
  onTrials?: (items: Trial[]) => void;
  onEvidence?: (items: EvidenceItem[]) => void;
  onDelta: (text: string) => void;
  onVerify?: (v: Verification) => void;
  onRewriteSuggestion?: (p: RewritePayload) => void;
  onTopicCard?: (card: TopicCard) => void;
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
        else if (ev.event === "topic_card") h.onTopicCard?.(data as TopicCard);
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

// 写标书: 方案骨架(helm 凝练结果)。
export interface GrantScheme {
  title: string;
  question: string;
  hypothesis: string;
  goal: string;
  contents: string[];
  innovations: string[];
  route: string;
}

export interface GrantOutlineItem {
  key: string;
  title: string;
  budget: string;
}

export interface GrantPlan {
  scheme: GrantScheme;
  outline: GrantOutlineItem[];
}

// 两段式第一步: 取可编辑的【方案骨架 + 大纲】。失败回退到空骨架 + 标准大纲(不阻断)。
export async function planGrant(
  inputs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GrantPlan> {
  const fallback: GrantPlan = {
    scheme: { title: String(inputs.title ?? ""), question: "", hypothesis: "", goal: "", contents: [], innovations: [], route: "" },
    outline: [],
  };
  try {
    const resp = await fetch(apiUrl("/api/grant/plan"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "grant", inputs }),
      signal,
    });
    if (!resp.ok) return fallback;
    const data = await resp.json();
    return {
      scheme: { ...fallback.scheme, ...(data.scheme ?? {}) },
      outline: Array.isArray(data.outline) ? data.outline : [],
    };
  } catch {
    return fallback;
  }
}

export interface GrantHandlers {
  onStatus?: (message: string) => void;
  onScheme?: (s: GrantScheme) => void;
  onOutline?: (items: GrantOutlineItem[]) => void;
  onSection?: (key: string, title: string) => void;
  onDelta: (text: string) => void;
  onVerify?: (v: Verification) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

// 写中文标书: 方案凝练 → 大纲 → 分节撰写 → 评审自查。处理 status/scheme/outline/section/delta/verify/done/error。
export async function streamGrant(
  inputs: Record<string, unknown>,
  h: GrantHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/grant"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "grant", inputs }),
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
        else if (ev.event === "scheme") h.onScheme?.(data as GrantScheme);
        else if (ev.event === "outline") h.onOutline?.(data.items ?? []);
        else if (ev.event === "section") h.onSection?.(data.key ?? "", data.title ?? "");
        else if (ev.event === "delta") h.onDelta(data.text ?? "");
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

export interface GrantReviseHandlers {
  onStatus?: (message: string) => void;
  onReferences?: (items: Reference[]) => void;
  onDelta: (text: string) => void;
  onVerify?: (v: Verification) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

// 逐节重写: 仅按意见重写某一章节(可选先重新调研)。处理 status/references/delta/verify/done/error。
export async function streamGrantRevise(
  inputs: Record<string, unknown>,
  h: GrantReviseHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/grant/revise"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "grant", inputs }),
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
        else if (ev.event === "delta") h.onDelta(data.text ?? "");
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

// ── 去 AI 味 ─────────────────────────────────────────────────────────
// 两步: ① scanAiFlavor 启发式扫描(不调 LLM)标出 AI 味较重的句子;
//       ② streamDeai 逐块流式改写(仅改标记的段落, 可随时 abort 中断)。
export interface DeaiSpan {
  block: number;       // 所在块的全局索引
  sentence: string;    // 命中的句子原文
  score: number;       // AI 味打分
  reasons: string[];   // 命中原因标签(可读)
}

export interface DeaiScanResult {
  spans: DeaiSpan[];
  flagged_blocks: number[]; // 去重、文档顺序; 供改写按块处理
  stats: { blocks: number; prose_blocks: number; sentences: number; flagged: number };
}

const _emptyScan: DeaiScanResult = {
  spans: [], flagged_blocks: [],
  stats: { blocks: 0, prose_blocks: 0, sentences: 0, flagged: 0 },
};

// 扫描(非流式)。任何失败都返回空结果(放行不阻塞), 与后端约定一致。
export async function scanAiFlavor(text: string, signal?: AbortSignal): Promise<DeaiScanResult> {
  try {
    const resp = await fetch(apiUrl("/api/deai/scan"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!resp.ok) return _emptyScan;
    const data = await resp.json();
    return {
      spans: Array.isArray(data.spans) ? data.spans : [],
      flagged_blocks: Array.isArray(data.flagged_blocks) ? data.flagged_blocks : [],
      stats: data.stats ?? _emptyScan.stats,
    };
  } catch {
    return _emptyScan;
  }
}

// 改写第二步: 一个待改写块(start/end 为其在原文中的字符区间)。
export interface DeaiSegmentInfo {
  block: number;
  start: number;
  end: number;
  original: string;
}

export interface DeaiHandlers {
  onSegment: (seg: DeaiSegmentInfo) => void;                          // 开始改写某块
  onDelta: (block: number, text: string) => void;                    // 该块增量
  onSegmentDone: (block: number, rewritten: string, citationWarn: boolean) => void; // 该块完成
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

// 逐块流式改写。处理 segment/delta/segment_done/done/error。abort 后静默返回(由调用方转 review)。
export async function streamDeai(
  text: string,
  blocks: number[],
  style: string,
  h: DeaiHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/deai/rewrite"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, blocks, style }),
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
        try { data = JSON.parse(ev.data); } catch { /* ignore */ }
        if (ev.event === "segment")
          h.onSegment({ block: data.block, start: data.start, end: data.end, original: data.original ?? "" });
        else if (ev.event === "delta") h.onDelta(data.block, data.text ?? "");
        else if (ev.event === "segment_done")
          h.onSegmentDone(data.block, data.rewritten ?? "", !!data.citation_warn);
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
