import { useEffect, useMemo, useRef, useState } from "react";
import {
  streamGrant, grantStyle, streamGrantReview,
  Reference, Verification, GrantScheme, GrantOutlineItem,
  GrantReviewData,
} from "../lib/sse";
import Markdown, { CiteInfo, normCiteUrl } from "../components/Markdown";
import { reportLLMError } from "../lib/errorToast";
import { addHistory } from "../lib/history";
import EditableMarkdown from "../components/EditableMarkdown";
import { extractFile } from "../lib/extract";
import RefIO from "../components/RefIO";
import ZoteroPanel from "../components/ZoteroPanel";
import { usePersistentState } from "../lib/usePersistentState";
import { downloadText, downloadDocxFromText, downloadPdfFromText, tsName } from "../lib/download";
import { prepareForExport } from "../lib/exportPrep";
import { withNumberedReferences } from "../lib/citations";

// 合并导入的 references 到现有列表, 按 DOI 优先去重, 缺 DOI 则按 (title|year) 兜底。
function mergeRefs(existing: Reference[], incoming: Reference[]): { merged: Reference[]; added: number; dup: number } {
  const norm = (s: string) => (s || "").trim().toLowerCase();
  const keyOf = (r: Reference) => {
    const doi = norm(r.pmid && r.pmid.startsWith("10.") ? r.pmid : "");
    if (doi) return `doi:${doi}`;
    if (r.pmid) return `pmid:${norm(r.pmid)}`;
    return `tit:${norm(r.title)}|${norm(r.year)}`;
  };
  const seen = new Set(existing.map(keyOf));
  const merged = [...existing];
  let added = 0;
  let dup = 0;
  for (const r of incoming) {
    if (!r || (!r.title && !r.pmid)) { dup += 1; continue; }
    const k = keyOf(r);
    if (seen.has(k)) { dup += 1; continue; }
    seen.add(k);
    merged.push(r);
    added += 1;
  }
  return { merged, added, dup };
}

const GRANT_TYPES: { key: string; label: string }[] = [
  { key: "general", label: "国家自然科学基金·面上项目" },
  { key: "youth", label: "国家自然科学基金·青年科学基金" },
  { key: "regional", label: "国家自然科学基金·地区科学基金" },
  { key: "general_other", label: "通用申请书（省部级/校级/横向等）" },
];

const COVER_TITLE: Record<string, string> = {
  general: "国家自然科学基金申请书", youth: "国家自然科学基金申请书",
  regional: "国家自然科学基金申请书", general_other: "科研项目申请书",
};
const FUND_CATEGORY: Record<string, string> = {
  general: "面上项目", youth: "青年科学基金", regional: "地区科学基金",
  general_other: "通用申请书（省部级/校级/横向等）",
};
// 参考文献著录章节名(各类基金统一走 GB/T 7714 数字著录)。
const refSectionTitle = (_gt: string) => "参考文献";

function buildCover(opts: { grantType: string; projectName: string; periodStart: string; periodEnd: string }): string {
  const title = COVER_TITLE[opts.grantType] || "科研项目申请书";
  const category = FUND_CATEGORY[opts.grantType] || "通用申请书";
  const s = opts.periodStart.trim();
  const e = opts.periodEnd.trim();
  const period = s || e ? `${s || "____"} — ${e || "____"}` : "[需申请人补充]";
  const name = opts.projectName.trim() || "[需申请人补充]";
  return [
    `# ${title}`, "",
    `| **资助类别** | ${category} |`, "| --- | --- |",
    `| **项目名称** | ${name} |`, `| **研究期限** | ${period} |`,
    "| **申请人** | [需申请人补充] |", "| **依托单位** | [需申请人补充] |", "",
  ].join("\n");
}

interface DocSection { key: string; title: string; text: string }

const emptyScheme: GrantScheme = { title: "", question: "", hypothesis: "", goal: "", contents: [], innovations: [], route: "" };

function coreTitle(s: string): string {
  return s.replace(/[#*\s]/g, "").replace(/^[一二三四五六七八九十]+[、.．]/, "").replace(/^（[一二三四五六七八九十]+）/, "");
}
function stripEchoedHeading(title: string, text: string): string {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return text;
  const first = lines[i].trim();
  const isHeadingish = /^#{1,6}\s*\S/.test(first) || /^\*\*.+\*\*$/.test(first) || coreTitle(first) === coreTitle(title);
  if (isHeadingish && coreTitle(first) && coreTitle(first) === coreTitle(title)) {
    lines.splice(0, i + 1);
    while (lines.length && !lines[0].trim()) lines.shift();
    return lines.join("\n");
  }
  return text;
}
function fullDoc(sections: DocSection[]): string {
  return sections.map((s) => `## ${s.title}\n\n${stripEchoedHeading(s.title, s.text)}`).join("\n\n");
}

const STEPS = [
  { n: 1, title: "准备材料", desc: "题名 · 资助类型 · 附加材料" },
  { n: 2, title: "撰写与精修", desc: "生成 · 编辑 · 精修 · 评审" },
];

export default function GrantModule() {
  // 可由「找选题」一键带入。
  const [title, setTitle] = usePersistentState("grant:title", "");
  const [idea, setIdea] = usePersistentState("grant:idea", "");
  const [report, setReport] = usePersistentState("grant:report", "");
  const [background, setBackground] = usePersistentState("grant:background", "");
  const [grantType, setGrantType] = usePersistentState("grant:type", "general");
  const [periodStart, setPeriodStart] = usePersistentState("grant:periodStart", "");
  const [periodEnd, setPeriodEnd] = usePersistentState("grant:periodEnd", "");
  const [refs, setRefs] = usePersistentState<Reference[]>("grant:refs", []);
  const [preResearch, setPreResearch] = usePersistentState<boolean>("grant:preResearch", true);

  // 文风样例(单独的上传框)。
  const [styleSample, setStyleSample] = usePersistentState("grant:styleSample", "");
  const [styleProfile, setStyleProfile] = usePersistentState("grant:styleProfile", "");
  const [styleOn, setStyleOn] = usePersistentState<boolean>("grant:styleOn", true);
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleErr, setStyleErr] = useState("");

  // 阶段: idle | writing | done ; step: 1 准备 | 2 撰写
  const [phase, setPhase] = usePersistentState<string>("grant:phase", "idle");
  const [step, setStep] = usePersistentState<number>("grant:step", 1);
  const [scheme, setScheme] = usePersistentState<GrantScheme | null>("grant:scheme", null);
  const [outline, setOutline] = usePersistentState<GrantOutlineItem[]>("grant:outline", []);
  const [sections, setSections] = usePersistentState<DocSection[]>("grant:sections", []);
  const [verify, setVerify] = usePersistentState<Verification | null>("grant:verify", null);
  // 评审与正文脱离: 评审正文单独存, 默认隐藏, 可唤起/重评。
  const [reviewText, setReviewText] = usePersistentState("grant:reviewText", "");
  const [review, setReview] = usePersistentState<GrantReviewData | null>("grant:review", null);
  const [showReview, setShowReview] = useState(false);

  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docxBusy, setDocxBusy] = useState(false);
  const [docxErr, setDocxErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [rereviewing, setRereviewing] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const rvctrl = useRef<AbortController | null>(null);
  const inReviewRef = useRef(false); // 流中是否已进入「评审」节(其 delta 路由到 reviewText)

  // 第 1 步附加材料 / 文风样例 附件解析
  const matFileRef = useRef<HTMLInputElement>(null);
  const styleFileRef = useRef<HTMLInputElement>(null);
  const [matDrag, setMatDrag] = useState(false);
  const [matBusy, setMatBusy] = useState(false);
  const [styleDrag, setStyleDrag] = useState(false);

  const text = fullDoc(sections);
  const hasInput = !!(title.trim() || report.trim());
  const effStyle = styleOn ? styleProfile : "";

  const coverMd = useMemo(
    () => buildCover({ grantType, projectName: scheme?.title || title, periodStart, periodEnd }),
    [grantType, scheme?.title, title, periodStart, periodEnd],
  );

  const citeInfo = useMemo(() => {
    const m: Record<string, CiteInfo> = {};
    for (const r of refs) if (r.url) m[normCiteUrl(r.url)] = { label: `${r.first_author} (${r.year}). ${r.title}`.slice(0, 140) };
    return m;
  }, [refs]);

  // 去 AI 味 / AI 精修采纳: 正文由 fullDoc(sections) 拼成, 按 `## ` 切回、按序写回各节。
  const applyDoc = (newDoc: string) => {
    const parts = newDoc.split(/\n(?=## )/);
    setSections((prev) => prev.map((s, i) => {
      const p = parts[i];
      if (p === undefined) return s;
      const m = p.match(/^##\s+(.+?)\r?\n+([\s\S]*)$/);
      return m ? { ...s, title: m[1].trim(), text: m[2].trim() } : s;
    }));
  };

  const savedRef = useRef("");
  useEffect(() => {
    if (phase === "done" && !running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "grant", icon: "📜", title: (scheme?.title || title || "标书初稿").slice(0, 40),
        data: {
          "grant:title": title, "grant:idea": idea, "grant:report": report, "grant:background": background,
          "grant:type": grantType, "grant:periodStart": periodStart, "grant:periodEnd": periodEnd, "grant:refs": refs,
          "grant:scheme": scheme, "grant:outline": outline, "grant:sections": sections,
          "grant:phase": "done", "grant:step": 2, "grant:verify": verify, "grant:review": review, "grant:reviewText": reviewText,
        },
      });
    }
  }, [phase, running, error, text, title, scheme]);

  // 文风提炼
  const extractStyle = async () => {
    if (!styleSample.trim() || styleBusy) return;
    setStyleErr(""); setStyleBusy(true);
    try {
      const { profile } = await grantStyle(styleSample);
      if (profile) setStyleProfile(profile);
      else setStyleErr("未能提炼出文风档案，请换一份更完整的样例或重试。");
    } catch { setStyleErr("提炼文风失败（网络或服务错误），请重试。"); }
    finally { setStyleBusy(false); }
  };

  // 附件 → 追加到目标文本框
  const ingest = async (files: FileList | File[] | null | undefined, sink: (chunk: string, name: string) => void, setBusy: (b: boolean) => void, inputEl?: HTMLInputElement | null) => {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    setBusy(true);
    for (const f of list) {
      const res = await extractFile(f);
      if (res.ok && res.text) sink(res.text, f.name);
    }
    setBusy(false);
    if (inputEl) inputEl.value = "";
  };

  // streamGrant 的公共处理器: 把 body 节写进 sections, 评审节路由到 reviewText。
  const writeHandlers = (signal: AbortSignal) => ({
    signal,
    onStatus: setStatus,
    onScheme: (s: GrantScheme) => setScheme(s),
    onOutline: (items: GrantOutlineItem[]) => setOutline(items),
    onReferences: (items: Reference[]) => setRefs(items),
    onSection: (key: string, secTitle: string) => {
      if (key === "review") { inReviewRef.current = true; setReviewText((p) => p + (p ? "\n\n" : "")); return; }
      inReviewRef.current = false;
      setSections((prev) => [...prev, { key, title: secTitle, text: "" }]);
    },
    onDelta: (t: string) => {
      if (inReviewRef.current) { setReviewText((p) => p + t); return; }
      setSections((prev) => {
        if (!prev.length) return prev;
        const next = [...prev];
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, text: last.text + t };
        return next;
      });
    },
    onReviewData: setReview,
    onVerify: setVerify,
    onError: (m: string) => {
      setError(m); setStatus(""); setRunning(false); setPhase("done");
      window.dispatchEvent(new Event("usage-updated")); reportLLMError(m);
    },
    onDone: () => {
      setStatus(""); setRunning(false); setPhase("done"); inReviewRef.current = false;
      window.dispatchEvent(new Event("usage-updated"));
    },
  });

  // 从零开始撰写: 后端现凝练方案骨架 + 大纲(无需用户确认) + 逐节撰写 + 评审。
  const startAll = async () => {
    if (!hasInput || running) return;
    setError(null); setSections([]); setReviewText(""); setReview(null); setVerify(null);
    setShowReview(false); setPaused(false); inReviewRef.current = false;
    setPhase("writing"); setRunning(true); setStep(2);
    ctrl.current = new AbortController();
    await streamGrant(
      { title, idea, report, background, grant_type: grantType, references: refs, research: preResearch, style_profile: effStyle },
      writeHandlers(ctrl.current.signal),
    );
    setRunning(false);
  };

  // 继续生成: 就已知方案骨架 + 尚未写的大纲章节续写(不重检索、不重评已写部分)。
  const continueWrite = async () => {
    if (running) return;
    const remaining = outline.filter((o) => !sections.some((s) => s.key === o.key));
    if (!remaining.length) { setPaused(false); return; }
    setError(null); setPaused(false); inReviewRef.current = false;
    setReviewText(""); setReview(null); // 续写后会重新评审
    setPhase("writing"); setRunning(true);
    ctrl.current = new AbortController();
    await streamGrant(
      {
        title, idea, report, background, grant_type: grantType, references: refs,
        research: false, style_profile: effStyle,
        scheme: scheme || undefined,
        sections: remaining.map((o) => ({ key: o.key, title: o.title, budget: o.budget })),
      },
      writeHandlers(ctrl.current.signal),
    );
    setRunning(false);
  };

  // 暂停: 中止流; 若还有没写的章节, 亮出「继续生成」。
  const pause = () => {
    ctrl.current?.abort();
    setRunning(false); setStatus(""); setPhase("done"); inReviewRef.current = false;
    const remaining = outline.filter((o) => !sections.some((s) => s.key === o.key));
    setPaused(remaining.length > 0);
  };

  // 一键全部重写: 用当前配置从头重跑(会覆盖现有初稿)。
  const rewriteAll = () => {
    if (running) return;
    if (text && !confirm("将丢弃当前初稿并从头重新撰写全部章节。确定重写？")) return;
    startAll();
  };

  // 重新评审: 把当前全文交回评审组重打分(评审与正文脱离, 结果进 reviewText)。
  const reReview = async () => {
    if (running || rereviewing) return;
    const body = sections.filter((s) => s.text.trim()).map((s) => ({ key: s.key, title: s.title, text: s.text }));
    if (!body.length) return;
    setRereviewing(true); setError(null); setReviewText(""); setReview(null); setShowReview(true);
    inReviewRef.current = true;
    rvctrl.current = new AbortController();
    await streamGrantReview(
      { title: scheme?.title || title, grant_type: grantType, scheme, references: refs, sections: body },
      {
        signal: rvctrl.current.signal,
        onStatus: setStatus,
        onSection: () => { inReviewRef.current = true; },
        onDelta: (t) => setReviewText((p) => p + t),
        onReviewData: setReview,
        onError: (m) => { setError(`重新评审失败：${m}`); setStatus(""); setRereviewing(false); reportLLMError(m); },
        onDone: () => { setStatus(""); setRereviewing(false); inReviewRef.current = false; window.dispatchEvent(new Event("usage-updated")); },
      },
    );
    setRereviewing(false);
  };

  // 从「找选题」带入时自动开写(不再让用户确认大纲, 直接进第 2 步预览)。
  const [autostart, setAutostart] = usePersistentState<boolean>("grant:autostart", false);
  useEffect(() => {
    if (autostart && hasInput && phase !== "writing" && !running) {
      setAutostart(false);
      startAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart]);

  const reset = () => {
    const hasWork = title.trim() || report.trim() || idea.trim() || scheme || sections.length > 0;
    if (hasWork && !confirm("将清空全部输入与已生成的初稿，且不可撤销。确定清空？")) return;
    if (running) { ctrl.current?.abort(); setRunning(false); }
    rvctrl.current?.abort();
    setTitle(""); setIdea(""); setReport(""); setBackground(""); setRefs([]);
    setPeriodStart(""); setPeriodEnd("");
    setScheme(null); setOutline([]); setSections([]); setVerify(null); setReview(null); setReviewText("");
    setStyleSample(""); setStyleProfile(""); setStyleOn(true); setStyleErr("");
    setStatus(""); setError(null); setPhase("idle"); setStep(1); setPaused(false);
  };

  // 导出全文 = 封面 + 正文(引用编号化) + 参考文献。
  const exportDoc = async () => {
    const numbered = withNumberedReferences(text, refs, refSectionTitle(grantType));
    const cover = buildCover({ grantType, projectName: scheme?.title || title, periodStart, periodEnd });
    return prepareForExport(cover + "\n" + numbered, "技术路线图/计划图");
  };

  const doExport = async (kind: "md" | "docx" | "pdf") => {
    if (docxBusy || !text) return;
    setDocxBusy(true); setDocxErr("");
    try {
      const body = await exportDoc();
      if (kind === "md") downloadText(tsName("标书初稿", "md"), body);
      else if (kind === "docx") await downloadDocxFromText(tsName("标书初稿", "docx"), body);
      else await downloadPdfFromText(tsName("标书初稿", "pdf"), body, scheme?.title || title);
    } catch (e) {
      setDocxErr(`导出失败：${(e as Error).message}`);
    } finally { setDocxBusy(false); }
  };

  const updateScheme = (patch: Partial<GrantScheme>) => setScheme((prev) => ({ ...(prev || emptyScheme), ...patch }));
  void updateScheme; // 方案骨架此版仅只读展示

  return (
    <div className="module grant-wizard">
      <header className="module-head">
        <h1>📜 写标书 · 中文基金申请书</h1>
        <p>两步走：准备材料 → 一键生成并在预览里精修。生成会自动凝练方案与大纲、分节撰写并给出评审自查；全程可暂停/继续、返回上一步。产出为<strong>初稿</strong>，请人工核对；无法推断的事实以 <code>[需申请人补充]</code> 占位，绝不杜撰。</p>
      </header>

      <div className="wiz-steps" data-testid="grant-steps">
        {STEPS.map((s) => {
          const state = step === s.n ? "current" : s.n < step ? "done" : "todo";
          // 撰写过程中也可返回准备步骤查看/微调(流写入持久化状态, 返回不打断生成)。
          const clickable = s.n === 1 || (s.n === 2 && (sections.length > 0 || running));
          return (
            <button key={s.n} type="button" className={`wiz-step ${state}`} data-testid={`grant-step-${s.n}`} disabled={!clickable} onClick={() => clickable && setStep(s.n)}>
              <span className="wiz-step-num">{s.n < step ? "✓" : s.n}</span>
              <span className="wiz-step-text"><span className="wiz-step-title">{s.title}</span><span className="wiz-step-desc">{s.desc}</span></span>
            </button>
          );
        })}
      </div>

      {error && <div className="result-error" data-testid="grant-error">{error}</div>}

      {/* ── 第 1 步：准备材料 ── */}
      {step === 1 && (
        <div className="wiz-panel" data-testid="grant-panel-1">
          <div className="form">
            <label className="field">
              <span className="field-label">项目题名 / 研究方向 <em>必填</em></span>
              <input data-testid="grant-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：肠道菌群代谢物 TMAO 通过 NLRP3 炎症小体促进动脉粥样硬化的机制研究" />
            </label>
            <div className="ss-row">
              <label className="field">
                <span className="field-label">资助类型</span>
                <select data-testid="grant-type" value={grantType} onChange={(e) => setGrantType(e.target.value)}>
                  {GRANT_TYPES.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field-label">研究期限（可选，用于封面）</span>
                <div className="grant-period-row">
                  <input data-testid="grant-period-start" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} placeholder="起，如 2026.01" />
                  <span className="grant-period-sep">—</span>
                  <input data-testid="grant-period-end" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} placeholder="止，如 2028.12" />
                </div>
              </label>
            </div>

            {/* 唯一的「附加材料」框: 文字 + 多文件, 同一个框 */}
            <div className="field" data-testid="grant-materials-field">
              <span className="field-label">附加材料（可选，越充分越好）</span>
              <p className="field-hint">可粘贴或上传：<strong>选题调研报告、前期工作/预实验、相关综述或论文、已有思路</strong>等。支持 Word / PDF / txt，<strong>可一次选多个</strong>；会作为撰写的现状与研究基础依据。</p>
              <div className={`combo-input${matDrag ? " dragover" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setMatDrag(true); }}
                onDragLeave={() => setMatDrag(false)}
                onDrop={(e) => { e.preventDefault(); setMatDrag(false); ingest(e.dataTransfer.files, (t, name) => setReport((p) => (p ? p + "\n\n" : "") + `[附加材料：${name}]\n` + t), setMatBusy); }}>
                <textarea data-testid="grant-report" value={report} onChange={(e) => setReport(e.target.value)} placeholder="把选题调研报告 / 前期工作 / 相关论文粘贴到这里，或把文件直接拖进本框（可多个）。" rows={5} />
                <div className="combo-foot">
                  <button type="button" className="combo-attach" data-testid="grant-materials-attach" onClick={() => matFileRef.current?.click()}>📎 添加附件（可多选）</button>
                  <span className="combo-hint">{matBusy ? "正在解析附件…" : "支持 Word / PDF / txt，可直接拖入本框"}</span>
                  <input ref={matFileRef} data-testid="grant-upload" type="file" accept=".docx,.pdf,.txt,.md" multiple style={{ display: "none" }} onChange={(e) => ingest(e.target.files, (t, name) => setReport((p) => (p ? p + "\n\n" : "") + `[附加材料：${name}]\n` + t), setMatBusy, matFileRef.current)} />
                </div>
              </div>
            </div>

            {/* 文风样例: 单独的附件框 */}
            <div className="field" data-testid="grant-style">
              <span className="field-label">文风样例（可选，单独上传）</span>
              <p className="field-hint">上传一份你满意的标书/论文（Word/PDF/txt），AI 会<strong>提炼语言风格</strong>并在撰写时模仿，兼起去 AI 味作用。<strong>只学"怎么写"，不会把样例内容写进你的标书。</strong></p>
              <div className={`combo-input${styleDrag ? " dragover" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setStyleDrag(true); }}
                onDragLeave={() => setStyleDrag(false)}
                onDrop={(e) => { e.preventDefault(); setStyleDrag(false); ingest(e.dataTransfer.files, (t) => setStyleSample((p) => (p ? p + "\n\n" : "") + t), setStyleBusy); }}>
                <textarea data-testid="grant-style-sample" value={styleSample} onChange={(e) => setStyleSample(e.target.value)} placeholder="把文风样例粘贴到这里，或把文件拖进本框。" rows={3} />
                <div className="combo-foot">
                  <button type="button" className="combo-attach" data-testid="grant-style-attach" onClick={() => styleFileRef.current?.click()}>📎 上传文风样例</button>
                  {styleSample && (
                    <button className="btn-secondary btn-sm" data-testid="grant-style-extract-btn" onClick={extractStyle} disabled={styleBusy}>
                      {styleBusy ? "提炼中…" : styleProfile ? "重新提炼文风" : "提炼文风"}
                    </button>
                  )}
                  {styleProfile && (
                    <label className="type-chip" title="撰写与去 AI 味时是否模仿此文风">
                      <input type="checkbox" data-testid="grant-style-toggle" checked={styleOn} onChange={(e) => setStyleOn(e.target.checked)} />模仿此文风
                    </label>
                  )}
                  <input ref={styleFileRef} data-testid="grant-style-upload" type="file" accept=".docx,.pdf,.txt,.md" multiple style={{ display: "none" }} onChange={(e) => ingest(e.target.files, (t) => setStyleSample((p) => (p ? p + "\n\n" : "") + t), setStyleBusy, styleFileRef.current)} />
                </div>
              </div>
              {styleErr && <div className="result-error" data-testid="grant-style-error">{styleErr}</div>}
              {styleProfile && (
                <label className="field" style={{ marginTop: 8 }}>
                  <span className="field-label">文风档案（可编辑）</span>
                  <textarea data-testid="grant-style-profile" value={styleProfile} rows={4} onChange={(e) => setStyleProfile(e.target.value)} />
                </label>
              )}
            </div>

            {/* 可引用文献(次要): 从找选题带入或导入 */}
            <details className="adv-settings" data-testid="grant-refs-info">
              <summary className="adv-summary"><span className="adv-summary-main">📚 可引用文献（{refs.length} 篇）</span><span className="adv-summary-sub">从「找选题」带入，或从 Zotero / 文件导入；立项依据会据实引用并在文末列「参考文献」</span></summary>
              <div className="adv-body">
                <RefIO currentRefs={refs} exportFilename="标书-文献" onImport={(imp) => setRefs(mergeRefs(refs, imp).merged)} />
                <ZoteroPanel currentRefs={refs} onImport={(imp) => setRefs(mergeRefs(refs, imp).merged)} />
                <label className="type-chip" data-testid="grant-preresearch" title="撰写前按本方向再检索一遍 PubMed 等, 把新文献并入后据此写立项依据(更贴合、稍慢)">
                  <input type="checkbox" data-testid="grant-preresearch-toggle" checked={preResearch} onChange={(e) => setPreResearch(e.target.checked)} />撰写前重新检索文献（推荐）
                </label>
              </div>
            </details>
          </div>

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={reset} data-testid="grant-reset-btn">清空</button>
            <button className="btn-primary" onClick={startAll} disabled={!hasInput || running} data-testid="grant-start-btn">
              一键生成初稿 →
            </button>
          </div>
          {!hasInput && <p className="field-hint" data-testid="grant-gate-hint" style={{ marginTop: 6 }}>开始前请至少填写<strong>项目题名</strong>，或在附加材料里粘贴一份<strong>选题调研报告</strong>。</p>}
        </div>
      )}

      {/* ── 第 2 步：撰写与精修 ── */}
      {step === 2 && (
        <div className="wiz-panel" data-testid="grant-panel-2">
          {status && <div className="status-line" data-testid="grant-status"><span className="spinner" /> {status}</div>}

          {scheme && (scheme.question || scheme.hypothesis || scheme.goal) && (
            <details className="refs" data-testid="grant-scheme-view">
              <summary>🧭 研究方案骨架</summary>
              <div className="result-text">
                {scheme.question && <p><strong>关键科学问题：</strong>{scheme.question}</p>}
                {scheme.hypothesis && <p><strong>科学假设：</strong>{scheme.hypothesis}</p>}
                {scheme.goal && <p><strong>总体目标：</strong>{scheme.goal}</p>}
                {scheme.contents.length > 0 && <div><strong>研究内容：</strong><ol>{scheme.contents.map((c, i) => <li key={i}>{c}</li>)}</ol></div>}
                {scheme.innovations.length > 0 && <div><strong>创新点：</strong><ul>{scheme.innovations.map((c, i) => <li key={i}>{c}</li>)}</ul></div>}
                {scheme.route && <p><strong>技术路线主线：</strong>{scheme.route}</p>}
              </div>
            </details>
          )}

          <div className="result-panel">
            <div className="result-toolbar">
              <span className="result-status">{running ? "撰写中…" : text ? "已完成" : "等待生成"}</span>
              <div className="result-actions">
                {running && <button className="btn-ghost" onClick={pause} data-testid="grant-pause-btn">⏸ 暂停</button>}
                {!running && paused && <button className="btn-primary btn-sm" onClick={continueWrite} data-testid="grant-continue-btn">▶ 继续生成</button>}
                {text && !running && <button className="btn-ghost" data-testid="grant-rewrite-all-btn" onClick={rewriteAll} title="丢弃当前初稿, 用当前配置从头重写全部章节">🔄 一键全部重写</button>}
                {text && !running && (
                  <button className="btn-ghost" data-testid="grant-copy-btn" title="复制申请书全文" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { /* ignore */ } }}>
                    {copied ? "已复制 ✓" : "复制"}
                  </button>
                )}
                {text && !running && <button className="btn-ghost" data-testid="grant-export-md" onClick={() => doExport("md")} disabled={docxBusy}>导出 Markdown</button>}
                {text && !running && <button className="btn-ghost" data-testid="grant-export-docx" onClick={() => doExport("docx")} disabled={docxBusy}>{docxBusy ? "导出中…" : "导出 Word"}</button>}
                {text && !running && <button className="btn-ghost" data-testid="grant-export-pdf" onClick={() => doExport("pdf")} disabled={docxBusy}>{docxBusy ? "导出中…" : "导出 PDF"}</button>}
              </div>
            </div>
            {docxErr && <div className="result-error">{docxErr}</div>}
            {phase === "done" && sections.length > 0 && <div className="grant-cover" data-testid="grant-cover"><Markdown>{coverMd}</Markdown></div>}
            <EditableMarkdown
              value={text}
              onSave={applyDoc}
              running={running}
              refInfo={citeInfo}
              deaiStyle={effStyle}
              enableRefine={phase === "done" && sections.length > 0}
              refs={refs}
              refineTestId="grant-refine"
              placeholder={running ? "正在撰写…" : "点“一键生成初稿”后，申请书会显示在这里；生成后可在本区就地编辑 / 去 AI 味 / AI 精修。"}
              testId="grant-result"
            />
          </div>

          {verify && !running && (
            verify.unverified.length === 0 ? (
              <div className="verify-ok" data-testid="grant-verify">
                ✓ 引用核验：正文 {verify.total} 处文献引用均来自带入/检索到的真实文献。
                {(verify.quotes_total ?? 0) > 0 && <span className="verify-quote-note">　其中 {verify.quotes_total} 处附有原文支持句（悬停引用即可查看）{(verify.quotes_ok ?? 0) < (verify.quotes_total ?? 0) && `；有 ${(verify.quotes_total ?? 0) - (verify.quotes_ok ?? 0)} 处未能逐字定位，请核对`}。</span>}
              </div>
            ) : (
              <div className="verify-bad" data-testid="grant-verify">
                ⚠ 引用核验：发现 {verify.unverified.length} 处引用未出现在带入的文献中，请核实：
                {verify.unverified.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer">{u}</a>)}
              </div>
            )
          )}

          {/* 评审自查: 与正文脱离, 默认隐藏, 可唤起/重评 */}
          {phase === "done" && sections.length > 0 && !running && (
            <div className="grant-review-zone" data-testid="grant-review-zone">
              <div className="grant-review-bar">
                <button className="btn-ghost btn-sm" data-testid="grant-review-toggle" onClick={() => setShowReview((v) => !v)}>
                  {showReview ? "▾ 收起评审自查" : "▸ 查看评审自查（评审视角打分与问题）"}
                </button>
                <button className="btn-secondary btn-sm" data-testid="grant-rereview-btn" onClick={reReview} disabled={rereviewing} title="把当前全文（含你编辑/精修后的版本）交回评审组重新打分">
                  {rereviewing ? "评审中…" : "🔁 重新评审"}
                </button>
              </div>
              {showReview && (
                <div className="grant-review-body" data-testid="grant-review-body">
                  {review && (
                    <div className="grant-review-summary" data-testid="grant-review-summary">
                      <span className={`grant-grade-badge grant-grade-${review.grade}`}>资助建议 {review.grade} · {review.grade_label}</span>
                      {review.overall != null && <span>总体均分 <strong>{review.overall}</strong>/10（{review.personas.length} 位评审专家）</span>}
                      {review.sections.filter((s) => s.score != null).map((s) => (
                        <span key={s.key} className="grant-score-chip" title={s.title}>{s.title.replace(/^[一二三四五六七八九十]+、/, "").slice(0, 8)} {s.score}</span>
                      ))}
                    </div>
                  )}
                  {reviewText ? <div className="result-text"><Markdown>{reviewText}</Markdown></div> : <p className="field-hint">尚无评审内容，点「重新评审」生成。</p>}
                </div>
              )}
            </div>
          )}

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => setStep(1)} data-testid="grant-back-btn">← 返回准备</button>
            <button className="btn-ghost" onClick={reset} disabled={running} data-testid="grant-reset-btn">重新开始</button>
          </div>
        </div>
      )}
    </div>
  );
}
