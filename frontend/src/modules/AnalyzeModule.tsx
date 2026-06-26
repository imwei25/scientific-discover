import { useEffect, useRef, useState } from "react";
import { streamAnalyze } from "../lib/sse";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import Markdown from "../components/Markdown";
import Dropzone from "../components/Dropzone";
import { downloadText, tsName, downloadAnalysisReport } from "../lib/download";
import type { Goto } from "../App";

export default function AnalyzeModule({ goto }: { goto: Goto }) {
  const [file, setFile] = useState<File | null>(null);
  const [question, setQuestion] = usePersistentState("analyze:question", "");

  const [status, setStatus] = useState("");
  const [code, setCode] = useState("");
  const [charts, setCharts] = useState<string[]>([]);
  const [output, setOutput] = useState("");
  const [conclusion, setConclusion] = usePersistentState("analyze:conclusion", "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && conclusion && savedRef.current !== conclusion) {
      savedRef.current = conclusion;
      addHistory({
        module: "analyze",
        icon: "📊",
        title: question.slice(0, 40) || "数据分析",
        data: { "analyze:question": question, "analyze:conclusion": conclusion },
      });
    }
  }, [running, conclusion, question]);

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
    await streamAnalyze(file, question, {
      signal: ctrl.current.signal,
      onStatus: setStatus,
      onCode: setCode,
      onCharts: setCharts,
      onOutput: setOutput,
      onDelta: (t) => setConclusion((p) => p + t),
      onError: (m) => {
        setError(m);
        setRunning(false);
      },
      onDone: () => {
        setStatus("");
        setRunning(false);
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
        <Dropzone
          testId="input-file"
          accept=".csv,.xlsx,.xls"
          label="数据文件（必填）"
          hint="支持 Excel(.xlsx/.xls) 与 CSV；可拖拽上传"
          mode="file"
          onFile={setFile}
        />
        <label className="field">
          <span className="field-label">研究目的 / 你想分析什么（强烈建议填写）</span>
          <textarea
            data-testid="input-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例如：比较治疗组与对照组的疗效是否有差异，并分析年龄、性别是否影响疗效"
            rows={3}
          />
        </label>
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
            {charts.map((b64, i) => (
              <figure key={i} className="chart">
                <img src={`data:image/png;base64,${b64}`} alt={`图 ${i + 1}`} data-testid={`chart-${i}`} />
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
                      charts,
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
