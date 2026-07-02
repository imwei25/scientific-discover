import { useEffect, useState } from "react";
import type { Reference } from "../lib/sse";
import { apiUrl } from "../lib/api";

interface ZoteroPanelProps {
  currentRefs: Reference[];
  onImport: (imported: Reference[]) => void;
  selectedForPush?: Reference[];
}

type Coll = { key: string; name: string; count: number };

// 后端 zotero 条目 → 前端 Reference(与 RefIO 的映射一致)。
function toRef(r: any): Reference {
  return {
    pmid: r.pmid || r.doi || "",
    title: r.title || "",
    first_author: r.first_author || (Array.isArray(r.authors) && r.authors.length ? String(r.authors[0]) : ""),
    journal: r.journal || "",
    year: r.year ? String(r.year) : "",
    url: r.url || (r.doi ? `https://doi.org/${r.doi}` : ""),
    doi: r.doi || "",
    abstract: r.abstract || "",   // 带上摘要: "只用导入的文献"跳过检索时靠它生成综述+核验支持句
    source: r.source,
  };
}

export default function ZoteroPanel({ currentRefs, onImport, selectedForPush }: ZoteroPanelProps) {
  const [online, setOnline] = useState<boolean | null>(null); // null=探测中
  const [colls, setColls] = useState<Coll[] | null>(null);
  const [busy, setBusy] = useState<"" | "load" | "import" | "push">("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(apiUrl("/api/zotero/status"))
      .then((r) => r.json())
      .then((d) => { if (alive) setOnline(!!d.running); })
      .catch(() => { if (alive) setOnline(false); });
    return () => { alive = false; };
  }, []);

  const loadColls = async () => {
    setBusy("load"); setMsg("");
    try {
      const d = await (await fetch(apiUrl("/api/zotero/collections"))).json();
      if (!d.ok) throw new Error(d.error || "读取失败");
      setColls(d.collections || []);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };

  const importColl = async (key: string, name: string) => {
    setBusy("import"); setMsg("");
    try {
      const d = await (await fetch(apiUrl("/api/zotero/import"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection_key: key }),
      })).json();
      if (!d.ok) throw new Error(d.error || "导入失败");
      const refs = (d.refs || []).map(toRef);
      onImport(refs);
      setMsg(`已从「${name}」导入 ${refs.length} 篇`);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };

  const push = async () => {
    const payload = (selectedForPush && selectedForPush.length ? selectedForPush : currentRefs);
    if (!payload.length) { setMsg("当前没有可推送的文献"); return; }
    setBusy("push"); setMsg("");
    try {
      const d = await (await fetch(apiUrl("/api/zotero/push"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs: payload }),
      })).json();
      if (!d.ok) throw new Error(d.error || "推送失败");
      setMsg(`已推送 ${d.saved} 篇到 Zotero(存入当前选中分类)`);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };

  if (online === null) return null;              // 探测中不占位
  if (!online) {
    return (
      <div className="zotero-panel offline" data-testid="zotero-offline" style={{ fontSize: 12, color: "var(--muted,#78877f)", marginTop: 4 }}>
        未检测到运行中的 Zotero。可改用上方「📥 导入文献」拖入 Zotero 导出的 .ris/.bib;
        或在 Zotero 设置→高级 勾选「允许本机其它应用与 Zotero 通信」后刷新。
      </div>
    );
  }

  const pushCount = (selectedForPush && selectedForPush.length) ? selectedForPush.length : currentRefs.length;
  const pushLabel = (selectedForPush && selectedForPush.length)
    ? `🔗 推送到 Zotero(已选 ${pushCount})`
    : `🔗 推送到 Zotero(全部 ${pushCount})`;

  return (
    <div className="zotero-panel" data-testid="zotero-panel" style={{ marginTop: 6 }}>
      <div className="form-actions">
        <button className="btn-secondary" data-testid="zotero-load-colls" disabled={!!busy} onClick={loadColls}>
          {busy === "load" ? "读取分类…" : "🔗 从 Zotero 导入"}
        </button>
        <button className="btn-secondary" data-testid="zotero-push" disabled={!!busy || pushCount === 0} onClick={push}>
          {busy === "push" ? "推送中…" : pushLabel}
        </button>
      </div>
      {colls && (
        <div className="zotero-colls" data-testid="zotero-colls" style={{ marginTop: 6, maxHeight: 200, overflowY: "auto" }}>
          {colls.length === 0 && <div style={{ fontSize: 12 }}>Zotero 里没有分类。</div>}
          {colls.map((c) => (
            <button key={c.key} className="btn-ghost" data-testid={`zotero-coll-${c.key}`}
              disabled={busy === "import"} onClick={() => importColl(c.key, c.name)}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", border: "none", background: "transparent", fontSize: 13 }}>
              {c.name} <span style={{ color: "var(--muted,#78877f)" }}>({c.count})</span>
            </button>
          ))}
        </div>
      )}
      {msg && <div data-testid="zotero-msg" style={{ marginTop: 6, fontSize: 12 }}>{msg}</div>}
    </div>
  );
}
