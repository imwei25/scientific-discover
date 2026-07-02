import { useEffect, useMemo, useRef, useState } from "react";
import { streamAnalyze, streamPost, ChartItem, PlanCard } from "../lib/sse";
import { reportLLMError } from "../lib/errorToast";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import EditableMarkdown from "../components/EditableMarkdown";
import { CanvasSlot } from "../components/Canvas";
import { HelpButton } from "../components/HelpButton";
import DeidentifyDialog, { DeidScanResult } from "../components/DeidentifyDialog";
import { downloadText, downloadBase64, chartMime, tsName, downloadAnalysisReport } from "../lib/download";
import { apiUrl } from "../lib/api";
import type { Goto } from "../App";

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const CHART_FORMATS = [
  { key: "png", label: "高清 PNG (300dpi)" },
  { key: "svg", label: "SVG 矢量" },
  { key: "pdf", label: "PDF 矢量" },
];
const PALETTES = [
  { key: "default", label: "默认" },
  { key: "colorblind", label: "色盲友好" },
  { key: "nature", label: "Nature 风格" },
  { key: "lancet", label: "Lancet 风格" },
];

type ChartType = "general" | "forest" | "km" | "roc";
const CHART_TYPES: { key: ChartType; label: string }[] = [
  { key: "general", label: "通用" },
  { key: "forest", label: "森林图" },
  { key: "km", label: "KM 生存曲线" },
  { key: "roc", label: "ROC 曲线" },
];

// 森林图单行
interface ForestRow {
  study: string;
  n_treat: string;
  event_treat: string;
  n_ctrl: string;
  event_ctrl: string;
}
const emptyForestRow = (): ForestRow => ({ study: "", n_treat: "", event_treat: "", n_ctrl: "", event_ctrl: "" });

// 森林图结果
interface ForestSummary {
  pooled: number;
  ci_low: number;
  ci_high: number;
  i2: number;
  q_pvalue: number;
}
interface ForestResult {
  image_base64: string;
  summary: ForestSummary;
}

// KM/ROC 结果
interface KMResult {
  image_base64: string;
  logrank_p: number;
  groups: string[];
}
interface ROCResult {
  image_base64: string;
  auc: number;
  auc_ci: [number, number];
  threshold: number;
}

// 统计顾问结构化输出。
// 注意: 后端 build_stats_advice 的契约是 recommended={test,why}、alternatives=[{test,when}]
// (对象, 不是字符串)。这里按对象渲染; 同时兼容旧的/流式未完整的字符串形态, 避免把对象
// 直接当 React 子节点导致 "Objects are not valid as a React child" 崩溃。
interface AdvisorRecommended {
  test?: string;
  why?: string;
}
interface AdvisorAlternative {
  test?: string;
  when?: string;
}
interface AdvisorPayload {
  recommended?: AdvisorRecommended | string;
  assumptions?: string[];
  cautions?: string[];
  alternatives?: (AdvisorAlternative | string)[];
}

export default function AnalyzeModule({ goto }: { goto: Goto }) {
  // ─── Tab 切换: 数据分析 / 统计顾问 ────────────────────────────
  const [tab, setTab] = usePersistentState<"data" | "advisor">("analyze:advisorTab", "data");

  return (
    <div className="module">
      <header className="module-head">
        <h1>📊 数据分析与写作 · 医学/药学/生物</h1>
        <p>
          上传数据并说明你的研究目的，AI 会读懂数据结构、<strong>编写针对性的分析代码并在本地执行</strong>，
          再基于真实运行结果给出结论（数字都由代码算出，不是凭空生成）。
        </p>
        <div className="analyze-tabs" data-testid="analyze-tabs">
          <button
            className={`analyze-tab ${tab === "data" ? "active" : ""}`}
            onClick={() => setTab("data")}
            data-testid="analyze-tab-data"
          >
            📊 数据分析
          </button>
          <button
            className={`analyze-tab ${tab === "advisor" ? "active" : ""}`}
            onClick={() => setTab("advisor")}
            data-testid="analyze-tab-advisor"
          >
            📚 统计顾问
          </button>
        </div>
      </header>

      {tab === "data" ? <DataPane goto={goto} /> : <AdvisorPane />}

      <style>{`
        .analyze-tabs {
          display: flex; gap: 4px; margin-top: 14px;
          border-bottom: 1px solid var(--line, #e3e8ef);
        }
        .analyze-tab {
          padding: 8px 16px; border: none; background: transparent; cursor: pointer;
          border-bottom: 2px solid transparent;
          font-size: 14px; color: var(--faint, #5b6675);
          transition: color 160ms ease, border-color 160ms ease;
        }
        .analyze-tab:hover { color: var(--ink, #1f2733); }
        .analyze-tab.active {
          color: var(--petrol, #14635c);
          border-bottom-color: var(--petrol, #14635c);
          font-weight: 600;
        }
        .analyze-type-row {
          display: flex; flex-wrap: wrap; gap: 14px; align-items: center;
          padding: 10px 0;
        }
        .analyze-deid-toggle {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 13px; color: var(--faint, #5b6675);
          margin-left: auto;
        }
        .analyze-deid-toggle input { margin: 0; }
        .forest-editor { display: flex; flex-direction: column; gap: 8px; }
        .forest-row {
          display: grid;
          grid-template-columns: 1.4fr 0.8fr 0.8fr 0.8fr 0.8fr 32px;
          gap: 6px; align-items: center;
        }
        .forest-row input {
          padding: 6px 8px; border: 1px solid var(--line, #e3e8ef); border-radius: 6px;
          font-size: 13px; min-width: 0;
        }
        .forest-row .row-x {
          width: 28px; height: 28px; border: none; background: transparent; cursor: pointer;
          color: var(--faint, #5b6675); border-radius: 4px;
        }
        .forest-row .row-x:hover { background: var(--surface, #f3f5f8); color: var(--bad, #c84030); }
        .forest-head {
          font-size: 12px; color: var(--faint, #5b6675);
          font-weight: 600;
        }
        .forest-actions { display: flex; gap: 8px; margin-top: 4px; }
        .col-map-grid {
          display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; align-items: center;
          margin-top: 10px;
        }
        .col-map-grid select { padding: 6px 8px; border: 1px solid var(--line, #e3e8ef); border-radius: 6px; }
        .analyze-chart-result {
          margin-top: 16px; padding: 14px; border: 1px solid var(--line, #e3e8ef); border-radius: 10px;
          background: var(--surface, #f7f9fc);
        }
        .analyze-chart-result img { max-width: 100%; border-radius: 8px; border: 1px solid var(--line, #e3e8ef); background: #fff; }
        .analyze-chart-result .summary-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;
          margin: 12px 0;
        }
        .summary-cell {
          padding: 8px 10px; background: #fff; border: 1px solid var(--line, #e3e8ef); border-radius: 6px;
        }
        .summary-cell .label { font-size: 12px; color: var(--faint, #5b6675); }
        .summary-cell .value { font-size: 15px; font-weight: 600; }
        .advisor-cards {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px;
          margin-top: 14px;
        }
        .advisor-card {
          padding: 14px; border: 1px solid var(--line, #e3e8ef); border-radius: 10px;
          background: var(--surface, #f7f9fc);
        }
        .advisor-card h4 { margin: 0 0 8px; font-size: 14px; }
        .advisor-card ul { margin: 0; padding-left: 18px; font-size: 13.5px; line-height: 1.7; }
        .advisor-card .reco { font-size: 14.5px; font-weight: 600; color: var(--petrol, #14635c); }
        .plan-cards { margin-top: 8px; }
        .plan-title { font-size: 14px; margin: 0 0 10px; color: var(--ink, #1f2733); }
        .plan-card {
          padding: 12px 14px; border: 1px solid var(--line, #e3e8ef); border-radius: 10px;
          background: var(--surface, #f7f9fc); margin-bottom: 10px;
        }
        .plan-goal { font-weight: 600; margin-bottom: 8px; }
        .plan-row { display: grid; grid-template-columns: 44px 1fr; gap: 8px; font-size: 13.5px; margin: 4px 0; }
        .plan-row .plan-k { color: var(--faint, #5b6675); font-size: 12px; padding-top: 1px; }
        .plan-reco { font-weight: 600; color: var(--petrol, #14635c); }
        .plan-note { font-size: 12.5px; color: var(--faint, #5b6675); margin-top: 6px; font-style: italic; }
        .analyze-disclaimer {
          padding: 8px 12px; margin: 6px 0 12px; border-radius: 8px;
          background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; font-size: 12.5px; line-height: 1.6;
        }
      `}</style>
    </div>
  );
}

// ─── 数据分析子面板 ─────────────────────────────────────────────
function DataPane({ goto }: { goto: Goto }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileErr, setFileErr] = useState("");
  const [drag, setDrag] = useState(false);
  const [question, setQuestion] = usePersistentState("analyze:question", "");
  const [chartFormat, setChartFormat] = usePersistentState("analyze:chartFormat", "png");
  const [palette, setPalette] = usePersistentState("analyze:palette", "default");
  const [chartType, setChartType] = usePersistentState<ChartType>("analyze:chartType", "general");
  const [deidEnabled, setDeidEnabled] = usePersistentState("analyze:deidEnabled", true);
  const fileInput = useRef<HTMLInputElement>(null);

  // 脱敏对话框状态
  const [scanResult, setScanResult] = useState<DeidScanResult | null>(null);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [deidOpen, setDeidOpen] = useState(false);

  const [status, setStatus] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "ok" | "err">("idle"); // 复制结论的短暂反馈
  const [plan, setPlan] = usePersistentState<PlanCard[]>("analyze:plan", []);
  const [code, setCode] = usePersistentState("analyze:code", "");
  const [charts, setCharts] = usePersistentState<ChartItem[]>("analyze:charts", []);
  const [output, setOutput] = usePersistentState("analyze:output", "");
  const [conclusion, setConclusion] = usePersistentState("analyze:conclusion", "");
  const [captions, setCaptions] = usePersistentState<string[]>("analyze:captions", []);
  const [capBusy, setCapBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const genCaptions = async () => {
    if (!charts.length || capBusy) return;
    setCapBusy(true);
    try {
      const resp = await fetch(apiUrl("/api/figure-captions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: charts.length, question, code, output, conclusion }),
      });
      const d = resp.ok ? await resp.json() : null;
      if (d?.ok) setCaptions(d.captions || []);
      else reportLLMError(d?.error || `生成图注失败（服务返回 ${resp.status}）`);
    } catch (e) {
      reportLLMError(`生成图注失败：${(e as Error).message}`);
    } finally {
      setCapBusy(false);
      window.dispatchEvent(new Event("usage-updated"));
    }
  };

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
        },
      });
    }
  }, [running, error, conclusion, question]);

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
    setStatus("");
    setPlan([]);
    setCode("");
    setCharts([]);
    setCaptions([]);
    setOutput("");
    setConclusion("");
    setError(null);
    setRunning(true);
    ctrl.current = new AbortController();
    await streamAnalyze(file, question, chartFormat, palette, {
      signal: ctrl.current.signal,
      onStatus: setStatus,
      onPlan: setPlan,
      onCode: setCode,
      onCharts: setCharts,
      onOutput: setOutput,
      onDelta: (t) => setConclusion((p) => p + t),
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
    savedRef.current = ""; // 允许新一轮结果重新入历史
  };

  const reset = () => {
    if (running) stop();
    setFile(null);
    setFileErr("");
    setQuestion("");
    clearResults();
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

  return (
    <>
      {/* 文件上传区(所有图表类型共用) */}
      <div className="form">
        <div
          className={`analyze-input ${drag ? "dragover" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pickFile(e.dataTransfer.files?.[0]); }}
        >
          <div className="analyze-file-bar">
            {file ? (
              <span className="file-chip" data-testid="input-file-info">
                📎 {file.name}
                <button className="chip-x" onClick={() => setFile(null)} aria-label="移除文件">✕</button>
              </span>
            ) : (
              <span className="file-placeholder">
                📎 把数据文件（.csv / .xlsx）拖到此处，或{" "}
                <button type="button" className="link-btn" onClick={() => fileInput.current?.click()}>
                  点击选择
                </button>
              </span>
            )}
            <input
              ref={fileInput}
              data-testid="input-file"
              type="file"
              accept=".csv,.xlsx,.xls"
              style={{ display: "none" }}
              onChange={(e) => pickFile(e.target.files?.[0] ?? undefined)}
            />
          </div>
          {chartType === "general" && (
            <textarea
              data-testid="input-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="说明研究目的；也可以直接要求画图。例如：比较治疗组与对照组疗效，并画箱线图；按生存时间画 KM 曲线；画各指标相关性热图、ROC 曲线"
              rows={3}
            />
          )}
        </div>
        {fileErr && (
          <span className="result-error" data-testid="input-file-error">{fileErr}</span>
        )}

        {/* 分析类型 + 脱敏开关 */}
        <div className="analyze-type-row">
          <label className="field-inline">
            分析类型
            <select
              data-testid="analyze-chart-type"
              value={chartType}
              onChange={(e) => setChartType(e.target.value as ChartType)}
            >
              {CHART_TYPES.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </label>
          <label className="analyze-deid-toggle">
            <input
              type="checkbox"
              checked={deidEnabled}
              onChange={(e) => setDeidEnabled(e.target.checked)}
              data-testid="analyze-deid-toggle"
            />
            上传时自动检测患者隐私信息
          </label>
        </div>

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
                {running ? "分析中…" : "开始分析"}
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

      {/* ─── 各类结果 ───────────────────────────────────────────── */}
      {chartType === "forest" && forestErr && (
        <div className="result-error" data-testid="forest-error">{forestErr}</div>
      )}
      {chartType === "forest" && forestResult && (
        <CanvasSlot><ForestResultPanel result={forestResult} effect={forestEffect} /></CanvasSlot>
      )}

      {chartType === "km" && kmErr && (
        <div className="result-error" data-testid="km-error">{kmErr}</div>
      )}
      {chartType === "km" && kmResult && <CanvasSlot><KMResultPanel result={kmResult} /></CanvasSlot>}

      {chartType === "roc" && rocErr && (
        <div className="result-error" data-testid="roc-error">{rocErr}</div>
      )}
      {chartType === "roc" && rocResult && <CanvasSlot><ROCResultPanel result={rocResult} /></CanvasSlot>}

      {/* ─── 通用模式: 原有结果区 ───────────────────────────────── */}
      {chartType === "general" && (
        <>
          {status && (
            <div className="status-line" data-testid="status-line">
              <span className="spinner" /> {status}
            </div>
          )}
          {error && (
            <div className="result-error" data-testid="analyze-error">{error}</div>
          )}
          {plan.length > 0 && (
            <CanvasSlot>
              <div className="plan-cards" data-testid="plan-cards">
                <h3 className="plan-title">📐 分析方案（系统按你的数据自动判定的方法与前提，请核对分组是否正确）</h3>
                {plan.map((c, i) => (
                  <div className="plan-card" key={i} data-testid={`plan-card-${i}`}>
                    <div className="plan-goal">{c.goal}</div>
                    <div className="plan-row"><span className="plan-k">数据</span><span>{c.data}</span></div>
                    {c.assumptions?.length > 0 && (
                      <div className="plan-row">
                        <span className="plan-k">前提</span>
                        <span>{c.assumptions.map((a, j) => <div key={j}>{a}</div>)}</span>
                      </div>
                    )}
                    <div className="plan-row"><span className="plan-k">方法</span><span className="plan-reco">{c.recommended}</span></div>
                    {c.fallback && <div className="plan-row"><span className="plan-k">备选</span><span>{c.fallback}</span></div>}
                    {c.note && <div className="plan-note">{c.note}</div>}
                  </div>
                ))}
              </div>
            </CanvasSlot>
          )}
          {code && (
            <details className="stats-details" data-testid="code-block">
              <summary>查看 AI 生成的分析代码（本地执行，可复现）</summary>
              <pre className="stats-pre">{code}</pre>
            </details>
          )}
          {charts.length > 0 && (
            <CanvasSlot>
            <div className="analysis-block" data-testid="analysis-block">
              {!running && (
                <div className="charts-toolbar">
                  <button className="btn-ghost btn-sm" onClick={genCaptions} disabled={capBusy} data-testid="gen-captions-btn">
                    {capBusy ? "生成图注中…" : "✍️ 生成规范图注"}
                  </button>
                  <HelpButton helpKey="figcaptions" />
                </div>
              )}
              <div className="charts">
                {charts.map((c, i) => (
                  <figure key={i} className="chart">
                    <img src={`data:image/png;base64,${c.png}`} alt={`图 ${i + 1}`} data-testid={`chart-${i}`} />
                    <figcaption>
                      {captions[i] && <p className="chart-caption" data-testid={`chart-caption-${i}`}>{captions[i]}</p>}
                      <button
                        className="btn-ghost btn-sm"
                        data-testid={`chart-download-${i}`}
                        onClick={() => downloadBase64(tsName(`图${i + 1}`, c.ext), c.data, chartMime(c.ext))}
                      >
                        下载 {c.ext.toUpperCase()}
                      </button>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
            </CanvasSlot>
          )}
          {output && (
            <details className="stats-details" data-testid="output-block">
              <summary>查看代码运行的原始输出（真实计算结果）</summary>
              <pre className="stats-pre">{output}</pre>
            </details>
          )}
          {(conclusion || (running && !error)) && (
            <CanvasSlot>
              <h2 className="section-title">分析结论</h2>
              <div className="analyze-disclaimer" data-testid="analyze-disclaimer">
                ⚠️ 本结论由 AI 基于代码真实运行结果自动生成，可能存在方法或解读上的偏差，
                <strong>正式用于论文/决策前请由专业统计人员核对</strong>；显著性（如 p&lt;0.05）不代表临床意义。
              </div>
              <div className="result-panel">
                <div className="result-toolbar">
                  <span className="result-status">{running ? "生成中…" : "已完成"}</span>
                  {conclusion && !running && (
                    <div className="result-actions">
                      <button
                        className="btn-ghost"
                        data-testid="copy-conclusion-btn"
                        title="把分析结论复制到剪贴板"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(conclusion);
                            setCopyState("ok");
                          } catch {
                            setCopyState("err");
                          }
                          window.setTimeout(() => setCopyState("idle"), 2000);
                        }}
                      >
                        {copyState === "ok" ? "已复制 ✓" : copyState === "err" ? "复制失败·请手动选择" : "复制结论"}
                      </button>
                      <button
                        className="btn-ghost"
                        data-testid="send-to-format-btn"
                        onClick={() => goto("format", { "format:manuscript": conclusion })}
                      >
                        用此结论去排版 →
                      </button>
                      <button
                        className="btn-ghost"
                        data-testid="export-report-btn"
                        onClick={() =>
                          downloadAnalysisReport({
                            title: "数据分析报告",
                            question,
                            code,
                            charts: charts.map((c) => c.png),
                            output,
                            conclusion,
                          })
                        }
                      >
                        导出完整报告(HTML)
                      </button>
                      <button
                        className="btn-ghost"
                        data-testid="export-md-btn"
                        onClick={() => downloadText(tsName("数据分析", "md"), conclusion)}
                      >
                        导出 Markdown
                      </button>
                    </div>
                  )}
                </div>
                <EditableMarkdown
                  value={conclusion}
                  onSave={setConclusion}
                  running={running}
                  placeholder="正在分析…"
                  testId="result-text"
                />
              </div>
            </CanvasSlot>
          )}
        </>
      )}

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

// ─── 森林图编辑器 ───────────────────────────────────────────────
interface ForestEditorProps {
  rows: ForestRow[];
  effect: "OR" | "RR";
  busy: boolean;
  onChange: (i: number, k: keyof ForestRow, v: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onEffect: (e: "OR" | "RR") => void;
  onRun: () => void;
}
function ForestEditor({ rows, effect, busy, onChange, onAdd, onRemove, onEffect, onRun }: ForestEditorProps) {
  return (
    <div className="forest-editor" data-testid="forest-editor">
      <div className="forest-row forest-head">
        <span>研究名</span>
        <span>治疗 N</span>
        <span>治疗事件</span>
        <span>对照 N</span>
        <span>对照事件</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div className="forest-row" key={i}>
          <input
            value={r.study}
            placeholder={`研究 ${i + 1}`}
            onChange={(e) => onChange(i, "study", e.target.value)}
            data-testid={`forest-study-${i}`}
          />
          <input
            type="number" inputMode="numeric"
            value={r.n_treat}
            onChange={(e) => onChange(i, "n_treat", e.target.value)}
            data-testid={`forest-ntreat-${i}`}
          />
          <input
            type="number" inputMode="numeric"
            value={r.event_treat}
            onChange={(e) => onChange(i, "event_treat", e.target.value)}
            data-testid={`forest-etreat-${i}`}
          />
          <input
            type="number" inputMode="numeric"
            value={r.n_ctrl}
            onChange={(e) => onChange(i, "n_ctrl", e.target.value)}
            data-testid={`forest-nctrl-${i}`}
          />
          <input
            type="number" inputMode="numeric"
            value={r.event_ctrl}
            onChange={(e) => onChange(i, "event_ctrl", e.target.value)}
            data-testid={`forest-ectrl-${i}`}
          />
          <button className="row-x" onClick={() => onRemove(i)} aria-label="删除此行">✕</button>
        </div>
      ))}
      <div className="forest-actions">
        <button className="btn-ghost btn-sm" onClick={onAdd} data-testid="forest-add-row">+ 添加一行</button>
        <label className="field-inline">
          效应量
          <select value={effect} onChange={(e) => onEffect(e.target.value as "OR" | "RR")} data-testid="forest-effect">
            <option value="OR">OR(优势比)</option>
            <option value="RR">RR(风险比)</option>
          </select>
        </label>
        <button className="btn-primary" onClick={onRun} disabled={busy} data-testid="forest-run-btn">
          {busy ? "生成中…" : "生成森林图"}
        </button>
      </div>
    </div>
  );
}

// ─── 列映射通用组件(KM / ROC 用) ────────────────────────────────
interface ColField {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  allowEmpty?: boolean;
  testId?: string;
}
interface ColMapperProps {
  title: string;
  file: File | null;
  headers: string[];
  fields: ColField[];
  busy: boolean;
  onRun: () => void;
  runTestId?: string;
  runLabel: string;
}
function ColMapper({ title, file, headers, fields, busy, onRun, runTestId, runLabel }: ColMapperProps) {
  if (!file) {
    return <p className="field-hint">请先在上方上传 CSV 文件以选择列。</p>;
  }
  // 未能解析出表头(如 xlsx)时, 退化为「手动输入列名」而非死路
  const manual = headers.length === 0;
  return (
    <div data-testid="col-mapper">
      <p className="field-hint" style={{ marginTop: 10 }}>{title}</p>
      {manual && (
        <p className="field-hint" style={{ marginTop: 6 }}>
          未能自动解析表头（xlsx 等）。请手动输入列名，需与表格首行列名<strong>完全一致</strong>（区分大小写与空格）。
        </p>
      )}
      <div className="col-map-grid">
        {fields.map((f) => (
          <Frag key={f.label}>
            <span>{f.label}</span>
            {manual ? (
              <input
                value={f.value}
                onChange={(e) => f.onChange(e.target.value)}
                data-testid={f.testId}
                placeholder={f.allowEmpty ? "列名（可留空 = 不使用）" : "输入列名"}
              />
            ) : (
              <select
                value={f.value}
                onChange={(e) => f.onChange(e.target.value)}
                data-testid={f.testId}
              >
                {f.allowEmpty && <option value="">(不使用)</option>}
                {!f.allowEmpty && <option value="">请选择…</option>}
                {headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            )}
          </Frag>
        ))}
      </div>
      <div className="form-actions">
        <button className="btn-primary" onClick={onRun} disabled={busy} data-testid={runTestId}>
          {busy ? "生成中…" : runLabel}
        </button>
      </div>
    </div>
  );
}
function Frag({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// ─── 森林图结果面板 ─────────────────────────────────────────────
function ForestResultPanel({ result, effect }: { result: ForestResult; effect: "OR" | "RR" }) {
  const ext = "png"; // 简化: 默认 png
  return (
    <div className="analyze-chart-result" data-testid="forest-result">
      <img src={`data:image/png;base64,${result.image_base64}`} alt="森林图" />
      <div className="summary-grid">
        <div className="summary-cell">
          <div className="label">合并 {effect}</div>
          <div className="value">{result.summary.pooled.toFixed(2)}</div>
        </div>
        <div className="summary-cell">
          <div className="label">95% CI</div>
          <div className="value">[{result.summary.ci_low.toFixed(2)}, {result.summary.ci_high.toFixed(2)}]</div>
        </div>
        <div className="summary-cell">
          <div className="label">I²(异质性)</div>
          <div className="value">{(result.summary.i2 * 100).toFixed(1)}%</div>
        </div>
        <div className="summary-cell">
          <div className="label">Q 检验 p</div>
          <div className="value">{result.summary.q_pvalue.toFixed(3)}</div>
        </div>
      </div>
      <button
        className="btn-ghost btn-sm"
        onClick={() => downloadBase64(tsName("森林图", ext), result.image_base64, chartMime(ext))}
        data-testid="forest-download"
      >
        下载 PNG
      </button>
    </div>
  );
}

function KMResultPanel({ result }: { result: KMResult }) {
  const ext = "png";
  return (
    <div className="analyze-chart-result" data-testid="km-result">
      <img src={`data:image/png;base64,${result.image_base64}`} alt="KM 曲线" />
      <div className="summary-grid">
        <div className="summary-cell">
          <div className="label">Log-rank p</div>
          <div className="value">{result.logrank_p.toFixed(4)}</div>
        </div>
        <div className="summary-cell">
          <div className="label">分组</div>
          <div className="value">{result.groups.join(" / ") || "(单组)"}</div>
        </div>
      </div>
      <button
        className="btn-ghost btn-sm"
        onClick={() => downloadBase64(tsName("KM曲线", ext), result.image_base64, chartMime(ext))}
        data-testid="km-download"
      >
        下载 PNG
      </button>
    </div>
  );
}

function ROCResultPanel({ result }: { result: ROCResult }) {
  const ext = "png";
  return (
    <div className="analyze-chart-result" data-testid="roc-result">
      <img src={`data:image/png;base64,${result.image_base64}`} alt="ROC 曲线" />
      <div className="summary-grid">
        <div className="summary-cell">
          <div className="label">AUC</div>
          <div className="value">{result.auc.toFixed(3)}</div>
        </div>
        <div className="summary-cell">
          <div className="label">AUC 95% CI</div>
          <div className="value">[{result.auc_ci[0].toFixed(3)}, {result.auc_ci[1].toFixed(3)}]</div>
        </div>
        <div className="summary-cell">
          <div className="label">最佳阈值</div>
          <div className="value">{result.threshold.toFixed(3)}</div>
        </div>
      </div>
      <button
        className="btn-ghost btn-sm"
        onClick={() => downloadBase64(tsName("ROC曲线", ext), result.image_base64, chartMime(ext))}
        data-testid="roc-download"
      >
        下载 PNG
      </button>
    </div>
  );
}

// ─── 统计顾问子面板 ─────────────────────────────────────────────
function AdvisorPane() {
  const [question, setQuestion] = usePersistentState("analyze:advisorQuestion", "");
  const [result, setResult] = usePersistentState<AdvisorPayload>("analyze:advisorResult", {});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const ask = async () => {
    if (!question.trim() || running) return;
    setRunning(true);
    setError(null);
    setResult({});
    ctrl.current = new AbortController();
    // 后端按 token 碎片流式发 delta({text}), 结束发 done——必须先累积拼成完整文本,
    // done 后剥掉可能的 ```json 围栏再一次性解析(单个碎片永远不是完整 payload)。
    let acc = "";
    let finished = false;
    try {
      await streamPost(apiUrl("/api/stats/advice"), { question }, {
        signal: ctrl.current.signal,
        onDelta: (text) => { acc += text; },
        onError: (msg) => { setError(msg); },
        onDone: () => { finished = true; },
      });
      if (finished) {
        const raw = acc.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
        try {
          setResult(JSON.parse(raw) as AdvisorPayload);
        } catch {
          setError("AI 返回的内容无法解析为推荐结果，请重试。");
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(`请求失败: ${(e as Error).message}`);
      }
    } finally {
      setRunning(false);
      window.dispatchEvent(new Event("usage-updated"));
    }
  };

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
  };

  const hasResult = useMemo(
    () =>
      !!(result.recommended || (result.assumptions && result.assumptions.length) ||
         (result.cautions && result.cautions.length) || (result.alternatives && result.alternatives.length)),
    [result],
  );

  return (
    <div className="form" data-testid="advisor-pane">
      <label className="field">
        <span className="field-label">向 AI 描述你的研究问题</span>
        <textarea
          rows={4}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例如:我有两组(治疗 vs 对照)各 60 例患者的术后 5 年生存数据(含删失), 想比较两组生存率是否有差异。"
          data-testid="advisor-question"
        />
      </label>
      <div className="form-actions">
        <button
          className="btn-primary"
          onClick={ask}
          disabled={!question.trim() || running}
          data-testid="advisor-ask-btn"
        >
          {running ? "请教中…" : "请教 AI"}
        </button>
        {running && (
          <button className="btn-ghost" onClick={stop} data-testid="advisor-stop-btn">停止</button>
        )}
      </div>

      {error && <div className="result-error" data-testid="advisor-error">{error}</div>}

      {(hasResult || running) && (
        <CanvasSlot>
        <div className="advisor-cards" data-testid="advisor-cards">
          <div className="advisor-card">
            <h4>✅ 推荐方法</h4>
            <div className="reco">
              {typeof result.recommended === "string"
                ? result.recommended
                : result.recommended?.test || (running ? "…" : "—")}
            </div>
            {result.recommended && typeof result.recommended !== "string" && result.recommended.why && (
              <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--faint)" }}>
                {result.recommended.why}
              </p>
            )}
          </div>
          <div className="advisor-card">
            <h4>📋 前置假设</h4>
            {result.assumptions && result.assumptions.length ? (
              <ul>{result.assumptions.map((s, i) => <li key={i}>{s}</li>)}</ul>
            ) : (
              <p style={{ margin: 0, color: "var(--faint)" }}>{running ? "…" : "—"}</p>
            )}
          </div>
          <div className="advisor-card">
            <h4>⚠️ 注意事项</h4>
            {result.cautions && result.cautions.length ? (
              <ul>{result.cautions.map((s, i) => <li key={i}>{s}</li>)}</ul>
            ) : (
              <p style={{ margin: 0, color: "var(--faint)" }}>{running ? "…" : "—"}</p>
            )}
          </div>
          <div className="advisor-card">
            <h4>🔄 替代方法</h4>
            {result.alternatives && result.alternatives.length ? (
              <ul>
                {result.alternatives.map((s, i) => (
                  <li key={i}>
                    {typeof s === "string" ? (
                      s
                    ) : (
                      <>
                        <strong>{s.test}</strong>
                        {s.when ? `：${s.when}` : ""}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ margin: 0, color: "var(--faint)" }}>{running ? "…" : "—"}</p>
            )}
          </div>
        </div>
        </CanvasSlot>
      )}
    </div>
  );
}
