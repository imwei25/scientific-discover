import { useEffect, useRef, useState } from "react";
import {
  streamGrant, planGrant, streamGrantRevise,
  Reference, Verification, GrantScheme, GrantOutlineItem,
} from "../lib/sse";
import { reportLLMError } from "../lib/errorToast";
import { addHistory } from "../lib/history";
import Markdown from "../components/Markdown";
import DeaiPanel from "../components/DeaiPanel";
import { CanvasSlot } from "../components/Canvas";
import Dropzone from "../components/Dropzone";
import { usePersistentState } from "../lib/usePersistentState";
import { downloadText, downloadDocxFromText, tsName } from "../lib/download";

const GRANT_TYPES: { key: string; label: string }[] = [
  { key: "general", label: "国家自然科学基金·面上项目" },
  { key: "youth", label: "国家自然科学基金·青年科学基金" },
  { key: "regional", label: "国家自然科学基金·地区科学基金" },
  { key: "general_other", label: "通用申请书（省部级/校级/横向等）" },
];

// 写作中的章节: 标题用于 ## 大标题, text 为正文。review 节也用同结构存。
interface DocSection { key: string; title: string; text: string }
// 大纲项额外带 include 开关(用户可在确认阶段勾掉某节)。
type EditableOutline = GrantOutlineItem & { include: boolean };

const emptyScheme: GrantScheme = {
  title: "", question: "", hypothesis: "", goal: "", contents: [], innovations: [], route: "",
};

function fullDoc(sections: DocSection[]): string {
  return sections.map((s) => `## ${s.title}\n\n${s.text}`).join("\n\n");
}

export default function GrantModule() {
  // 这些字段可由「找选题」一键带入(写入对应持久化键后切换过来)。
  const [title, setTitle] = usePersistentState("grant:title", "");
  const [idea, setIdea] = usePersistentState("grant:idea", "");
  const [report, setReport] = usePersistentState("grant:report", "");
  const [background, setBackground] = usePersistentState("grant:background", "");
  const [grantType, setGrantType] = usePersistentState("grant:type", "general");
  const [refs, setRefs] = usePersistentState<Reference[]>("grant:refs", []);

  // phase: idle(未开始) | planned(大纲待确认) | writing | done
  const [phase, setPhase] = usePersistentState<string>("grant:phase", "idle");
  const [scheme, setScheme] = usePersistentState<GrantScheme | null>("grant:scheme", null);
  const [outline, setOutline] = usePersistentState<EditableOutline[]>("grant:outline", []);
  const [sections, setSections] = usePersistentState<DocSection[]>("grant:sections", []);
  const [verify, setVerify] = usePersistentState<Verification | null>("grant:verify", null);

  const [status, setStatus] = useState("");
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docxBusy, setDocxBusy] = useState(false);
  const [docxErr, setDocxErr] = useState("");
  const ctrl = useRef<AbortController | null>(null);

  // 逐节重写
  const [reviseNote, setReviseNote] = useState<Record<string, string>>({});
  const [revisingKey, setRevisingKey] = useState<string | null>(null);
  const [reviseErr, setReviseErr] = useState<string | null>(null);
  const [reviseStatus, setReviseStatus] = useState("");
  const rctrl = useRef<AbortController | null>(null);

  const text = fullDoc(sections);

  // 去 AI 味采纳/撤回: 正文由 fullDoc(sections) 拼成, 去AI味不动 `## 标题`,
  // 故按 `## ` 切回、按序写回各节正文(解析失败的节保持原样, 不破坏文档)。
  const applyDeai = (newDoc: string) => {
    const parts = newDoc.split(/\n(?=## )/);
    setSections((prev) =>
      prev.map((s, i) => {
        const p = parts[i];
        if (p === undefined) return s;
        const m = p.match(/^##\s+(.+?)\r?\n+([\s\S]*)$/);
        return m ? { ...s, title: m[1].trim(), text: m[2].trim() } : s;
      }),
    );
  };

  const savedRef = useRef("");
  useEffect(() => {
    if (phase === "done" && !running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "grant",
        icon: "📜",
        title: (scheme?.title || title || "标书初稿").slice(0, 40),
        data: {
          "grant:title": title, "grant:idea": idea, "grant:report": report,
          "grant:background": background, "grant:type": grantType, "grant:refs": refs,
          "grant:scheme": scheme, "grant:outline": outline, "grant:sections": sections,
          "grant:phase": "done", "grant:verify": verify,
        },
      });
    }
  }, [phase, running, error, text, title, scheme]);

  const hasInput = !!(title.trim() || report.trim());

  // —— 第一步: 生成可编辑大纲(两段式) ——
  const genPlan = async () => {
    if (!hasInput || planning || running) return;
    setError(null);
    setPlanning(true);
    setStatus("正在凝练研究方案与大纲…");
    const plan = await planGrant({ title, idea, report, grant_type: grantType });
    setScheme({ ...emptyScheme, ...plan.scheme });
    setOutline(plan.outline.map((o) => ({ ...o, include: true })));
    setSections([]);
    setVerify(null);
    setPhase("planned");
    setStatus("");
    setPlanning(false);
    window.dispatchEvent(new Event("usage-updated"));
  };

  // —— 第二步(或一步到位): 撰写 ——
  // confirmed=true 时带上用户确认过的 scheme/sections; 否则让后端现凝练(跳过确认)。
  const startWrite = async (confirmed: boolean) => {
    if (!hasInput || running) return;
    setError(null);
    setSections([]);
    setVerify(null);
    setReviseErr(null);
    setPhase("writing");
    setRunning(true);
    ctrl.current = new AbortController();
    const payload: Record<string, unknown> = {
      title, idea, report, background, grant_type: grantType, references: refs,
    };
    if (confirmed) {
      if (scheme) payload.scheme = scheme;
      payload.sections = outline
        .filter((o) => o.include)
        .map((o) => ({ key: o.key, title: o.title, budget: o.budget }));
    }
    await streamGrant(payload, {
      signal: ctrl.current.signal,
      onStatus: setStatus,
      onScheme: (s) => setScheme(s),
      onOutline: (items) => setOutline(items.map((o) => ({ ...o, include: true }))),
      onSection: (key, secTitle) =>
        setSections((prev) => [...prev, { key, title: secTitle, text: "" }]),
      onDelta: (t) =>
        setSections((prev) => {
          if (!prev.length) return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, text: last.text + t };
          return next;
        }),
      onVerify: setVerify,
      onError: (m) => {
        setError(m);
        setStatus("");
        setRunning(false);
        setPhase("done");
        window.dispatchEvent(new Event("usage-updated"));
        reportLLMError(m);
      },
      onDone: () => {
        setStatus("");
        setRunning(false);
        setPhase("done");
        window.dispatchEvent(new Event("usage-updated"));
      },
    });
    setRunning(false);
  };

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
    setPhase("done");
  };

  // —— 逐节重写 —— research=true 时先按新方向重新检索文献再写。
  const reviseSection = async (sec: DocSection, research: boolean) => {
    const note = (reviseNote[sec.key] || "").trim();
    if (!note || revisingKey || running) return;
    setReviseErr(null);
    setReviseStatus("");
    setRevisingKey(sec.key);
    rctrl.current = new AbortController();
    const budget = outline.find((o) => o.key === sec.key)?.budget || "";
    let buf = "";
    await streamGrantRevise(
      {
        title, report, background, grant_type: grantType, references: refs, scheme,
        section: { key: sec.key, title: sec.title, budget },
        current: sec.text,
        note,
        research,
      },
      {
        signal: rctrl.current.signal,
        onStatus: setReviseStatus,
        onReferences: (items) => setRefs(items), // 重新调研: 把扩充后的文献池写回
        onDelta: (t) => {
          buf += t;
          setSections((prev) => prev.map((s) => (s.key === sec.key ? { ...s, text: buf } : s)));
        },
        onVerify: setVerify,
        onError: (m) => {
          setReviseErr(`《${sec.title}》修改失败：${m}`);
          setRevisingKey(null);
          setReviseStatus("");
          reportLLMError(m);
        },
        onDone: () => {
          setReviseNote((prev) => ({ ...prev, [sec.key]: "" }));
          setRevisingKey(null);
          setReviseStatus("");
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setRevisingKey(null);
  };

  const reset = () => {
    if (running) stop();
    rctrl.current?.abort();
    setTitle(""); setIdea(""); setReport(""); setBackground(""); setRefs([]);
    setScheme(null); setOutline([]); setSections([]); setVerify(null);
    setReviseNote({}); setRevisingKey(null); setReviseErr(null);
    setStatus(""); setError(null); setPhase("idle");
  };

  const exportMd = () => {
    const refMd = refs.length
      ? "\n\n## 参考文献\n" + refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n")
      : "";
    downloadText(tsName("标书初稿", "md"), text + refMd);
  };

  const exportDocx = async () => {
    if (!text || docxBusy) return;
    setDocxBusy(true);
    setDocxErr("");
    try {
      await downloadDocxFromText(tsName("标书初稿", "docx"), text);
    } catch (e) {
      setDocxErr(`导出 Word 失败：${(e as Error).message}`);
    } finally {
      setDocxBusy(false);
    }
  };

  const updateScheme = (patch: Partial<GrantScheme>) =>
    setScheme((prev) => ({ ...(prev || emptyScheme), ...patch }));

  return (
    <div className="module">
      <header className="module-head">
        <h1>📜 写标书 · 中文基金申请书</h1>
        <p>
          接着「找选题」往下走：先把选题<strong>凝练成方案骨架 + 大纲</strong>交你确认/修改，再按
          <strong>立项依据 → 研究内容与目标 → 研究方案与可行性 → 特色创新 → 年度计划 → 研究基础</strong>分节撰写，
          最后给一份<strong>评审视角自查</strong>；写完每节都可<strong>按意见单独重写</strong>。立项依据只引用选题阶段检索到的真实文献；
          申请人/经费等无法推断的事实用 <code>[需申请人补充]</code> 占位，绝不杜撰。产出为<strong>初稿</strong>，请人工核对后使用。
        </p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">项目题名 / 研究方向 <em>必填</em></span>
          <input
            data-testid="grant-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：肠道菌群代谢物 TMAO 通过 NLRP3 炎症小体促进动脉粥样硬化的机制研究"
          />
        </label>
        <label className="field">
          <span className="field-label">资助类型</span>
          <select data-testid="grant-type" value={grantType} onChange={(e) => setGrantType(e.target.value)}>
            {GRANT_TYPES.map((g) => (
              <option key={g.key} value={g.key}>{g.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">研究想法 / 核心思路（可选，建议从「找选题」带入）</span>
          <textarea
            data-testid="grant-idea"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="拟解决的科学问题、创新点、初步设想等"
            rows={3}
          />
        </label>
        <label className="field">
          <span className="field-label">选题调研报告（可选，强烈建议带入——用于综述现状/空白并据实引用文献）</span>
          <textarea
            data-testid="grant-report"
            value={report}
            onChange={(e) => setReport(e.target.value)}
            placeholder="从「找选题」点“用此结果写标书 →”会自动带入这里；也可手动粘贴你的调研综述。"
            rows={4}
          />
        </label>
        <label className="field">
          <span className="field-label">研究基础 / 工作条件（可选）</span>
          <textarea
            data-testid="grant-background"
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            placeholder="例如：团队前期相关工作、已有平台/设备/样本来源、合作单位等（缺失处会标注 [需申请人补充]）"
            rows={3}
          />
        </label>
        <Dropzone
          testId="grant-upload"
          accept=".docx,.pdf,.txt,.md"
          label="附加材料（可选：已有综述/前期工作/预实验）"
          hint="支持 Word/PDF/txt；内容会作为研究基础补充"
          mode="text"
          onText={(t, name) =>
            setBackground((prev) => (prev ? prev + "\n\n" : "") + `[附加材料：${name}]\n` + t)
          }
        />

        {refs.length > 0 && (
          <div className="field" data-testid="grant-refs-info">
            <span className="field-label">已带入可引用文献</span>
            <span className="field-hint">
              共 {refs.length} 篇（来自找选题）。立项依据会优先据实引用这些文献，写完做引用核验。
            </span>
          </div>
        )}

        <div className="form-actions">
          <button
            className="btn-primary"
            onClick={genPlan}
            disabled={!hasInput || planning || running}
            data-testid="grant-plan-btn"
          >
            {planning ? "生成中…" : "① 生成大纲（推荐先确认）"}
          </button>
          <button
            className="btn-secondary"
            onClick={() => startWrite(false)}
            disabled={!hasInput || running}
            data-testid="grant-oneshot-btn"
          >
            一步到位直接写完
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="grant-reset-btn">
            清空
          </button>
        </div>
      </div>

      {status && (
        <div className="status-line" data-testid="grant-status">
          <span className="spinner" /> {status}
        </div>
      )}

      {error && <div className="result-error" data-testid="grant-error">{error}</div>}

      {/* —— 大纲确认面板(两段式第二步) —— */}
      {phase === "planned" && scheme && (
        <div className="topic-card" data-testid="grant-confirm">
          <div className="topic-card-head">🧭 确认方案骨架与大纲（可直接编辑，确认后再撰写）</div>
          <div className="form" style={{ marginTop: 8 }}>
            <label className="field">
              <span className="field-label">凝练后的项目题名</span>
              <input
                data-testid="grant-scheme-title"
                value={scheme.title}
                onChange={(e) => updateScheme({ title: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">关键科学问题</span>
              <textarea value={scheme.question} rows={2} onChange={(e) => updateScheme({ question: e.target.value })} />
            </label>
            <div className="ss-row">
              <label className="field">
                <span className="field-label">科学假设</span>
                <textarea value={scheme.hypothesis} rows={2} onChange={(e) => updateScheme({ hypothesis: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">总体目标</span>
                <textarea value={scheme.goal} rows={2} onChange={(e) => updateScheme({ goal: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span className="field-label">研究内容（每行一条）</span>
              <textarea
                value={scheme.contents.join("\n")}
                rows={3}
                onChange={(e) => updateScheme({ contents: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
              />
            </label>
            <label className="field">
              <span className="field-label">创新点（每行一条）</span>
              <textarea
                value={scheme.innovations.join("\n")}
                rows={2}
                onChange={(e) => updateScheme({ innovations: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
              />
            </label>
            <label className="field">
              <span className="field-label">技术路线主线</span>
              <textarea value={scheme.route} rows={2} onChange={(e) => updateScheme({ route: e.target.value })} />
            </label>

            <div className="field">
              <span className="field-label">大纲章节（勾选要写的，可改标题与篇幅）</span>
              <ol className="grant-outline-edit" data-testid="grant-outline-edit">
                {outline.map((o, i) => (
                  <li key={o.key} className="grant-outline-row">
                    <input
                      type="checkbox"
                      checked={o.include}
                      data-testid={`grant-outline-include-${i}`}
                      onChange={(e) =>
                        setOutline((prev) => prev.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))
                      }
                    />
                    <input
                      className="grant-outline-title"
                      value={o.title}
                      onChange={(e) =>
                        setOutline((prev) => prev.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))
                      }
                    />
                    <input
                      className="grant-outline-budget"
                      value={o.budget}
                      onChange={(e) =>
                        setOutline((prev) => prev.map((x, j) => (j === i ? { ...x, budget: e.target.value } : x)))
                      }
                    />
                  </li>
                ))}
              </ol>
            </div>

            <div className="form-actions">
              <button
                className="btn-primary"
                data-testid="grant-confirm-write-btn"
                onClick={() => startWrite(true)}
                disabled={running || !outline.some((o) => o.include)}
              >
                ② 确认大纲并撰写 →
              </button>
              <button className="btn-ghost" onClick={() => setPhase("idle")} disabled={running}>
                收起
              </button>
            </div>
          </div>
        </div>
      )}

      {/* —— 只读方案骨架(撰写中/已完成时折叠展示) —— */}
      {scheme && phase !== "planned" && (text || running) && (
        <details className="refs" data-testid="grant-scheme-view">
          <summary>🧭 研究方案骨架</summary>
          <div className="result-text">
            {scheme.question && <p><strong>关键科学问题：</strong>{scheme.question}</p>}
            {scheme.hypothesis && <p><strong>科学假设：</strong>{scheme.hypothesis}</p>}
            {scheme.goal && <p><strong>总体目标：</strong>{scheme.goal}</p>}
            {scheme.contents.length > 0 && (
              <div><strong>研究内容：</strong><ol>{scheme.contents.map((c, i) => <li key={i}>{c}</li>)}</ol></div>
            )}
            {scheme.innovations.length > 0 && (
              <div><strong>创新点：</strong><ul>{scheme.innovations.map((c, i) => <li key={i}>{c}</li>)}</ul></div>
            )}
            {scheme.route && <p><strong>技术路线主线：</strong>{scheme.route}</p>}
          </div>
        </details>
      )}

      <CanvasSlot>
        <div className="result-panel">
          <div className="result-toolbar">
            <span className="result-status">{running ? "撰写中…" : text ? "已完成" : "等待开始"}</span>
            <div className="result-actions">
              {running && (
                <button className="btn-ghost" onClick={stop} data-testid="grant-stop-btn">停止</button>
              )}
              {text && !running && (
                <DeaiPanel value={text} onApply={applyDeai} disabled={running} />
              )}
              {text && !running && (
                <button className="btn-ghost" data-testid="grant-export-md" onClick={exportMd}>导出 Markdown</button>
              )}
              {text && !running && (
                <button className="btn-ghost" data-testid="grant-export-docx" onClick={exportDocx} disabled={docxBusy}>
                  {docxBusy ? "导出中…" : "导出 Word"}
                </button>
              )}
            </div>
          </div>
          {docxErr && <div className="result-error">{docxErr}</div>}
          <div className="result-text" data-testid="grant-result">
            {text ? (
              <Markdown>{text}</Markdown>
            ) : (
              <span className="result-placeholder">
                {running ? "正在撰写…" : "填好题名（或从「找选题」带入）后，点“生成大纲”确认，再撰写；申请书初稿会显示在这里。"}
              </span>
            )}
            {running && <span className="cursor-blink">▍</span>}
          </div>
        </div>
      </CanvasSlot>

      {verify && !running && (
        verify.unverified.length === 0 ? (
          <div className="verify-ok" data-testid="grant-verify">
            ✓ 引用核验：正文 {verify.total} 处文献引用均来自选题阶段检索到的真实文献。
          </div>
        ) : (
          <div className="verify-bad" data-testid="grant-verify">
            ⚠ 引用核验：发现 {verify.unverified.length} 处引用未出现在带入的文献中，可能不准确，请核实：
            {verify.unverified.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer">{u}</a>
            ))}
          </div>
        )
      )}

      {/* —— 逐节修改 —— */}
      {phase === "done" && sections.length > 0 && !running && (
        <div className="followup" data-testid="grant-revise">
          <div className="followup-head">逐节修改</div>
          <p className="followup-tip">
            对某一章节不满意？写下修改意见，让 AI 只重写这一节（不动其它章节）。普通重写只用现有文献；
            <strong>立项依据</strong>可选「🔍 重新调研重写」——按你的新方向再检索 PubMed 等并把新文献并入后重写（更慢、更耗额度）。
          </p>
          {reviseErr && <div className="result-error">{reviseErr}</div>}
          {reviseStatus && (
            <div className="status-line" data-testid="grant-revise-status">
              <span className="spinner" /> {reviseStatus}
            </div>
          )}
          <ol className="grant-revise-list">
            {sections.map((s) => (
              <li key={s.key} className="grant-revise-item" data-testid={`grant-revise-${s.key}`}>
                <div className="grant-revise-title">{s.title}</div>
                <div className="grant-revise-controls">
                  <input
                    data-testid={`grant-revise-note-${s.key}`}
                    value={reviseNote[s.key] || ""}
                    onChange={(e) => setReviseNote((prev) => ({ ...prev, [s.key]: e.target.value }))}
                    placeholder="例如：补一段技术路线图说明 / 创新点更聚焦机制 / 这节再精简些"
                    disabled={!!revisingKey}
                  />
                  <button
                    className="btn-ghost btn-sm"
                    data-testid={`grant-revise-btn-${s.key}`}
                    onClick={() => reviseSection(s, false)}
                    disabled={!!revisingKey || !(reviseNote[s.key] || "").trim()}
                  >
                    {revisingKey === s.key ? "重写中…" : "重写本节"}
                  </button>
                  {s.key === "rationale" && (
                    <button
                      className="btn-secondary btn-sm"
                      data-testid={`grant-research-btn-${s.key}`}
                      onClick={() => reviseSection(s, true)}
                      disabled={!!revisingKey || !(reviseNote[s.key] || "").trim()}
                      title="按你的修改意见作为新方向，重新检索文献后再写"
                    >
                      🔍 重新调研重写
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
