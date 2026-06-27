import { useEffect, useRef, useState } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import ResultPanel from "../components/ResultPanel";
import Dropzone from "../components/Dropzone";
import { copyToClipboard } from "../lib/clipboard";

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
  // 投稿包: 预提交体检 + 投稿信(各自独立流)
  const precheck = useStream("format:precheck");
  const cover = useStream("format:cover");
  const [coverDocxBusy, setCoverDocxBusy] = useState(false);

  // 参考文献格式化(CSL)
  const [refsInput, setRefsInput] = usePersistentState("format:refs", "");
  const [fmtRefs, setFmtRefs] = usePersistentState<string[]>("format:fmtRefs", []);
  const [refsBusy, setRefsBusy] = useState(false);
  const [refsErr, setRefsErr] = useState<string | null>(null);

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "format",
        icon: "📄",
        title: manuscript.slice(0, 40) || "期刊排版",
        data: { "format:manuscript": manuscript, "format:journal": journalId, "format:result": text },
      });
    }
  }, [running, error, text, manuscript, journalId]);

  const formatRefs = async () => {
    if (!refsInput.trim() || refsBusy) return;
    setRefsBusy(true);
    setRefsErr(null);
    setFmtRefs([]);
    try {
      const resp = await fetch(apiUrl("/api/format-refs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ references: refsInput, journal_id: journalId }),
      });
      const d = await resp.json();
      if (d.ok) setFmtRefs(d.formatted || []);
      else setRefsErr(d.error || "格式化失败");
    } catch (e) {
      setRefsErr(`格式化失败：${(e as Error).message}`);
    } finally {
      setRefsBusy(false);
    }
  };

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

  const runPrecheck = () => {
    if (!manuscript.trim() || !journalId || precheck.running) return;
    precheck.start("precheck", { manuscript, journal_id: journalId });
  };
  const runCover = () => {
    if (!manuscript.trim() || !journalId || cover.running) return;
    cover.start("coverletter", { manuscript, journal_id: journalId });
  };
  const downloadCover = async () => {
    if (!cover.text || coverDocxBusy) return;
    setCoverDocxBusy(true);
    try {
      const resp = await fetch(apiUrl("/api/docx"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cover.text, journal_id: "", references: [] }),
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cover-letter.docx";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setCoverDocxBusy(false);
    }
  };

  const reset = () => {
    if (running) stop();
    if (precheck.running) precheck.stop();
    if (cover.running) cover.stop();
    setManuscript("");
    setText("");
    precheck.setText("");
    cover.setText("");
    setRefsInput("");
    setFmtRefs([]);
    setRefsErr(null);
  };

  const downloadDocx = async () => {
    if (!text || downloading) return;
    setDownloading(true);
    try {
      const resp = await fetch(apiUrl("/api/docx"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, journal_id: journalId, references: fmtRefs }),
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
          {downloading ? "正在生成…" : fmtRefs.length ? "⬇ 下载 Word 文件（含格式化参考文献）" : "⬇ 下载 Word 文件"}
        </button>
      )}

      <h2 className="section-title">🚀 投稿包（投稿前自查 + 投稿信）</h2>
      <p className="section-hint">
        基于上面的稿件与目标期刊：一键做<strong>预提交体检</strong>（必需章节/声明/字数/参考文献是否齐全），
        并自动生成<strong>投稿信（Cover Letter）</strong>。
      </p>
      <div className="form-actions">
        <button
          className="btn-primary"
          onClick={runPrecheck}
          disabled={!manuscript.trim() || !journalId || precheck.running}
          data-testid="precheck-btn"
        >
          {precheck.running ? "体检中…" : "预提交体检"}
        </button>
        <button
          className="btn-secondary"
          onClick={runCover}
          disabled={!manuscript.trim() || !journalId || cover.running}
          data-testid="cover-btn"
        >
          {cover.running ? "生成中…" : "生成投稿信"}
        </button>
      </div>

      {(precheck.text || precheck.running || precheck.error) && (
        <>
          <h3 className="section-title" data-testid="precheck-title">✅ 预提交体检</h3>
          <ResultPanel
            text={precheck.text}
            running={precheck.running}
            error={precheck.error}
            onStop={precheck.stop}
            exportName="预提交体检"
            placeholder="必需章节/声明/字数/参考文献等检查结果会显示在这里。"
            panelTestId="precheck-panel"
          />
        </>
      )}

      {(cover.text || cover.running || cover.error) && (
        <>
          <h3 className="section-title" data-testid="cover-title">✉️ 投稿信</h3>
          <ResultPanel
            text={cover.text}
            running={cover.running}
            error={cover.error}
            onStop={cover.stop}
            exportName="投稿信"
            placeholder="投稿信草稿会显示在这里。"
            onExportDocx={downloadCover}
            exportingDocx={coverDocxBusy}
            panelTestId="cover-panel"
          />
        </>
      )}

      <h2 className="section-title">参考文献格式化</h2>
      <p className="section-hint">
        粘贴你的参考文献，按所选期刊的引用规范（如 Vancouver、GB/T 7714、IEEE 等）自动排好。
        采用标准 CSL 引用引擎渲染，格式准确。
      </p>
      <div className="form">
        <label className="field">
          <span className="field-label">参考文献（每条一行，或整段粘贴）</span>
          <textarea
            data-testid="input-refs"
            value={refsInput}
            onChange={(e) => setRefsInput(e.target.value)}
            placeholder="例如：Cortes J, et al. Pembrolizumab plus chemotherapy ... Lancet 2020;396(10265):1817-1828."
            rows={5}
          />
        </label>
        <button
          className="btn-primary"
          onClick={formatRefs}
          disabled={!refsInput.trim() || refsBusy}
          data-testid="format-refs-btn"
        >
          {refsBusy ? "格式化中…" : "按该期刊格式化参考文献"}
        </button>
      </div>

      {refsErr && (
        <div className="result-error" data-testid="refs-error">
          {refsErr}
        </div>
      )}

      {fmtRefs.length > 0 && (
        <div className="result-panel">
          <div className="result-toolbar">
            <span className="result-status">已格式化 {fmtRefs.length} 条</span>
            <button
              className="btn-ghost"
              data-testid="copy-refs-btn"
              onClick={() => copyToClipboard(fmtRefs.join("\n"))}
            >
              复制全部
            </button>
          </div>
          <div className="fmt-refs" data-testid="fmt-refs">
            {fmtRefs.map((r, i) => (
              <p key={i}>{r}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
