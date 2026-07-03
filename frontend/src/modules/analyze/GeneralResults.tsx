import { useState } from "react";
import type { ChartItem, PlanCard } from "../../lib/sse";
import { reportLLMError } from "../../lib/errorToast";
import EditableMarkdown from "../../components/EditableMarkdown";
import { HelpButton } from "../../components/HelpButton";
import { downloadText, downloadBase64, chartMime, tsName, downloadAnalysisReport } from "../../lib/download";
import { apiUrl } from "../../lib/api";
import type { Goto } from "../../App";
import type { ChartType } from "./types";

// 弹出式浮层(替代折叠 <details>): 分析方案 / 代码 / 原始输出 点击才弹出。
function Popup({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="analyze-popup-overlay" data-testid="analyze-popup" onClick={onClose}>
      <div className="analyze-popup" onClick={(e) => e.stopPropagation()}>
        <div className="analyze-popup-head">
          <span>{title}</span>
          <button className="analyze-popup-close" data-testid="analyze-popup-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="analyze-popup-body">{children}</div>
      </div>
    </div>
  );
}

// ─── 通用模式: 第二阶段结果区(结论左 / 图片右, 方案&代码&输出弹出式) ──────
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
  chartType, goto, status, error, plan, code, charts, captions, setCaptions,
  output, conclusion, setConclusion, running, question,
}: GeneralResultsProps) {
  const [copyState, setCopyState] = useState<"idle" | "ok" | "err">("idle");
  const [capBusy, setCapBusy] = useState(false);
  const [popup, setPopup] = useState<null | "plan" | "code" | "output">(null);

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

  const downloadAllCharts = () => {
    charts.forEach((c, i) => downloadBase64(tsName(`图${i + 1}`, c.ext), c.data, chartMime(c.ext)));
  };

  if (chartType !== "general") return null;

  const hasResult = conclusion || charts.length > 0 || (running && !error);

  return (
    <>
      {status && (
        <div className="status-line" data-testid="status-line"><span className="spinner" /> {status}</div>
      )}
      {error && <div className="result-error" data-testid="analyze-error">{error}</div>}

      {hasResult && (
        <>
          {/* 弹出式入口: 分析方案 / 代码 / 原始输出(默认隐藏) */}
          {(plan.length > 0 || code || output) && (
            <div className="analyze-popbar" data-testid="analyze-popbar">
              {plan.length > 0 && (
                <button className="btn-ghost btn-sm" data-testid="show-plan-btn" onClick={() => setPopup("plan")}>📐 分析方案</button>
              )}
              {code && (
                <button className="btn-ghost btn-sm" data-testid="show-code-btn" onClick={() => setPopup("code")}>💻 分析代码</button>
              )}
              {output && (
                <button className="btn-ghost btn-sm" data-testid="show-output-btn" onClick={() => setPopup("output")}>📄 原始输出</button>
              )}
            </div>
          )}

          <div className="analyze-disclaimer" data-testid="analyze-disclaimer">
            ⚠️ 本结论由 AI 基于代码真实运行结果自动生成，可能存在方法或解读上的偏差，
            <strong>正式用于论文/决策前请由专业统计人员核对</strong>；显著性（如 p&lt;0.05）不代表临床意义。
          </div>

          {/* 结论左 / 图片右 */}
          <div className="analyze-cols" data-testid="analyze-cols">
            <div className="analyze-col-left" data-testid="analyze-col-left">
              <div className="result-panel">
                <div className="result-toolbar">
                  <span className="result-status">{running ? "生成中…" : conclusion ? "分析结论" : "分析中…"}</span>
                  {conclusion && !running && (
                    <div className="result-actions">
                      <button
                        className="btn-ghost" data-testid="copy-conclusion-btn" title="把分析结论复制到剪贴板"
                        onClick={async () => {
                          try { await navigator.clipboard.writeText(conclusion); setCopyState("ok"); }
                          catch { setCopyState("err"); }
                          window.setTimeout(() => setCopyState("idle"), 2000);
                        }}
                      >
                        {copyState === "ok" ? "已复制 ✓" : copyState === "err" ? "复制失败·请手动选择" : "复制结论"}
                      </button>
                      <button className="btn-ghost" data-testid="send-to-format-btn" onClick={() => goto("format", { "format:manuscript": conclusion })}>用此结论去排版 →</button>
                      <button
                        className="btn-ghost" data-testid="export-report-btn"
                        onClick={() => downloadAnalysisReport({ title: "数据分析报告", question, code, charts: charts.map((c) => c.png), output, conclusion })}
                      >
                        导出完整报告(HTML)
                      </button>
                      <button className="btn-ghost" data-testid="export-md-btn" onClick={() => downloadText(tsName("数据分析", "md"), conclusion)}>导出 Markdown</button>
                    </div>
                  )}
                </div>
                <EditableMarkdown
                  value={conclusion}
                  onSave={setConclusion}
                  running={running}
                  enableRefine={!running && !!conclusion}
                  refineTestId="analyze-refine"
                  placeholder="正在分析…"
                  testId="result-text"
                />
              </div>
            </div>

            <div className="analyze-col-right" data-testid="analyze-col-right">
              {charts.length > 0 ? (
                <div className="analysis-block" data-testid="analysis-block">
                  {!running && (
                    <div className="charts-toolbar">
                      <button className="btn-ghost btn-sm" onClick={genCaptions} disabled={capBusy} data-testid="gen-captions-btn">
                        {capBusy ? "生成图注中…" : "✍️ 生成规范图注"}
                      </button>
                      <button className="btn-ghost btn-sm" onClick={downloadAllCharts} data-testid="download-all-charts-btn">⬇ 下载全部图片</button>
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
              ) : (
                <div className="analyze-noimg" data-testid="analyze-noimg">{running ? "图表生成中…" : "本次分析未产生图表"}</div>
              )}
            </div>
          </div>
        </>
      )}

      {popup === "plan" && plan.length > 0 && (
        <Popup title="📐 分析方案（系统按数据自动判定的方法与前提，请核对分组是否正确）" onClose={() => setPopup(null)}>
          <div className="plan-cards" data-testid="plan-cards">
            {plan.map((c, i) => (
              <div className="plan-card" key={i} data-testid={`plan-card-${i}`}>
                <div className="plan-goal">{c.goal}</div>
                <div className="plan-row"><span className="plan-k">数据</span><span>{c.data}</span></div>
                {c.assumptions?.length > 0 && (
                  <div className="plan-row"><span className="plan-k">前提</span><span>{c.assumptions.map((a, j) => <div key={j}>{a}</div>)}</span></div>
                )}
                <div className="plan-row"><span className="plan-k">方法</span><span className="plan-reco">{c.recommended}</span></div>
                {c.fallback && <div className="plan-row"><span className="plan-k">备选</span><span>{c.fallback}</span></div>}
                {c.note && <div className="plan-note">{c.note}</div>}
              </div>
            ))}
          </div>
        </Popup>
      )}
      {popup === "code" && code && (
        <Popup title="💻 AI 生成的分析代码（本地执行，可复现）" onClose={() => setPopup(null)}>
          <pre className="stats-pre" data-testid="code-block">{code}</pre>
        </Popup>
      )}
      {popup === "output" && output && (
        <Popup title="📄 代码运行的原始输出（真实计算结果）" onClose={() => setPopup(null)}>
          <pre className="stats-pre" data-testid="output-block">{output}</pre>
        </Popup>
      )}
    </>
  );
}
