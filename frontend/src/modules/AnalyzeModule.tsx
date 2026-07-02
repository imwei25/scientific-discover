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
      `}</style>
    </div>
  );
}
