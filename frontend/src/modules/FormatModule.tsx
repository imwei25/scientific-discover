import { useEffect, useState } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { apiUrl } from "../lib/api";
import ResultPanel from "../components/ResultPanel";
import Dropzone from "../components/Dropzone";

interface Journal {
  id: string;
  name: string;
  summary: string;
}

export default function FormatModule() {
  const [journals, setJournals] = useState<Journal[]>([]);
  const [journalId, setJournalId] = usePersistentState("format:journal", "");
  const [manuscript, setManuscript] = usePersistentState("format:manuscript", "");
  const [downloading, setDownloading] = useState(false);
  const { text, running, error, start, stop, setText } = useStream("format:result");

  useEffect(() => {
    fetch(apiUrl("/api/journals"))
      .then((r) => r.json())
      .then((d) => {
        setJournals(d.journals || []);
        // 仅在尚未选择(或上次选择已失效)时, 默认选第一个
        setJournalId((prev) =>
          prev && d.journals?.some((j: Journal) => j.id === prev) ? prev : d.journals?.[0]?.id ?? "",
        );
      })
      .catch(() => setJournals([]));
  }, [setJournalId]);

  const submit = () => {
    if (!manuscript.trim() || !journalId || running) return;
    start("format", { manuscript, journal_id: journalId });
  };

  const reset = () => {
    if (running) stop();
    setManuscript("");
    setText("");
  };

  const downloadDocx = async () => {
    if (!text || downloading) return;
    setDownloading(true);
    try {
      const resp = await fetch(apiUrl("/api/docx"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, journal_id: journalId }),
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "manuscript.docx";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const selected = journals.find((j) => j.id === journalId);

  return (
    <div className="module">
      <header className="module-head">
        <h1>📄 期刊排版</h1>
        <p>粘贴你的稿件，选择目标期刊，我按该刊的结构与格式要求重排，并导出 Word 文件。</p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">目标期刊</span>
          <select
            data-testid="input-journal"
            value={journalId}
            onChange={(e) => setJournalId(e.target.value)}
          >
            {journals.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
          {selected && <span className="field-hint">{selected.summary}</span>}
        </label>
        <Dropzone
          testId="upload-manuscript"
          accept=".docx,.pdf,.txt,.md"
          label="上传稿件文件（可选，自动填入下方）"
          hint="支持 Word(.docx) / PDF / txt；也可直接在下方粘贴"
          mode="text"
          onText={(t) => setManuscript(t)}
        />
        <label className="field">
          <span className="field-label">稿件内容 <em>必填</em></span>
          <textarea
            data-testid="input-manuscript"
            value={manuscript}
            onChange={(e) => setManuscript(e.target.value)}
            placeholder="把你的论文正文粘贴到这里，或用上方上传 Word/PDF 自动填入"
            rows={8}
          />
        </label>
        <div className="form-actions">
          <button
            className="btn-primary"
            onClick={submit}
            disabled={!manuscript.trim() || !journalId || running}
            data-testid="run-btn"
          >
            {running ? "重排中…" : "按该期刊重排"}
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">
            清空
          </button>
        </div>
      </div>

      <ResultPanel
        text={text}
        running={running}
        error={error}
        onStop={stop}
        exportName="排版稿"
        placeholder="重排后的稿件会显示在这里，并附上格式变更说明。"
      />

      {text && !running && (
        <button className="btn-secondary" onClick={downloadDocx} disabled={downloading} data-testid="download-btn">
          {downloading ? "正在生成…" : "⬇ 下载 Word 文件"}
        </button>
      )}
    </div>
  );
}
