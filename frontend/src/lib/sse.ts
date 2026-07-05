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
  /** 后端非致命告警: event: warning, data: {message}. 如 PHI 出站扫描、checklist 回引校验。 */
  onWarning?: (message: string) => void;
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
        } else if (ev.event === "warning") {
          let msg = ev.data;
          try {
            msg = JSON.parse(ev.data).message ?? ev.data;
          } catch {
            /* keep raw */
          }
          handlers.onWarning?.(msg);
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
  type?: string; // CSL type: "article-journal" | "posted-content" | "proceedings-article" | ...
                 // 供期刊排版格式化时识别非学术来源（infographic / preprint / 会议摘要等）
  cited_by_count?: number;
  oa_url?: string; // Unpaywall 发现的合法 OA 全文链接(优先 PDF)
  journal_impact?: number | null; // 影响力指数(OpenAlex 近2年篇均被引); 未知为 null
  journal_quartile?: string | null; // Scimago 医学分区 Q1-Q4(仅医学刊有); 未知为 null
  abstract?: string; // 截断摘要(≤800字): 供写标书阶段据实摘录『支持句』, 前端不直接展示
  rel?: number; // AI 相关性判分 0-3(相对研究方向): 3=直接相关 2=相关 1=弱相关 0=离题
  rel_why?: string; // 相关性判分的一句话理由(悬停展示)
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
  quotes_total?: number; // 正文里附了『支持句』的引用数(可悬停查看)
  quotes_ok?: number; // 其中经子串核验、确为摘要原文逐字摘录的数量
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

// AI 精修: 一处 find/replace 补丁。find 逐字取自原文(后端已校验能定位), replace 为改后文本。
export interface EditPatch {
  find: string;
  replace: string;
  note?: string;
}

export interface EditResult {
  edits: EditPatch[];
  mode: string; // "selection" | "global" | "none"
  note?: string;
}

// 调 AI 精修接口(非流式): 传全文 + 修改意见(可带选中段 selection + 文献池 references),
// 返回一组 find/replace 补丁, 由前端执行替换并标黄。失败返回空补丁 + 说明, 不抛出。
export async function surgicalEdit(
  inputs: { text: string; instruction: string; selection?: string; references?: Reference[] },
  signal?: AbortSignal,
): Promise<EditResult> {
  try {
    const resp = await fetch(apiUrl("/api/edit"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "edit", inputs }),
      signal,
    });
    if (!resp.ok) return { edits: [], mode: "none", note: `服务返回 ${resp.status}` };
    const data = await resp.json();
    return {
      edits: Array.isArray(data.edits) ? data.edits : [],
      mode: typeof data.mode === "string" ? data.mode : "none",
      note: typeof data.note === "string" ? data.note : "",
    };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return { edits: [], mode: "none", note: "网络请求失败" };
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
  onWarning?: (message: string) => void;
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
        else if (ev.event === "warning") h.onWarning?.(data.message ?? ev.data);
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

// 从文风样例提炼『文风档案』(非流式)。失败/空返回空档案, 不阻断撰写。
export async function grantStyle(sample: string, signal?: AbortSignal): Promise<{ profile: string }> {
  try {
    const resp = await fetch(apiUrl("/api/grant/style"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sample }),
      signal,
    });
    if (!resp.ok) return { profile: "" };
    const data = await resp.json();
    return { profile: typeof data.profile === "string" ? data.profile : "" };
  } catch {
    return { profile: "" };
  }
}

// 评审组模拟评审的结构化结果(后端 review_data 事件): 供摘要卡与「按评审意见修订」联动。
export interface GrantReviewIssue {
  section: string;
  severity: string; // 高|中|低
  problem: string;
  advice: string;
  evidence?: string;
  by?: string; // 提出该问题的评委
}

export interface GrantReviewSection {
  key: string;
  title: string;
  score: number | null;
  issues: GrantReviewIssue[];
}

export interface GrantReviewData {
  personas: string[];
  overall: number | null;
  grade: string; // A|B|C
  grade_label: string;
  votes: Record<string, number>;
  scores: Record<string, number | null>;
  sections: GrantReviewSection[];
  general_issues: GrantReviewIssue[];
  coverage: { item: string; status: string; note: string }[];
}

export interface GrantHandlers {
  onStatus?: (message: string) => void;
  onScheme?: (s: GrantScheme) => void;
  onOutline?: (items: GrantOutlineItem[]) => void;
  onReferences?: (items: Reference[]) => void;
  onSection?: (key: string, title: string) => void;
  onDelta: (text: string) => void;
  onReviewData?: (d: GrantReviewData) => void;
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
        else if (ev.event === "references") h.onReferences?.(data.items ?? []);
        else if (ev.event === "section") h.onSection?.(data.key ?? "", data.title ?? "");
        else if (ev.event === "delta") h.onDelta(data.text ?? "");
        else if (ev.event === "review_data") h.onReviewData?.(data as GrantReviewData);
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

export interface GrantReviewHandlers {
  onStatus?: (message: string) => void;
  onSection?: (key: string, title: string) => void;
  onDelta: (text: string) => void;
  onReviewData?: (d: GrantReviewData) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

// 重新评审: 把当前全文交回评审组重新打分合议(修订后回头看改进了没)。
// 处理 status/section/delta/review_data/done/error。
export async function streamGrantReview(
  inputs: Record<string, unknown>,
  h: GrantReviewHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/grant/review"), {
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
        else if (ev.event === "section") h.onSection?.(data.key ?? "", data.title ?? "");
        else if (ev.event === "delta") h.onDelta(data.text ?? "");
        else if (ev.event === "review_data") h.onReviewData?.(data as GrantReviewData);
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

// ── 学术海报 ──────────────────────────────────────────────────────
export interface PosterSection {
  heading: string;
  bullets: string[];
}
export interface PosterContent {
  title: string;
  highlights: string[];
  sections: PosterSection[];
  keywords: string[];
}
export interface PosterHandlers {
  onStatus?: (message: string) => void;
  onPoster: (content: PosterContent, html: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

// 学术海报: 论文提炼要点(纯文本 LLM) + 确定性渲染自包含 HTML。处理 status/poster/done/error。
export async function streamPoster(
  inputs: Record<string, unknown>,
  h: PosterHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/poster"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "poster", inputs }),
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
        else if (ev.event === "poster") h.onPoster(data.content as PosterContent, data.html ?? "");
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

// T3 决策卡: 由后端确定性规则在真实数据上判定的"方法与前提"。
export interface PlanCard {
  goal: string;
  data: string;
  assumptions: string[];
  recommended: string;
  fallback?: string;
  note?: string;
}

export type AnalyzeMode = "analyze" | "draw";
export type TransparencyKind = "method" | "assumption" | "quality";

export interface AnalyzeHandlers {
  onStatus?: (message: string) => void;
  onPlan?: (cards: PlanCard[]) => void;
  onCode?: (code: string) => void;
  onCharts?: (items: ChartItem[]) => void;
  onOutput?: (text: string) => void;
  onTransparency?: (kind: TransparencyKind, text: string) => void;
  onDelta: (text: string) => void;
  /** wave2 检查(如 p 值一致性)在流中产的告警, 即时追加显示。 */
  onWarning?: (message: string) => void;
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
  mode: AnalyzeMode,
  h: AnalyzeHandlers,
): Promise<void> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("question", question);
  fd.append("chart_format", chartFormat);
  fd.append("palette", palette);
  fd.append("mode", mode);
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
        else if (ev.event === "plan") h.onPlan?.(data.cards ?? []);
        else if (ev.event === "code") h.onCode?.(data.code ?? "");
        else if (ev.event === "charts") h.onCharts?.(normalizeCharts(data.items));
        else if (ev.event === "output") h.onOutput?.(data.text ?? "");
        else if (ev.event === "transparency_method")     h.onTransparency?.("method",     data.text ?? "");
        else if (ev.event === "transparency_assumption") h.onTransparency?.("assumption", data.text ?? "");
        else if (ev.event === "transparency_quality")    h.onTransparency?.("quality",    data.text ?? "");
        else if (ev.event === "delta") h.onDelta(data.text ?? "");
        else if (ev.event === "warning") h.onWarning?.(data.message ?? ev.data);
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

// 对话式续跑: 在已有分析代码上按用户新需求改一版并重跑。事件与 streamAnalyze 一致,
// 但只回传 当前代码 + 上轮结论摘要 + 新需求(不缓存完整对话历史), 数据仍带本次文件。
export async function streamAnalyzeRefine(
  file: File,
  currentCode: string,
  requirement: string,
  prevSummary: string,
  question: string,
  chartFormat: string,
  palette: string,
  mode: AnalyzeMode,
  h: AnalyzeHandlers,
): Promise<void> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("current_code", currentCode);
  fd.append("requirement", requirement);
  fd.append("prev_summary", prevSummary);
  fd.append("question", question);
  fd.append("chart_format", chartFormat);
  fd.append("palette", palette);
  fd.append("mode", mode);
  let resp: Response;
  try {
    resp = await fetch(apiUrl("/api/analyze/refine"), { method: "POST", body: fd, signal: h.signal });
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
        else if (ev.event === "plan") h.onPlan?.(data.cards ?? []);
        else if (ev.event === "code") h.onCode?.(data.code ?? "");
        else if (ev.event === "charts") h.onCharts?.(normalizeCharts(data.items));
        else if (ev.event === "output") h.onOutput?.(data.text ?? "");
        else if (ev.event === "transparency_method")     h.onTransparency?.("method",     data.text ?? "");
        else if (ev.event === "transparency_assumption") h.onTransparency?.("assumption", data.text ?? "");
        else if (ev.event === "transparency_quality")    h.onTransparency?.("quality",    data.text ?? "");
        else if (ev.event === "delta") h.onDelta(data.text ?? "");
        else if (ev.event === "warning") h.onWarning?.(data.message ?? ev.data);
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

// ── 实验规划 / 伦理材料 / 论文初稿: 追问 & 修改 ────────────────────

export interface DraftFollowupHandlers {
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

async function _streamDraftFollowup(
  url: string,
  module: string,
  inputs: Record<string, unknown>,
  h: DraftFollowupHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(apiUrl(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module, inputs }),
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
        if (ev.event === "delta") h.onDelta(data.text ?? "");
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

export function streamPlanFollowup(
  inputs: Record<string, unknown>,
  h: DraftFollowupHandlers,
): Promise<void> {
  return _streamDraftFollowup("/api/plan-followup", "plan", inputs, h);
}

export function streamImradFollowup(
  inputs: Record<string, unknown>,
  h: DraftFollowupHandlers,
): Promise<void> {
  return _streamDraftFollowup("/api/imrad-followup", "imrad", inputs, h);
}

export function streamEthicsFollowup(
  inputs: Record<string, unknown>,
  h: DraftFollowupHandlers,
): Promise<void> {
  return _streamDraftFollowup("/api/ethics-followup", "ethics", inputs, h);
}

// ── 深度调研 ─────────────────────────────────────────────────

export interface RecommendItem { ref_key: string; score: "high" | "medium" | "none"; reason: string; }

export interface ContributionRow {
  n: number;
  author_year: string;
  journal: string;
  design: string;
  sample: string;
  finding: string;
  relevance: "direct" | "indirect" | "supporting";
  deep_read: boolean;
}

export interface DeepReadTarget {
  ref_key: string;
  source: "upload" | "oa" | "europepmc" | "crossref";
  upload_id?: string;
  oa_url?: string;
}

export interface DeepResearchPayload {
  question: string;
  field?: string;
  background?: string;
  depth?: string;
  sources?: string[];
  filters?: unknown;
  phase: "search" | "generate";
  references?: Reference[];
  evidence?: EvidenceItem[];
  deep_read_targets?: DeepReadTarget[];
  english_report?: boolean;
  project_id?: string | null;
}

export interface DeepResearchCallbacks {
  signal: AbortSignal;
  onStatus?: (msg: string) => void;
  onReferences?: (items: Reference[]) => void;
  onEvidence?: (items: EvidenceItem[]) => void;
  onDeepReadProgress?: (p: { done: number; total: number; current_ref_key: string }) => void;
  onDelta: (text: string) => void;
  onContributionTable?: (rows: ContributionRow[]) => void;
  onVerify?: (v: Verification) => void;
  onWarning?: (msg: string) => void;
  onError: (msg: string) => void;
  onDone: () => void;
}

// 内部: 复用 streamIdea 的内联 SSE 读取模式(fetch + ReadableStream + parseChunk),
// 但把事件分发交给调用方回调, 用于深度调研两个流式端点。
async function _runDeepResearchSSE(
  url: string,
  body: unknown,
  signal: AbortSignal,
  dispatch: (event: string, data: any) => void,
  onError: (msg: string) => void,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    onError(`无法连接本地服务: ${(e as Error).message}`);
    return;
  }
  if (!resp.ok || !resp.body) {
    onError(`服务返回错误: ${resp.status}`);
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
          /* ignore malformed */
        }
        dispatch(ev.event, data);
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      onError(`读取流出错: ${(e as Error).message}`);
    }
  }
}

export async function streamDeepResearch(payload: DeepResearchPayload, cb: DeepResearchCallbacks): Promise<void> {
  await _runDeepResearchSSE(apiUrl("/api/deep_research/stream"), payload, cb.signal, (event: string, data: any) => {
    switch (event) {
      case "status": cb.onStatus?.(data.message); break;
      case "references": cb.onReferences?.(data.items); break;
      case "evidence": cb.onEvidence?.(data.items); break;
      case "deep_read_progress": cb.onDeepReadProgress?.(data); break;
      case "delta": cb.onDelta(data.text); break;
      case "contribution_table": cb.onContributionTable?.(data.rows); break;
      case "verify": cb.onVerify?.(data); break;
      case "warning": cb.onWarning?.(data.message); break;
      case "error": cb.onError(data.message); break;
      case "done": cb.onDone(); break;
    }
  }, cb.onError);
}

export async function fetchDeepResearchRecommend(
  payload: { question: string; refs: { ref_key: string; title: string; abstract: string }[] },
): Promise<{ ok: boolean; items?: RecommendItem[]; error?: string }> {
  const r = await fetch(apiUrl("/api/deep_research/recommend"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return r.json();
}

export async function streamDeepResearchFollowup(
  payload: {
    mode: "ask" | "revise"; question: string; report: string;
    references: Reference[]; evidence: EvidenceItem[]; english_report?: boolean;
  },
  cb: {
    signal: AbortSignal;
    onDelta: (t: string) => void;
    onVerify?: (v: Verification) => void;
    onError: (m: string) => void;
    onDone: () => void;
  },
): Promise<void> {
  await _runDeepResearchSSE(apiUrl("/api/deep_research/followup/stream"), payload, cb.signal, (event: string, data: any) => {
    switch (event) {
      case "delta": cb.onDelta(data.text); break;
      case "verify": cb.onVerify?.(data); break;
      case "error": cb.onError(data.message); break;
      case "done": cb.onDone(); break;
    }
  }, cb.onError);
}
