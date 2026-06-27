import { useEffect, useRef, useState } from "react";
import { streamIdea, Reference, Verification, RewritePayload } from "../lib/sse";
import { addHistory } from "../lib/history";
import Markdown from "../components/Markdown";
import Dropzone from "../components/Dropzone";
import { downloadText, tsName } from "../lib/download";
import { usePersistentState } from "../lib/usePersistentState";
import type { Goto } from "../App";

export default function IdeaModule({ goto }: { goto: Goto }) {
  const [field, setField] = usePersistentState("idea:field", "");
  const [keywords, setKeywords] = usePersistentState("idea:keywords", "");
  const [background, setBackground] = usePersistentState("idea:background", "");
  const [depth, setDepth] = usePersistentState("idea:depth", "deep");

  const [status, setStatus] = useState("");
  const [refs, setRefs] = usePersistentState<Reference[]>("idea:refs", []);
  const [text, setText] = usePersistentState("idea:result", "");
  const [verify, setVerify] = usePersistentState<Verification | null>("idea:verify", null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rewrite, setRewrite] = useState<RewritePayload | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "idea",
        icon: "💡",
        title: field || "选题调研",
        data: {
          "idea:field": field,
          "idea:keywords": keywords,
          "idea:background": background,
          "idea:result": text,
          "idea:refs": refs,
          "idea:verify": verify,
        },
      });
    }
  }, [running, error, text, field, keywords, background, refs, verify]);

  const submit = async (override?: { field?: string; keywords?: string }) => {
    const f = override?.field ?? field;
    const k = override?.keywords ?? keywords;
    if (!f.trim() || running) return;
    setStatus("");
    setRefs([]);
    setText("");
    setVerify(null);
    setError(null);
    setRewrite(null);
    setRunning(true);
    ctrl.current = new AbortController();
    await streamIdea(
      { field: f, keywords: k, background, depth },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onReferences: setRefs,
        onDelta: (t) => setText((p) => p + t),
        onVerify: setVerify,
        onRewriteSuggestion: setRewrite,
        onError: (m) => {
          setError(m);
          setStatus("");
          setRunning(false);
        },
        onDone: () => {
          setStatus("");
          setRunning(false);
        },
      },
    );
    setRunning(false);
  };

  const acceptRewrite = () => {
    if (!rewrite?.suggestion) return;
    const next = rewrite.suggestion;
    setField(next.field);
    setKeywords(next.keywords);
    setRewrite(null);
    setError(null);
    submit({ field: next.field, keywords: next.keywords });
  };

  const dismissRewrite = () => {
    setRewrite(null);
  };

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
  };

  const reset = () => {
    if (running) stop();
    setField("");
    setKeywords("");
    setBackground("");
    setRefs([]);
    setText("");
    setVerify(null);
    setStatus("");
    setError(null);
    setRewrite(null);
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>💡 找选题 · 医学/药学/生物</h1>
        <p>
          我会实际检索 <strong>PubMed / Europe PMC / OpenAlex</strong> 多源真实文献（按相关性+被引+新近择优纳入），
          梳理该方向已有哪些工作、还缺什么，再给出有文献支撑的候选选题。文中引用均为可点击的文献链接。
        </p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">研究领域 / 方向 <em>必填</em></span>
          <input
            data-testid="input-field"
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder="例如：PD-1 抑制剂在三阴性乳腺癌中的应用、肠道菌群与阿尔茨海默病"
          />
        </label>
        <label className="field">
          <span className="field-label">关键词（可选，建议英文，利于检索）</span>
          <input
            data-testid="input-keywords"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="逗号分隔，例如：immunotherapy, biomarker, resistance"
          />
        </label>
        <label className="field">
          <span className="field-label">已有基础 / 限制条件（可选）</span>
          <textarea
            data-testid="input-background"
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            placeholder="例如：偏临床回顾性研究，可获取本院病理样本；不做动物实验"
            rows={3}
          />
        </label>
        <label className="field">
          <span className="field-label">调研深度</span>
          <select data-testid="input-depth" value={depth} onChange={(e) => setDepth(e.target.value)}>
            <option value="deep">深入（多子方向 + 空白补检索 + 空白矩阵，推荐）</option>
            <option value="fast">快速（单轮检索，省额度更快）</option>
          </select>
        </label>
        <Dropzone
          testId="upload-doc"
          accept=".docx,.pdf,.txt,.md"
          label="附加文档（可选：已有综述/标书/草案）"
          hint="支持 Word/PDF/txt；内容会作为背景补充"
          mode="text"
          onText={(t, name) =>
            setBackground((prev) => (prev ? prev + "\n\n" : "") + `[附加文档：${name}]\n` + t)
          }
        />
        <div className="form-actions">
          <button className="btn-primary" onClick={() => submit()} disabled={!field.trim() || running} data-testid="run-btn">
            {running ? "调研中…" : "开始文献调研"}
          </button>
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

      {rewrite && !running && (
        <div className="rewrite-suggest" data-testid="rewrite-suggest">
          <div className="rewrite-title">PubMed 零命中 · AI 改写建议</div>
          {rewrite.tried_queries.length > 0 && (
            <details className="rewrite-tried">
              <summary>本次实际跑过的检索式（{rewrite.tried_queries.length} 个，均零命中）</summary>
              <ul>
                {rewrite.tried_queries.map((q, i) => (
                  <li key={i}><code>{q}</code></li>
                ))}
              </ul>
            </details>
          )}
          {rewrite.suggestion ? (
            <>
              <div className="rewrite-row">
                <span className="rewrite-label">建议方向</span>
                <span className="rewrite-value" data-testid="rewrite-field">{rewrite.suggestion.field}</span>
              </div>
              <div className="rewrite-row">
                <span className="rewrite-label">建议关键词</span>
                <span className="rewrite-value" data-testid="rewrite-keywords">{rewrite.suggestion.keywords || "（无）"}</span>
              </div>
              {rewrite.suggestion.reason && (
                <div className="rewrite-row">
                  <span className="rewrite-label">为什么这样改</span>
                  <span className="rewrite-value">{rewrite.suggestion.reason}</span>
                </div>
              )}
              <div className="rewrite-actions">
                <button className="btn-primary" onClick={acceptRewrite} data-testid="rewrite-accept">
                  采纳并重试
                </button>
                <button className="btn-ghost" onClick={dismissRewrite} data-testid="rewrite-dismiss">
                  我自己改
                </button>
              </div>
            </>
          ) : (
            <div className="rewrite-row">AI 未能生成有效建议，请手动调整方向或关键词后重试。</div>
          )}
        </div>
      )}

      {error && (
        <div className="result-error" data-testid="result-error">
          {error}
        </div>
      )}

      {refs.length > 0 && (
        <details className="refs" open data-testid="refs">
          <summary>检索到的文献（{refs.length} 篇，点击打开原文）</summary>
          <ol className="ref-list">
            {refs.map((r, i) => (
              <li key={r.pmid || r.url || i}>
                {r.source === "preprint" && <span className="ref-badge ref-badge-preprint">预印本</span>}
                {r.source === "europepmc" && <span className="ref-badge ref-badge-epmc">Europe PMC</span>}
                {r.source === "openalex" && <span className="ref-badge ref-badge-openalex">OpenAlex</span>}
                <a href={r.url} target="_blank" rel="noreferrer">
                  {r.first_author} ({r.year}). {r.title}
                </a>
                {r.journal && <span className="ref-journal"> — {r.journal}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}

      {(text || running) && (
        <div className="result-panel">
          <div className="result-toolbar">
            <span className="result-status">{running ? "生成中…" : "已完成"}</span>
            <div className="result-actions">
              {running && (
                <button className="btn-ghost" onClick={stop} data-testid="stop-btn">
                  停止
                </button>
              )}
              {text && !running && (
                <button
                  className="btn-ghost"
                  data-testid="send-to-plan-btn"
                  onClick={() => goto("plan", { "plan:idea": text })}
                >
                  用此结果做实验规划 →
                </button>
              )}
              {text && !running && (
                <button
                  className="btn-ghost"
                  data-testid="export-md-btn"
                  onClick={() => {
                    const refMd = refs.length
                      ? "\n\n## 参考文献\n" +
                        refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n")
                      : "";
                    downloadText(tsName("选题调研", "md"), text + refMd);
                  }}
                >
                  导出 Markdown
                </button>
              )}
            </div>
          </div>
          <div className="result-text" data-testid="result-text">
            {text ? <Markdown>{text}</Markdown> : <span className="result-placeholder">正在分析…</span>}
            {running && <span className="cursor-blink">▍</span>}
          </div>
        </div>
      )}

      {verify && !running && (
        verify.unverified.length === 0 ? (
          <div className="verify-ok" data-testid="verify">
            ✓ 引用核验：正文 {verify.total} 处文献引用均来自本次检索到的真实文献。
          </div>
        ) : (
          <div className="verify-bad" data-testid="verify">
            ⚠ 引用核验：发现 {verify.unverified.length} 处引用未出现在检索结果中，可能不准确，请核实：
            {verify.unverified.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer">
                {u}
              </a>
            ))}
          </div>
        )
      )}
    </div>
  );
}
