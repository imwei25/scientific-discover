import { usePersistentState } from "../lib/usePersistentState";
import type { Goto } from "../App";
import DataPane from "./analyze/DataPane";
import AdvisorPane from "./analyze/AdvisorPane";

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
        /* 宽版结果区: 突破 .module 880px 上限, 结论拿舒适阅读带 + 缩略图右侧 sticky rail */
        .analyze-results-wide {
          width: min(1200px, calc(100vw - 32px));
          margin-left: 0;  /* 左对齐, 不居中, 避免结论飘走 */
        }
        /* 第二阶段: 结论左 / 图片右 两栏 (宽版) */
        .analyze-cols {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 240px;
          gap: 24px; align-items: start;
        }
        .analyze-col-right {
          position: sticky; top: 16px;
          max-height: calc(100vh - 32px);
          overflow-y: auto;
        }
        .analyze-col-right .analysis-block { margin-top: 0; }
        .analyze-col-right .charts { display: flex; flex-direction: column; gap: 12px; }
        /* 缩略图小图化 */
        .analyze-col-right .chart {
          cursor: pointer; margin: 0;
          border: 1px solid var(--line, #e3e8ef); border-radius: 8px;
          padding: 6px; background: #fff;
          transition: transform 120ms ease, box-shadow 120ms ease;
        }
        .analyze-col-right .chart:hover {
          transform: scale(1.015);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }
        .analyze-col-right .chart img {
          width: 100%; max-height: 160px; object-fit: contain; display: block;
        }
        .analyze-col-right .chart figcaption {
          margin-top: 4px; font-size: 11.5px; text-align: right;
        }
        .analyze-col-right .chart-caption {
          font-size: 11px; color: var(--faint, #5b6675);
          text-align: left; margin: 4px 0;
          overflow: hidden; text-overflow: ellipsis;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        }
        @media (max-width: 1140px) {
          .analyze-results-wide { width: 100%; }
          .analyze-cols { grid-template-columns: 1fr; }
          .analyze-col-right {
            position: static; max-height: none; overflow-y: visible;
          }
          .analyze-col-right .charts {
            flex-direction: row; flex-wrap: wrap;
          }
          .analyze-col-right .chart {
            flex: 0 0 calc(50% - 6px);
          }
        }
        @media (max-width: 720px) {
          .analyze-col-right .chart {
            flex: 0 0 100%;
          }
        }
        .analyze-noimg {
          padding: 24px; text-align: center; color: var(--faint, #5b6675);
          border: 1px dashed var(--line, #e3e8ef); border-radius: 10px; background: var(--surface, #f7f9fc);
        }
        /* 弹出式入口条 */
        .analyze-popbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 10px; }
        /* 弹出层 */
        .analyze-popup-overlay {
          position: fixed; inset: 0; z-index: 60; background: rgba(15,23,32,.42);
          display: flex; align-items: center; justify-content: center; padding: 24px;
          animation: analyze-pop-in 140ms ease;
        }
        @keyframes analyze-pop-in { from { opacity: 0 } to { opacity: 1 } }
        .analyze-popup {
          background: var(--surface-1, #fff); color: var(--ink, #1f2733);
          border: 1px solid var(--line, #e3e8ef); border-radius: 12px;
          max-width: min(920px, 94vw); max-height: 86vh; width: 100%;
          display: flex; flex-direction: column; box-shadow: 0 18px 50px rgba(0,0,0,.28);
        }
        .analyze-popup-head {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: 12px 16px; border-bottom: 1px solid var(--line, #e3e8ef); font-weight: 600;
        }
        .analyze-popup-close {
          border: none; background: transparent; cursor: pointer; font-size: 16px;
          color: var(--faint, #5b6675); border-radius: 6px; width: 28px; height: 28px;
        }
        .analyze-popup-close:hover { background: var(--surface, #f3f5f8); color: var(--ink, #1f2733); }
        .analyze-popup-body { padding: 16px; overflow: auto; }
        .analyze-popup-body .stats-pre {
          margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.6;
        }
      `}</style>
    </div>
  );
}
