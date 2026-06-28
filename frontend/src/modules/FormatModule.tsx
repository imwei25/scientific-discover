import { useEffect, useRef, useState } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import ResultPanel from "../components/ResultPanel";
import Dropzone from "../components/Dropzone";
import RefIO from "../components/RefIO";
import type { Reference } from "../lib/sse";
import { downloadDocxFromText } from "../lib/download";
import { copyToClipboard } from "../lib/clipboard";
import DiffView from "../components/DiffView";

// 与 IdeaModule 同一套合并逻辑: DOI 优先, 兜底 title+year. 这里独立一份避免跨模块耦合.
function mergeRefs(existing: Reference[], incoming: Reference[]): { merged: Reference[]; added: number; dup: number } {
  const norm = (s: string) => (s || "").trim().toLowerCase();
  const keyOf = (r: Reference) => {
    const doi = norm(r.pmid && r.pmid.startsWith("10.") ? r.pmid : "");
    if (doi) return `doi:${doi}`;
    if (r.pmid) return `pmid:${norm(r.pmid)}`;
    return `tit:${norm(r.title)}|${norm(r.year)}`;
  };
  const seen = new Set(existing.map(keyOf));
  const merged = [...existing];
  let added = 0;
  let dup = 0;
  for (const r of incoming) {
    if (!r || (!r.title && !r.pmid)) { dup += 1; continue; }
    const k = keyOf(r);
    if (seen.has(k)) { dup += 1; continue; }
    seen.add(k);
    merged.push(r);
    added += 1;
  }
  return { merged, added, dup };
}

// 把一条 Reference 渲染回纯文本, 用于追加到参考文献输入框 (粗略 Vancouver 形态).
function refToLine(r: Reference): string {
  const parts: string[] = [];
  if (r.first_author) parts.push(r.first_author);
  if (r.year) parts.push(`(${r.year})`);
  if (r.title) parts.push(r.title + (r.title.endsWith(".") ? "" : "."));
  if (r.journal) parts.push(r.journal + ".");
  if (r.url) parts.push(r.url);
  return parts.join(" ").trim();
}

interface Journal {
  id: string;
  name: string;
  summary: string;
}

interface RefCheckItem {
  raw: string;
  doi: string;
  pmid: string;
  title: string;
  status: string; // real | not_found | retracted | unverifiable
  note: string;
  completed: string;
  duplicate_of?: number;
}

const REFCHECK_BADGE: Record<string, { label: string; cls: string }> = {
  real: { label: "✓ 真实", cls: "rc-real" },
  not_found: { label: "✗ 查无此文献", cls: "rc-bad" },
  retracted: { label: "⚠ 已撤稿", cls: "rc-warn" },
  unverifiable: { label: "? 无法核验", cls: "rc-gray" },
};

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

  // 参考文献核验(真实性/撤稿/去重/补全)
  const [checkResult, setCheckResult] = usePersistentState<RefCheckItem[]>("format:refcheck", []);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);

  // 引用文件双向导入导出: 用户从 EndNote/Zotero 导入的结构化引用 + 用于导出.
  const [importedRefs, setImportedRefs] = usePersistentState<Reference[]>("format:importedRefs", []);
  const [importNote, setImportNote] = useState("");
  // 导出来源: 已导入的引用 + 核验结果(真实条目, 已带 doi/pmid/title), 取并集.
  const exportableRefs: Reference[] = (() => {
    const fromCheck: Reference[] = (checkResult || [])
      .filter((it) => !it.duplicate_of && (it.title || it.doi || it.pmid))
      .map((it) => ({
        pmid: it.doi || it.pmid || "",
        title: it.title || it.raw || "",
        first_author: "",
        journal: "",
        year: "",
        url: it.doi ? `https://doi.org/${it.doi}` : (it.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${it.pmid}/` : ""),
      }));
    return mergeRefs(importedRefs, fromCheck).merged;
  })();

  const checkRefs = async () => {
    if (!refsInput.trim() || checkBusy) return;
    setCheckBusy(true);
    setCheckErr(null);
    setCheckResult([]);
    try {
      const resp = await fetch(apiUrl("/api/check-refs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ references: refsInput }),
      });
      const d = await resp.json();
      if (d.ok) setCheckResult(d.items || []);
      else setCheckErr(d.error || "核验失败");
    } catch (e) {
      setCheckErr(`核验失败：${(e as Error).message}`);
    } finally {
      setCheckBusy(false);
      window.dispatchEvent(new Event("usage-updated"));
    }
  };

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

  // W2-3 Diff: 排版前快照原稿, 完成后弹 DiffView 让用户接受/拒绝。
  const [diffOpen, setDiffOpen] = useState(false);
  const [originalSnapshot, setOriginalSnapshot] = useState("");
  const prevRunning = useRef(running);
  useEffect(() => {
    // 从 running 真→假 且无错误 且 text 非空 → 弹 diff
    if (prevRunning.current && !running && !error && text && originalSnapshot) {
      setDiffOpen(true);
    }
    prevRunning.current = running;
  }, [running, error, text, originalSnapshot]);

  const submit = () => {
    if (!manuscript.trim() || !journalId || running) return;
    setOriginalSnapshot(manuscript);  // 记录原文, 用于稍后 diff
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
    setDlErr(null);
    try {
      await downloadDocxFromText("cover-letter.docx", cover.text);
    } catch (e) {
      setDlErr(`导出 Word 失败：${(e as Error).message}`);
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
    setCheckResult([]);
    setCheckErr(null);
    setImportedRefs([]);
    setImportNote("");
  };

  const [dlErr, setDlErr] = useState<string | null>(null);
  const downloadDocx = async () => {
    if (!text || downloading) return;
    setDownloading(true);
    setDlErr(null);
    try {
      await downloadDocxFromText("manuscript.docx", text, { journal_id: journalId, references: fmtRefs });
    } catch (e) {
      setDlErr(`导出 Word 失败：${(e as Error).message}`);
    } finally {
      setDownloading(false);
    }
  };

  const selected = journals.find((j) => j.id === journalId);

  return (
    <div className="module">
      <DiffView
        open={diffOpen}
        original={originalSnapshot}
        modified={text}
        title="AI 重排后的稿件 · 对比"
        onAccept={() => {
          // 接受: 把重排后的稿件回填到 manuscript 输入框, 关闭 diff
          setManuscript(text);
          setDiffOpen(false);
        }}
        onReject={() => {
          // 拒绝: 保留原稿, 清空 text(不影响 history 已存的旧记录)
          setText("");
          setDiffOpen(false);
        }}
      />
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
      {dlErr && <div className="result-error" data-testid="dl-error">{dlErr}</div>}

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
      <RefIO
        currentRefs={exportableRefs}
        exportFilename="期刊排版-参考文献"
        onImport={(imported) => {
          const { merged, added, dup } = mergeRefs(importedRefs, imported);
          setImportedRefs(merged);
          // 同时把导入条目以文本形式追加到 refsInput, 直接可用于格式化/核验.
          if (added > 0) {
            const lines = imported
              .filter((r) => r && (r.title || r.pmid))
              .map(refToLine)
              .filter(Boolean)
              .join("\n");
            if (lines) {
              setRefsInput((prev) => (prev && prev.trim() ? prev.trimEnd() + "\n" + lines : lines));
            }
          }
          setImportNote(`导入 ${added} 篇，去重 ${dup} 篇`);
          window.setTimeout(() => setImportNote(""), 4000);
        }}
      />
      {importNote && (
        <div className="status-line" data-testid="refio-import-note">{importNote}</div>
      )}
      {importedRefs.length > 0 && (
        <details className="refs" data-testid="imported-refs">
          <summary>已导入的引用（{importedRefs.length} 篇，可在下方文本中编辑或直接导出）</summary>
          <ol className="ref-list">
            {importedRefs.map((r, i) => (
              <li key={(r.pmid || r.url || "") + i}>
                {r.first_author && <>{r.first_author} </>}
                {r.year && <>({r.year}) </>}
                {r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.title || r.url}</a> : (r.title || r.pmid)}
                {r.journal && <span className="ref-journal"> — {r.journal}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
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
        <div className="form-actions">
          <button
            className="btn-primary"
            onClick={formatRefs}
            disabled={!refsInput.trim() || refsBusy}
            data-testid="format-refs-btn"
          >
            {refsBusy ? "格式化中…" : "按该期刊格式化参考文献"}
          </button>
          <button
            className="btn-secondary"
            onClick={checkRefs}
            disabled={!refsInput.trim() || checkBusy}
            data-testid="check-refs-btn"
          >
            {checkBusy ? "核验中…" : "核验真实性 / 撤稿 / 去重"}
          </button>
        </div>
      </div>

      {checkErr && (
        <div className="result-error" data-testid="refcheck-error">
          {checkErr}
        </div>
      )}

      {checkResult.length > 0 && (
        <div className="result-panel" data-testid="refcheck">
          <div className="result-toolbar">
            <span className="result-status">
              核验 {checkResult.length} 条 ·
              {" "}真实 {checkResult.filter((x) => x.status === "real" && !x.duplicate_of).length}
              {" "}/ 问题 {checkResult.filter((x) => x.status === "not_found" || x.status === "retracted" || x.duplicate_of).length}
            </span>
          </div>
          <ol className="ref-list" data-testid="refcheck-list">
            {checkResult.map((it, i) => {
              const b = it.duplicate_of
                ? { label: `⧉ 与第${it.duplicate_of}条重复`, cls: "rc-gray" }
                : REFCHECK_BADGE[it.status] || REFCHECK_BADGE.unverifiable;
              return (
                <li key={i}>
                  <span className={`ref-badge ${b.cls}`}>{b.label}</span>
                  {it.title || it.raw}
                  {it.doi && <span className="ref-journal"> — {it.doi}</span>}
                  {it.note && <span className="refcheck-note">{it.note}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}

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
