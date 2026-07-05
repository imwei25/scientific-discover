import { useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";

export interface FollowupItem { q: string; a: string; }

interface Props {
  followups: FollowupItem[];
  onAddFollowup: (item: FollowupItem) => void;
  onReviseReport: (revised: string) => void;
  onVerifyUpdate?: (verify: unknown) => void;
  streamFn: (
    payload: {
      mode: "ask" | "revise"; question: string; report: string;
      references: unknown[]; evidence: unknown[]; english_report: boolean;
    },
    callbacks: {
      signal: AbortSignal;
      onDelta: (t: string) => void;
      onVerify?: (v: unknown) => void;
      onError: (msg: string) => void;
      onDone: () => void;
    },
  ) => Promise<void>;
  currentReport: string;
  references: unknown[];
  evidence: unknown[];
  englishReport: boolean;
  disabled?: boolean;
  testId?: string;
}

export default function FollowupPanel(props: Props) {
  const {
    followups, onAddFollowup, onReviseReport, onVerifyUpdate,
    streamFn, currentReport, references, evidence, englishReport,
    disabled, testId = "followup",
  } = props;

  const [input, setInput] = useState("");
  const [current, setCurrent] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // 卸载时中止在途请求, 避免父组件重置 (runSearch / reset) 后 stale delta 反填。
  useEffect(() => () => { ctrl.current?.abort(); }, []);

  const run = async (mode: "ask" | "revise") => {
    const q = input.trim();
    if (!q || running || disabled) return;
    setError(null);
    setRunning(true);
    ctrl.current = new AbortController();
    let buf = "";
    if (mode === "ask") setCurrent("…"); else onReviseReport("");
    await streamFn(
      { mode, question: q, report: currentReport, references, evidence, english_report: englishReport },
      {
        signal: ctrl.current.signal,
        onDelta: (t) => {
          buf += t;
          if (mode === "ask") setCurrent(buf);
          else onReviseReport(currentReport + buf);
        },
        onVerify: (v) => { if (mode === "revise" && onVerifyUpdate) onVerifyUpdate(v); },
        onError: (m) => { setError(m); setRunning(false); },
        onDone: () => {
          if (mode === "ask") { onAddFollowup({ q, a: buf }); setCurrent(""); }
          setInput(""); setRunning(false);
        },
      },
    );
    setRunning(false);
  };

  return (
    <div className="followup" data-testid={testId}>
      <div className="followup-head">追问 / 修改意见</div>
      <p className="followup-tip">
        可针对某篇文献或某条结论追问, 或提出意见让 AI 修订报告。回答仍只基于本次检索到的真实文献。
      </p>
      {followups.length > 0 && (
        <div className="qa-list" data-testid={`${testId}-list`}>
          {followups.map((qa, i) => (
            <div key={i} className="qa-item">
              <div className="qa-q">❓ {qa.q}</div>
              <div className="qa-a"><Markdown>{qa.a}</Markdown></div>
            </div>
          ))}
        </div>
      )}
      {running && current && (
        <div className="qa-item">
          <div className="qa-a"><Markdown>{current}</Markdown><span className="cursor-blink">▍</span></div>
        </div>
      )}
      <textarea
        data-testid={`${testId}-input`}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="例如: 第 3 篇的样本量是多少? / 请把结论段扩写一些"
        rows={2}
        disabled={running}
      />
      {error && <div className="result-error">{error}</div>}
      <div className="form-actions">
        <button className="btn-primary" data-testid={`${testId}-ask`} onClick={() => run("ask")} disabled={!input.trim() || running || disabled}>追问</button>
        <button className="btn-ghost" data-testid={`${testId}-revise`} onClick={() => run("revise")} disabled={!input.trim() || running || disabled}>按此修改报告</button>
        {running && (
          <button className="btn-ghost" data-testid={`${testId}-stop`} onClick={() => { ctrl.current?.abort(); setRunning(false); }}>停止</button>
        )}
        {running && <span className="status-line"><span className="spinner" /> 处理中…</span>}
      </div>
    </div>
  );
}
