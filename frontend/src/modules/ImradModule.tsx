import { useRef, useState } from "react";
import { streamImrad, runModule } from "../lib/sse";
import { usePersistentState, readPersisted } from "../lib/usePersistentState";
import { apiUrl } from "../lib/api";
import Markdown from "../components/Markdown";
import { downloadText, tsName } from "../lib/download";

export default function ImradModule() {
  const [topic, setTopic] = usePersistentState("imrad:topic", "");
  const [background, setBackground] = usePersistentState("imrad:background", "");
  const [methods, setMethods] = usePersistentState("imrad:methods", "");
  const [results, setResults] = usePersistentState("imrad:results", "");
  const [discussion, setDiscussion] = usePersistentState("imrad:discussion", "");
  const [refs, setRefs] = usePersistentState("imrad:refs", "");

  const [draft, setDraft] = usePersistentState("imrad:draft", "");
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docxBusy, setDocxBusy] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  // 投稿包打包
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

    if (!files.length && !docx.length) {
      setBundleMsg("暂无可打包的材料，请先在各模块生成结果。");
      return;
    }
    setBundleBusy(true);
    setBundleMsg(null);
    try {
      const resp = await fetch(apiUrl("/api/bundle"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files, docx }),
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "research-package.zip";
      a.click();
      URL.revokeObjectURL(url);
      setBundleMsg(`已打包 ${files.length + docx.length} 份材料为 ZIP。`);
    } catch (e) {
      setBundleMsg(`打包失败：${(e as Error).message}`);
    } finally {
      setBundleBusy(false);
    }
  };

  // 结构式摘要
  const [absPoints, setAbsPoints] = usePersistentState("imrad:absPoints", "");
  const [absMax, setAbsMax] = usePersistentState("imrad:absMax", "250");
  const [absStructured, setAbsStructured] = usePersistentState("imrad:absStructured", true);
  const [abstract, setAbstract] = usePersistentState("imrad:abstract", "");
  const [absRunning, setAbsRunning] = useState(false);
  const [absErr, setAbsErr] = useState<string | null>(null);
  const absCtrl = useRef<AbortController | null>(null);

  const importFromModules = () => {
    const idea = readPersisted("idea:result", "");
    const plan = readPersisted("plan:result", "");
    const sap = readPersisted("plan:sap", "");
    const concl = readPersisted("analyze:conclusion", "");
    if (idea) setBackground((p) => p || idea);
    if (plan || sap) setMethods((p) => p || [plan, sap].filter(Boolean).join("\n\n"));
    if (concl) setResults((p) => p || concl);
  };

  const submit = async () => {
    if (running) return;
    if (![background, methods, results, discussion].some((x) => x.trim())) {
      setError("请至少填写一部分材料（引言/方法/结果/讨论），或点“从各模块导入”。");
      return;
    }
    setStatus("");
    setDraft("");
    setError(null);
    setRunning(true);
    ctrl.current = new AbortController();
    await streamImrad(
      { topic, background, methods, results, discussion, references: refs },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onDelta: (t) => setDraft((p) => p + t),
        onError: (m) => {
          setError(m);
          setStatus("");
          setRunning(false);
        },
        onDone: () => {
          setStatus("");
          setRunning(false);
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setRunning(false);
  };

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
  };

  const reset = () => {
    if (running) stop();
    setTopic("");
    setBackground("");
    setMethods("");
    setResults("");
    setDiscussion("");
    setRefs("");
    setDraft("");
    setError(null);
    setStatus("");
  };

  const downloadDocx = async () => {
    if (!draft || docxBusy) return;
    setDocxBusy(true);
    try {
      const resp = await fetch(apiUrl("/api/docx"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft, journal_id: "", references: [] }),
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "manuscript-draft.docx";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDocxBusy(false);
    }
  };

  const genAbstract = async () => {
    if (!absPoints.trim() || absRunning) return;
    setAbsErr(null);
    setAbstract("");
    setAbsRunning(true);
    absCtrl.current = new AbortController();
    await runModule(
      "abstract",
      { points: absPoints, max_words: absMax, structured: absStructured ? "true" : "false" },
      {
        signal: absCtrl.current.signal,
        onDelta: (t) => setAbstract((p) => p + t),
        onError: (m) => {
          setAbsErr(m);
          setAbsRunning(false);
        },
        onDone: () => {
          setAbsRunning(false);
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setAbsRunning(false);
  };

  // 中英文混排字数：中文按字符、英文按词的近似统计
  const wordCount = (s: string) => {
    const cn = (s.match(/[一-鿿]/g) || []).length;
    const en = (s.replace(/[一-鿿]/g, " ").match(/[A-Za-z0-9]+/g) || []).length;
    return cn + en;
  };
  const absCount = wordCount(abstract);
  const absOver = abstract && absCount > (parseInt(absMax) || 250);

  return (
    <div className="module">
      <header className="module-head">
        <h1>📝 论文初稿（IMRaD 装配 + 摘要）</h1>
        <p>
          把你已产出的<strong>真实材料</strong>（综述/方法/结果/讨论）拼成连贯的 Introduction/Methods/Results/Discussion 初稿。
          铁律：<strong>只据你的材料、不编造数字与文献</strong>，缺失处标 [待补充]，导出 Word。
        </p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">论文主题 / 题目（可选）</span>
          <input data-testid="imrad-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="例如：二甲双胍对2型糖尿病合并NAFLD肝纤维化的疗效" />
        </label>
        <div className="form-actions">
          <button className="btn-secondary" onClick={importFromModules} data-testid="imrad-import-btn">
            ↩ 从各模块导入已有成果
          </button>
          <span className="field-hint">自动填入：找选题综述→引言、实验规划/SAP→方法、数据分析结论→结果</span>
        </div>
        <label className="field">
          <span className="field-label">引言素材（背景/综述/研究空白/目的）</span>
          <textarea data-testid="imrad-background" value={background} onChange={(e) => setBackground(e.target.value)} rows={4} placeholder="粘贴综述要点与研究空白" />
        </label>
        <label className="field">
          <span className="field-label">方法素材（设计/对象/变量/样本量/统计计划）</span>
          <textarea data-testid="imrad-methods" value={methods} onChange={(e) => setMethods(e.target.value)} rows={4} placeholder="粘贴实验方案 / SAP" />
        </label>
        <label className="field">
          <span className="field-label">结果素材（真实统计结果/数字，来自数据分析）</span>
          <textarea data-testid="imrad-results" value={results} onChange={(e) => setResults(e.target.value)} rows={4} placeholder="粘贴数据分析结论（数字会被原样使用，不会编造）" />
        </label>
        <label className="field">
          <span className="field-label">讨论要点（意义/局限/展望，可选）</span>
          <textarea data-testid="imrad-discussion" value={discussion} onChange={(e) => setDiscussion(e.target.value)} rows={3} placeholder="可留空，AI 会基于结果给出讨论框架并标注待补充" />
        </label>
        <label className="field">
          <span className="field-label">可引用的参考文献（可选）</span>
          <textarea data-testid="imrad-refs" value={refs} onChange={(e) => setRefs(e.target.value)} rows={3} placeholder="文中将用 [作者, 年] 标注，只引用此处确有的文献" />
        </label>
        <div className="form-actions">
          <button className="btn-primary" onClick={submit} disabled={running} data-testid="run-btn">
            {running ? "装配中…" : "装配 IMRaD 初稿"}
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">清空</button>
        </div>
      </div>

      {status && (
        <div className="status-line" data-testid="status-line">
          <span className="spinner" /> {status}
        </div>
      )}
      {error && <div className="result-error" data-testid="imrad-error">{error}</div>}

      {(draft || (running && !error)) && (
        <div className="result-panel">
          <div className="result-toolbar">
            <span className="result-status">{running ? "生成中…" : "已完成"}</span>
            <div className="result-actions">
              {running && <button className="btn-ghost" onClick={stop} data-testid="stop-btn">停止</button>}
              {draft && !running && (
                <button className="btn-ghost" data-testid="export-md-btn" onClick={() => downloadText(tsName("论文初稿", "md"), draft)}>导出 Markdown</button>
              )}
              {draft && !running && (
                <button className="btn-ghost" data-testid="export-docx-btn" onClick={downloadDocx} disabled={docxBusy}>
                  {docxBusy ? "导出中…" : "导出 Word"}
                </button>
              )}
            </div>
          </div>
          <div className="result-text" data-testid="result-text">
            {draft ? <Markdown>{draft}</Markdown> : <span className="result-placeholder">正在撰写…</span>}
            {running && <span className="cursor-blink">▍</span>}
          </div>
        </div>
      )}

      <h2 className="section-title">🧾 结构式摘要 + 字数核对</h2>
      <p className="section-hint">输入要点与目标字数，生成 Background/Methods/Results/Conclusions 摘要并实时显示字数（超限会提示）。</p>
      <div className="form">
        <label className="field">
          <span className="field-label">摘要要点 / 材料</span>
          <textarea data-testid="abs-points" value={absPoints} onChange={(e) => setAbsPoints(e.target.value)} rows={4} placeholder="粘贴研究目的、方法、主要结果（数字）、结论要点" />
        </label>
        <div className="chart-opts">
          <label className="field-inline">
            目标字数上限
            <input data-testid="abs-max" value={absMax} onChange={(e) => setAbsMax(e.target.value)} style={{ width: 80 }} />
          </label>
          <label className="field-inline">
            <input type="checkbox" data-testid="abs-structured" checked={absStructured} onChange={(e) => setAbsStructured(e.target.checked)} />
            结构式（四段带小标题）
          </label>
        </div>
        <button className="btn-primary" onClick={genAbstract} disabled={!absPoints.trim() || absRunning} data-testid="abs-btn">
          {absRunning ? "生成中…" : "生成摘要"}
        </button>
      </div>
      {absErr && <div className="result-error" data-testid="abs-error">{absErr}</div>}
      {(abstract || absRunning) && (
        <div className="result-panel">
          <div className="result-toolbar">
            <span className="result-status" data-testid="abs-count">
              字数 {absCount} / {absMax}
              {absOver ? <span className="abs-over"> · 超出 {absCount - (parseInt(absMax) || 250)}，建议精简</span> : abstract ? " · 符合" : ""}
            </span>
            {abstract && !absRunning && (
              <button className="btn-ghost" data-testid="abs-export-btn" onClick={() => downloadText(tsName("摘要", "md"), abstract)}>导出 Markdown</button>
            )}
          </div>
          <div className="result-text" data-testid="abs-text">
            {abstract ? <Markdown>{abstract}</Markdown> : <span className="result-placeholder">正在生成…</span>}
            {absRunning && <span className="cursor-blink">▍</span>}
          </div>
        </div>
      )}

      <h2 className="section-title">📦 一键投稿包（ZIP）</h2>
      <p className="section-hint">
        把各模块已产出的材料（选题/方案/SAP/分析结论/初稿/摘要/投稿信/排版稿/参考文献/规范核对/审稿回复）
        汇总打包成一个 ZIP，初稿与摘要会转为 Word。
      </p>
      <div className="form-actions">
        <button className="btn-primary" onClick={buildBundle} disabled={bundleBusy} data-testid="bundle-btn">
          {bundleBusy ? "打包中…" : "打包投稿包 ZIP"}
        </button>
        {bundleMsg && <span className="field-hint" data-testid="bundle-msg">{bundleMsg}</span>}
      </div>
    </div>
  );
}
