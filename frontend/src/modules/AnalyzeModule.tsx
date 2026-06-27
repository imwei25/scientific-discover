import { useEffect, useRef, useState } from "react";
import { streamAnalyze, ChartItem } from "../lib/sse";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import Markdown from "../components/Markdown";
import { downloadText, downloadBase64, chartMime, tsName, downloadAnalysisReport } from "../lib/download";
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

export default function AnalyzeModule({ goto }: { goto: Goto }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileErr, setFileErr] = useState("");
  const [drag, setDrag] = useState(false);
  const [question, setQuestion] = usePersistentState("analyze:question", "");
  const [chartFormat, setChartFormat] = usePersistentState("analyze:chartFormat", "png");
  const [palette, setPalette] = usePersistentState("analyze:palette", "default");
  const fileInput = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState("");
  const [code, setCode] = useState("");
  const [charts, setCharts] = useState<ChartItem[]>([]);
  const [output, setOutput] = useState("");
  const [conclusion, setConclusion] = usePersistentState("analyze:conclusion", "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && conclusion && savedRef.current !== conclusion) {
      savedRef.current = conclusion;
      addHistory({
        module: "analyze",
        icon: "📊",
        title: question.slice(0, 40) || "数据分析",
        data: { "analyze:question": question, "analyze:conclusion": conclusion },
      });
    }
  }, [running, error, conclusion, question]);

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setFileErr(`文件过大（${(f.size / 1024 / 1024).toFixed(1)}MB），请上传小于 30MB 的文件。`);
      return;
    }
    setFileErr("");
    setFile(f);
  };

  const run = async () => {
    if (!file || running) return;
    setStatus("");
    setCode("");
    setCharts([]);
    setOutput("");
    setConclusion("");
    setError(null);
    setRunning(true);
    ctrl.current = new AbortController();
    await streamAnalyze(file, question, chartFormat, palette, {
      signal: ctrl.current.signal,
      onStatus: setStatus,
      onCode: setCode,
      onCharts: setCharts,
      onOutput: setOutput,
      onDelta: (t) => setConclusion((p) => p + t),
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
    });
    setRunning(false);
  };

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
  };

  const reset = () => {
    if (running) stop();
    setFile(null);
    setFileErr("");
    setQuestion("");
    setCode("");
    setCharts([]);
    setOutput("");
    setConclusion("");
    setError(null);
    setStatus("");
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>📊 数据分析与写作 · 医学/药学/生物</h1>
        <p>
          上传数据并说明你的研究目的，AI 会读懂数据结构、<strong>编写针对性的分析代码并在本地执行</strong>，
          再基于真实运行结果给出结论（数字都由代码算出，不是凭空生成）。
        </p>
      </header>

      <div className="form">
        <div
          className={`analyze-input ${drag ? "dragover" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pickFile(e.dataTransfer.files?.[0]);
          }}
        >
          <div className="analyze-file-bar">
            {file ? (
              <span className="file-chip" data-testid="input-file-info">
                📎 {file.name}
                <button className="chip-x" onClick={() => setFile(null)} aria-label="移除文件">
                  ✕
                </button>
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
          <textarea
            data-testid="input-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="说明研究目的；也可以直接要求画图。例如：比较治疗组与对照组疗效，并画箱线图；按生存时间画 KM 曲线；画各指标相关性热图、ROC 曲线"
            rows={3}
          />
        </div>
        {fileErr && (
          <span className="result-error" data-testid="input-file-error">
            {fileErr}
          </span>
        )}

        <div className="chart-opts">
          <label className="field-inline">
            图表导出格式
            <select data-testid="chart-format" value={chartFormat} onChange={(e) => setChartFormat(e.target.value)}>
              {CHART_FORMATS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            配色风格
            <select data-testid="chart-palette" value={palette} onChange={(e) => setPalette(e.target.value)}>
              {PALETTES.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="form-actions">
          <button className="btn-primary" onClick={run} disabled={!file || running} data-testid="run-btn">
            {running ? "分析中…" : "开始分析"}
          </button>
          {running && (
            <button className="btn-ghost" onClick={stop} data-testid="stop-btn">
              停止
            </button>
          )}
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">
            清空
          </button>
        </div>
      </div>

      {status && (
        <div className="status-line" data-testid="status-line">
          <span className="spinner" /> {status}
        </div>
      )}

      {error && (
        <div className="result-error" data-testid="analyze-error">
          {error}
        </div>
      )}

      {code && (
        <details className="stats-details" data-testid="code-block">
          <summary>查看 AI 生成的分析代码（本地执行，可复现）</summary>
          <pre className="stats-pre">{code}</pre>
        </details>
      )}

      {charts.length > 0 && (
        <div className="analysis-block" data-testid="analysis-block">
          <div className="charts">
            {charts.map((c, i) => (
              <figure key={i} className="chart">
                <img src={`data:image/png;base64,${c.png}`} alt={`图 ${i + 1}`} data-testid={`chart-${i}`} />
                <figcaption>
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
      )}

      {output && (
        <details className="stats-details" data-testid="output-block">
          <summary>查看代码运行的原始输出（真实计算结果）</summary>
          <pre className="stats-pre">{output}</pre>
        </details>
      )}

      {(conclusion || (running && !error)) && (
        <>
          <h2 className="section-title">分析结论</h2>
          <div className="result-panel">
            <div className="result-toolbar">
              <span className="result-status">{running ? "生成中…" : "已完成"}</span>
              {conclusion && !running && (
                <button
                  className="btn-ghost"
                  data-testid="send-to-format-btn"
                  onClick={() => goto("format", { "format:manuscript": conclusion })}
                >
                  用此结论去排版 →
                </button>
              )}
              {conclusion && !running && (
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
              )}
              {conclusion && !running && (
                <button
                  className="btn-ghost"
                  data-testid="export-md-btn"
                  onClick={() => downloadText(tsName("数据分析", "md"), conclusion)}
                >
                  导出 Markdown
                </button>
              )}
            </div>
            <div className="result-text" data-testid="result-text">
              {conclusion ? <Markdown>{conclusion}</Markdown> : <span className="result-placeholder">正在分析…</span>}
              {running && <span className="cursor-blink">▍</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
