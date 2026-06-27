import { useEffect, useRef, useState } from "react";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import Dropzone from "../components/Dropzone";

interface JournalHit {
  journal: string;
  count: number;
  is_oa: boolean;
  in_doaj: boolean;
  issn: string;
  samples: string[];
  reason: string;
}

export default function JournalMatchModule() {
  const [abstract, setAbstract] = usePersistentState("journal:abstract", "");
  const [hits, setHits] = usePersistentState<JournalHit[]>("journal:hits", []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savedRef = useRef("");
  useEffect(() => {
    const key = hits.map((h) => h.journal).join("|");
    if (!busy && !error && hits.length && savedRef.current !== key) {
      savedRef.current = key;
      addHistory({
        module: "journal",
        icon: "🎯",
        title: abstract.slice(0, 40) || "选刊匹配",
        data: { "journal:abstract": abstract, "journal:hits": hits },
      });
    }
  }, [busy, error, hits, abstract]);

  const submit = async () => {
    if (!abstract.trim() || busy) return;
    setBusy(true);
    setError(null);
    setHits([]);
    try {
      const resp = await fetch(apiUrl("/api/journal-match"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ abstract }),
      });
      const d = await resp.json();
      if (d.ok) setHits(d.journals || []);
      else setError(d.error || "匹配失败");
    } catch (e) {
      setError(`匹配失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event("usage-updated"));
    }
  };

  const reset = () => {
    setAbstract("");
    setHits([]);
    setError(null);
  };

  const maxCount = hits.reduce((m, h) => Math.max(m, h.count), 1);

  return (
    <div className="module">
      <header className="module-head">
        <h1>🎯 智能选刊匹配</h1>
        <p>
          粘贴你的<strong>摘要或标题</strong>，我用 OpenAlex 检索近年主题相近的真实文献，
          聚合它们的发表期刊，给出契合的候选期刊（含是否开放获取、匹配理由），帮你决定投哪本。
        </p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">稿件摘要 / 标题 <em>必填</em></span>
          <textarea
            data-testid="input-abstract"
            value={abstract}
            onChange={(e) => setAbstract(e.target.value)}
            placeholder="把摘要（或标题+关键词）粘贴到这里，越完整匹配越准"
            rows={6}
          />
        </label>
        <Dropzone
          testId="upload-abstract"
          accept=".docx,.pdf,.txt,.md"
          label="或上传含摘要的文件（可选）"
          hint="支持 Word/PDF/txt；内容会填入上面的摘要"
          mode="text"
          onText={(t) => setAbstract(t)}
        />
        <div className="form-actions">
          <button className="btn-primary" onClick={submit} disabled={!abstract.trim() || busy} data-testid="run-btn">
            {busy ? "匹配中…" : "匹配候选期刊"}
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">
            清空
          </button>
        </div>
      </div>

      {busy && (
        <div className="status-line" data-testid="status-line">
          <span className="spinner" /> 正在检索相近文献并聚合期刊…
        </div>
      )}

      {error && (
        <div className="result-error" data-testid="journal-error">
          {error}
        </div>
      )}

      {hits.length > 0 && (
        <div className="journal-hits" data-testid="journal-hits">
          {hits.map((h, i) => (
            <div className="journal-card" key={i}>
              <div className="journal-head">
                <span className="journal-rank">{i + 1}</span>
                <a
                  className="journal-name"
                  href={`https://www.google.com/search?q=${encodeURIComponent(h.journal + " journal")}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {h.journal}
                </a>
                {h.is_oa && <span className="ref-badge rc-real">开放获取</span>}
                {h.in_doaj && <span className="ref-badge ref-badge-epmc">DOAJ</span>}
              </div>
              <div className="journal-bar">
                <span className="journal-bar-fill" style={{ width: `${Math.round((h.count / maxCount) * 100)}%` }} />
                <span className="journal-bar-label">相近文献 {h.count} 篇</span>
              </div>
              {h.reason && <div className="journal-reason">{h.reason}</div>}
              {h.samples.length > 0 && (
                <div className="journal-samples">近年相近：{h.samples.join("；")}</div>
              )}
            </div>
          ))}
          <p className="section-hint">
            期刊数据来自 OpenAlex（相近文献聚合，非影响因子排名）；最终请结合期刊范围、收录与投稿要求综合判断。
          </p>
        </div>
      )}
    </div>
  );
}
