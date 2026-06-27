import { useEffect, useRef, useState } from "react";
import { streamRebuttal, ReviewComment } from "../lib/sse";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import Markdown from "../components/Markdown";
import Dropzone from "../components/Dropzone";
import { downloadText, tsName } from "../lib/download";

export default function RebuttalModule() {
  const [reviews, setReviews] = usePersistentState("rebuttal:reviews", "");
  const [manuscript, setManuscript] = usePersistentState("rebuttal:manuscript", "");
  const [tone, setTone] = usePersistentState("rebuttal:tone", "balanced");

  const [status, setStatus] = useState("");
  const [comments, setComments] = usePersistentState<ReviewComment[]>("rebuttal:comments", []);
  const [letter, setLetter] = usePersistentState("rebuttal:letter", "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && letter && savedRef.current !== letter) {
      savedRef.current = letter;
      addHistory({
        module: "rebuttal",
        icon: "✍️",
        title: reviews.slice(0, 40) || "回复审稿",
        data: {
          "rebuttal:reviews": reviews,
          "rebuttal:manuscript": manuscript,
          "rebuttal:comments": comments,
          "rebuttal:letter": letter,
        },
      });
    }
  }, [running, error, letter, reviews, manuscript, comments]);

  const submit = async () => {
    if (!reviews.trim() || running) return;
    setStatus("");
    setComments([]);
    setLetter("");
    setError(null);
    setRunning(true);
    ctrl.current = new AbortController();
    await streamRebuttal(
      { reviews, manuscript, tone },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onComments: setComments,
        onDelta: (t) => setLetter((p) => p + t),
        onError: (m) => {
          setError(m);
          setStatus("");
          setRunning(false);
        },
        onDone: () => {
          setStatus("");
          setRunning(false);
          window.dispatchEvent(new Event("usage-updated"));
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
    setReviews("");
    setManuscript("");
    setComments([]);
    setLetter("");
    setError(null);
    setStatus("");
  };

  const downloadDocx = async () => {
    if (!letter || downloading) return;
    setDownloading(true);
    try {
      const resp = await fetch(apiUrl("/api/docx"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: letter, journal_id: "", references: [] }),
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rebuttal.docx";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>✍️ 回复审稿意见 · Rebuttal</h1>
        <p>
          粘贴审稿意见（可选附稿件），AI 会把意见<strong>逐条拆解</strong>并生成 point-by-point 回复信草稿（含回应与正文修改建议）。
          全程<strong>本地处理、数据不出网</strong>，适合未发表稿件与保密审稿意见。
        </p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">审稿意见 <em>必填</em></span>
          <textarea
            data-testid="input-reviews"
            value={reviews}
            onChange={(e) => setReviews(e.target.value)}
            placeholder="把审稿人/编辑的意见整段粘贴到这里（可包含 Reviewer 1、Reviewer 2 等）"
            rows={6}
          />
        </label>
        <Dropzone
          testId="upload-reviews"
          accept=".docx,.pdf,.txt,.md"
          label="或上传审稿意见文件（可选）"
          hint="支持 Word/PDF/txt；内容会追加到上面的审稿意见"
          mode="text"
          onText={(t, name) => setReviews((prev) => (prev ? prev + "\n\n" : "") + `[${name}]\n` + t)}
        />
        <label className="field">
          <span className="field-label">稿件全文（可选，强烈建议：便于精准定位修改处、避免泛泛而谈）</span>
          <textarea
            data-testid="input-manuscript"
            value={manuscript}
            onChange={(e) => setManuscript(e.target.value)}
            placeholder="可粘贴稿件正文，或用下方上传"
            rows={3}
          />
        </label>
        <Dropzone
          testId="upload-manuscript"
          accept=".docx,.pdf,.txt,.md"
          label="上传稿件（可选）"
          hint="支持 Word/PDF/txt；内容会填入上面的稿件全文"
          mode="text"
          onText={(t) => setManuscript(t)}
        />
        <label className="field">
          <span className="field-label">回复语气</span>
          <select data-testid="input-tone" value={tone} onChange={(e) => setTone(e.target.value)}>
            <option value="balanced">谦逊建设性（尽量采纳，温和说明分歧）</option>
            <option value="firm">礼貌而坚定（有理有据地反驳不认同之处）</option>
          </select>
        </label>
        <div className="form-actions">
          <button className="btn-primary" onClick={submit} disabled={!reviews.trim() || running} data-testid="run-btn">
            {running ? "生成中…" : "生成逐条回复"}
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
        <div className="result-error" data-testid="rebuttal-error">
          {error}
        </div>
      )}

      {comments.length > 0 && (
        <details className="refs" open data-testid="comments">
          <summary>识别到的审稿意见（{comments.length} 条）</summary>
          <ol className="ref-list">
            {comments.map((c, i) => (
              <li key={i}>
                <span className="ref-badge ref-badge-epmc">{c.reviewer}</span>
                {c.type && <span className="ref-badge ref-badge-openalex">{c.type}</span>}
                {c.comment}
              </li>
            ))}
          </ol>
        </details>
      )}

      {(letter || (running && !error)) && (
        <>
          <h2 className="section-title">逐条回复信草稿</h2>
          <div className="result-panel">
            <div className="result-toolbar">
              <span className="result-status">{running ? "生成中…" : "已完成"}</span>
              {running && (
                <button className="btn-ghost" onClick={stop} data-testid="stop-btn">
                  停止
                </button>
              )}
              {letter && !running && (
                <button
                  className="btn-ghost"
                  data-testid="export-md-btn"
                  onClick={() => downloadText(tsName("审稿回复", "md"), letter)}
                >
                  导出 Markdown
                </button>
              )}
              {letter && !running && (
                <button className="btn-ghost" onClick={downloadDocx} disabled={downloading} data-testid="download-docx-btn">
                  {downloading ? "导出中…" : "导出 Word"}
                </button>
              )}
            </div>
            <div className="result-text" data-testid="result-text">
              {letter ? <Markdown>{letter}</Markdown> : <span className="result-placeholder">正在撰写…</span>}
              {running && <span className="cursor-blink">▍</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
