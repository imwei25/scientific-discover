import { useEffect, useRef, useState } from "react";
import { streamImrad, streamImradFollowup, runModule } from "../lib/sse";
import { reportLLMError } from "../lib/errorToast";
import DiffView from "../components/DiffView";
import { usePersistentState, readPersisted } from "../lib/usePersistentState";
import { mergeLegacyIntoMaterials } from "../lib/legacyMerge";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import EditableMarkdown from "../components/EditableMarkdown";
import Markdown from "../components/Markdown";
import { CanvasSlot } from "../components/Canvas";
import { HelpButton } from "../components/HelpButton";
import { extractFile } from "../lib/extract";
import { downloadText, downloadDocxFromText, downloadBlob, tsName } from "../lib/download";
import DeidentifyDialog from "../components/DeidentifyDialog";
import type { Goto } from "../App";

type PhiScanResult = {
  columns: { name: string; phi_types: string[]; count: number; samples: string[] }[];
  total_rows: number;
};

function isTabularFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".csv") || name.endsWith(".xlsx") || name.endsWith(".xls");
}

const STEPS = [
  { n: 1, title: "准备材料", desc: "主题 · 附加材料" },
  { n: 2, title: "预览 & 精修", desc: "装配 · 追问 · 修改" },
];

export default function ImradModule({ goto }: { goto: Goto }) {
  const [topic, setTopic] = usePersistentState("imrad:topic", "");
  const [materials, setMaterials] = usePersistentState("imrad:materials", "");
  const [step, setStep] = usePersistentState<number>("imrad:step", 1);
  const [maxStep, setMaxStep] = usePersistentState<number>("imrad:maxStep", 1);
  const goStep = (n: number) => { setStep(n); if (n > maxStep) setMaxStep(n); };

  useEffect(() => {
    mergeLegacyIntoMaterials("imrad:materials", [
      { key: "imrad:background", label: "引言素材" },
      { key: "imrad:methods", label: "方法素材" },
      { key: "imrad:results", label: "结果素材" },
      { key: "imrad:discussion", label: "讨论要点" },
      { key: "imrad:refs", label: "可引用文献" },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [draft, setDraft] = usePersistentState("imrad:draft", "");
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docxBusy, setDocxBusy] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const [deidEnabled, setDeidEnabled] = usePersistentState("imrad:deidEnabled", true);
  const [deidOpen, setDeidOpen] = useState(false);
  const [deidScan, setDeidScan] = useState<PhiScanResult | null>(null);
  const [deidFile, setDeidFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadInfo, setUploadInfo] = useState<string>("");
  const [uploadErr, setUploadErr] = useState<string>("");

  const matFileRef = useRef<HTMLInputElement>(null);
  const [matDrag, setMatDrag] = useState(false);

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && draft && savedRef.current !== draft) {
      savedRef.current = draft;
      addHistory({
        module: "imrad",
        icon: "📝",
        title: topic.slice(0, 40) || "论文初稿",
        data: { "imrad:topic": topic, "imrad:materials": materials, "imrad:draft": draft },
      });
    }
  }, [running, error, draft, topic, materials]);

  // 投稿包
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleMsg, setBundleMsg] = useState<string | null>(null);
  const buildBundle = async () => {
    if (bundleBusy) return;
    const files: { name: string; content: string }[] = [];
    const docx: { name: string; content: string }[] = [];
    const addMd = (name: string, key: string) => {
      const v = readPersisted(key, "");
      if (typeof v === "string" && v.trim()) files.push({ name, content: v });
    };
    addMd("01_选题调研.md", "idea:result");
    addMd("02_实验方案.md", "plan:result");
    addMd("02_统计分析计划SAP.md", "plan:sap");
    addMd("03_数据分析结论.md", "analyze:conclusion");
    addMd("05_投稿信.md", "format:cover");
    addMd("06_排版稿.md", "format:result");
    addMd("07_报告规范核对.md", "checklist:result");
    addMd("08_审稿回复.md", "rebuttal:letter");
    const refsArr = readPersisted<string[]>("format:fmtRefs", []);
    if (Array.isArray(refsArr) && refsArr.length) files.push({ name: "06_参考文献.md", content: refsArr.join("\n") });
    const draftV = (readPersisted("imrad:draft", "") as string) || draft;
    if (draftV && draftV.trim()) docx.push({ name: "04_论文初稿.docx", content: draftV });
    const absV = (readPersisted("imrad:abstract", "") as string) || abstract;
    if (absV && absV.trim()) files.push({ name: "04_摘要.md", content: absV });
    if (!files.length && !docx.length) { setBundleMsg("暂无可打包的材料,请先在各模块生成结果。"); return; }
    setBundleBusy(true); setBundleMsg(null);
    try {
      const resp = await fetch(apiUrl("/api/bundle"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files, docx }),
      });
      if (!resp.ok) throw new Error(`服务返回错误 ${resp.status}`);
      downloadBlob("research-package.zip", await resp.blob());
      setBundleMsg(`已打包 ${files.length + docx.length} 份材料为 ZIP。`);
    } catch (e) { setBundleMsg(`打包失败: ${(e as Error).message}`); }
    finally { setBundleBusy(false); }
  };

  // 摘要
  const [absPoints, setAbsPoints] = usePersistentState("imrad:absPoints", "");
  const [absMax, setAbsMax] = usePersistentState("imrad:absMax", "250");
  const [absStructured, setAbsStructured] = usePersistentState("imrad:absStructured", true);
  const [abstract, setAbstract] = usePersistentState("imrad:abstract", "");
  const [absRunning, setAbsRunning] = useState(false);
  const [absErr, setAbsErr] = useState<string | null>(null);
  const absCtrl = useRef<AbortController | null>(null);

  const [keywords, setKeywords] = usePersistentState("imrad:keywords", "");
  const [copiedKey, setCopiedKey] = useState("");
  const copyToClipboard = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopiedKey(key); window.setTimeout(() => setCopiedKey(""), 1800); }
    catch { /* ignore */ }
  };
  const [kwRunning, setKwRunning] = useState(false);
  const [kwErr, setKwErr] = useState<string | null>(null);
  const kwCtrl = useRef<AbortController | null>(null);

  const genKeywords = async () => {
    const src = absPoints.trim() || abstract.trim() || materials.trim();
    if (!src || kwRunning) return;
    setKeywords(""); setKwErr(null); setKwRunning(true);
    kwCtrl.current = new AbortController();
    await runModule("keywords", { points: src }, {
      signal: kwCtrl.current.signal,
      onDelta: (t) => setKeywords((p) => p + t),
      onError: (m) => { setKwErr(m); setKwRunning(false); reportLLMError(m); },
      onDone: () => { setKwRunning(false); window.dispatchEvent(new Event("usage-updated")); },
    });
    setKwRunning(false);
  };

  const ingestFileAsText = async (file: File) => {
    setUploadBusy(true);
    setUploadInfo(`正在解析 ${file.name} …`);
    setUploadErr("");
    const res = await extractFile(file);
    setUploadBusy(false);
    if (!res.ok || !res.text) { setUploadInfo(""); setUploadErr(res.error || "解析失败"); return; }
    setUploadInfo(`已导入: ${file.name}${res.truncated ? "(内容较长已截断)" : ""}`);
    setMaterials((prev) => (prev ? prev + "\n\n" : "") + `[附加材料: ${file.name}]\n` + res.text);
  };

  const handleUpload = async (file: File) => {
    setUploadErr(""); setUploadInfo("");
    if (deidEnabled && isTabularFile(file)) {
      try {
        setUploadBusy(true); setUploadInfo("正在检测患者信息(PHI)…");
        const fd = new FormData();
        fd.append("file", file);
        const resp = await fetch(apiUrl("/api/deidentify/scan"), { method: "POST", body: fd });
        if (!resp.ok) throw new Error(`扫描接口返回 ${resp.status}`);
        const data = (await resp.json()) as PhiScanResult;
        setUploadBusy(false);
        if (data && Array.isArray(data.columns) && data.columns.length > 0) {
          setDeidScan(data); setDeidFile(file); setDeidOpen(true);
          setUploadInfo(`检测到 ${data.columns.length} 个可能含 PHI 的列,请在弹窗中选择处理方式。`);
          return;
        }
      } catch (e) { setUploadBusy(false); setUploadInfo(`PHI 扫描失败(${(e as Error).message}),将按原文件继续。`); }
    }
    await ingestFileAsText(file);
  };
  const handleDeidAccept = async (redactedFile: File, _mapping: Record<string, string>) => {
    setDeidOpen(false); setDeidScan(null); setDeidFile(null);
    setUploadInfo(`已脱敏并导入: ${redactedFile.name}`);
    await ingestFileAsText(redactedFile);
  };
  const handleDeidCancel = async () => {
    const original = deidFile;
    setDeidOpen(false); setDeidScan(null); setDeidFile(null);
    if (original) { setUploadInfo(`已跳过脱敏,按原文件导入: ${original.name}`); await ingestFileAsText(original); }
  };

  // 附加材料多文件拖入
  const ingestMaterialFiles = async (files: FileList | File[] | null | undefined) => {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    for (const f of list) await handleUpload(f);
    if (matFileRef.current) matFileRef.current.value = "";
  };

  // 从各模块导入(全部塞进 materials)
  const importFromModules = () => {
    const idea = readPersisted("idea:result", "");
    const plan = readPersisted("plan:result", "");
    const sap = readPersisted("plan:sap", "");
    const concl = readPersisted("analyze:conclusion", "");
    const parts: string[] = [];
    if (idea) parts.push(`[选题调研]\n${idea}`);
    if (plan) parts.push(`[实验方案]\n${plan}`);
    if (sap) parts.push(`[SAP]\n${sap}`);
    if (concl) parts.push(`[数据分析结论]\n${concl}`);
    if (!parts.length) return;
    setMaterials((p) => (p ? p + "\n\n" : "") + parts.join("\n\n"));
  };

  // Diff for re-generate
  const [diffOpen, setDiffOpen] = useState(false);
  const [prevDraftSnapshot, setPrevDraftSnapshot] = useState("");
  const prevRunning = useRef(running);
  useEffect(() => {
    if (prevRunning.current && !running && !error && draft && prevDraftSnapshot && draft !== prevDraftSnapshot) {
      setDiffOpen(true);
    }
    prevRunning.current = running;
  }, [running, error, draft, prevDraftSnapshot]);

  const submit = async () => {
    if (running) return;
    if (!materials.trim()) {
      setError("请在附加材料里粘贴或上传引言/方法/结果/讨论素材,再装配初稿。");
      return;
    }
    goStep(2);
    setStatus(""); setPrevDraftSnapshot(draft); setDraft(""); setError(null); setRunning(true);
    ctrl.current = new AbortController();
    // 整段附加材料以 background 参数传给后端(prompt 里方法/结果/讨论素材若为空则不写)
    await streamImrad(
      { topic, background: materials, methods: "", results: "", discussion: "", references: "" },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onDelta: (t) => setDraft((p) => p + t),
        onError: (m) => { setError(m); setStatus(""); setRunning(false); reportLLMError(m); },
        onDone: () => { setStatus(""); setRunning(false); window.dispatchEvent(new Event("usage-updated")); },
      },
    );
    setRunning(false);
  };

  const stop = () => { ctrl.current?.abort(); setRunning(false); setStatus(""); };

  const reset = () => {
    if (running) stop();
    absCtrl.current?.abort(); kwCtrl.current?.abort();
    setAbsRunning(false); setKwRunning(false);
    setTopic(""); setMaterials("");
    setDraft(""); setAbstract(""); setAbsPoints(""); setKeywords("");
    setAbsErr(null); setKwErr(null); setError(null); setStatus("");
    setFollowups([]); setFollowupInput(""); setCurrentAnswer("");
    setStep(1); setMaxStep(1);
  };

  const downloadDocx = async () => {
    if (!draft || docxBusy) return;
    setDocxBusy(true);
    try { await downloadDocxFromText("manuscript-draft.docx", draft); }
    catch (e) { setError(`导出 Word 失败: ${(e as Error).message}`); }
    finally { setDocxBusy(false); }
  };

  const genAbstract = async () => {
    if (!absPoints.trim() || absRunning) return;
    setAbsErr(null); setAbstract(""); setAbsRunning(true);
    absCtrl.current = new AbortController();
    await runModule("abstract", { points: absPoints, max_words: absMax, structured: absStructured ? "true" : "false" }, {
      signal: absCtrl.current.signal,
      onDelta: (t) => setAbstract((p) => p + t),
      onError: (m) => { setAbsErr(m); setAbsRunning(false); reportLLMError(m); },
      onDone: () => { setAbsRunning(false); window.dispatchEvent(new Event("usage-updated")); },
    });
    setAbsRunning(false);
  };

  const wordCount = (s: string) => {
    const cn = (s.match(/[一-鿿]/g) || []).length;
    const en = (s.replace(/[一-鿿]/g, " ").match(/[A-Za-z0-9]+/g) || []).length;
    return cn + en;
  };
  const absCount = wordCount(abstract);
  const absOver = abstract && absCount > (parseInt(absMax) || 250);

  // 追问 / 修改
  const [followups, setFollowups] = usePersistentState<{ q: string; a: string }[]>("imrad:followups", []);
  const [followupInput, setFollowupInput] = useState("");
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [fRunning, setFRunning] = useState(false);
  const [fError, setFError] = useState<string | null>(null);
  const fctrl = useRef<AbortController | null>(null);

  const runFollowup = async (mode: "ask" | "revise") => {
    const q = followupInput.trim();
    if (!q || fRunning || running) return;
    setFError(null); setFRunning(true);
    fctrl.current = new AbortController();
    const baseDraft = draft;
    let buf = "";
    if (mode === "ask") setCurrentAnswer("…"); else setDraft("");
    await streamImradFollowup(
      { mode, question: q, draft: baseDraft, topic, materials },
      {
        signal: fctrl.current.signal,
        onDelta: (t) => { buf += t; if (mode === "ask") setCurrentAnswer(buf); else setDraft((p) => p + t); },
        onError: (m) => { setFError(m); setFRunning(false); if (mode === "revise") setDraft(baseDraft); reportLLMError(m); },
        onDone: () => {
          if (mode === "ask") { setFollowups((prev) => [...prev, { q, a: buf }]); setCurrentAnswer(""); }
          setFollowupInput(""); setFRunning(false); window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setFRunning(false);
  };

  return (
    <div className="module imrad-wizard">
      <DiffView
        open={diffOpen}
        original={prevDraftSnapshot}
        modified={draft}
        title="重新装配的 IMRaD 初稿 · 对比旧版本"
        onAccept={() => setDiffOpen(false)}
        onReject={() => { setDraft(prevDraftSnapshot); setDiffOpen(false); }}
      />
      <header className="module-head">
        <h1>📝 论文初稿(IMRaD 装配 + 摘要)</h1>
        <p>
          两步走:填写附加材料 → 装配初稿并追问/修改。铁律:<strong>只据你的材料、不编造数字与文献</strong>,缺失处标 [待补充]。
        </p>
        <label className="field-inline" data-testid="imrad-deid-toggle">
          <input type="checkbox" checked={deidEnabled} onChange={(e) => setDeidEnabled(e.target.checked)} data-testid="imrad-deid-enabled" />
          上传医学数据时自动检测患者信息(PHI)
        </label>
      </header>

      <div className="wiz-steps" data-testid="imrad-steps">
        {STEPS.map((s) => {
          const state = step === s.n ? "current" : s.n < step ? "done" : "todo";
          const clickable = s.n <= maxStep;
          return (
            <button key={s.n} type="button" className={`wiz-step ${state}`} data-testid={`imrad-step-${s.n}`} disabled={!clickable} onClick={() => clickable && setStep(s.n)}>
              <span className="wiz-step-num">{s.n < step ? "✓" : s.n}</span>
              <span className="wiz-step-text"><span className="wiz-step-title">{s.title}</span><span className="wiz-step-desc">{s.desc}</span></span>
            </button>
          );
        })}
      </div>

      {error && <div className="result-error" data-testid="imrad-error">{error}</div>}

      {/* Step 1 */}
      {step === 1 && (
        <div className="wiz-panel" data-testid="imrad-panel-1">
          <div className="form">
            <label className="field">
              <span className="field-label">论文主题 / 题目(可选)</span>
              <input data-testid="imrad-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="例如:二甲双胍对2型糖尿病合并NAFLD肝纤维化的疗效" />
            </label>

            <div className="field" data-testid="imrad-materials-field">
              <span className="field-label">附加材料 <em>必填</em></span>
              <p className="field-hint">
                可粘贴或上传:<strong>引言/综述要点、方法(设计/对象/样本量/统计)、结果(真实数字)、讨论要点、参考文献、已有草案/表格</strong>等。支持 Word/PDF/CSV/xlsx/txt,<strong>可一次选多个</strong>;表格类会自动检测 PHI。
              </p>
              <div className={`combo-input${matDrag ? " dragover" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setMatDrag(true); }}
                onDragLeave={() => setMatDrag(false)}
                onDrop={(e) => { e.preventDefault(); setMatDrag(false); ingestMaterialFiles(e.dataTransfer.files); }}>
                <textarea
                  data-testid="imrad-materials"
                  value={materials}
                  onChange={(e) => setMaterials(e.target.value)}
                  placeholder="把引言/方法/结果/讨论素材粘贴到这里,或把文件拖入本框(可多个)。"
                  rows={6}
                />
                <div className="combo-foot">
                  <button type="button" className="combo-attach" data-testid="imrad-materials-attach" onClick={() => matFileRef.current?.click()}>📎 添加附件(可多选)</button>
                  <span className="combo-hint">{uploadBusy ? "处理中…" : "支持 Word/PDF/CSV/xlsx/txt,可直接拖入本框"}</span>
                  <input ref={matFileRef} data-testid="imrad-upload" type="file" accept=".docx,.pdf,.txt,.md,.csv,.xlsx,.xls" multiple style={{ display: "none" }} onChange={(e) => ingestMaterialFiles(e.target.files)} />
                </div>
              </div>
              {uploadInfo && <span className="file-name" data-testid="imrad-upload-info">{uploadInfo}</span>}
              {uploadErr && <span className="result-error" data-testid="imrad-upload-error">{uploadErr}</span>}
            </div>

            <div className="form-actions">
              <button className="btn-secondary" onClick={importFromModules} data-testid="imrad-import-btn">↩ 从各模块导入已有成果</button>
              <span className="field-hint">自动追加:选题综述 / 实验方案 / SAP / 数据分析结论</span>
            </div>
          </div>

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={reset} data-testid="reset-btn">清空</button>
            <button className="btn-primary" onClick={submit} disabled={running || !materials.trim()} data-testid="run-btn">
              {running ? "装配中…" : "下一步:装配 IMRaD 初稿 →"}
            </button>
          </div>
          {!materials.trim() && (
            <p className="field-hint" data-testid="imrad-gate-hint" style={{ marginTop: 6 }}>
              开始前请在<strong>附加材料</strong>里放入至少一部分素材。
            </p>
          )}
        </div>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <div className="wiz-panel" data-testid="imrad-panel-2">
          {status && <div className="status-line" data-testid="status-line"><span className="spinner" /> {status}</div>}

          <CanvasSlot>
            <div className="result-panel">
              <div className="result-toolbar">
                <span className="result-status">{running ? "生成中…" : draft ? "已完成" : "等待开始"}</span>
                <div className="result-actions">
                  {running && <button className="btn-ghost" onClick={stop} data-testid="stop-btn">停止</button>}
                  {!running && (
                    <button className="btn-primary btn-sm" onClick={submit} disabled={!materials.trim()} data-testid="imrad-regen-btn">{draft ? "🔄 重新装配" : "装配初稿"}</button>
                  )}
                  {draft && !running && (
                    <button className="btn-ghost" data-testid="copy-draft-btn" title="复制论文初稿到剪贴板" onClick={() => copyToClipboard("draft", draft)}>
                      {copiedKey === "draft" ? "已复制 ✓" : "复制"}
                    </button>
                  )}
                  {draft && !running && <button className="btn-ghost" data-testid="export-md-btn" onClick={() => downloadText(tsName("论文初稿", "md"), draft)}>导出 Markdown</button>}
                  {draft && !running && <button className="btn-ghost" data-testid="export-docx-btn" onClick={downloadDocx} disabled={docxBusy}>{docxBusy ? "导出中…" : "导出 Word"}</button>}
                  {draft && !running && (
                    <button className="btn-ghost" data-testid="imrad-to-journal-btn" title="带着这篇初稿去『智能选刊』匹配期刊" onClick={() => goto("journal", { "journal:abstract": abstract || draft })}>用此初稿去选刊 →</button>
                  )}
                  {draft && !running && (
                    <button className="btn-ghost" data-testid="imrad-to-format-btn" title="带着这篇初稿去『期刊排版』重排导出" onClick={() => goto("format", { "format:manuscript": draft, "format:refs": "" })}>用此初稿去排版 →</button>
                  )}
                </div>
              </div>
              <EditableMarkdown
                value={draft}
                onSave={setDraft}
                running={running}
                enableRefine={!running && !!draft}
                refineTestId="imrad-refine"
                placeholder={running ? "正在撰写…" : "填好上方材料后点击装配,论文初稿会显示在这里;生成后可就地编辑 / 去 AI 味 / AI 精修。"}
                testId="result-text"
              />
            </div>
          </CanvasSlot>

          {/* 追问 / 修改 */}
          {draft && !running && (
            <div className="followup" data-testid="imrad-followup">
              <div className="followup-head">追问 / 修改主稿</div>
              <p className="followup-tip">可就初稿某段追问,或按意见让 AI 重写完整初稿。追问基于当前初稿与附加材料,不会引入未提供的数字/文献。</p>
              {followups.length > 0 && (
                <div className="qa-list" data-testid="imrad-qa-list">
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
                data-testid="imrad-followup-input"
                value={followupInput}
                onChange={(e) => setFollowupInput(e.target.value)}
                placeholder="例如:讨论段能否更聚焦局限性? / 请把方法段第 2 段扩写 / 结果段引用改成 [作者, 年]"
                rows={2}
                disabled={fRunning}
              />
              {fError && <div className="result-error">{fError}</div>}
              <div className="form-actions">
                <button className="btn-primary" data-testid="imrad-ask-btn" onClick={() => runFollowup("ask")} disabled={!followupInput.trim() || fRunning}>追问</button>
                <button className="btn-ghost" data-testid="imrad-revise-btn" onClick={() => runFollowup("revise")} disabled={!followupInput.trim() || fRunning}>按此修改主稿</button>
                {fRunning && <button className="btn-ghost" onClick={() => { fctrl.current?.abort(); setFRunning(false); }} data-testid="imrad-followup-stop">停止</button>}
                {fRunning && <span className="status-line"><span className="spinner" /> 处理中…</span>}
              </div>
            </div>
          )}

          <h2 className="section-title">🧾 结构式摘要 + 字数核对</h2>
          <p className="section-hint">输入要点与目标字数,生成 Background/Methods/Results/Conclusions 摘要并实时显示字数。</p>
          <div className="form">
            <label className="field">
              <span className="field-label">摘要要点 / 材料</span>
              <textarea data-testid="abs-points" value={absPoints} onChange={(e) => setAbsPoints(e.target.value)} rows={4} placeholder="粘贴研究目的、方法、主要结果(数字)、结论要点" />
            </label>
            <div className="chart-opts">
              <label className="field-inline">目标字数上限
                <input data-testid="abs-max" value={absMax} onChange={(e) => setAbsMax(e.target.value)} style={{ width: 80 }} />
              </label>
              <label className="field-inline">
                <input type="checkbox" data-testid="abs-structured" checked={absStructured} onChange={(e) => setAbsStructured(e.target.checked)} />
                结构式(四段带小标题)
              </label>
            </div>
            <div className="form-actions">
              <button className="btn-primary" onClick={genAbstract} disabled={!absPoints.trim() || absRunning} data-testid="abs-btn">{absRunning ? "生成中…" : "生成摘要"}</button>
              <button className="btn-secondary" onClick={genKeywords} disabled={kwRunning} data-testid="kw-btn">{kwRunning ? "推荐中…" : "推荐关键词 / MeSH"}</button>
              <HelpButton helpKey="keywords" />
            </div>
          </div>
          {absErr && <div className="result-error" data-testid="abs-error">{absErr}</div>}
          <CanvasSlot>
            {(abstract || absRunning) && (
              <div className="result-panel">
                <div className="result-toolbar">
                  <span className="result-status" data-testid="abs-count">
                    字数 {absCount} / {absMax}
                    {absOver ? <span className="abs-over"> · 超出 {absCount - (parseInt(absMax) || 250)},建议精简</span> : abstract ? " · 符合" : ""}
                  </span>
                  {absRunning && <button className="btn-ghost" data-testid="abs-stop-btn" onClick={() => { absCtrl.current?.abort(); setAbsRunning(false); }}>停止</button>}
                  {abstract && !absRunning && (
                    <button className="btn-ghost" data-testid="abs-copy-btn" title="复制摘要到剪贴板" onClick={() => copyToClipboard("abstract", abstract)}>
                      {copiedKey === "abstract" ? "已复制 ✓" : "复制"}
                    </button>
                  )}
                  {abstract && !absRunning && <button className="btn-ghost" data-testid="abs-export-btn" onClick={() => downloadText(tsName("摘要", "md"), abstract)}>导出 Markdown</button>}
                </div>
                <EditableMarkdown value={abstract} onSave={setAbstract} running={absRunning} placeholder="正在生成…" testId="abs-text" />
              </div>
            )}
          </CanvasSlot>

          {kwErr && <div className="result-error" data-testid="kw-error">{kwErr}</div>}
          <CanvasSlot>
            {(keywords || kwRunning) && (
              <div className="result-panel" data-testid="kw-panel">
                <div className="result-toolbar">
                  <span className="result-status">{kwRunning ? "推荐中…" : "关键词 / MeSH"}</span>
                  {kwRunning && <button className="btn-ghost" data-testid="kw-stop-btn" onClick={() => { kwCtrl.current?.abort(); setKwRunning(false); }}>停止</button>}
                  {keywords && !kwRunning && (
                    <button className="btn-ghost" data-testid="kw-copy-btn" title="复制关键词到剪贴板" onClick={() => copyToClipboard("keywords", keywords)}>
                      {copiedKey === "keywords" ? "已复制 ✓" : "复制"}
                    </button>
                  )}
                </div>
                <EditableMarkdown value={keywords} onSave={setKeywords} running={kwRunning} placeholder="正在推荐…" testId="kw-text" />
              </div>
            )}
          </CanvasSlot>

          <h2 className="section-title">📦 一键投稿包(ZIP)<HelpButton helpKey="bundle" /></h2>
          <p className="section-hint">把各模块已产出的材料汇总打包成一个 ZIP,初稿与摘要会转为 Word。</p>
          <div className="form-actions">
            <button className="btn-primary" onClick={buildBundle} disabled={bundleBusy} data-testid="bundle-btn">{bundleBusy ? "打包中…" : "打包投稿包 ZIP"}</button>
            {bundleMsg && <span className="field-hint" data-testid="bundle-msg">{bundleMsg}</span>}
          </div>

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => setStep(1)} data-testid="imrad-back-btn">← 返回准备</button>
            <button className="btn-ghost" onClick={reset} disabled={running} data-testid="imrad-reset-btn">重新开始</button>
          </div>

          <DeidentifyDialog open={deidOpen} scanResult={deidScan} originalFile={deidFile} onAccept={handleDeidAccept} onCancel={handleDeidCancel} />
        </div>
      )}
    </div>
  );
}
