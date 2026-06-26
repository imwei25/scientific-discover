import { useRef, useState } from "react";
import { streamIdea, Reference } from "../lib/sse";
import Markdown from "../components/Markdown";
import Dropzone from "../components/Dropzone";
import { downloadText, tsName } from "../lib/download";
import { usePersistentState } from "../lib/usePersistentState";
import type { Goto } from "../App";

export default function IdeaModule({ goto }: { goto: Goto }) {
  const [field, setField] = usePersistentState("idea:field", "");
  const [keywords, setKeywords] = usePersistentState("idea:keywords", "");
  const [background, setBackground] = usePersistentState("idea:background", "");

  const [status, setStatus] = useState("");
  const [refs, setRefs] = usePersistentState<Reference[]>("idea:refs", []);
  const [text, setText] = usePersistentState("idea:result", "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const submit = async () => {
    if (!field.trim() || running) return;
    setStatus("");
    setRefs([]);
    setText("");
    setError(null);
    setRunning(true);
    ctrl.current = new AbortController();
    await streamIdea(
      { field, keywords, background },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onReferences: setRefs,
        onDelta: (t) => setText((p) => p + t),
        onError: (m) => {
          setError(m);
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
    setStatus("");
    setError(null);
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>💡 找选题 · 医学/药学/生物</h1>
        <p>
          我会实际检索 <strong>PubMed</strong> 真实文献，梳理该方向已有哪些工作、还缺什么，
          再给出有文献支撑的候选选题。文中引用均为可点击的文献链接。
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
          <button className="btn-primary" onClick={submit} disabled={!field.trim() || running} data-testid="run-btn">
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

      {error && (
        <div className="result-error" data-testid="result-error">
          {error}
        </div>
      )}

      {refs.length > 0 && (
        <details className="refs" open data-testid="refs">
          <summary>检索到的文献（{refs.length} 篇，点击可打开 PubMed）</summary>
          <ol className="ref-list">
            {refs.map((r) => (
              <li key={r.pmid}>
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
    </div>
  );
}
