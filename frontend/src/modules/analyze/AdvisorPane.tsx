import { useMemo, useRef, useState } from "react";
import { streamPost } from "../../lib/sse";
import { usePersistentState } from "../../lib/usePersistentState";
import { CanvasSlot } from "../../components/Canvas";
import { apiUrl } from "../../lib/api";

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
export interface AdvisorPayload {
  recommended?: AdvisorRecommended | string;
  assumptions?: string[];
  cautions?: string[];
  alternatives?: (AdvisorAlternative | string)[];
}

// ─── 统计顾问子面板 ─────────────────────────────────────────────
export default function AdvisorPane() {
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
