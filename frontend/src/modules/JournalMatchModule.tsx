import { useEffect, useRef, useState } from "react";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import Dropzone from "../components/Dropzone";
import { downloadText, tsName } from "../lib/download";

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
  const [copied, setCopied] = useState(false); // 复制清单的短暂反馈

  // 把候选期刊拼成可复制/导出的 Markdown 清单
  const hitsMarkdown = () =>
    "# 候选期刊（智能选刊）\n\n" +
    hits
      .map((h, i) => {
        const tags = [h.is_oa ? "开放获取" : "", h.in_doaj ? "DOAJ" : ""].filter(Boolean).join(" · ");
        return (
          `${i + 1}. **${h.journal}**${tags ? ` · ${tags}` : ""} — 相近文献 ${h.count} 篇` +
          (h.reason ? `\n   - 匹配理由：${h.reason}` : "")
        );
      })
      .join("\n") +
    "\n\n> 数据来自 OpenAlex 相近文献聚合，非影响因子/分区排名，样本有限仅供参考。";

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
          <button
            className="btn-ghost btn-sm"
            style={{ marginLeft: 10 }}
            onClick={submit}
            disabled={busy || !abstract.trim()}
            data-testid="journal-retry-btn"
          >
            重试
          </button>
        </div>
      )}

      {hits.length > 0 && (
        <div className="journal-hits" data-testid="journal-hits">
          <div className="result-toolbar">
            <span className="result-status">共 {hits.length} 本候选</span>
            <div className="result-actions">
              <button
                className="btn-ghost"
                data-testid="journal-copy-btn"
                title="复制候选期刊清单到剪贴板"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(hitsMarkdown());
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1800);
                  } catch {
                    /* 剪贴板未授权：忽略 */
                  }
                }}
              >
                {copied ? "已复制 ✓" : "复制清单"}
              </button>
              <button
                className="btn-ghost"
                data-testid="journal-export-btn"
                onClick={() => downloadText(tsName("候选期刊", "md"), hitsMarkdown())}
              >
                导出 Markdown
              </button>
            </div>
          </div>
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
                {h.is_oa && (
                  <span className="ref-badge rc-real" title="开放获取(Open Access)：论文免费公开可读，通常作者需支付版面费(APC)">
                    开放获取
                  </span>
                )}
                {h.in_doaj && (
                  <span className="ref-badge ref-badge-epmc" title="DOAJ：开放获取期刊目录，收录经审核的正规 OA 期刊，可作为期刊正规性的参考">
                    DOAJ
                  </span>
                )}
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
            期刊数据来自 OpenAlex（对最多约 50 篇主题相近文献聚合，<strong>非影响因子/分区排名</strong>）；
            样本有限、个位数计数噪声较大，条形图仅表示<strong>相对相近度</strong>，并非期刊质量或匹配度评分。
            最终请结合期刊范围(Scope)、收录与投稿要求综合判断。
          </p>
        </div>
      )}
    </div>
  );
}
