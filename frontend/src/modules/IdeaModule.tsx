import { useEffect, useMemo, useRef, useState } from "react";
import { CiteInfo, normCiteUrl } from "../components/Markdown";
import { streamIdea, streamIdeaFollowup, Reference, Trial, EvidenceItem, Verification, RewritePayload, TopicCard } from "../lib/sse";
import { reportLLMError } from "../lib/errorToast";
import { addHistory } from "../lib/history";
import { parseAttachments, appendAttachmentsToField } from "../lib/attachments";
import AttachmentChips from "../components/AttachmentChips";
import Markdown from "../components/Markdown";
import EditableMarkdown from "../components/EditableMarkdown";
import { downloadText, downloadCsv, downloadDocxFromText, downloadPdfFromText, tsName } from "../lib/download";
import { stripSupportQuotes } from "../lib/exportPrep";
import { usePersistentState } from "../lib/usePersistentState";
import type { Goto } from "../App";
import { LiteraturePicker } from "../components/LiteraturePicker";
import { extractEvidenceForRefs } from "../lib/evidenceExtract";
import { stash as stashHandoff } from "../lib/refHandoff";


const STUDY_TYPES: { key: string; label: string }[] = [
  { key: "rct", label: "随机对照试验" },
  { key: "meta", label: "Meta 分析" },
  { key: "systematic", label: "系统综述" },
  { key: "review", label: "综述" },
];

// 默认检索源(界面已隐藏来源选择, 始终多源检索)。
const DEFAULT_SOURCES = ["pubmed", "europepmc", "openalex", "crossref", "clinicaltrials", "unpaywall"];

const Q_RANK: Record<string, number> = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
function impactOf(r: Reference): number {
  return typeof r.journal_impact === "number" ? r.journal_impact : -1;
}
function quartileRank(r: Reference): number {
  return r.journal_quartile ? Q_RANK[r.journal_quartile] ?? 99 : 99;
}
function sortRefs(refs: Reference[], by: string): Reference[] {
  if (by === "relevance") {
    const hasRel = refs.some((r) => typeof r.rel === "number");
    if (hasRel) return [...refs].sort((a, b) => (b.rel ?? -1) - (a.rel ?? -1));
    return refs;
  }
  if (by === "cited") return [...refs].sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0));
  if (by === "year") return [...refs].sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
  if (by === "impact") return [...refs].sort((a, b) => impactOf(b) - impactOf(a));
  if (by === "quartile")
    return [...refs].sort((a, b) => quartileRank(a) - quartileRank(b) || impactOf(b) - impactOf(a));
  return refs;
}

// 从整篇调研报告里只截取【研究现状 + 研究空白】部分, 砍掉"候选选题(各方向)/首选推荐"。
function reportBackgroundOnly(full: string): string {
  const m = full.match(/(^|\n)#{1,6}[^\n]*候选选题/);
  if (!m || m.index == null) return full;
  const cut = full.slice(0, m.index).trimEnd();
  return cut.length >= 20 ? cut : full;
}

// 从候选方向正文里挑出【被它引用到的那几篇】文献(按正文 Markdown 链接的 URL/PMID 匹配)。
function refsCitedIn(body: string, all: Reference[]): Reference[] {
  const strip = (u: string) => u.replace(/\/+$/, "");
  const urls = new Set<string>();
  const re = /\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) urls.add(strip(m[1]));
  if (urls.size === 0) return [];
  return all.filter((r) => {
    const u = strip(r.url || "");
    if (u && urls.has(u)) return true;
    if (r.pmid) {
      for (const cu of urls) if (cu.endsWith("/" + r.pmid)) return true;
    }
    return false;
  });
}

const refKey = (r: Reference) => r.pmid || r.url || r.title;

// 把选题卡的候选方向拼回 Markdown「候选选题」章节, 供导出/复制时补回报告(报告正文已剥离候选段)。
function candidatesMd(card: TopicCard | null): string {
  if (!card || !card.candidates.length) return "";
  const lines: string[] = ["", "## 候选选题", ""];
  for (const c of card.candidates) {
    lines.push(`### 候选选题${c.n}：${c.title}`);
    if (c.body) lines.push(c.body);
    if (c.feasibility != null) lines.push(`> 可行性 ★${c.feasibility}/5｜创新性 ★${c.innovation ?? "-"}/5`);
    lines.push("");
  }
  return lines.join("\n");
}

// 向导步骤定义
const STEPS = [
  { n: 1, title: "研究方向", desc: "领域 · 关键词 · 相关资料" },
  { n: 2, title: "检索设置", desc: "年份 · 证据等级 · 质量" },
  { n: 3, title: "文献复核", desc: "查看 · 增删 · 勾选" },
  { n: 4, title: "调研产出", desc: "报告 · 选题卡" },
];

export default function IdeaModule({ goto }: { goto: Goto }) {
  const [field, setField] = usePersistentState("idea:field", "");
  const [keywords, setKeywords] = usePersistentState("idea:keywords", "");
  const [background, setBackground] = usePersistentState("idea:background", "");
  const [depth, setDepth] = usePersistentState("idea:depth", "deep");
  // 时间筛选改为「最近 N 年」: ""=不限, "1".."5"=近 N 年; 默认近 3 年。
  const [yearsBack, setYearsBack] = usePersistentState("idea:yearsBack", "3");
  const [studyTypes, setStudyTypes] = usePersistentState<string[]>("idea:studyTypes", STUDY_TYPES.map((s) => s.key));
  const [impactMin, setImpactMin] = usePersistentState("idea:impactMin", "");
  const [minQuartile, setMinQuartile] = usePersistentState("idea:minQuartile", "");
  const [keepUnknownImpact, setKeepUnknownImpact] = usePersistentState("idea:keepUnknownImpact", true);
  const [englishReport, setEnglishReport] = usePersistentState("idea:englishReport", false);

  // 向导步骤 + 到达过的最大步骤(允许回看而不丢数据)
  const [step, setStep] = usePersistentState<number>("idea:step", 1);
  const [maxStep, setMaxStep] = usePersistentState<number>("idea:maxStep", 1);
  const goStep = (n: number) => { setStep(n); if (n > maxStep) setMaxStep(n); };

  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);
  const [refs, setRefs] = usePersistentState<Reference[]>("idea:refs", []);
  const [selectedKeys, setSelectedKeys] = usePersistentState<string[]>("idea:selected", []);
  const [refSort, setRefSort] = usePersistentState("idea:refSort", "relevance");
  const [trials, setTrials] = usePersistentState<Trial[]>("idea:trials", []);
  const [evidence, setEvidence] = usePersistentState<EvidenceItem[]>("idea:evidence", []);
  const [text, setText] = usePersistentState("idea:result", "");
  const [verify, setVerify] = usePersistentState<Verification | null>("idea:verify", null);
  const [card, setCard] = usePersistentState<TopicCard | null>("idea:card", null);
  const [reportCollapsed, setReportCollapsed] = useState(false);
  const [wordBusy, setWordBusy] = useState(false);
  const [running, setRunning] = useState(false); // 检索或生成进行中
  const [error, setError] = useState<string | null>(null);
  const [evidenceExtractProgress, setEvidenceExtractProgress] = useState<{ done: number; total: number } | null>(null);
  const [rewrite, setRewrite] = useState<RewritePayload | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // 追问 / 修改报告
  const [followups, setFollowups] = usePersistentState<{ q: string; a: string }[]>("idea:qa", []);
  const [followupInput, setFollowupInput] = useState("");
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [fRunning, setFRunning] = useState(false);
  const [fError, setFError] = useState<string | null>(null);
  const fctrl = useRef<AbortController | null>(null);

  // 第 1 步「相关资料」附件: 添加时不解析,提交任务时才解析并注入 payload。
  const fileRef = useRef<HTMLInputElement>(null);
  const [comboDrag, setComboDrag] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);

  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "idea",
        icon: "💡",
        title: field || "选题调研",
        data: {
          "idea:field": field, "idea:keywords": keywords, "idea:background": background,
          "idea:result": text, "idea:refs": refs, "idea:trials": trials, "idea:evidence": evidence,
          "idea:qa": followups, "idea:verify": verify, "idea:card": card,
        },
      });
    }
  }, [running, error, text, field, keywords, background, refs, verify]);

  // 当前年份 → 起始年份(近 N 年); 不限则空字符串。
  const yearFromValue = () => (yearsBack ? String(new Date().getFullYear() - Number(yearsBack) + 1) : "");

  const filtersPayload = () => ({
    year_from: yearFromValue(),
    study_types: studyTypes,
    min_quartile: minQuartile,
    min_impact: impactMin,
    keep_unknown: keepUnknownImpact,
  });

  // ── 第 2→3 步：只检索(含抽取要点), 不生成报告 ────────────────────
  const runSearch = async () => {
    if (!field.trim() || running) return;
    setError(null);
    // 先解析附件（如有）,失败中止不进入 LLM
    let mergedBackground = background;
    if (pendingAttachments.length > 0) {
      const parseCtrl = new AbortController();
      ctrl.current = parseCtrl;
      setRunning(true);
      try {
        const parsed = await parseAttachments(pendingAttachments, {
          signal: parseCtrl.signal,
          onProgress: (p) => setStatus(`正在解析附件 ${p.index}/${p.total}：${p.name} …`),
        });
        mergedBackground = appendAttachmentsToField(background, parsed);
      } catch (e) {
        setError((e as Error).message);
        setStatus("");
        setRunning(false);
        return;
      }
    }
    fctrl.current?.abort();
    setFRunning(false);
    setStatus("");
    setError(null);
    setRewrite(null);
    setRefs([]);
    setSelectedKeys([]);
    setTrials([]);
    setEvidence([]);
    setText("");
    setVerify(null);
    setCard(null);
    setFollowups([]);
    setRunning(true);
    goStep(3);
    ctrl.current = new AbortController();
    await streamIdea(
      {
        field, keywords, background: mergedBackground, depth,
        sources: DEFAULT_SOURCES,
        filters: filtersPayload(),
        phase: "search",
      },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onReferences: (items) => { setRefs(items); setSelectedKeys(items.map(refKey)); },
        onTrials: setTrials,
        onEvidence: setEvidence,
        onDelta: () => {},
        onRewriteSuggestion: setRewrite,
        onError: (m) => { setError(m); setStatus(""); setRunning(false); window.dispatchEvent(new Event("usage-updated")); reportLLMError(m); },
        onDone: () => { setStatus(""); setRunning(false); window.dispatchEvent(new Event("usage-updated")); },
      },
    );
    setRunning(false);
  };

  // ── 第 3→4 步：据勾选的文献直接生成报告(不再询问用户) ────────────
  const runGenerate = async () => {
    if (running) return;
    const sel = refs.filter((r) => selectedSet.has(refKey(r)));
    if (sel.length === 0) { setError("请至少勾选一篇文献再进入调研产出。"); return; }
    const selUrls = new Set(sel.map((r) => (r.url || "").replace(/\/+$/, "")));
    const selTitles = new Set(sel.map((r) => (r.title || "").trim().toLowerCase()));
    const selEvidence = evidence.filter(
      (e) => selUrls.has((e.url || "").replace(/\/+$/, "")) || selTitles.has((e.title || "").trim().toLowerCase()),
    );
    let mergedBackground = background;
    if (pendingAttachments.length > 0) {
      const parseCtrl = new AbortController();
      ctrl.current = parseCtrl;
      setRunning(true);
      try {
        const parsed = await parseAttachments(pendingAttachments, {
          signal: parseCtrl.signal,
          onProgress: (p) => setStatus(`正在解析附件 ${p.index}/${p.total}：${p.name} …`),
        });
        mergedBackground = appendAttachmentsToField(background, parsed);
      } catch (e) {
        setError((e as Error).message);
        setStatus("");
        setRunning(false);
        return;
      }
    }
    fctrl.current?.abort();
    setFRunning(false);
    setError(null);
    setStatus("");
    setText("");
    setVerify(null);
    setCard(null);
    setReportCollapsed(false);
    setFollowups([]);
    setRunning(true);
    goStep(4);
    ctrl.current = new AbortController();
    await streamIdea(
      {
        field, keywords, background: mergedBackground, depth,
        references: sel,
        evidence: selEvidence,
        phase: "generate",
        english_report: englishReport,
      },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onDelta: (t) => setText((p) => p + t),
        onVerify: setVerify,
        onTopicCard: setCard,
        onError: (m) => { setError(m); setStatus(""); setRunning(false); window.dispatchEvent(new Event("usage-updated")); reportLLMError(m); },
        onDone: () => {
          setStatus(""); setRunning(false); window.dispatchEvent(new Event("usage-updated"));
          // 候选方向已由「选题卡」单独承载, 从报告正文里去掉「候选选题」段, 避免读两遍;
          // 同时让预览=可编辑正文一致, 就地 AI 精修才不会误改。
          setText((t) => reportBackgroundOnly(t));
        },
      },
    );
    setRunning(false);
  };

  const acceptRewrite = () => {
    if (!rewrite?.suggestion) return;
    const next = rewrite.suggestion;
    setField(next.field);
    setKeywords(next.keywords);
    setRewrite(null);
    setError(null);
    // 用改写建议重新检索
    setTimeout(runSearch, 0);
  };

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
    setStatus("");
  };

  const runFollowup = async (mode: "ask" | "revise") => {
    const q = followupInput.trim();
    if (!q || fRunning || running) return;
    setFError(null);
    setFRunning(true);
    fctrl.current = new AbortController();
    const baseReport = text;
    let buf = "";
    if (mode === "ask") setCurrentAnswer("…");
    else setText("");
    await streamIdeaFollowup(
      { mode, question: q, report: baseReport, references: refs, evidence, english_report: englishReport },
      {
        signal: fctrl.current.signal,
        onDelta: (t) => { buf += t; if (mode === "ask") setCurrentAnswer(buf); else setText((p) => p + t); },
        onVerify: (v) => { if (mode === "revise") setVerify(v); },
        onError: (m) => { setFError(m); setFRunning(false); if (mode === "revise") setText(baseReport); reportLLMError(m); },
        onDone: () => {
          if (mode === "ask") { setFollowups((prev) => [...prev, { q, a: buf }]); setCurrentAnswer(""); }
          setFollowupInput(""); setFRunning(false); window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setFRunning(false);
  };

  const toggleStudyType = (key: string) => {
    setStudyTypes((prev) => (prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]));
  };
  const shownRefs = sortRefs(refs, refSort);

  // 文献 → 证据要点(核心发现) 的映射: 先按 URL, 再按题名。
  const evByRef = useMemo(() => {
    const byUrl: Record<string, EvidenceItem> = {};
    const byTitle: Record<string, EvidenceItem> = {};
    for (const e of evidence) {
      if (e.url) byUrl[e.url.replace(/\/+$/, "")] = e;
      if (e.title) byTitle[e.title.trim().toLowerCase()] = e;
    }
    return (r: Reference): EvidenceItem | undefined =>
      byUrl[(r.url || "").replace(/\/+$/, "")] || byTitle[(r.title || "").trim().toLowerCase()];
  }, [evidence]);

  // LiteraturePicker: evidenceByKey 按 refKey 索引(与 selectedKeys 格式一致)
  const evidenceByKey = useMemo(() => {
    const m: Record<string, EvidenceItem & { _ev_status?: string }> = {};
    for (const r of refs) {
      const ev = evByRef(r);
      if (ev) m[refKey(r)] = ev as EvidenceItem & { _ev_status?: string };
    }
    return m;
  }, [refs, evByRef]);

  const citeInfo = useMemo(() => {
    const m: Record<string, CiteInfo> = {};
    for (const r of refs) {
      if (r.url) m[normCiteUrl(r.url)] = { label: `${r.first_author} (${r.year}). ${r.title}`.slice(0, 140) };
    }
    for (const e of evidence) {
      if (!e.url) continue;
      const k = normCiteUrl(e.url);
      m[k] = { label: m[k]?.label || `${e.first_author} (${e.year}). ${e.title}`.slice(0, 140), finding: e.finding || undefined };
    }
    return m;
  }, [refs, evidence]);

  const reset = () => {
    if (running) stop();
    fctrl.current?.abort();
    setFollowups([]); setCurrentAnswer(""); setFollowupInput(""); setFError(null);
    setField(""); setKeywords(""); setBackground("");
    setRefs([]); setSelectedKeys([]); setTrials([]); setEvidence([]);
    setText(""); setVerify(null); setCard(null);
    setStatus(""); setError(null); setRewrite(null);
    setPendingAttachments([]);
    setStep(1); setMaxStep(1);
  };

  // 第 1 步：只把附件加入 pending 列表,不做任何解析。
  const ingestFiles = (files: FileList | File[] | null | undefined) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    setPendingAttachments((prev) => [...prev, ...list]);
    if (fileRef.current) fileRef.current.value = "";
  };
  const removeAttachment = (index: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="module idea-wizard">
      <header className="module-head">
        <h1>💡 找选题 · 医学/药学/生物</h1>
        <p>分四步进行：填写研究方向 → 确认检索设置 → 复核文献 → 生成调研报告与选题卡。全程可返回上一步修改，不会丢失后续内容。</p>
      </header>

      {/* 步骤条 */}
      <div className="wiz-steps" data-testid="wiz-steps">
        {STEPS.map((s) => {
          const state = step === s.n ? "current" : s.n < step ? "done" : "todo";
          // 生成过程中也允许回看已到达的步骤(检索/生成的流写入的是持久化状态, 不受当前显示步骤影响, 返回不打断)。
          const clickable = s.n <= maxStep;
          return (
            <button
              key={s.n}
              type="button"
              className={`wiz-step ${state}`}
              data-testid={`wiz-step-${s.n}`}
              disabled={!clickable}
              onClick={() => clickable && setStep(s.n)}
            >
              <span className="wiz-step-num">{s.n < step ? "✓" : s.n}</span>
              <span className="wiz-step-text">
                <span className="wiz-step-title">{s.title}</span>
                <span className="wiz-step-desc">{s.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      {error && <div className="result-error" data-testid="result-error">{error}</div>}

      {/* ── 第 1 步：研究方向 ─────────────────────────────── */}
      {step === 1 && (
        <div className="wiz-panel" data-testid="wiz-panel-1">
          <div className="form">
            <label className="field">
              <span className="field-label">研究领域 / 方向 <em>必填</em></span>
              <input
                data-testid="input-field"
                value={field}
                onChange={(e) => setField(e.target.value)}
                placeholder="例如：PD-1 抑制剂在三阴性乳腺癌中的应用、肠道菌群与阿尔茨海默病"
              />
            </label>
            <label className="field">
              <span className="field-label">关键词（可选，建议英文，利于检索）</span>
              <input
                data-testid="input-keywords"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="逗号分隔，例如：immunotherapy, biomarker, resistance"
              />
            </label>
            <div className="field" data-testid="background-field">
              <span className="field-label">相关资料（可选）</span>
              {/* 文字输入与拖入文件合为同一个框 */}
              <div
                className={`combo-input${comboDrag ? " dragover" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setComboDrag(true); }}
                onDragLeave={() => setComboDrag(false)}
                onDrop={(e) => { e.preventDefault(); setComboDrag(false); ingestFiles(e.dataTransfer.files); }}
              >
                <textarea
                  data-testid="input-background"
                  value={background}
                  onChange={(e) => setBackground(e.target.value)}
                  placeholder="粘贴你之前的研究/综述/草案，或把 Word/PDF/txt 文件直接拖进这个框（可多个）作为背景。"
                  rows={4}
                />
                <div className="combo-foot">
                  <button type="button" className="combo-attach" data-testid="combo-attach" onClick={() => fileRef.current?.click()}>
                    📎 添加附件（可多选）
                  </button>
                  <span className="combo-hint">支持 Word / PDF / txt，将在开始检索时解析</span>
                  <input
                    ref={fileRef}
                    data-testid="upload-doc"
                    type="file"
                    accept=".docx,.pdf,.txt,.md"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => ingestFiles(e.target.files)}
                  />
                </div>
                <AttachmentChips
                  files={pendingAttachments}
                  onRemove={removeAttachment}
                  disabled={running}
                  testId="idea-attach-chips"
                />
              </div>
            </div>
          </div>
          <div className="wiz-nav">
            <button className="btn-ghost" onClick={reset} data-testid="reset-btn">清空</button>
            <button className="btn-primary" onClick={() => goStep(2)} disabled={!field.trim()} data-testid="wiz-next-1">
              下一步：检索设置 →
            </button>
          </div>
        </div>
      )}

      {/* ── 第 2 步：检索设置 ─────────────────────────────── */}
      {step === 2 && (
        <div className="wiz-panel" data-testid="wiz-panel-2">
          <div className="form">
            <label className="field">
              <span className="field-label">调研深度</span>
              <select data-testid="input-depth" value={depth} onChange={(e) => setDepth(e.target.value)}>
                <option value="deep">深入（多子方向 + 空白补检索 + 空白矩阵，推荐）</option>
                <option value="fast">快速（单轮检索，省额度更快）</option>
              </select>
            </label>
            <div className="field" data-testid="filters">
              <span className="field-label">时间范围</span>
              <div className="filter-row filter-chips">
                {([["1", "近 1 年"], ["2", "近 2 年"], ["3", "近 3 年"], ["4", "近 4 年"], ["5", "近 5 年"], ["", "不限"]] as const).map(
                  ([val, label]) => (
                    <label key={val || "all"} className={`type-chip${yearsBack === val ? " on" : ""}`}>
                      <input
                        type="radio"
                        name="idea-years"
                        data-testid={`years-${val || "all"}`}
                        checked={yearsBack === val}
                        onChange={() => setYearsBack(val)}
                      />
                      {label}
                    </label>
                  ),
                )}
              </div>
            </div>
            <div className="field">
              <span className="field-label">证据等级（勾选 = 仅保留所勾类型；全勾/全不勾 = 不限）</span>
              <div className="filter-types">
                {STUDY_TYPES.map((s) => (
                  <label key={s.key} className={`type-chip${studyTypes.includes(s.key) ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      data-testid={`type-${s.key}`}
                      checked={studyTypes.includes(s.key)}
                      onChange={() => toggleStudyType(s.key)}
                    />
                    {s.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="field" data-testid="quality-filters">
              <span className="field-label">文献质量（检索时预筛，默认不限）</span>
              <div className="filter-row filter-quality">
                <label className="filter-quartile-label" title="按 Scimago(SJR) 分区过滤; 仅医学期刊有分区数据">
                  分区≥
                  <select data-testid="filter-quartile" value={minQuartile} onChange={(e) => setMinQuartile(e.target.value)}>
                    <option value="">不限</option>
                    <option value="1">仅 Q1</option>
                    <option value="2">Q1–Q2</option>
                    <option value="3">Q1–Q3</option>
                  </select>
                </label>
                <label title="滤掉影响力低于该值的文献(影响力指数=OpenAlex 近2年篇均被引, 非官方影响因子)">
                  影响力≥
                  <input
                    type="number" min="0" step="0.5" placeholder="不限"
                    data-testid="filter-impact"
                    value={impactMin}
                    onChange={(e) => setImpactMin(e.target.value)}
                    style={{ width: "4.5em" }}
                  />
                </label>
                <label className="type-chip" title="既无影响力也无分区数据的文献是否保留">
                  <input
                    type="checkbox"
                    data-testid="filter-keep-unknown"
                    checked={keepUnknownImpact}
                    onChange={(e) => setKeepUnknownImpact(e.target.checked)}
                  />
                  保留无指标数据
                </label>
              </div>
            </div>
            <div className="field">
              <span className="field-label">报告语言</span>
              <label className="type-chip" title="勾选后，最终调研报告与追问回答一律用英文输出（文献本身可为任意语言）">
                <input
                  type="checkbox"
                  data-testid="english-report"
                  checked={englishReport}
                  onChange={(e) => setEnglishReport(e.target.checked)}
                />
                用英语输出最终报告
              </label>
            </div>
          </div>
          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => setStep(1)} data-testid="wiz-back-2">← 上一步</button>
            <button className="btn-primary" onClick={runSearch} disabled={running || !field.trim()} data-testid="wiz-next-2">
              下一步：检索文献 →
            </button>
          </div>
        </div>
      )}

      {/* ── 第 3 步：文献复核 ─────────────────────────────── */}
      {step === 3 && (
        <div className="wiz-panel" data-testid="wiz-panel-3">
          {status && (
            <div className="status-line" data-testid="status-line">
              <span className="spinner" /> {status}
            </div>
          )}

          {rewrite && !running && (
            <div className="rewrite-suggest" data-testid="rewrite-suggest">
              <div className="rewrite-title">文献源零命中 · AI 改写建议</div>
              {rewrite.suggestion ? (
                <>
                  <div className="rewrite-row"><span className="rewrite-label">建议方向</span><span className="rewrite-value" data-testid="rewrite-field">{rewrite.suggestion.field}</span></div>
                  <div className="rewrite-row"><span className="rewrite-label">建议关键词</span><span className="rewrite-value" data-testid="rewrite-keywords">{rewrite.suggestion.keywords || "（无）"}</span></div>
                  {rewrite.suggestion.reason && <div className="rewrite-row"><span className="rewrite-label">为什么这样改</span><span className="rewrite-value">{rewrite.suggestion.reason}</span></div>}
                  <div className="rewrite-actions">
                    <button className="btn-primary" onClick={acceptRewrite} data-testid="rewrite-accept">采纳并重试</button>
                    <button className="btn-ghost" onClick={() => setStep(1)} data-testid="rewrite-dismiss">返回修改</button>
                  </div>
                </>
              ) : (
                <div className="rewrite-row">未能生成有效建议，请返回上一步调整方向或关键词后重试。</div>
              )}
            </div>
          )}

          <LiteraturePicker
            refs={shownRefs}
            evidenceByKey={evidenceByKey}
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            keyFn={refKey}
            exportFilename="找选题-文献"
            extractionStatus={evidenceExtractProgress}
            onImport={async (imported) => {
              // Merge new refs (dedup by existing refKey)
              const keyMap = new Map(refs.map((r) => [refKey(r), r]));
              for (const imp of imported) {
                const k = refKey(imp);
                const existing = keyMap.get(k);
                if (!existing) keyMap.set(k, imp);
                else if (!existing.abstract && imp.abstract) keyMap.set(k, { ...existing, ...imp, abstract: imp.abstract });
              }
              const merged = Array.from(keyMap.values());
              setRefs(merged);
              setSelectedKeys((prev) => [...new Set([...prev, ...imported.map(refKey)])]);
              const newOnes = imported.filter((imp) => !refs.some((r) => refKey(r) === refKey(imp)));
              if (!newOnes.length) return;
              setEvidenceExtractProgress({ done: 0, total: newOnes.length });
              try {
                const evMap = await extractEvidenceForRefs(newOnes, (d, t) => setEvidenceExtractProgress({ done: d, total: t }));
                setEvidence((prev) => {
                  const next = [...prev];
                  for (const row of Object.values(evMap)) {
                    if (prev.some((p) => p.url === row.url)) continue;
                    next.push(row);
                  }
                  return next;
                });
              } finally {
                setEvidenceExtractProgress(null);
              }
            }}
            header={
              <div className="lit-head">
                <div className="lit-head-title">
                  文献与核心发现（已勾选 <strong>{selectedKeys.length}</strong> / 共 {refs.length} 篇）
                </div>
                <div className="ref-toolbar">
                  <label className="lit-sort">
                    <span className="lit-sort-label">排序</span>
                    <select data-testid="ref-sort" value={refSort} onChange={(e) => setRefSort(e.target.value)}>
                      <option value="relevance">相关性</option>
                      <option value="cited">被引最多</option>
                      <option value="year">最新</option>
                      <option value="impact">影响力</option>
                      <option value="quartile">分区</option>
                    </select>
                  </label>
                  <button
                    className="btn-ghost lit-export-btn"
                    data-testid="export-evidence-btn"
                    onClick={() => {
                      const headers = ["序号", "第一作者", "年份", "标题", "期刊", "来源", "被引", "研究对象", "设计/方法", "主要发现", "局限/空白", "链接", "免费全文"];
                      const rows = evidence.map((e) => [e.index, e.first_author, e.year, e.title, e.journal, e.source, e.cited_by_count, e.pop, e.design, e.finding, e.gap, e.url, e.oa_url || ""]);
                      downloadCsv(tsName("证据表", "csv"), headers, rows);
                    }}
                    disabled={evidence.length === 0}
                  >
                    导出证据表 CSV
                  </button>
                  {running ? (
                    <button className="btn-ghost" onClick={stop} data-testid="stop-btn-top">停止检索</button>
                  ) : (
                    <button
                      className="btn-primary lit-start-btn"
                      onClick={runGenerate}
                      disabled={selectedKeys.length === 0}
                      data-testid="wiz-next-3-top"
                      title="据勾选的文献生成调研报告"
                    >
                      开始文献调研（{selectedKeys.length}）→
                    </button>
                  )}
                </div>
              </div>
            }
            secondaryAction={{
              label: "→ 期刊排版",
              onClick: (checked) => {
                const subset: Record<string, EvidenceItem & { _ev_status?: string }> = {};
                for (const r of checked) {
                  const k = refKey(r);
                  if (evidenceByKey[k]) subset[k] = evidenceByKey[k];
                }
                stashHandoff({ refs: checked, evidence: subset, from: "idea" });
                // Format tab switch — hooked separately via refhandoff:pending event
                goto("format", {});
              },
            }}
          />

          {refs.length === 0 && !running && !rewrite && (
            <p className="lit-empty">尚无文献。可返回上一步检索，或用上方「导入文献」带入。</p>
          )}

          {trials.length > 0 && (
            <details className="refs trials" data-testid="trials">
              <summary>🧪 相关在研临床试验（{trials.length} 项 · ClinicalTrials.gov）</summary>
              <ol className="ref-list">
                {trials.map((t, i) => (
                  <li key={t.nct_id || i}>
                    {t.status && <span className="ref-badge ref-badge-trial">{t.status}</span>}
                    {t.phase && <span className="ref-badge ref-badge-phase">{t.phase}</span>}
                    <a href={t.url} target="_blank" rel="noreferrer">{t.title}</a>
                    {t.conditions && <span className="ref-journal"> — {t.conditions}</span>}
                    <span className="trial-nct"> （{t.nct_id}{t.year ? `, ${t.year}` : ""}）</span>
                  </li>
                ))}
              </ol>
            </details>
          )}

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => setStep(2)} data-testid="wiz-back-3">← 上一步</button>
            {running ? (
              <button className="btn-ghost" onClick={stop} data-testid="stop-btn">停止检索</button>
            ) : (
              <button className="btn-primary" onClick={runGenerate} disabled={selectedKeys.length === 0} data-testid="wiz-next-3">
                开始文献调研（{selectedKeys.length} 篇）→
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── 第 4 步：调研产出 ─────────────────────────────── */}
      {step === 4 && (
        <div className="wiz-panel" data-testid="wiz-panel-4">
          {status && (
            <div className="status-line" data-testid="status-line"><span className="spinner" /> {status}</div>
          )}

          <div className="result-panel">
            <div className="result-toolbar">
              <span className="result-status">{running ? "生成中…" : text ? "已完成" : "等待生成"}</span>
              <div className="result-actions">
                {running && <button className="btn-ghost" onClick={stop} data-testid="stop-btn">停止</button>}
                {text && !running && (
                  <button className="btn-ghost" data-testid="toggle-report-btn" onClick={() => setReportCollapsed((v) => !v)} title={reportCollapsed ? "展开调研报告" : "折叠调研报告，突出下方选题卡"}>
                    {reportCollapsed ? "展开报告 ▾" : "折叠报告 ▴"}
                  </button>
                )}
                {text && !running && (!card || card.candidates.length === 0) && (
                  <button className="btn-ghost" data-testid="send-to-plan-btn" onClick={() => {
                    const parts: string[] = [];
                    if (field) parts.push(`[学科领域]\n${field}`);
                    if (background) parts.push(`[相关资料 · 来自找选题]\n${background}`);
                    goto("plan", {
                      "plan:idea": text,
                      "plan:materials": parts.join("\n\n"),
                      "plan:materials:migrated": true,
                      "plan:step": 1,
                      "plan:maxStep": 1,
                    });
                  }}>用此结果做实验规划 →</button>
                )}
                {text && !running && (
                  <button
                    className="btn-ghost"
                    data-testid="copy-report-btn"
                    onClick={async () => {
                      const refMd = refs.length ? "\n\n## 参考文献\n" + refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n") : "";
                      try { await navigator.clipboard.writeText(stripSupportQuotes(text) + candidatesMd(card) + refMd); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
                      catch { setStatus("复制失败：浏览器未授权剪贴板，请手动选择复制"); window.setTimeout(() => setStatus((s) => (s.startsWith("复制失败") ? "" : s)), 4000); }
                    }}
                    title="把调研报告（含参考文献）复制到剪贴板"
                  >
                    {copied ? "已复制 ✓" : "复制"}
                  </button>
                )}
                {text && !running && (
                  <button
                    className="btn-ghost"
                    data-testid="export-md-btn"
                    onClick={() => {
                      const refMd = refs.length ? "\n\n## 参考文献\n" + refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n") : "";
                      downloadText(tsName("选题调研", "md"), stripSupportQuotes(text) + candidatesMd(card) + refMd);
                    }}
                  >
                    导出 Markdown
                  </button>
                )}
                {text && !running && (
                  <button
                    className="btn-ghost" data-testid="export-docx-btn" disabled={wordBusy}
                    onClick={async () => {
                      setWordBusy(true);
                      try {
                        const refMd = refs.length ? "\n\n## 参考文献\n" + refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n") : "";
                        await downloadDocxFromText(tsName("选题调研", "docx"), stripSupportQuotes(text) + candidatesMd(card) + refMd);
                      } catch (e) { setStatus(`导出 Word 失败：${(e as Error).message}`); window.setTimeout(() => setStatus((s) => (s.startsWith("导出 Word 失败") ? "" : s)), 5000); }
                      finally { setWordBusy(false); }
                    }}
                  >
                    {wordBusy ? "导出中…" : "导出 Word"}
                  </button>
                )}
                {text && !running && (
                  <button
                    className="btn-ghost" data-testid="export-pdf-btn" disabled={wordBusy}
                    onClick={async () => {
                      setWordBusy(true);
                      try {
                        const refMd = refs.length ? "\n\n## 参考文献\n" + refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n") : "";
                        await downloadPdfFromText(tsName("选题调研", "pdf"), stripSupportQuotes(text) + candidatesMd(card) + refMd, field || "选题调研");
                      } catch (e) { setStatus(`导出 PDF 失败：${(e as Error).message}`); window.setTimeout(() => setStatus((s) => (s.startsWith("导出 PDF 失败") ? "" : s)), 5000); }
                      finally { setWordBusy(false); }
                    }}
                  >
                    {wordBusy ? "导出中…" : "导出 PDF"}
                  </button>
                )}
              </div>
            </div>
            {reportCollapsed && text && !running && (
              <button className="report-collapsed-bar" data-testid="report-collapsed" onClick={() => setReportCollapsed(false)} title="点击展开调研报告">
                📄 调研报告已折叠 —— 点此展开（下方为选题卡）
              </button>
            )}
            <div className={reportCollapsed && text && !running ? "report-body is-collapsed" : "report-body"}>
              <EditableMarkdown
                value={text}
                onSave={setText}
                running={running}
                refInfo={citeInfo}
                enableRefine={!running && !!text}
                refs={refs}
                refineTestId="idea-refine"
                placeholder={running ? "正在分析…" : "点击「开始文献调研」后，调研报告会显示在这里。"}
                testId="result-text"
              />
            </div>
          </div>

          {verify && !running && (
            verify.unverified.length === 0 ? (
              <div className="verify-ok" data-testid="verify">
                ✓ 引用核验：正文 {verify.total} 处文献引用均来自本次检索到的真实文献。
                {(verify.quotes_total ?? 0) > 0 && (
                  <span className="verify-quote-note">
                    　其中 {verify.quotes_total} 处附有原文支持句（悬停引用即可查看）
                    {(verify.quotes_ok ?? 0) < (verify.quotes_total ?? 0) && `；有 ${(verify.quotes_total ?? 0) - (verify.quotes_ok ?? 0)} 处未能在摘要中逐字定位，请核对`}。
                  </span>
                )}
              </div>
            ) : (
              <div className="verify-bad" data-testid="verify">
                ⚠ 引用核验：发现 {verify.unverified.length} 处引用未出现在检索结果中，请核实：
                {verify.unverified.map((u) => (<a key={u} href={u} target="_blank" rel="noreferrer">{u}</a>))}
              </div>
            )
          )}

          {/* 选题卡：候选方向 + 每个方向的「写标书/做实验规划」按钮 */}
          {card && card.candidates.length > 0 && !running && (
            <div className="topic-card" data-testid="topic-card">
              <div className="topic-card-head">🧭 选题卡 · 挑一个方向直接写标书或做实验规划</div>
              {card.facets.length > 0 && (
                <div className="topic-facets" data-testid="topic-facets">
                  <span className="topic-facets-label">子方向：</span>
                  {card.facets.map((f) => (<span key={f} className="facet-chip">{f}</span>))}
                </div>
              )}
              <ol className="candidate-list" data-testid="candidate-list">
                {card.candidates.map((c, i) => (
                  <li key={i} className="candidate-item" data-testid={`candidate-${i}`}>
                    <div className="candidate-main">
                      <div className="candidate-title">
                        方向{c.n}：{c.title}
                        {c.feasibility != null && <span className="candidate-scores">可行★{c.feasibility}｜创新★{c.innovation ?? "-"}</span>}
                      </div>
                      {c.body && <div className="candidate-body">{c.body}</div>}
                    </div>
                    <div className="candidate-actions">
                      <button
                        className="btn-primary candidate-to-grant"
                        data-testid={`candidate-to-grant-${i}`}
                        onClick={() => {
                          const cited = refsCitedIn(c.body, refs);
                          const carried = cited.length ? cited : refs;
                          // 同步带走已经抽好的核心发现, 标书那边就不用再跑一次 /api/refs/extract-evidence。
                          const carriedEvidence: Record<string, EvidenceItem & { _ev_status?: string }> = {};
                          for (const r of carried) {
                            const ev = evidenceByKey[refKey(r)];
                            if (ev) carriedEvidence[refKey(r)] = ev;
                          }
                          goto("grant", {
                            "grant:title": c.title,
                            "grant:idea": `${c.title}\n\n${c.body}`,
                            "grant:report": reportBackgroundOnly(text),
                            "grant:background": background,
                            "grant:refs": carried,
                            "grant:evidence": carriedEvidence,
                            // 直接开写: 用默认配置自动生成大纲并撰写, 跳到第 2 步预览, 不再让用户确认大纲。
                            "grant:phase": "idle", "grant:step": 1, "grant:autostart": true,
                            "grant:scheme": null, "grant:outline": [], "grant:sections": [],
                            "grant:reviewText": "", "grant:verify": null, "grant:review": null,
                          });
                        }}
                      >
                        用此方向写标书 →
                      </button>
                      <button
                        className="btn-ghost candidate-to-plan"
                        data-testid={`candidate-to-plan-${i}`}
                        onClick={() => {
                          const parts: string[] = [];
                          if (card.field) parts.push(`[学科领域]\n${card.field}`);
                          if (background) parts.push(`[相关资料 · 来自找选题]\n${background}`);
                          if (c.body) parts.push(`[候选方向补充]\n${c.body}`);
                          goto("plan", {
                            "plan:idea": `${c.title}\n\n${c.body}`,
                            "plan:materials": parts.join("\n\n"),
                            "plan:materials:migrated": true,
                            "plan:step": 1,
                            "plan:maxStep": 1,
                          });
                        }}
                      >
                        用此方向做实验规划 →
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {text && !running && (
            <div className="followup" data-testid="followup">
              <div className="followup-head">追问 / 修改意见</div>
              <p className="followup-tip">可针对某篇文献或某条结论追问，或提出意见让 AI 修订报告。回答仍只基于本次检索到的真实文献。</p>
              {followups.length > 0 && (
                <div className="qa-list" data-testid="qa-list">
                  {followups.map((qa, i) => (
                    <div key={i} className="qa-item">
                      <div className="qa-q">❓ {qa.q}</div>
                      <div className="qa-a"><Markdown>{qa.a}</Markdown></div>
                    </div>
                  ))}
                </div>
              )}
              {fRunning && currentAnswer && (
                <div className="qa-item"><div className="qa-a"><Markdown>{currentAnswer}</Markdown><span className="cursor-blink">▍</span></div></div>
              )}
              <textarea
                data-testid="followup-input"
                value={followupInput}
                onChange={(e) => setFollowupInput(e.target.value)}
                placeholder="例如：第 3 篇的样本量是多少？/ 请把候选选题三改成偏机制研究 / 研究空白这部分再具体些"
                rows={2}
                disabled={fRunning}
              />
              {fError && <div className="result-error">{fError}</div>}
              <div className="form-actions">
                <button className="btn-primary" data-testid="ask-btn" onClick={() => runFollowup("ask")} disabled={!followupInput.trim() || fRunning}>追问</button>
                <button className="btn-ghost" data-testid="revise-btn" onClick={() => runFollowup("revise")} disabled={!followupInput.trim() || fRunning}>按此修改报告</button>
                {fRunning && <button className="btn-ghost" data-testid="followup-stop-btn" onClick={() => { fctrl.current?.abort(); setFRunning(false); }}>停止</button>}
                {fRunning && <span className="status-line"><span className="spinner" /> 处理中…</span>}
              </div>
            </div>
          )}

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => setStep(3)} data-testid="wiz-back-4">← 返回文献</button>
            <button className="btn-ghost" onClick={reset} disabled={running} data-testid="reset-btn">重新开始</button>
          </div>
        </div>
      )}
    </div>
  );
}
