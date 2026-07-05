import { useEffect, useMemo, useRef, useState } from "react";
import { streamDeepResearch, fetchDeepResearchRecommend, streamDeepResearchFollowup, Reference, EvidenceItem, RecommendItem, ContributionRow, Verification } from "../lib/sse";
import { reportLLMError } from "../lib/errorToast";
import { addHistory } from "../lib/history";
import { parseAttachments, appendAttachmentsToField } from "../lib/attachments";
import { parseUpload, lookupTitle, uploadedToReference, estimateDeepReadTokens, UploadedRef } from "../lib/uploadedLit";
import AttachmentUploadBox from "../components/AttachmentUploadBox";
import { LiteraturePicker } from "../components/LiteraturePicker";
import EditableMarkdown from "../components/EditableMarkdown";
import WarningPanel from "../components/WarningPanel";
import FollowupPanel from "../components/FollowupPanel";
import ReportExportBar from "../components/ReportExportBar";
import { usePersistentState, readPersisted } from "../lib/usePersistentState";
import { useProjects } from "../lib/projects";
import { downloadCsv, tsName } from "../lib/download";
import type { Goto } from "../App";

const STUDY_TYPES = [
  { key: "rct", label: "随机对照试验" },
  { key: "meta", label: "Meta 分析" },
  { key: "systematic", label: "系统综述" },
  { key: "review", label: "综述" },
];

const DEFAULT_SOURCES = ["pubmed", "europepmc", "openalex", "crossref", "unpaywall"];

const STEPS = [
  { n: 1, title: "研究问题", desc: "问题 · 相关资料 · 上传文献" },
  { n: 2, title: "检索设置", desc: "年份 · 证据等级 · 质量" },
  { n: 3, title: "文献复核", desc: "查看 · 深读推荐 · 勾选" },
  { n: 4, title: "调研产出", desc: "报告 · 贡献表 · 追问" },
];

const refKeyOf = (r: Reference & { upload_id?: string }) => r.upload_id || r.pmid || r.url || r.title;

export default function ResearchModule({ goto }: { goto: Goto }) {
  const { current: project } = useProjects();
  const projectId = project?.id ?? null;

  // ── 表单字段 ────────────────────────────────────────────────
  const [question, setQuestion] = usePersistentState("research:question", "");
  const [field, setField] = usePersistentState("research:field", "");
  const [background, setBackground] = usePersistentState("research:background", "");
  const [depth, setDepth] = usePersistentState("research:depth", "deep");
  const [yearsBack, setYearsBack] = usePersistentState("research:yearsBack", "3");
  const [studyTypes, setStudyTypes] = usePersistentState<string[]>("research:studyTypes", STUDY_TYPES.map((s) => s.key));
  const [impactMin, setImpactMin] = usePersistentState("research:impactMin", "");
  const [minQuartile, setMinQuartile] = usePersistentState("research:minQuartile", "");
  const [keepUnknown, setKeepUnknown] = usePersistentState("research:keepUnknownImpact", true);
  const [englishReport, setEnglishReport] = usePersistentState("research:englishReport", false);

  // ── 向导步骤 ────────────────────────────────────────────────
  const [step, setStep] = usePersistentState<number>("research:step", 1);
  const [maxStep, setMaxStep] = usePersistentState<number>("research:maxStep", 1);
  const goStep = (n: number) => { setStep(n); if (n > maxStep) setMaxStep(n); };

  // ── 上传文献 & 相关资料附件 ────────────────────────────────
  const [uploadedRefs, setUploadedRefs] = usePersistentState<UploadedRef[]>("research:uploadedRefs", []);
  const [pendingLitFiles, setPendingLitFiles] = useState<File[]>([]);
  const [pendingBackgroundFiles, setPendingBackgroundFiles] = useState<File[]>([]);
  const [uploadParsing, setUploadParsing] = useState<{ done: number; total: number } | null>(null);
  const [uploadNeedingTitle, setUploadNeedingTitle] = useState<{ file: File; err?: string }[]>([]);

  // ── 检索结果 / 复核 (Task 15 会用) ─────────────────────────
  const [refs, setRefs] = usePersistentState<Reference[]>("research:refs", []);
  const [selectedKeys, setSelectedKeys] = usePersistentState<string[]>("research:selectedKeys", []);
  const [deepReadKeys, setDeepReadKeys] = usePersistentState<string[]>("research:deepReadKeys", []);
  const [refSort, setRefSort] = usePersistentState("research:refSort", "relevance");
  const [evidence, setEvidence] = usePersistentState<EvidenceItem[]>("research:evidence", []);
  const [recommend, setRecommend] = useState<Record<string, RecommendItem>>({});

  // ── 产出 (Task 16 会用) ────────────────────────────────────
  const [text, setText] = usePersistentState("research:result", "");
  const [contribution, setContribution] = usePersistentState<ContributionRow[]>("research:contribution", []);
  const [verify, setVerify] = usePersistentState<Verification | null>("research:verify", null);
  const [followups, setFollowups] = usePersistentState<{ q: string; a: string }[]>("research:qa", []);
  const [reportCollapsed, setReportCollapsed] = useState(false);

  // ── 运行状态 ──────────────────────────────────────────────
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [deepReadProgress, setDeepReadProgress] = useState<{ done: number; total: number; current_ref_key?: string } | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // ── history 集成: 报告完成后写一次 ─────────────────────────
  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "research", icon: "🔬",
        title: question.slice(0, 40) || "深度调研",
        data: {
          "research:question": question, "research:field": field,
          "research:background": background, "research:result": text,
          "research:refs": refs, "research:evidence": evidence,
          "research:contribution": contribution, "research:verify": verify,
          "research:qa": followups,
          "research:step": step, "research:maxStep": Math.max(maxStep, step),
          "research:selectedKeys": selectedKeys, "research:deepReadKeys": deepReadKeys,
          "research:uploadedRefs": uploadedRefs,
        },
      });
    }
  }, [running, error, text, contribution, verify]);

  // ── 上传解析 (拖入即解析) ─────────────────────────────────
  const ingestLit = async (files: File[]) => {
    if (files.length === 0) return;
    setUploadParsing({ done: 0, total: files.length });
    const needTitle: { file: File; err?: string }[] = [];
    const good: UploadedRef[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setUploadParsing({ done: i, total: files.length });
        try {
          const res = await parseUpload(f, projectId);
          if ("error" in res) needTitle.push({ file: f, err: res.error });
          else if (res.parse_confidence === "low" && !res.title) needTitle.push({ file: f });
          else good.push(res);
        } catch (e) {
          needTitle.push({ file: f, err: (e as Error).message });
        }
      }
      setUploadedRefs((prev) => [...prev, ...good]);
      if (needTitle.length) setUploadNeedingTitle((prev) => [...prev, ...needTitle]);
    } finally {
      setUploadParsing(null);
    }
  };

  const filtersPayload = () => ({
    year_from: yearsBack ? String(new Date().getFullYear() - Number(yearsBack) + 1) : "",
    study_types: studyTypes,
    min_quartile: minQuartile,
    min_impact: impactMin,
    keep_unknown: keepUnknown,
  });

  const runSearch = async () => {
    if (!question.trim() || running) return;
    setError(null);
    let mergedBackground = background;
    if (pendingBackgroundFiles.length > 0) {
      const parseCtrl = new AbortController();
      ctrl.current = parseCtrl;
      setRunning(true);
      try {
        const parsed = await parseAttachments(pendingBackgroundFiles, {
          signal: parseCtrl.signal,
          onProgress: (p) => setStatus(`正在解析相关资料 ${p.index}/${p.total}: ${p.name}`),
        });
        mergedBackground = appendAttachmentsToField(background, parsed);
        setPendingBackgroundFiles([]);
      } catch (e) {
        setError((e as Error).message); setRunning(false); return;
      }
    }
    setRefs([]); setSelectedKeys([]); setDeepReadKeys([]); setEvidence([]);
    setText(""); setContribution([]); setVerify(null); setFollowups([]); setRecommend({});
    setStatus(""); setError(null); setWarnings([]); setRunning(true);
    goStep(3);
    ctrl.current = new AbortController();
    const uploadedAsRefs = uploadedRefs.map(uploadedToReference);
    let latestRefs: Reference[] = [];
    await streamDeepResearch(
      {
        question, field, background: mergedBackground, depth,
        sources: DEFAULT_SOURCES,
        filters: filtersPayload(),
        phase: "search",
        project_id: projectId,
      },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onReferences: (items) => {
          const norm = (s: string) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
          const seen = new Set(uploadedAsRefs.map((r) => norm(r.title)));
          const merged: Reference[] = [...uploadedAsRefs];
          for (const r of items) {
            if (!seen.has(norm(r.title))) { merged.push(r); seen.add(norm(r.title)); }
          }
          setRefs(merged);
          setSelectedKeys(merged.map((r) => refKeyOf(r as Reference & { upload_id?: string })));
          latestRefs = merged;
        },
        onEvidence: setEvidence,
        onDelta: () => {},
        onWarning: (m) => setWarnings((prev) => [...prev, m]),
        onError: (m) => { setError(m); setStatus(""); setRunning(false); reportLLMError(m); },
        onDone: async () => {
          setStatus(""); setRunning(false); window.dispatchEvent(new Event("usage-updated"));
          // Recommend using CURRENT refs captured in closure (setRefs is async, storage lags one tick)
          try {
            const forRec = latestRefs.map((r) => ({
              ref_key: refKeyOf(r as Reference & { upload_id?: string }),
              title: r.title || "",
              abstract: r.abstract || "",
            }));
            const res = await fetchDeepResearchRecommend(
              { question, refs: forRec },
              ctrl.current?.signal,
            );
            if (res.ok && res.items) {
              const map: Record<string, RecommendItem> = {};
              const autoDeep: string[] = [];
              for (const it of res.items) {
                map[it.ref_key] = it;
                if (it.score === "high") autoDeep.push(it.ref_key);
              }
              setRecommend(map);
              setDeepReadKeys(autoDeep);
            }
          } catch { /* recommend failure non-blocking */ }
        },
      },
    );
    setRunning(false);
  };
  const runGenerate = async () => {
    if (running) return;
    const sel = refs.filter((r) => selectedKeys.includes(refKeyOf(r as Reference & { upload_id?: string })));
    if (sel.length === 0) { setError("请至少勾选一篇文献"); return; }
    const selEvidence = evidence.filter((e) => sel.some((r) =>
      (r.url && r.url.replace(/\/+$/, "") === (e.url || "").replace(/\/+$/, ""))
      || (r.title && r.title.trim().toLowerCase() === (e.title || "").trim().toLowerCase())
    ));
    const deep_read_targets = sel
      .filter((r) => deepReadKeys.includes(refKeyOf(r as Reference & { upload_id?: string })))
      .map((r) => {
        const cast = r as Reference & { upload_id?: string; oa_url?: string };
        return {
          ref_key: refKeyOf(cast),
          source: (cast.upload_id ? "upload" : cast.oa_url ? "oa" : "crossref") as "upload" | "oa" | "crossref",
          upload_id: cast.upload_id,
          oa_url: cast.oa_url,
        };
      });
    setError(null); setStatus(""); setText(""); setContribution([]); setVerify(null);
    setReportCollapsed(false); setFollowups([]); setWarnings([]);
    setRunning(true); goStep(4);
    ctrl.current = new AbortController();
    await streamDeepResearch(
      {
        question, field, background, phase: "generate",
        references: sel,
        evidence: selEvidence,
        deep_read_targets,
        english_report: englishReport,
        project_id: projectId,
      },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onDeepReadProgress: (p) => setDeepReadProgress(p),
        onDelta: (t) => setText((prev) => prev + t),
        onContributionTable: (rows) => { setContribution(rows); setDeepReadProgress(null); },
        onVerify: setVerify,
        onWarning: (m) => setWarnings((prev) => [...prev, m]),
        onError: (m) => {
          setError(m); setStatus(""); setRunning(false);
          setText((t) => (t && !t.endsWith("…(生成中断)") ? t + "\n\n…(生成中断)" : t));
          reportLLMError(m);
        },
        onDone: () => {
          setStatus(""); setRunning(false); setDeepReadProgress(null);
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setRunning(false);
  };
  const stop = () => { ctrl.current?.abort(); setRunning(false); setStatus(""); };

  const toggleStudyType = (key: string) => {
    setStudyTypes((prev) => (prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]));
  };

  // refSort/setRefSort: 预留给 Step 3 排序增强 (尚未接入 LiteraturePicker), 暂保留
  void refSort; void setRefSort;
  void useMemo;

  return (
    <div className="module idea-wizard">
      <header className="module-head">
        <h1>🔬 深度调研 · 医学/药学/生物</h1>
        <p>四步:研究问题 → 检索设置 → 文献复核 (含深读推荐) → 调研产出。</p>
      </header>

      <div className="wiz-steps" data-testid="research-wiz-steps">
        {STEPS.map((s) => {
          const state = step === s.n ? "current" : s.n < step ? "done" : "todo";
          const clickable = s.n <= maxStep;
          return (
            <button key={s.n} type="button" className={`wiz-step ${state}`}
              data-testid={`research-wiz-step-${s.n}`}
              disabled={!clickable}
              onClick={() => clickable && setStep(s.n)}
            >
              <span className="wiz-step-num">{s.n < step ? "✓" : s.n}</span>
              <span className="wiz-step-text">
                <span className="wiz-step-title">{s.title}</span>
                <span className="wiz-step-desc">{s.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      {error && <div className="result-error">{error}</div>}
      <WarningPanel warnings={warnings} onClear={() => setWarnings([])} testId="research-warnings" />

      {/* Step 1 */}
      {step === 1 && (
        <div className="wiz-panel" data-testid="research-wiz-panel-1">
          <div className="form">
            <label className="field">
              <span className="field-label">研究问题 <em>必填</em></span>
              <textarea
                data-testid="research-input-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="例如: PD-1 抑制剂能否改善三阴性乳腺癌患者的 OS? 与化疗相比不同亚组的效应差异如何?"
                rows={3}
              />
            </label>
            <label className="field">
              <span className="field-label">研究领域 (可选,用于消歧)</span>
              <input
                data-testid="research-input-field"
                value={field}
                onChange={(e) => setField(e.target.value)}
                placeholder="例如: 乳腺癌免疫治疗"
              />
            </label>
            <AttachmentUploadBox
              label="相关资料 (可选)"
              hint="Word / PDF / txt,将在开始检索时解析,作为背景注入"
              textValue={background}
              onTextChange={setBackground}
              pendingFiles={pendingBackgroundFiles}
              onFilesAdd={(fs) => setPendingBackgroundFiles((prev) => [...prev, ...fs])}
              onFileRemove={(i) => setPendingBackgroundFiles((prev) => prev.filter((_, k) => k !== i))}
              disabled={running}
              testId="research-background-field"
              placeholder="粘贴前置综述/背景, 或拖入 pdf/docx"
            />
            <div className="field" data-testid="research-upload-lit-field">
              <span className="field-label">上传文献 (可选,进入文献池)</span>
              <AttachmentUploadBox
                label=""
                hint={uploadParsing ? `解析中 ${uploadParsing.done}/${uploadParsing.total}` : "拖入或选择;解析后自动进入文献池"}
                pendingFiles={pendingLitFiles}
                onFilesAdd={async (fs) => {
                  setPendingLitFiles((prev) => [...prev, ...fs]);
                  await ingestLit(fs);
                  setPendingLitFiles([]);
                }}
                onFileRemove={(i) => setPendingLitFiles((prev) => prev.filter((_, k) => k !== i))}
                disabled={running || !!uploadParsing}
                testId="research-upload-lit-box"
              />
              {uploadedRefs.length > 0 && (
                <div className="uploaded-list" data-testid="research-uploaded-list">
                  已解析 {uploadedRefs.length} 篇:
                  <ul>
                    {uploadedRefs.map((u) => (
                      <li key={u.upload_id}>
                        {u.parse_confidence === "low" ? "❓ " : ""}
                        {u.title} {u.first_author && `— ${u.first_author}`} {u.year}
                        <button className="btn-ghost" onClick={() => setUploadedRefs((prev) => prev.filter((x) => x.upload_id !== u.upload_id))}>删</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {uploadNeedingTitle.length > 0 && (
                <NeedTitleList
                  items={uploadNeedingTitle}
                  onResolved={(idx, ref) => {
                    setUploadNeedingTitle((prev) => prev.filter((_, i) => i !== idx));
                    if (ref) setUploadedRefs((prev) => [...prev, ref]);
                  }}
                />
              )}
            </div>
          </div>
          <div className="wiz-nav">
            <button className="btn-primary" onClick={() => goStep(2)} disabled={!question.trim()} data-testid="research-wiz-next-1">
              下一步:检索设置 →
            </button>
          </div>
        </div>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <div className="wiz-panel" data-testid="research-wiz-panel-2">
          <div className="form">
            <label className="field">
              <span className="field-label">调研深度</span>
              <select data-testid="research-input-depth" value={depth} onChange={(e) => setDepth(e.target.value)}>
                <option value="deep">深入 (多子方向 + 空白补检索)</option>
                <option value="fast">快速 (单轮检索)</option>
              </select>
            </label>
            <div className="field">
              <span className="field-label">时间范围</span>
              <div className="filter-row filter-chips">
                {([["1", "近 1 年"], ["2", "近 2 年"], ["3", "近 3 年"], ["4", "近 4 年"], ["5", "近 5 年"], ["", "不限"]] as const).map(([val, label]) => (
                  <label key={val || "all"} className={`type-chip${yearsBack === val ? " on" : ""}`}>
                    <input type="radio" name="research-years" data-testid={`research-years-${val || "all"}`}
                      checked={yearsBack === val} onChange={() => setYearsBack(val)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">证据等级 (勾选 = 保留)</span>
              <div className="filter-types">
                {STUDY_TYPES.map((s) => (
                  <label key={s.key} className={`type-chip${studyTypes.includes(s.key) ? " on" : ""}`}>
                    <input type="checkbox" data-testid={`research-type-${s.key}`}
                      checked={studyTypes.includes(s.key)} onChange={() => toggleStudyType(s.key)} />
                    {s.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">文献质量</span>
              <div className="filter-row filter-quality">
                <label>分区≥
                  <select data-testid="research-filter-quartile" value={minQuartile} onChange={(e) => setMinQuartile(e.target.value)}>
                    <option value="">不限</option>
                    <option value="1">仅 Q1</option>
                    <option value="2">Q1–Q2</option>
                    <option value="3">Q1–Q3</option>
                  </select>
                </label>
                <label>影响力≥
                  <input type="number" min="0" step="0.5" placeholder="不限"
                    data-testid="research-filter-impact"
                    value={impactMin} onChange={(e) => setImpactMin(e.target.value)}
                    style={{ width: "4.5em" }} />
                </label>
                <label className="type-chip">
                  <input type="checkbox" data-testid="research-filter-keep-unknown"
                    checked={keepUnknown} onChange={(e) => setKeepUnknown(e.target.checked)} />
                  保留无指标数据
                </label>
              </div>
            </div>
            <div className="field">
              <span className="field-label">报告语言</span>
              <label className="type-chip">
                <input type="checkbox" data-testid="research-english-report"
                  checked={englishReport} onChange={(e) => setEnglishReport(e.target.checked)} />
                用英语输出最终报告
              </label>
            </div>
          </div>
          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => setStep(1)} data-testid="research-wiz-back-2">← 上一步</button>
            <button className="btn-primary" onClick={runSearch} disabled={running || !question.trim()} data-testid="research-wiz-next-2">
              下一步:检索文献 →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 */}
      {step === 3 && (
        <div className="wiz-panel" data-testid="research-wiz-panel-3">
          {status && <div className="status-line"><span className="spinner" /> {status}</div>}

          <div className="deep-read-bar" data-testid="research-deep-read-bar">
            <span>
              AI 推荐深读 <strong>{Object.values(recommend).filter((r) => r.score === "high").length}</strong> 篇(⭐);
              你已勾 <strong>{deepReadKeys.length}</strong> 篇,预计 ~
              <strong>{estimateDeepReadTokens(
                refs
                  .filter((r) => deepReadKeys.includes(refKeyOf(r as Reference & { upload_id?: string })))
                  .map((r) => ({ page_count: (r as Reference & { page_count?: number }).page_count }))
              ).toLocaleString()}</strong> tokens
            </span>
            <button className="btn-ghost" onClick={() => {
              const highs = Object.values(recommend).filter((r) => r.score === "high").map((r) => r.ref_key);
              setDeepReadKeys([...new Set([...deepReadKeys, ...highs])]);
            }}>全选推荐</button>
            <button className="btn-ghost" onClick={() => setDeepReadKeys([])}>清空深读</button>
          </div>

          {/* Fallback deep-read grid: LiteraturePicker doesn't support extraColumns yet */}
          <div className="deep-read-list" data-testid="research-deep-read-list">
            <h4>深读候选 (勾选 = 将读全文)</h4>
            <table className="deep-read-table">
              <thead><tr><th>⭐</th><th>题名</th><th>深读</th></tr></thead>
              <tbody>
              {refs.map((r) => {
                const key = refKeyOf(r as Reference & { upload_id?: string });
                const rec = recommend[key];
                return (
                  <tr key={key}>
                    <td title={rec?.reason || ""}>
                      {rec?.score === "high" ? "⭐" : rec?.score === "medium" ? "○" : "—"}
                    </td>
                    <td>{r.title}</td>
                    <td>
                      <input
                        type="checkbox"
                        data-testid={`research-deep-${key}`}
                        checked={deepReadKeys.includes(key)}
                        onChange={(e) => {
                          if (e.target.checked) setDeepReadKeys((prev) => [...new Set([...prev, key])]);
                          else setDeepReadKeys((prev) => prev.filter((x) => x !== key));
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
              </tbody>
            </table>
          </div>

          <h4 style={{marginTop: 24, marginBottom: 8, fontSize: 14, color: 'var(--muted)'}}>
            文献列表 (勾选 = 参与合成, 详情/证据/删除在此)
          </h4>
          <LiteraturePicker
            refs={refs}
            evidenceByKey={(() => {
              const m: Record<string, EvidenceItem & { _ev_status?: string }> = {};
              const byUrl: Record<string, EvidenceItem> = {};
              const byTitle: Record<string, EvidenceItem> = {};
              for (const e of evidence) {
                if (e.url) byUrl[e.url.replace(/\/+$/, "")] = e;
                if (e.title) byTitle[e.title.trim().toLowerCase()] = e;
              }
              for (const r of refs) {
                const ev = byUrl[(r.url || "").replace(/\/+$/, "")] || byTitle[(r.title || "").trim().toLowerCase()];
                if (ev) m[refKeyOf(r as Reference & { upload_id?: string })] = ev as EvidenceItem & { _ev_status?: string };
              }
              return m;
            })()}
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            keyFn={(r) => refKeyOf(r as Reference & { upload_id?: string })}
            exportFilename="深度调研-文献"
          />

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => setStep(2)} data-testid="research-wiz-back-3">← 上一步</button>
            {running ? (
              <button className="btn-ghost" onClick={stop} data-testid="research-stop-btn">停止</button>
            ) : (
              <button className="btn-primary" onClick={runGenerate} disabled={selectedKeys.length === 0} data-testid="research-wiz-next-3">
                开始文献调研 (勾选 {selectedKeys.length} 篇, 深读 {deepReadKeys.length} 篇) →
              </button>
            )}
          </div>
        </div>
      )}

      {/* Step 4 (调研产出) */}
      {step === 4 && (
        <div className="wiz-panel" data-testid="research-wiz-panel-4">
          {status && <div className="status-line"><span className="spinner" /> {status}</div>}
          {deepReadProgress && (
            <div className="deep-read-progress" data-testid="research-deep-read-progress">
              深读 {deepReadProgress.done}/{deepReadProgress.total} …
            </div>
          )}

          <div className="result-panel">
            <div className="result-toolbar">
              <span className="result-status">
                {running ? "生成中…" : text ? (text.endsWith("…(生成中断)") ? "⚠ 已中断" : "已完成") : "等待生成"}
              </span>
              <ReportExportBar
                text={text}
                refs={refs}
                title="深度调研"
                running={running}
                reportCollapsed={reportCollapsed}
                onToggleCollapsed={() => setReportCollapsed((v) => !v)}
                onStatus={setStatus}
                testIdPrefix="research-"
                extraLeadingActions={
                  <>
                    {running && <button className="btn-ghost" onClick={stop} data-testid="research-stop-btn">停止</button>}
                    {text && !running && (
                      <button className="btn-ghost" data-testid="research-send-to-plan-btn" onClick={() => {
                        const existing = (readPersisted<string>("plan:idea", "") || "").trim();
                        if (existing && existing !== text.trim()) {
                          if (!window.confirm(`实验规划页已有研究想法 (~${existing.length} 字), 覆盖?`)) return;
                        }
                        const parts = [`[研究问题]\n${question}`, background && `[背景]\n${background}`].filter(Boolean).join("\n\n");
                        goto("plan", {
                          "plan:idea": text,
                          "plan:materials": parts,
                          "plan:materials:migrated": true,
                        });
                      }}>→ 送到实验规划</button>
                    )}
                  </>
                }
              />
            </div>
            {reportCollapsed && text && !running && (
              <button className="report-collapsed-bar" onClick={() => setReportCollapsed(false)}>
                📄 调研报告已折叠 —— 点此展开
              </button>
            )}
            <div className={reportCollapsed && text && !running ? "report-body is-collapsed" : "report-body"}>
              <EditableMarkdown
                value={text}
                onSave={setText}
                running={running}
                enableRefine={!running && !!text}
                refs={refs}
                placeholder={running ? "正在合成…" : "点击 Step 3 的开始按钮后, 报告会显示在这里。"}
                testId="research-result-text"
              />
            </div>
          </div>

          {verify && !running && (
            verify.unverified.length === 0 ? (
              <div className="verify-ok" data-testid="research-verify">
                ✓ 引用核验: {verify.total} 处引用均命中已勾选文献
              </div>
            ) : (
              <div className="verify-bad" data-testid="research-verify">
                ⚠ 引用核验: {verify.unverified.length} 处引用未命中 (可能为 LLM 编造): {verify.unverified.slice(0, 8).join(", ")}{verify.unverified.length > 8 ? ` …还有 ${verify.unverified.length - 8} 处` : ""}
              </div>
            )
          )}

          {contribution.length > 0 && !running && (
            <div className="contribution-table" data-testid="research-contribution-table">
              <div className="contribution-head">
                <span>逐文献贡献表</span>
                <button className="btn-ghost" onClick={() => {
                  const headers = ["#", "作者/年份", "期刊", "设计", "样本", "主要发现", "相关性", "深读"];
                  const rows = contribution.map((c) => [c.n, c.author_year, c.journal, c.design, c.sample, c.finding, c.relevance, c.deep_read ? "是" : "否"]);
                  downloadCsv(tsName("深度调研-贡献表", "csv"), headers, rows);
                }}>导出 CSV</button>
              </div>
              <table>
                <thead><tr>{["#", "作者/年份", "期刊", "设计", "样本", "主要发现", "相关性", "深读"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {contribution.map((c) => (
                    <tr key={c.n}>
                      <td>{c.n}</td><td>{c.author_year}</td><td>{c.journal}</td>
                      <td>{c.design}</td><td>{c.sample}</td><td>{c.finding}</td>
                      <td>{c.relevance === "direct" ? "直接" : c.relevance === "indirect" ? "间接" : "支持"}</td>
                      <td>{c.deep_read ? "✓" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {text && !running && (
            <FollowupPanel
              testId="research-followup"
              followups={followups}
              onAddFollowup={(item) => setFollowups((prev) => [...prev, item])}
              onReviseReport={setText}
              onVerifyUpdate={setVerify as (v: unknown) => void}
              streamFn={(payload, cb) => streamDeepResearchFollowup(
                payload as Parameters<typeof streamDeepResearchFollowup>[0],
                cb as Parameters<typeof streamDeepResearchFollowup>[1],
              )}
              currentReport={text}
              references={refs}
              evidence={evidence}
              englishReport={englishReport}
            />
          )}

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => { if (running) stop(); setStep(3); }} data-testid="research-wiz-back-4">← 返回文献</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 手输题名子组件 ────────────────────────────────────────────
function NeedTitleList({ items, onResolved }: {
  items: { file: File; err?: string }[];
  onResolved: (index: number, ref: UploadedRef | null) => void;
}) {
  return (
    <div className="need-title-list" data-testid="research-need-title-list">
      {items.map((it, idx) => (
        <NeedTitleRow key={`${it.file.name}-${it.file.size}-${it.file.lastModified}`}
          file={it.file} err={it.err}
          onSkip={() => onResolved(idx, null)}
          onSubmitTitle={async (title) => {
            const info = await lookupTitle(title);
            const upload_id = "typed_" + Math.random().toString(36).slice(2, 10);
            const ref: UploadedRef = {
              upload_id, title,
              first_author: info.first_author || "",
              year: info.year || "",
              abstract: info.abstract || "",
              full_text_available: false,
              page_count: 0,
              parse_confidence: "low",
            };
            onResolved(idx, ref);
          }}
        />
      ))}
    </div>
  );
}

function NeedTitleRow({ file, err, onSkip, onSubmitTitle }: {
  file: File; err?: string; onSkip: () => void; onSubmitTitle: (t: string) => void;
}) {
  const [title, setTitle] = useState("");
  return (
    <div className="need-title-row">
      <span>无法识别题名:{file.name} {err && `(${err})`}</span>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="请输入论文题目" />
      <button onClick={() => title.trim() && onSubmitTitle(title.trim())} disabled={!title.trim()}>提交</button>
      <button onClick={onSkip}>跳过</button>
    </div>
  );
}
