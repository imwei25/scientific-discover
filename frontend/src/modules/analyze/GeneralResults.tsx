import { useState } from "react";
import type { ChartItem, PlanCard } from "../../lib/sse";
import { reportLLMError } from "../../lib/errorToast";
import EditableMarkdown from "../../components/EditableMarkdown";
import { CanvasSlot } from "../../components/Canvas";
import { HelpButton } from "../../components/HelpButton";
import { downloadText, downloadBase64, chartMime, tsName, downloadAnalysisReport } from "../../lib/download";
import { apiUrl } from "../../lib/api";
import type { Goto } from "../../App";
import type { ChartType } from "./types";

// ─── 通用模式: 原有结果区 ───────────────────────────────────────
interface GeneralResultsProps {
  chartType: ChartType;
  goto: Goto;
  status: string;
  error: string | null;
  plan: PlanCard[];
  code: string;
  charts: ChartItem[];
  captions: string[];
  setCaptions: (c: string[]) => void;
  output: string;
  conclusion: string;
  setConclusion: (v: string) => void;
  running: boolean;
  question: string;
}
export default function GeneralResults({
  chartType,
  goto,
  status,
  error,
  plan,
  code,
  charts,
  captions,
  setCaptions,
  output,
  conclusion,
  setConclusion,
  running,
  question,
}: GeneralResultsProps) {
  const [copyState, setCopyState] = useState<"idle" | "ok" | "err">("idle"); // 复制结论的短暂反馈
  const [capBusy, setCapBusy] = useState(false);

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

  if (chartType !== "general") return null;

  return (
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
  );
}
