import { useEffect, useRef, useState } from "react";
import { streamAnalyze, streamAnalyzeRefine, ChartItem, PlanCard, AnalyzeMode, TransparencyKind } from "../../lib/sse";
import { reportLLMError } from "../../lib/errorToast";
import { usePersistentState } from "../../lib/usePersistentState";
import { addHistory } from "../../lib/history";
import DeidentifyDialog, { DeidScanResult } from "../../components/DeidentifyDialog";
import { apiUrl } from "../../lib/api";
import type { Goto } from "../../App";
import {
  MAX_UPLOAD_BYTES,
  CHART_FORMATS,
  PALETTES,
  ChartType,
  ForestRow,
  emptyForestRow,
  ForestResult,
  KMResult,
  ROCResult,
} from "./types";
import UploadArea from "./UploadArea";
import ForestEditor from "./ForestEditor";
import ColMapper from "./ColMapper";
import { ForestResultPanel, KMResultPanel, ROCResultPanel } from "./ResultPanels";
import GeneralResults from "./GeneralResults";
import WarningPanel from "../../components/WarningPanel";

// ─── 数据分析子面板 ─────────────────────────────────────────────
export default function DataPane({ goto }: { goto: Goto }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileErr, setFileErr] = useState("");
  const [question, setQuestion] = usePersistentState("analyze:question", "");
  const [chartFormat, setChartFormat] = usePersistentState("analyze:chartFormat", "png");
  const [palette, setPalette] = usePersistentState("analyze:palette", "default");
  const [chartType, setChartType] = usePersistentState<ChartType>("analyze:chartType", "general");
  const [deidEnabled, setDeidEnabled] = usePersistentState("analyze:deidEnabled", true);

  // 脱敏对话框状态
  const [scanResult, setScanResult] = useState<DeidScanResult | null>(null);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [deidOpen, setDeidOpen] = useState(false);

  // 两阶段: 1 数据与方案(上传+设置) → 2 分析结果。点「开始方案」进入第二阶段。
  const [step, setStep] = usePersistentState<number>("analyze:step", 1);
  const goStage2 = () => setStep(2);
  const [status, setStatus] = useState("");
  const [plan, setPlan] = usePersistentState<PlanCard[]>("analyze:plan", []);
  const [code, setCode] = usePersistentState("analyze:code", "");
  const [charts, setCharts] = usePersistentState<ChartItem[]>("analyze:charts", []);
  const [output, setOutput] = usePersistentState("analyze:output", "");
  const [conclusion, setConclusion] = usePersistentState("analyze:conclusion", "");
  const [mode, setMode] = usePersistentState<AnalyzeMode>("analyze:mode", "analyze");
  const [transparency, setTransparency] = usePersistentState<{ method: string; assumption: string; quality: string }>(
    "analyze:transparency",
    { method: "", assumption: "", quality: "" },
  );
  const [captions, setCaptions] = usePersistentState<string[]>("analyze:captions", []);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 后端流式 warning 事件(如 wave2 check_p_value_consistency 的统计不一致提醒、
  // dataanalysis 中间检查等)。即时追加, 与 error 面板并存, 显示在结论下方。
  const [warnings, setWarnings] = useState<string[]>([]);
  const [refineInput, setRefineInput] = useState(""); // 「继续对话」的新需求输入(临时, 不持久化)
  const ctrl = useRef<AbortController | null>(null);

  // ─── 森林图 / KM / ROC 各自状态 ────────────────────────────
  const [forestRows, setForestRows] = usePersistentState<ForestRow[]>("analyze:forestRows", [
    emptyForestRow(),
    emptyForestRow(),
    emptyForestRow(),
  ]);
  const [forestEffect, setForestEffect] = usePersistentState<"OR" | "RR">("analyze:forestEffect", "OR");
  const [forestResult, setForestResult] = useState<ForestResult | null>(null);
  const [forestBusy, setForestBusy] = useState(false);
  const [forestErr, setForestErr] = useState<string | null>(null);

  // CSV 表头(用于 KM/ROC 的列映射)
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [kmTimeCol, setKmTimeCol] = usePersistentState("analyze:kmTimeCol", "");
  const [kmEventCol, setKmEventCol] = usePersistentState("analyze:kmEventCol", "");
  const [kmGroupCol, setKmGroupCol] = usePersistentState("analyze:kmGroupCol", "");
  const [kmResult, setKmResult] = useState<KMResult | null>(null);
  const [kmBusy, setKmBusy] = useState(false);
  const [kmErr, setKmErr] = useState<string | null>(null);

  const [rocYTrueCol, setRocYTrueCol] = usePersistentState("analyze:rocYTrueCol", "");
  const [rocYScoreCol, setRocYScoreCol] = usePersistentState("analyze:rocYScoreCol", "");
  const [rocResult, setRocResult] = useState<ROCResult | null>(null);
  const [rocBusy, setRocBusy] = useState(false);
  const [rocErr, setRocErr] = useState<string | null>(null);

  const savedRef = useRef("");
  const abortedRef = useRef(false); // 手动「停止」时置真, 避免把半截结论当「已完成」写入历史
  useEffect(() => {
    if (!running && !error && !abortedRef.current && conclusion && savedRef.current !== conclusion) {
      savedRef.current = conclusion;
      addHistory({
        module: "analyze",
        icon: "📊",
        title: question.slice(0, 40) || "数据分析",
        data: {
          "analyze:question": question,
          "analyze:conclusion": conclusion,
          "analyze:code": code,
          "analyze:charts": charts,
          "analyze:output": output,
          "analyze:captions": captions,
          // 恢复时直接停在结果页(step=2), 而不是空的上传页
          "analyze:step": step,
        },
      });
    }
  }, [running, error, conclusion, question, step]);

  // 解析 CSV 表头(只读第一行, 同时处理 BOM)。
  const readCsvHeaders = async (f: File) => {
    try {
      const text = await f.slice(0, 64 * 1024).text();
      const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "";
      // 简单 CSV 解析(支持引号包围)
      const headers: string[] = [];
      let cur = "";
      let inQuote = false;
      for (let i = 0; i < firstLine.length; i++) {
        const ch = firstLine[i];
        if (inQuote) {
          if (ch === '"' && firstLine[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') inQuote = false;
          else cur += ch;
        } else {
          if (ch === ',') { headers.push(cur.trim()); cur = ""; }
          else if (ch === '"') inQuote = true;
          else cur += ch;
        }
      }
      headers.push(cur.trim());
      setCsvHeaders(headers.filter((h) => h.length > 0));
    } catch {
      setCsvHeaders([]);
    }
  };

  // 后台扫描 PHI。失败/无命中则静默, 不打扰用户。
  const scanForPhi = async (f: File) => {
    try {
      const fd = new FormData();
      fd.append("file", f);
      const resp = await fetch(apiUrl("/api/deidentify/scan"), { method: "POST", body: fd });
      if (!resp.ok) return;
      const data: DeidScanResult = await resp.json();
      if (data && Array.isArray(data.columns) && data.columns.length > 0) {
        setScanResult(data);
        setScanFile(f);
        setDeidOpen(true);
      }
    } catch {
      /* 扫描失败静默忽略 */
    }
  };

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setFileErr(`文件过大（${(f.size / 1024 / 1024).toFixed(1)}MB），请上传小于 30MB 的文件。`);
      return;
    }
    setFileErr("");
    setFile(f);
    clearResults(); // 换文件: 丢弃与旧文件绑定的结果, 避免结论与当前文件对不上
    // 顺便解析表头, 供 KM/ROC 用
    if (/\.csv$/i.test(f.name)) readCsvHeaders(f);
    else setCsvHeaders([]);
    // 如果开启脱敏检测, 后台扫描
    if (deidEnabled) scanForPhi(f);
  };

  const onDeidAccept = (redactedFile: File, _mapping: Record<string, string>) => {
    setFile(redactedFile);
    setDeidOpen(false);
    if (/\.csv$/i.test(redactedFile.name)) readCsvHeaders(redactedFile);
  };
  const onDeidCancel = () => setDeidOpen(false);

  const run = async () => {
    if (!file || running) return;
    abortedRef.current = false;
    goStage2();
    setStatus("");
    setPlan([]);
    setCode("");
    setCharts([]);
    setCaptions([]);
    setOutput("");
    setConclusion("");
    setError(null);
    setWarnings([]);
    setRunning(true);
    ctrl.current = new AbortController();
    await streamAnalyze(file, question, chartFormat, palette, mode, {
      signal: ctrl.current.signal,
      onStatus: setStatus,
      onPlan: setPlan,
      onCode: setCode,
      onCharts: setCharts,
      onOutput: setOutput,
      onTransparency: (kind: TransparencyKind, text: string) => setTransparency((p) => ({ ...p, [kind]: text })),
      onDelta: (t) => setConclusion((p) => p + t),
      onWarning: (m) => setWarnings((prev) => [...prev, m]),
      onError: (m) => {
        setError(m);
        setStatus("");
        setRunning(false);
        reportLLMError(m);
      },
      onDone: () => {
        setStatus("");
        setRunning(false);
        window.dispatchEvent(new Event("usage-updated"));
      },
    });
    setRunning(false);
  };

  // 对话式续跑: 在已有分析代码上按新需求改一版并重跑。只回传 当前代码 + 上轮结论 + 新需求,
  // 数据仍带本次文件——因此不缓存完整对话历史, 每轮 token 固定、不随轮数增长。
  const runRefine = async () => {
    if (!file || running) return;
    const req = refineInput.trim();
    if (!req || !code) return;
    const baseCode = code; // 先抓取当前代码/结论, 再清结果区(避免被清空)
    const baseSummary = conclusion;
    abortedRef.current = false;
    setStatus("");
    setPlan([]);
    setCharts([]);
    setCaptions([]);
    setOutput("");
    setConclusion("");
    setError(null);
    setWarnings([]);
    setRunning(true);
    ctrl.current = new AbortController();
    await streamAnalyzeRefine(file, baseCode, req, baseSummary, question, chartFormat, palette, mode, {
      signal: ctrl.current.signal,
      onStatus: setStatus,
      onPlan: setPlan,
      onCode: setCode,
      onCharts: setCharts,
      onOutput: setOutput,
      onTransparency: (kind: TransparencyKind, text: string) => setTransparency((p) => ({ ...p, [kind]: text })),
      onDelta: (t) => setConclusion((p) => p + t),
      onWarning: (m) => setWarnings((prev) => [...prev, m]),
      onError: (m) => {
        setError(m);
        setStatus("");
        setRunning(false);
        reportLLMError(m);
      },
      onDone: () => {
        setStatus("");
        setRunning(false);
        setRefineInput("");
        window.dispatchEvent(new Event("usage-updated"));
      },
    });
    setRunning(false);
  };

  const stop = () => {
    ctrl.current?.abort();
    abortedRef.current = true; // 标记为手动中止, 半截结论不入历史
    setRunning(false);
    setStatus(""); // 同时清掉状态行, 否则 spinner 会一直转
  };

  // 清掉与「某份数据文件」绑定的全部结果(不含 question 等用户输入)。
  // 换文件时调用, 避免出现「屏幕结论来自旧文件、顶部却是新文件」的错乱。
  const clearResults = () => {
    setPlan([]);
    setCode("");
    setCharts([]);
    setCaptions([]);
    setOutput("");
    setConclusion("");
    setError(null);
    setStatus("");
    setForestResult(null);
    setKmResult(null);
    setRocResult(null);
    setForestErr(null);
    setKmErr(null);
    setRocErr(null);
    setWarnings([]);
    savedRef.current = ""; // 允许新一轮结果重新入历史
  };

  const reset = () => {
    if (running) stop();
    setFile(null);
    setFileErr("");
    setQuestion("");
    clearResults();
    setStep(1);
  };

  // ─── 森林图: 调 /api/analyze/forest ───────────────────────────
  const runForest = async () => {
    if (forestBusy) return;
    const studies = forestRows
      .filter((r) => r.study.trim())
      .map((r) => ({
        study: r.study.trim(),
        n_treat: Number(r.n_treat) || 0,
        event_treat: Number(r.event_treat) || 0,
        n_ctrl: Number(r.n_ctrl) || 0,
        event_ctrl: Number(r.event_ctrl) || 0,
      }));
    if (studies.length < 2) {
      setForestErr("至少需要 2 项研究才能合并");
      return;
    }
    setForestBusy(true);
    setForestErr(null);
    setForestResult(null);
    try {
      const resp = await fetch(apiUrl("/api/analyze/forest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studies, effect: forestEffect, format: chartFormat }),
      });
      if (!resp.ok) throw new Error(`服务返回错误 ${resp.status}`);
      const data: ForestResult = await resp.json();
      setForestResult(data);
      goStage2();
    } catch (e) {
      setForestErr(`生成失败: ${(e as Error).message}`);
    } finally {
      setForestBusy(false);
      window.dispatchEvent(new Event("usage-updated"));
    }
  };

  // ─── KM: 调 /api/analyze/km ────────────────────────────────────
  const runKm = async () => {
    if (!file || kmBusy) return;
    if (!kmTimeCol || !kmEventCol) {
      setKmErr("请先选择时间列与事件列");
      return;
    }
    setKmBusy(true);
    setKmErr(null);
    setKmResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("time_col", kmTimeCol);
      fd.append("event_col", kmEventCol);
      if (kmGroupCol) fd.append("group_col", kmGroupCol);
      const resp = await fetch(apiUrl("/api/analyze/km"), { method: "POST", body: fd });
      if (!resp.ok) throw new Error(`服务返回错误 ${resp.status}`);
      const data: KMResult = await resp.json();
      setKmResult(data);
      goStage2();
    } catch (e) {
      setKmErr(`生成失败: ${(e as Error).message}`);
    } finally {
      setKmBusy(false);
      window.dispatchEvent(new Event("usage-updated"));
    }
  };

  // ─── ROC: 调 /api/analyze/roc ──────────────────────────────────
  const runRoc = async () => {
    if (!file || rocBusy) return;
    if (!rocYTrueCol || !rocYScoreCol) {
      setRocErr("请先选择真实标签列与预测分数列");
      return;
    }
    setRocBusy(true);
    setRocErr(null);
    setRocResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("y_true_col", rocYTrueCol);
      fd.append("y_score_col", rocYScoreCol);
      const resp = await fetch(apiUrl("/api/analyze/roc"), { method: "POST", body: fd });
      if (!resp.ok) throw new Error(`服务返回错误 ${resp.status}`);
      const data: ROCResult = await resp.json();
      setRocResult(data);
      goStage2();
    } catch (e) {
      setRocErr(`生成失败: ${(e as Error).message}`);
    } finally {
      setRocBusy(false);
      window.dispatchEvent(new Event("usage-updated"));
    }
  };

  // 森林图行编辑
  const setForestField = (i: number, k: keyof ForestRow, v: string) => {
    setForestRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  };
  const addForestRow = () => setForestRows((prev) => [...prev, emptyForestRow()]);
  const removeForestRow = (i: number) =>
    setForestRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const canStage2 = !!(conclusion || charts.length > 0 || output || forestResult || kmResult || rocResult || running);

  return (
    <>
      {/* 两阶段步骤条 */}
      <div className="wiz-steps" data-testid="analyze-steps">
        {[{ n: 1, title: "数据与方案", desc: "上传数据 · 说明目的" }, { n: 2, title: "分析结果", desc: "结论 · 图表 · 代码" }].map((s) => {
          const state = step === s.n ? "current" : s.n < step ? "done" : "todo";
          const clickable = s.n === 1 || canStage2;
          return (
            <button key={s.n} type="button" className={`wiz-step ${state}`} data-testid={`analyze-step-${s.n}`} disabled={!clickable} onClick={() => clickable && setStep(s.n)}>
              <span className="wiz-step-num">{s.n < step ? "✓" : s.n}</span>
              <span className="wiz-step-text"><span className="wiz-step-title">{s.title}</span><span className="wiz-step-desc">{s.desc}</span></span>
            </button>
          );
        })}
      </div>

      {/* ── 第 1 阶段：数据与方案 ── */}
      <div style={{ display: step === 1 ? "block" : "none" }} data-testid="analyze-stage-1">
      {/* 文件上传区(所有图表类型共用) */}
      <div className="form">
        <div className="mode-radio" data-testid="mode-radio" style={{ display: "flex", gap: 16, marginBottom: 12, alignItems: "center" }}>
          <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="radio"
              name="analyze-mode"
              data-testid="mode-analyze"
              checked={mode === "analyze"}
              disabled={running}
              onChange={() => {
                if (running) return;
                setMode("analyze");
                setConclusion("");
                setOutput("");
                setTransparency({ method: "", assumption: "", quality: "" });
                setCharts([]);
                setPlan([]);
                setCode("");
                setCaptions([]);
              }}
            />
            <span>📊 数据分析</span>
            <span style={{ color: "#888", fontSize: 12, marginLeft: 4 }}>跑统计+透明化+结论</span>
          </label>
          <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="radio"
              name="analyze-mode"
              data-testid="mode-draw"
              checked={mode === "draw"}
              disabled={running}
              onChange={() => {
                if (running) return;
                setMode("draw");
                setConclusion("");
                setOutput("");
                setTransparency({ method: "", assumption: "", quality: "" });
                setCharts([]);
                setPlan([]);
                setCode("");
                setCaptions([]);
              }}
            />
            <span>🎨 只画图</span>
            <span style={{ color: "#888", fontSize: 12, marginLeft: 4 }}>只画图,不做统计不写结论</span>
          </label>
        </div>
        <UploadArea
          file={file}
          fileErr={fileErr}
          question={question}
          chartType={chartType}
          deidEnabled={deidEnabled}
          onPickFile={pickFile}
          onRemoveFile={() => setFile(null)}
          onQuestionChange={setQuestion}
          onChartTypeChange={setChartType}
          onDeidEnabledChange={setDeidEnabled}
        />

        {/* 通用模式的图表选项 + 主按钮 */}
        {chartType === "general" && (
          <>
            <div className="chart-opts">
              <label className="field-inline">
                图表导出格式
                <select data-testid="chart-format" value={chartFormat} onChange={(e) => setChartFormat(e.target.value)}>
                  {CHART_FORMATS.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </label>
              <label className="field-inline">
                配色风格
                <select data-testid="chart-palette" value={palette} onChange={(e) => setPalette(e.target.value)}>
                  {PALETTES.map((p) => (
                    <option key={p.key} value={p.key}>{p.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="form-actions">
              <button className="btn-primary" onClick={run} disabled={!file || running} data-testid="run-btn">
                {running ? "分析中…" : "开始方案 →"}
              </button>
              {running && (
                <button className="btn-ghost" onClick={stop} data-testid="stop-btn">停止</button>
              )}
              <button className="btn-ghost" onClick={reset} data-testid="reset-btn">清空</button>
            </div>
            {!file && (conclusion || charts.length > 0 || output) && (
              <p className="field-hint" data-testid="analyze-stale-hint" style={{ marginTop: 6 }}>
                下方结果是上次分析的本地存档；原数据文件已不在，<strong>如需重新分析请重新上传文件</strong>。
              </p>
            )}
          </>
        )}

        {/* 森林图编辑器 */}
        {chartType === "forest" && (
          <ForestEditor
            rows={forestRows}
            effect={forestEffect}
            busy={forestBusy}
            onChange={setForestField}
            onAdd={addForestRow}
            onRemove={removeForestRow}
            onEffect={setForestEffect}
            onRun={runForest}
          />
        )}

        {/* KM 列映射 */}
        {chartType === "km" && (
          <ColMapper
            title="KM 曲线 — 列映射"
            file={file}
            headers={csvHeaders}
            fields={[
              { label: "时间列(必填)", value: kmTimeCol, onChange: setKmTimeCol, required: true, testId: "km-time-col" },
              { label: "事件列(必填, 0/1)", value: kmEventCol, onChange: setKmEventCol, required: true, testId: "km-event-col" },
              { label: "分组列(可选)", value: kmGroupCol, onChange: setKmGroupCol, allowEmpty: true, testId: "km-group-col" },
            ]}
            busy={kmBusy}
            onRun={runKm}
            runTestId="km-run-btn"
            runLabel="生成 KM 曲线"
          />
        )}

        {/* ROC 列映射 */}
        {chartType === "roc" && (
          <ColMapper
            title="ROC 曲线 — 列映射"
            file={file}
            headers={csvHeaders}
            fields={[
              { label: "真实标签列(0/1)", value: rocYTrueCol, onChange: setRocYTrueCol, required: true, testId: "roc-ytrue-col" },
              { label: "预测分数列", value: rocYScoreCol, onChange: setRocYScoreCol, required: true, testId: "roc-yscore-col" },
            ]}
            busy={rocBusy}
            onRun={runRoc}
            runTestId="roc-run-btn"
            runLabel="生成 ROC 曲线"
          />
        )}
      </div>
      {/* 校验/生成错误留在第一阶段 */}
      {chartType === "forest" && forestErr && <div className="result-error" data-testid="forest-error">{forestErr}</div>}
      {chartType === "km" && kmErr && <div className="result-error" data-testid="km-error">{kmErr}</div>}
      {chartType === "roc" && rocErr && <div className="result-error" data-testid="roc-error">{rocErr}</div>}
      </div>

      {/* ── 第 2 阶段：分析结果 ── */}
      <div style={{ display: step === 2 ? "block" : "none" }} data-testid="analyze-stage-2">
        <div className="wiz-nav" style={{ marginBottom: 12, borderTop: "none", paddingTop: 0 }}>
          <button className="btn-ghost" onClick={() => setStep(1)} data-testid="analyze-back-btn">← 返回数据与方案</button>
        </div>

        {chartType === "forest" && forestResult && <ForestResultPanel result={forestResult} effect={forestEffect} />}
        {chartType === "km" && kmResult && <KMResultPanel result={kmResult} />}
        {chartType === "roc" && rocResult && <ROCResultPanel result={rocResult} />}

        {/* ─── 通用模式: 结论左/图片右, 方案&代码&输出弹出式 ─── */}
        <GeneralResults
          chartType={chartType}
          goto={goto}
          status={status}
          error={error}
          plan={plan}
          code={code}
          charts={charts}
          captions={captions}
          setCaptions={setCaptions}
          output={output}
          conclusion={conclusion}
          setConclusion={setConclusion}
          running={running}
          question={question}
          mode={mode}
          transparency={transparency}
        />

        {/* 后端流式 warning 事件(如统计一致性检查): 显示在结论下方, 与 error 面板并存。 */}
        <WarningPanel
          warnings={warnings}
          onClear={() => setWarnings([])}
          testId="analyze-warnings"
        />

      {/* 继续对话: 首轮分析出结果后, 可反复提新需求让 AI 在现有代码上改 */}
      {chartType === "general" && code && (
        <div className="refine-bar" data-testid="refine-bar" style={{ marginTop: 14 }}>
          <label className="field" style={{ display: "block" }}>
            继续对话 · 让 AI 按新需求修改上面的分析
            <textarea
              data-testid="refine-input"
              value={refineInput}
              onChange={(e) => setRefineInput(e.target.value)}
              placeholder={mode === "draw" ? "换成箱线图 / 加标题 / 换配色…" : "换图型 / 加显著性 / 换分析…"}
              rows={2}
              disabled={running || !file}
            />
          </label>
          <div className="form-actions">
            <button
              className="btn-primary"
              onClick={runRefine}
              disabled={!file || running || !refineInput.trim()}
              data-testid="refine-btn"
            >
              {running ? "修改中…" : "按新需求修改"}
            </button>
            {running && (
              <button className="btn-ghost" onClick={stop} data-testid="refine-stop-btn">停止</button>
            )}
          </div>
          {!file && (
            <p className="field-hint" data-testid="refine-need-file">
              续跑需要原始数据；当前文件已不在，请重新上传<strong>同一份数据</strong>后再修改。
            </p>
          )}
        </div>
      )}
      </div>

      {/* 脱敏对话框 */}
      <DeidentifyDialog
        open={deidOpen}
        scanResult={scanResult}
        originalFile={scanFile}
        onAccept={onDeidAccept}
        onCancel={onDeidCancel}
      />
    </>
  );
}
