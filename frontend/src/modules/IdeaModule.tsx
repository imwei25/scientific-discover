import { useEffect, useRef, useState } from "react";
import { streamIdea, streamIdeaFollowup, runModule, Reference, Trial, EvidenceItem, Verification, RewritePayload } from "../lib/sse";
import { addHistory } from "../lib/history";
import Markdown from "../components/Markdown";
import Dropzone from "../components/Dropzone";
import { downloadText, downloadCsv, tsName } from "../lib/download";
import { usePersistentState } from "../lib/usePersistentState";
import type { Goto } from "../App";

const PAPER_SOURCES: { key: string; label: string; hint: string }[] = [
  { key: "pubmed", label: "PubMed", hint: "NCBI 权威医学库" },
  { key: "europepmc", label: "Europe PMC", hint: "含 bioRxiv/medRxiv 预印本" },
  { key: "openalex", label: "OpenAlex", hint: "覆盖最广 + 被引数" },
];
const TRIAL_SOURCE = { key: "clinicaltrials", label: "ClinicalTrials.gov", hint: "在研临床试验（旁路）" };
const STUDY_TYPES: { key: string; label: string }[] = [
  { key: "rct", label: "随机对照试验" },
  { key: "meta", label: "Meta 分析" },
  { key: "systematic", label: "系统综述" },
  { key: "review", label: "综述" },
];

// 文献列表排序: 相关性(原序) / 被引降序 / 年份降序
function sortRefs(refs: Reference[], by: string): Reference[] {
  if (by === "cited") return [...refs].sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0));
  if (by === "year") return [...refs].sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
  return refs;
}

export default function IdeaModule({ goto }: { goto: Goto }) {
  const [field, setField] = usePersistentState("idea:field", "");
  const [keywords, setKeywords] = usePersistentState("idea:keywords", "");
  const [background, setBackground] = usePersistentState("idea:background", "");
  const [depth, setDepth] = usePersistentState("idea:depth", "deep");
  const [sources, setSources] = usePersistentState<string[]>("idea:sources", [
    "pubmed",
    "europepmc",
    "openalex",
    "clinicaltrials",
  ]);
  const [yearFrom, setYearFrom] = usePersistentState("idea:yearFrom", "");
  const [studyTypes, setStudyTypes] = usePersistentState<string[]>("idea:studyTypes", []);

  const [status, setStatus] = useState("");
  const [refs, setRefs] = usePersistentState<Reference[]>("idea:refs", []);
  const [refSort, setRefSort] = usePersistentState("idea:refSort", "relevance");
  const [trials, setTrials] = usePersistentState<Trial[]>("idea:trials", []);
  const [evidence, setEvidence] = usePersistentState<EvidenceItem[]>("idea:evidence", []);
  const [text, setText] = usePersistentState("idea:result", "");
  const [verify, setVerify] = usePersistentState<Verification | null>("idea:verify", null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rewrite, setRewrite] = useState<RewritePayload | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // 追问 / 修改报告
  const [followups, setFollowups] = usePersistentState<{ q: string; a: string }[]>("idea:qa", []);
  const [followupInput, setFollowupInput] = useState("");
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [fRunning, setFRunning] = useState(false);
  const [fError, setFError] = useState<string | null>(null);
  const fctrl = useRef<AbortController | null>(null);

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "idea",
        icon: "💡",
        title: field || "选题调研",
        data: {
          "idea:field": field,
          "idea:keywords": keywords,
          "idea:background": background,
          "idea:result": text,
          "idea:refs": refs,
          "idea:trials": trials,
          "idea:evidence": evidence,
          "idea:qa": followups,
          "idea:verify": verify,
        },
      });
    }
  }, [running, error, text, field, keywords, background, refs, verify]);

  const submit = async (override?: { field?: string; keywords?: string }) => {
    const f = override?.field ?? field;
    const k = override?.keywords ?? keywords;
    if (!f.trim() || running) return;
    // 避免与进行中的 追问/PICO 流交叉写入
    fctrl.current?.abort();
    picoCtrl.current?.abort();
    setFRunning(false);
    setPicoRunning(false);
    setStatus("");
    setRefs([]);
    setTrials([]);
    setEvidence([]);
    setText("");
    setVerify(null);
    setError(null);
    setRewrite(null);
    setFollowups([]);
    setCurrentAnswer("");
    setFError(null);
    setRunning(true);
    ctrl.current = new AbortController();
    await streamIdea(
      {
        field: f,
        keywords: k,
        background,
        depth,
        sources,
        filters: { year_from: yearFrom, study_types: studyTypes },
      },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onReferences: setRefs,
        onTrials: setTrials,
        onEvidence: setEvidence,
        onDelta: (t) => setText((p) => p + t),
        onVerify: setVerify,
        onRewriteSuggestion: setRewrite,
        onError: (m) => {
          setError(m);
          setStatus("");
          setRunning(false);
          window.dispatchEvent(new Event("usage-updated"));
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

  const acceptRewrite = () => {
    if (!rewrite?.suggestion) return;
    const next = rewrite.suggestion;
    setField(next.field);
    setKeywords(next.keywords);
    setRewrite(null);
    setError(null);
    submit({ field: next.field, keywords: next.keywords });
  };

  const dismissRewrite = () => {
    setRewrite(null);
  };

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
  };

  const runFollowup = async (mode: "ask" | "revise") => {
    const q = followupInput.trim();
    if (!q || fRunning || running) return;
    setFError(null);
    setFRunning(true);
    fctrl.current = new AbortController();
    const baseReport = text; // revise 以当前报告为基准
    let buf = "";
    if (mode === "ask") setCurrentAnswer("…");
    else setText(""); // revise: 流式重写报告
    await streamIdeaFollowup(
      { mode, question: q, report: baseReport, references: refs, evidence },
      {
        signal: fctrl.current.signal,
        onDelta: (t) => {
          buf += t;
          if (mode === "ask") setCurrentAnswer(buf);
          else setText((p) => p + t);
        },
        onVerify: (v) => {
          if (mode === "revise") setVerify(v);
        },
        onError: (m) => {
          setFError(m);
          setFRunning(false);
          if (mode === "revise") setText(baseReport); // 修改失败则回滚
        },
        onDone: () => {
          if (mode === "ask") {
            setFollowups((prev) => [...prev, { q, a: buf }]);
            setCurrentAnswer("");
          }
          setFollowupInput("");
          setFRunning(false);
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setFRunning(false);
  };

  // PICO / 纳排标准提取
  const [pico, setPico] = usePersistentState("idea:pico", "");
  const [picoRunning, setPicoRunning] = useState(false);
  const [picoErr, setPicoErr] = useState<string | null>(null);
  const picoCtrl = useRef<AbortController | null>(null);

  const genPico = async () => {
    if (!field.trim() || picoRunning) return;
    setPico("");
    setPicoErr(null);
    setPicoRunning(true);
    picoCtrl.current = new AbortController();
    await runModule(
      "pico",
      { field, keywords, background },
      {
        signal: picoCtrl.current.signal,
        onDelta: (t) => setPico((p) => p + t),
        onError: (m) => {
          setPicoErr(m);
          setPicoRunning(false);
        },
        onDone: () => {
          setPicoRunning(false);
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setPicoRunning(false);
  };

  const toggleSource = (key: string) => {
    setSources((prev) => (prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]));
  };
  const toggleStudyType = (key: string) => {
    setStudyTypes((prev) => (prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]));
  };
  // 至少要选一个论文源, 否则无文献可综述。
  const noPaperSource = !PAPER_SOURCES.some((s) => sources.includes(s.key));

  const reset = () => {
    if (running) stop();
    fctrl.current?.abort();
    picoCtrl.current?.abort();
    setPico("");
    setFollowups([]);
    setCurrentAnswer("");
    setFollowupInput("");
    setFError(null);
    setField("");
    setKeywords("");
    setBackground("");
    setRefs([]);
    setTrials([]);
    setEvidence([]);
    setText("");
    setVerify(null);
    setStatus("");
    setError(null);
    setRewrite(null);
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>💡 找选题 · 医学/药学/生物</h1>
        <p>
          我会实际检索 <strong>PubMed / Europe PMC / OpenAlex</strong> 多源真实文献（按相关性+被引+新近择优纳入），
          梳理该方向已有哪些工作、还缺什么，再给出有文献支撑的候选选题。文中引用均为可点击的文献链接。
        </p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">研究领域 / 方向 <em>必填</em></span>
          <input
            data-testid="input-field"
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder="例如：PD-1 抑制剂在三阴性乳腺癌中的应用、肠道菌群与阿尔茨海默病"
          />
        </label>
        <label className="field">
          <span className="field-label">关键词（可选，建议英文，利于检索）</span>
          <input
            data-testid="input-keywords"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="逗号分隔，例如：immunotherapy, biomarker, resistance"
          />
        </label>
        <label className="field">
          <span className="field-label">已有基础 / 限制条件（可选）</span>
          <textarea
            data-testid="input-background"
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            placeholder="例如：偏临床回顾性研究，可获取本院病理样本；不做动物实验"
            rows={3}
          />
        </label>
        <label className="field">
          <span className="field-label">调研深度</span>
          <select data-testid="input-depth" value={depth} onChange={(e) => setDepth(e.target.value)}>
            <option value="deep">深入（多子方向 + 空白补检索 + 空白矩阵，推荐）</option>
            <option value="fast">快速（单轮检索，省额度更快）</option>
          </select>
        </label>
        <div className="field" data-testid="source-selector">
          <span className="field-label">检索来源（可多选）</span>
          <div className="source-grid">
            {PAPER_SOURCES.map((s) => (
              <label key={s.key} className={`source-chip${sources.includes(s.key) ? " on" : ""}`}>
                <input
                  type="checkbox"
                  data-testid={`source-${s.key}`}
                  checked={sources.includes(s.key)}
                  onChange={() => toggleSource(s.key)}
                />
                <span className="source-name">{s.label}</span>
                <span className="source-hint">{s.hint}</span>
              </label>
            ))}
            <label className={`source-chip trial${sources.includes(TRIAL_SOURCE.key) ? " on" : ""}`}>
              <input
                type="checkbox"
                data-testid={`source-${TRIAL_SOURCE.key}`}
                checked={sources.includes(TRIAL_SOURCE.key)}
                onChange={() => toggleSource(TRIAL_SOURCE.key)}
              />
              <span className="source-name">{TRIAL_SOURCE.label}</span>
              <span className="source-hint">{TRIAL_SOURCE.hint}</span>
            </label>
          </div>
          {noPaperSource && (
            <span className="source-warn" data-testid="source-warn">
              请至少选择一个论文源（PubMed / Europe PMC / OpenAlex），否则没有文献可供综述。
            </span>
          )}
        </div>
        <div className="field" data-testid="filters">
          <span className="field-label">检索过滤（可选）</span>
          <div className="filter-row">
            <label className="filter-year">
              起始年份
              <select data-testid="filter-year" value={yearFrom} onChange={(e) => setYearFrom(e.target.value)}>
                <option value="">不限</option>
                <option value="2021">近 5 年</option>
                <option value="2019">近 7 年</option>
                <option value="2014">近 10 年</option>
              </select>
            </label>
            <div className="filter-types">
              <span className="filter-types-label">证据等级</span>
              {STUDY_TYPES.map((s) => (
                <label key={s.key} className={`type-chip${studyTypes.includes(s.key) ? " on" : ""}`}>
                  <input
                    type="checkbox"
                    data-testid={`type-${s.key}`}
                    checked={studyTypes.includes(s.key)}
                    onChange={() => toggleStudyType(s.key)}
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
          <span className="filter-hint">证据等级过滤主要作用于 PubMed / Europe PMC（OpenAlex 仅能近似匹配综述）。</span>
        </div>
        <Dropzone
          testId="upload-doc"
          accept=".docx,.pdf,.txt,.md"
          label="附加文档（可选：已有综述/标书/草案）"
          hint="支持 Word/PDF/txt；内容会作为背景补充"
          mode="text"
          onText={(t, name) =>
            setBackground((prev) => (prev ? prev + "\n\n" : "") + `[附加文档：${name}]\n` + t)
          }
        />
        <div className="form-actions">
          <button className="btn-primary" onClick={() => submit()} disabled={!field.trim() || running || noPaperSource} data-testid="run-btn">
            {running ? "调研中…" : "开始文献调研"}
          </button>
          <button className="btn-secondary" onClick={genPico} disabled={!field.trim() || picoRunning} data-testid="pico-btn">
            {picoRunning ? "提取中…" : "提取 PICO / 纳排标准"}
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">
            清空
          </button>
        </div>
      </div>

      {picoErr && <div className="result-error" data-testid="pico-error">{picoErr}</div>}
      {(pico || picoRunning) && (
        <details className="refs" open data-testid="pico-panel">
          <summary>🔬 PICO 与纳入/排除标准</summary>
          {picoRunning && (
            <div className="ref-toolbar">
              <button className="btn-ghost" data-testid="pico-stop-btn" onClick={() => { picoCtrl.current?.abort(); setPicoRunning(false); }}>停止</button>
            </div>
          )}
          <div className="result-text">
            {pico ? <Markdown>{pico}</Markdown> : <span className="result-placeholder">正在提取…</span>}
            {picoRunning && <span className="cursor-blink">▍</span>}
          </div>
        </details>
      )}

      {status && (
        <div className="status-line" data-testid="status-line">
          <span className="spinner" /> {status}
        </div>
      )}

      {rewrite && !running && (
        <div className="rewrite-suggest" data-testid="rewrite-suggest">
          <div className="rewrite-title">PubMed 零命中 · AI 改写建议</div>
          {rewrite.tried_queries.length > 0 && (
            <details className="rewrite-tried">
              <summary>本次实际跑过的检索式（{rewrite.tried_queries.length} 个，均零命中）</summary>
              <ul>
                {rewrite.tried_queries.map((q, i) => (
                  <li key={i}><code>{q}</code></li>
                ))}
              </ul>
            </details>
          )}
          {rewrite.suggestion ? (
            <>
              <div className="rewrite-row">
                <span className="rewrite-label">建议方向</span>
                <span className="rewrite-value" data-testid="rewrite-field">{rewrite.suggestion.field}</span>
              </div>
              <div className="rewrite-row">
                <span className="rewrite-label">建议关键词</span>
                <span className="rewrite-value" data-testid="rewrite-keywords">{rewrite.suggestion.keywords || "（无）"}</span>
              </div>
              {rewrite.suggestion.reason && (
                <div className="rewrite-row">
                  <span className="rewrite-label">为什么这样改</span>
                  <span className="rewrite-value">{rewrite.suggestion.reason}</span>
                </div>
              )}
              <div className="rewrite-actions">
                <button className="btn-primary" onClick={acceptRewrite} data-testid="rewrite-accept">
                  采纳并重试
                </button>
                <button className="btn-ghost" onClick={dismissRewrite} data-testid="rewrite-dismiss">
                  我自己改
                </button>
              </div>
            </>
          ) : (
            <div className="rewrite-row">AI 未能生成有效建议，请手动调整方向或关键词后重试。</div>
          )}
        </div>
      )}

      {error && (
        <div className="result-error" data-testid="result-error">
          {error}
        </div>
      )}

      {refs.length > 0 && (
        <details className="refs" open data-testid="refs">
          <summary>检索到的文献（{refs.length} 篇，点击打开原文）</summary>
          <div className="ref-toolbar">
            <label>
              排序
              <select data-testid="ref-sort" value={refSort} onChange={(e) => setRefSort(e.target.value)}>
                <option value="relevance">相关性</option>
                <option value="cited">被引最多</option>
                <option value="year">最新</option>
              </select>
            </label>
          </div>
          <ol className="ref-list">
            {sortRefs(refs, refSort).map((r, i) => (
              <li key={r.pmid || r.url || i}>
                {r.source === "preprint" && <span className="ref-badge ref-badge-preprint">预印本</span>}
                {r.source === "europepmc" && <span className="ref-badge ref-badge-epmc">Europe PMC</span>}
                {r.source === "openalex" && <span className="ref-badge ref-badge-openalex">OpenAlex</span>}
                {(r.cited_by_count ?? 0) > 0 && (
                  <span className="ref-badge ref-badge-cited">被引 {r.cited_by_count}</span>
                )}
                <a href={r.url} target="_blank" rel="noreferrer">
                  {r.first_author} ({r.year}). {r.title}
                </a>
                {r.journal && <span className="ref-journal"> — {r.journal}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}

      {trials.length > 0 && (
        <details className="refs trials" open data-testid="trials">
          <summary>🧪 相关在研临床试验（{trials.length} 项 · ClinicalTrials.gov，点击查看登记信息）</summary>
          <ol className="ref-list">
            {trials.map((t, i) => (
              <li key={t.nct_id || i}>
                {t.status && <span className="ref-badge ref-badge-trial">{t.status}</span>}
                {t.phase && <span className="ref-badge ref-badge-phase">{t.phase}</span>}
                <a href={t.url} target="_blank" rel="noreferrer">
                  {t.title}
                </a>
                {t.conditions && <span className="ref-journal"> — {t.conditions}</span>}
                <span className="trial-nct"> （{t.nct_id}{t.year ? `, ${t.year}` : ""}）</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {evidence.length > 0 && (
        <details className="refs evidence" data-testid="evidence">
          <summary>📋 证据表（{evidence.length} 篇 · 对象/设计/发现/局限，可导出）</summary>
          <div className="ref-toolbar">
            <button
              className="btn-ghost"
              data-testid="export-evidence-btn"
              onClick={() => {
                const headers = ["序号", "第一作者", "年份", "标题", "期刊", "来源", "被引", "研究对象", "设计/方法", "主要发现", "局限/空白", "链接"];
                const rows = evidence.map((e) => [
                  e.index, e.first_author, e.year, e.title, e.journal, e.source, e.cited_by_count,
                  e.pop, e.design, e.finding, e.gap, e.url,
                ]);
                downloadCsv(tsName("证据表", "csv"), headers, rows);
              }}
            >
              导出 CSV
            </button>
          </div>
          <div className="md-table-wrap">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th>#</th><th>文献</th><th>对象</th><th>设计</th><th>主要发现</th><th>局限/空白</th>
                </tr>
              </thead>
              <tbody>
                {evidence.map((e) => (
                  <tr key={e.index}>
                    <td>{e.index}</td>
                    <td>
                      <a href={e.url} target="_blank" rel="noreferrer">
                        {e.first_author} ({e.year})
                      </a>
                    </td>
                    <td>{e.pop || "—"}</td>
                    <td>{e.design || "—"}</td>
                    <td>{e.finding || "—"}</td>
                    <td>{e.gap || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {(text || running) && (
        <div className="result-panel">
          <div className="result-toolbar">
            <span className="result-status">{running ? "生成中…" : "已完成"}</span>
            <div className="result-actions">
              {running && (
                <button className="btn-ghost" onClick={stop} data-testid="stop-btn">
                  停止
                </button>
              )}
              {text && !running && (
                <button
                  className="btn-ghost"
                  data-testid="send-to-plan-btn"
                  onClick={() => goto("plan", { "plan:idea": text })}
                >
                  用此结果做实验规划 →
                </button>
              )}
              {text && !running && (
                <button
                  className="btn-ghost"
                  data-testid="export-md-btn"
                  onClick={() => {
                    const refMd = refs.length
                      ? "\n\n## 参考文献\n" +
                        refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n")
                      : "";
                    downloadText(tsName("选题调研", "md"), text + refMd);
                  }}
                >
                  导出 Markdown
                </button>
              )}
            </div>
          </div>
          <div className="result-text" data-testid="result-text">
            {text ? <Markdown>{text}</Markdown> : <span className="result-placeholder">正在分析…</span>}
            {running && <span className="cursor-blink">▍</span>}
          </div>
        </div>
      )}

      {verify && !running && (
        verify.unverified.length === 0 ? (
          <div className="verify-ok" data-testid="verify">
            ✓ 引用核验：正文 {verify.total} 处文献引用均来自本次检索到的真实文献。
          </div>
        ) : (
          <div className="verify-bad" data-testid="verify">
            ⚠ 引用核验：发现 {verify.unverified.length} 处引用未出现在检索结果中，可能不准确，请核实：
            {verify.unverified.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer">
                {u}
              </a>
            ))}
          </div>
        )
      )}

      {text && !running && (
        <div className="followup" data-testid="followup">
          <div className="followup-head">追问 / 修改意见</div>
          <p className="followup-tip">
            可针对某篇文献或某条结论追问，或提出意见让 AI 修订报告。回答仍只基于本次检索到的真实文献。
          </p>
          {followups.length > 0 && (
            <div className="qa-list" data-testid="qa-list">
              {followups.map((qa, i) => (
                <div key={i} className="qa-item">
                  <div className="qa-q">❓ {qa.q}</div>
                  <div className="qa-a">
                    <Markdown>{qa.a}</Markdown>
                  </div>
                </div>
              ))}
            </div>
          )}
          {fRunning && currentAnswer && (
            <div className="qa-item">
              <div className="qa-a">
                <Markdown>{currentAnswer}</Markdown>
                <span className="cursor-blink">▍</span>
              </div>
            </div>
          )}
          <textarea
            data-testid="followup-input"
            value={followupInput}
            onChange={(e) => setFollowupInput(e.target.value)}
            placeholder="例如：第 3 篇的样本量是多少？/ 请把候选选题三改成偏机制研究 / 研究空白这部分再具体些"
            rows={2}
            disabled={fRunning}
          />
          {fError && <div className="result-error">{fError}</div>}
          <div className="form-actions">
            <button
              className="btn-primary"
              data-testid="ask-btn"
              onClick={() => runFollowup("ask")}
              disabled={!followupInput.trim() || fRunning}
            >
              追问
            </button>
            <button
              className="btn-ghost"
              data-testid="revise-btn"
              onClick={() => runFollowup("revise")}
              disabled={!followupInput.trim() || fRunning}
            >
              按此修改报告
            </button>
            {fRunning && (
              <button className="btn-ghost" data-testid="followup-stop-btn" onClick={() => { fctrl.current?.abort(); setFRunning(false); }}>
                停止
              </button>
            )}
            {fRunning && (
              <span className="status-line">
                <span className="spinner" /> 处理中…
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
