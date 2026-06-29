import { useRef, useState } from "react";
import type { Reference } from "../lib/sse";
import { apiUrl } from "../lib/api";

// 引用文件双向导入导出。
// - 导入: .ris / .bib / .enw → multipart POST /api/refs/import → onImport(refs)
// - 导出: 当前 refs + 选定格式 → JSON POST /api/refs/export → 下载字节流
export interface RefIOProps {
  currentRefs: Reference[];
  onImport: (imported: Reference[]) => void;
  exportFilename?: string; // 不含扩展名, 默认 "references"
}

type RefFormat = "ris" | "bib" | "enw";

const FORMATS: { key: RefFormat; label: string; ext: string }[] = [
  { key: "ris", label: "RIS (.ris) · EndNote/Zotero", ext: ".ris" },
  { key: "bib", label: "BibTeX (.bib) · LaTeX", ext: ".bib" },
  { key: "enw", label: "EndNote (.enw)", ext: ".enw" },
];

const ACCEPT = ".ris,.bib,.enw";

function extToFormat(name: string): RefFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".ris")) return "ris";
  if (lower.endsWith(".bib")) return "bib";
  if (lower.endsWith(".enw")) return "enw";
  return null;
}

// 从 Content-Disposition 提取文件名 (兼容 filename* / filename=)。
function parseFilename(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star && star[1]) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")); } catch { /* ignore */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  if (plain && plain[1]) return plain[1].trim();
  return fallback;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function RefIO({ currentRefs, onImport, exportFilename = "references" }: RefIOProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"" | "import" | "export">("");
  const [err, setErr] = useState<string>("");
  const [menuOpen, setMenuOpen] = useState(false);

  const onPick = () => {
    if (busy) return;
    setErr("");
    inputRef.current?.click();
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const fmt = extToFormat(file.name);
    if (!fmt) {
      setErr("仅支持 .ris / .bib / .enw 三种格式");
      return;
    }
    setBusy("import");
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("format", fmt);
      const resp = await fetch(apiUrl("/api/refs/import"), { method: "POST", body: fd });
      if (!resp.ok) throw new Error(`服务返回 ${resp.status}`);
      const data = await resp.json();
      const items: any[] = Array.isArray(data?.refs) ? data.refs : [];
      // 把后端的 {title,authors,journal,year,doi,url,abstract,...} 映射到现有 Reference。
      const mapped: Reference[] = items.map((r: any) => ({
        pmid: r.pmid || r.doi || "",
        title: r.title || "",
        first_author: Array.isArray(r.authors) && r.authors.length ? String(r.authors[0]) : (r.first_author || ""),
        journal: r.journal || "",
        year: r.year ? String(r.year) : "",
        url: r.url || (r.doi ? `https://doi.org/${r.doi}` : ""),
        source: r.source,
        cited_by_count: typeof r.cited_by_count === "number" ? r.cited_by_count : undefined,
      }));
      onImport(mapped);
    } catch (e) {
      setErr(`导入失败: ${(e as Error).message}`);
    } finally {
      setBusy("");
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const onExport = async (fmt: RefFormat) => {
    setMenuOpen(false);
    if (busy) return;
    if (!currentRefs.length) {
      setErr("当前没有可导出的文献");
      return;
    }
    setBusy("export");
    setErr("");
    try {
      const resp = await fetch(apiUrl("/api/refs/export"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs: currentRefs, format: fmt }),
      });
      if (!resp.ok) throw new Error(`服务返回 ${resp.status}`);
      const blob = await resp.blob();
      const ext = FORMATS.find((f) => f.key === fmt)?.ext ?? `.${fmt}`;
      const fallback = `${exportFilename}${ext}`;
      const filename = parseFilename(resp.headers.get("Content-Disposition"), fallback);
      saveBlob(blob, filename);
    } catch (e) {
      setErr(`导出失败: ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="refio" data-testid="refio">
      <div className="form-actions refio-actions">
        <button
          className="btn-secondary"
          onClick={onPick}
          disabled={!!busy}
          data-testid="refio-import-btn"
          title="支持 EndNote (.enw) / Zotero / Mendeley 导出的 .ris / .bib"
        >
          {busy === "import" ? "导入中…" : "📥 导入文献"}
        </button>
        <div className="refio-export-wrap" style={{ position: "relative", display: "inline-block" }}>
          <button
            className="btn-secondary"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={!!busy || currentRefs.length === 0}
            data-testid="refio-export-btn"
            title="导出为 .ris / .bib / .enw, 可直接导入 EndNote / Zotero"
          >
            {busy === "export" ? "导出中…" : `📤 导出 (${currentRefs.length})`}
          </button>
          {menuOpen && (
            <div
              className="refio-menu"
              data-testid="refio-export-menu"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                zIndex: 30,
                background: "var(--surface, #fff)",
                border: "1px solid var(--line, #DCE5E3)",
                borderRadius: "var(--radius-sm, 10px)",
                boxShadow: "var(--shadow, 0 2px 8px rgba(0,0,0,.08))",
                minWidth: 220,
                padding: "6px 0",
              }}
              onMouseLeave={() => setMenuOpen(false)}
            >
              {FORMATS.map((f) => (
                <button
                  key={f.key}
                  className="btn-ghost"
                  onClick={() => onExport(f.key)}
                  data-testid={`refio-export-${f.key}`}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 14px",
                    border: "none",
                    background: "transparent",
                    fontSize: 13,
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          data-testid="refio-file-input"
          style={{ display: "none" }}
          onChange={(e) => onFile(e.target.files?.[0] ?? undefined)}
        />
      </div>
      {err && (
        <div className="result-error" data-testid="refio-error" style={{ marginTop: 6 }}>
          {err}
        </div>
      )}
    </div>
  );
}
