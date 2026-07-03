import { useEffect, useRef, useState } from "react";
import { streamPoster, type PosterContent } from "../lib/sse";
import { reportLLMError } from "../lib/errorToast";
import { usePersistentState, readPersisted } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import Dropzone from "../components/Dropzone";
import { downloadText, tsName } from "../lib/download";

// 数据分析模块持久化的图表形态(与 sse.ts ChartItem 一致)。
type Chart = { png: string; data?: string; ext?: string };

export default function PosterModule() {
  const [title, setTitle] = usePersistentState("poster:title", "");
  const [authors, setAuthors] = usePersistentState("poster:authors", "");
  const [affiliation, setAffiliation] = usePersistentState("poster:affiliation", "");
  const [lang, setLang] = usePersistentState("poster:lang", "zh");
  const [content, setContent] = usePersistentState("poster:content", "");
  const [includeFigs, setIncludeFigs] = usePersistentState("poster:includeFigs", true);

  const [html, setHtml] = usePersistentState("poster:html", "");
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadInfo, setUploadInfo] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const ctrl = useRef<AbortController | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // 可复用的数据分析图表数量(用于提示是否能带图)
  const figCount = (readPersisted<Chart[]>("analyze:charts", []) || []).length;

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && html && savedRef.current !== html) {
      savedRef.current = html;
      addHistory({
        module: "poster",
        icon: "🖼️",
        title: (title || content).slice(0, 40) || "学术海报",
        data: {
          "poster:title": title, "poster:authors": authors, "poster:affiliation": affiliation,
          "poster:lang": lang, "poster:content": content, "poster:html": html,
        },
      });
    }
  }, [running, error, html, title]);

  const importFromModules = () => {
    const draft = readPersisted("imrad:draft", "") as string;
    const abstract = readPersisted("imrad:abstract", "") as string;
    const concl = readPersisted("analyze:conclusion", "") as string;
    const idea = readPersisted("idea:result", "") as string;
    const pick = [abstract, draft, concl, idea].find((x) => x && x.trim());
    if (pick) {
      setContent((p) => p || pick);
      setImportMsg("已从已有模块导入材料（摘要/初稿/分析结论/选题，取第一份非空）。");
    } else {
      setImportMsg("未找到可导入的材料，请先在论文初稿/数据分析等模块生成结果。");
    }
  };

  const collectFigures = (): string[] => {
    if (!includeFigs) return [];
    const charts = readPersisted<Chart[]>("analyze:charts", []) || [];
    return charts.map((c) => c?.png).filter((s): s is string => !!s).slice(0, 6);
  };

  const submit = async () => {
    if (running) return;
    if (!content.trim()) {
      setError("请粘贴/上传论文内容，或点“从已有模块导入”。");
      return;
    }
    setStatus("");
    setError(null);
    setHtml("");
    setRunning(true);
    ctrl.current = new AbortController();
    await streamPoster(
      { content, title, authors, affiliation, lang, figures: collectFigures() },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onPoster: (_c: PosterContent, h: string) => setHtml(h),
        onError: (m) => {
          setError(m);
          setStatus("");
          setRunning(false);
          reportLLMError(m);
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
    setStatus("");
  };

  const reset = () => {
    if (running) stop();
    setTitle("");
    setAuthors("");
    setAffiliation("");
    setContent("");
    setHtml("");
    setError(null);
    setStatus("");
    setUploadInfo("");
    setImportMsg("");
  };

  const printPoster = () => {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      win.focus();
      win.print();
    }
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>🖼️ 学术海报</h1>
        <p>
          把一篇论文/稿件提炼成一张<strong>会议学术海报</strong>：AI 只据你的材料提炼要点（
          <strong>不编造数字与文献</strong>），版面由确定性模板渲染成自包含 HTML，可直接
          <strong>打印或另存为 PDF</strong>。可选带上数据分析已生成的图表。
        </p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">海报标题（可选，留空则由 AI 提炼）</span>
          <input data-testid="poster-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：二甲双胍对2型糖尿病合并NAFLD肝纤维化的疗效" />
        </label>
        <div className="chart-opts">
          <label className="field-inline" style={{ flex: 1 }}>
            作者
            <input data-testid="poster-authors" value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="张三, 李四" style={{ width: "100%" }} />
          </label>
          <label className="field-inline" style={{ flex: 1 }}>
            单位
            <input data-testid="poster-affiliation" value={affiliation} onChange={(e) => setAffiliation(e.target.value)} placeholder="某某医院 / 某某大学" style={{ width: "100%" }} />
          </label>
          <label className="field-inline">
            语言
            <select data-testid="poster-lang" value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <Dropzone
          testId="poster-upload"
          accept=".docx,.pdf,.txt,.md"
          label="上传论文（可选：Word/PDF/txt/Markdown）"
          hint="上传后自动解析为文本填入下方内容框"
          mode="text"
          onText={(text, filename, truncated) => {
            setContent((p) => (p ? p + "\n\n" : "") + text);
            setUploadInfo(`已导入：${filename}${truncated ? "（内容较长已截断）" : ""}`);
          }}
        />
        {uploadInfo && <span className="file-name" data-testid="poster-upload-info">{uploadInfo}</span>}
        <div className="form-actions">
          <button className="btn-secondary" onClick={importFromModules} data-testid="poster-import-btn">
            ↩ 从已有模块导入材料
          </button>
          {figCount > 0 && (
            <label className="field-inline" data-testid="poster-figs-toggle">
              <input type="checkbox" checked={includeFigs} onChange={(e) => setIncludeFigs(e.target.checked)} data-testid="poster-include-figs" />
              带上数据分析的 {figCount} 张图表
            </label>
          )}
        </div>
        {importMsg && <span className="field-hint" data-testid="poster-import-msg">{importMsg}</span>}
        <label className="field">
          <span className="field-label">论文内容（粘贴摘要/正文，或用上面的上传/导入）</span>
          <textarea data-testid="poster-content" value={content} onChange={(e) => setContent(e.target.value)} rows={8} placeholder="粘贴论文的摘要与主要内容；内容越完整，海报要点越准确。" />
        </label>
        <div className="form-actions">
          <button className="btn-primary" onClick={submit} disabled={running} data-testid="run-btn">
            {running ? "生成中…" : "生成海报"}
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">清空</button>
        </div>
      </div>

      {status && (
        <div className="status-line" data-testid="status-line">
          <span className="spinner" /> {status}
        </div>
      )}
      {error && <div className="result-error" data-testid="poster-error">{error}</div>}

      {(html || running) && (
        <div className="result-panel" data-testid="poster-panel">
          <div className="result-toolbar">
            <span className="result-status">{running ? "生成中…" : html ? "已完成" : "等待开始"}</span>
            <div className="result-actions">
              {running && <button className="btn-ghost" onClick={stop} data-testid="stop-btn">停止</button>}
              {html && !running && (
                <button className="btn-ghost" data-testid="poster-print-btn" onClick={printPoster} title="打印或在打印对话框里另存为 PDF">
                  打印 / 存 PDF
                </button>
              )}
              {html && !running && (
                <button className="btn-ghost" data-testid="poster-export-html-btn" onClick={() => downloadText(tsName("学术海报", "html"), html, "text/html")}>
                  下载 HTML
                </button>
              )}
            </div>
          </div>
          {html && (
            <iframe
              ref={iframeRef}
              data-testid="poster-preview"
              title="海报预览"
              srcDoc={html}
              style={{ width: "100%", height: 620, border: "1px solid #dbe4e2", borderRadius: 8, background: "#d8dedd" }}
            />
          )}
        </div>
      )}
    </div>
  );
}
