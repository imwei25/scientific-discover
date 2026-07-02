import { downloadBase64, chartMime, tsName } from "../../lib/download";
import type { ForestResult, KMResult, ROCResult } from "./types";

// ─── 森林图结果面板 ─────────────────────────────────────────────
export function ForestResultPanel({ result, effect }: { result: ForestResult; effect: "OR" | "RR" }) {
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

export function KMResultPanel({ result }: { result: KMResult }) {
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

export function ROCResultPanel({ result }: { result: ROCResult }) {
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
