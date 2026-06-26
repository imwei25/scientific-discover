import { useState } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { apiUrl } from "../lib/api";
import ResultPanel from "../components/ResultPanel";
import Dropzone from "../components/Dropzone";

interface Chart {
  title: string;
  b64: string;
}
interface AnalyzeResult {
  ok: boolean;
  error?: string;
  rows: number;
  cols: number;
  describe_md: string;
  stats_md: string;
  charts: Chart[];
  facts: string;
}

export default function AnalyzeModule() {
  const [file, setFile] = useState<File | null>(null);
  const [question, setQuestion] = usePersistentState("analyze:question", "");
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null);
  const [withAI, setWithAI] = usePersistentState("analyze:withAI", true);
  const { text, running, error, start, stop, setText } = useStream("analyze:result");

  const analyze = async () => {
    if (!file || analyzing) return;
    setAnalyzing(true);
    setResult(null);
    setAnalyzeErr(null);
    setText("");
    const fd = new FormData();
    fd.append("file", file);
    fd.append("question", question);
    try {
      const resp = await fetch(apiUrl("/api/analyze"), { method: "POST", body: fd });
      const data: AnalyzeResult = await resp.json();
      if (!data.ok) {
        setAnalyzeErr(data.error || "分析失败");
      } else {
        setResult(data);
        // 计算完成后, 若开启则让 AI 基于"已算好的事实"撰写分析(不让 AI 算数字)
        if (withAI) start("write", { facts: data.facts, question });
      }
    } catch (e) {
      setAnalyzeErr(`分析失败: ${(e as Error).message}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const reset = () => {
    if (running) stop();
    setFile(null);
    setQuestion("");
    setResult(null);
    setAnalyzeErr(null);
    setText("");
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>📊 数据分析与写作</h1>
        <p>上传你的数据（CSV 或 Excel），我先在本地算出统计结果与图表，再据此提炼核心观点、撰写论文段落。</p>
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
          <span className="field-label">研究问题 / 你想验证什么（可选）</span>
          <textarea
            data-testid="input-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例如：A组和B组的疗效是否有显著差异？哪些因素与产量相关？"
            rows={3}
          />
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={withAI}
            onChange={(e) => setWithAI(e.target.checked)}
            data-testid="with-ai"
          />
          <span>同时用 AI 解读数据并撰写论文段落（会消耗模型额度；取消则只做本地统计与出图，免费）</span>
        </label>
        <div className="form-actions">
          <button className="btn-primary" onClick={analyze} disabled={!file || analyzing} data-testid="run-btn">
            {analyzing ? "正在本地计算…" : "分析数据"}
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">
            清空
          </button>
        </div>
      </div>

      {analyzeErr && (
        <div className="result-error" data-testid="analyze-error">
          {analyzeErr}
        </div>
      )}

      {result && (
        <div className="analysis-block" data-testid="analysis-block">
          <div className="analysis-meta">
            数据规模：{result.rows} 行 × {result.cols} 列（以下数字均由本地程序计算，可复现）
          </div>
          {result.charts.length > 0 && (
            <div className="charts">
              {result.charts.map((c, i) => (
                <figure key={i} className="chart">
                  <img src={`data:image/png;base64,${c.b64}`} alt={c.title} data-testid={`chart-${i}`} />
                  <figcaption>{c.title}</figcaption>
                </figure>
              ))}
            </div>
          )}
          <details className="stats-details" open>
            <summary>描述性统计与检验结果</summary>
            <pre className="stats-pre">{result.describe_md}</pre>
            <pre className="stats-pre">{result.stats_md}</pre>
          </details>
        </div>
      )}

      {withAI && (result || running || error) && (
        <>
          <h2 className="section-title">AI 分析与论文初稿</h2>
          <ResultPanel
            text={text}
            running={running}
            error={error}
            onStop={stop}
            exportName="数据分析"
            placeholder="基于上面计算结果的核心观点与论文段落会显示在这里。"
          />
        </>
      )}
    </div>
  );
}
