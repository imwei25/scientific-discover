import { useState, useRef, useEffect } from "react";
import { apiUrl } from "../lib/api";
import { usePersistentState, readPersisted, writePersisted } from "../lib/usePersistentState";
import { downloadBlob, tsName } from "../lib/download";
import { addHistory } from "../lib/history";
import { CanvasSlot } from "../components/Canvas";
import { streamEthicsFollowup } from "../lib/sse";
import { reportLLMError } from "../lib/errorToast";
import Markdown from "../components/Markdown";
import { extractFile } from "../lib/extract";

type TemplateId = "informed_consent" | "protocol" | "crf" | "data_use_commitment";

interface FieldDef {
  key: string; label: string; rows?: number; placeholder?: string;
}
interface TemplateDef {
  id: TemplateId; icon: string; title: string; desc: string; fields: FieldDef[];
}

const TEMPLATES: TemplateDef[] = [
  {
    id: "informed_consent", icon: "📋", title: "知情同意书", desc: "受试者签字版,伦理委员会必交",
    fields: [
      { key: "研究名称", label: "研究名称", placeholder: "完整正式的研究项目名称" },
      { key: "研究目的", label: "研究目的", rows: 3, placeholder: "用通俗语言说明本研究希望解决的问题" },
      { key: "研究流程", label: "研究流程", rows: 4, placeholder: "受试者将经历哪些访视、检查、干预" },
      { key: "风险", label: "潜在风险与不适", rows: 3, placeholder: "已知与预期的不良反应、风险等级" },
      { key: "受益", label: "可能的获益", rows: 3, placeholder: "对受试者本人或社会的潜在获益" },
      { key: "隐私保护", label: "隐私与数据保护", rows: 3, placeholder: "去标识化、访问权限、保存期限等" },
      { key: "自愿原则", label: "自愿参加与退出", rows: 2, placeholder: "可随时退出,不影响常规医疗等说明" },
      { key: "研究者", label: "主要研究者(PI)", placeholder: "姓名 · 职称" },
      { key: "联系方式", label: "联系电话/邮箱", placeholder: "受试者咨询/投诉通道" },
      { key: "机构", label: "研究机构", placeholder: "医院/科室全称" },
      { key: "日期", label: "版本日期", placeholder: "YYYY-MM-DD" },
    ],
  },
  {
    id: "protocol", icon: "📜", title: "研究方案", desc: "详细的科研方案,供伦理审查与立项",
    fields: [
      { key: "研究名称", label: "研究名称", placeholder: "项目正式名称" },
      { key: "研究背景", label: "研究背景与意义", rows: 4, placeholder: "国内外现状、未解决的问题、本研究的必要性" },
      { key: "研究目的", label: "研究目的", rows: 3, placeholder: "主要目的与次要目的" },
      { key: "研究假设", label: "研究假设", rows: 2, placeholder: "可被检验的科学假设" },
      { key: "研究设计", label: "研究设计", rows: 3, placeholder: "如随机对照/前瞻队列/横断面等" },
      { key: "入组标准", label: "入组标准", rows: 3, placeholder: "受试者纳入条件" },
      { key: "排除标准", label: "排除标准", rows: 3, placeholder: "排除条件" },
      { key: "样本量", label: "样本量估算", rows: 2, placeholder: "样本量及计算依据(α、power、效应量)" },
      { key: "干预措施", label: "干预/暴露因素", rows: 3, placeholder: "干预方案、剂量、疗程或暴露的定义" },
      { key: "主要终点", label: "主要终点指标", rows: 2, placeholder: "如治疗有效率、生存期等" },
      { key: "次要终点", label: "次要终点指标", rows: 2, placeholder: "如安全性、生活质量等" },
      { key: "统计方法", label: "统计分析方法", rows: 3, placeholder: "采用的统计模型、缺失数据处理等" },
      { key: "研究时间", label: "研究时间表", rows: 2, placeholder: "起止时间、关键节点" },
      { key: "研究者", label: "主要研究者", placeholder: "姓名 · 职称" },
      { key: "机构", label: "研究机构", placeholder: "牵头单位" },
      { key: "日期", label: "版本日期", placeholder: "YYYY-MM-DD" },
    ],
  },
  {
    id: "crf", icon: "📊", title: "CRF 病例报告表", desc: "标准化数据采集模板",
    fields: [
      { key: "研究名称", label: "研究名称", placeholder: "对应方案名称" },
      { key: "受试者编号", label: "受试者编号规则", rows: 2, placeholder: "如 中心号-序号,例 01-001" },
      { key: "访视计划", label: "访视计划", rows: 4, placeholder: "V1 基线 / V2 4 周 / V3 12 周 等" },
      { key: "基线数据", label: "基线数据字段", rows: 4, placeholder: "人口学、既往史、合并用药等需采集字段" },
      { key: "疗效指标", label: "疗效评价字段", rows: 4, placeholder: "每个访视采集的主/次要终点字段" },
      { key: "安全性指标", label: "安全性字段", rows: 3, placeholder: "不良事件、实验室检查、生命体征" },
      { key: "脱落终止", label: "脱落/终止字段", rows: 2, placeholder: "退出原因、终止访视等" },
      { key: "研究者", label: "数据负责人", placeholder: "姓名 · 职称" },
      { key: "机构", label: "研究机构", placeholder: "所属单位" },
      { key: "日期", label: "版本日期", placeholder: "YYYY-MM-DD" },
    ],
  },
  {
    id: "data_use_commitment", icon: "🔒", title: "数据使用承诺", desc: "研究者签署的数据使用与保密承诺",
    fields: [
      { key: "研究名称", label: "研究名称", placeholder: "项目名称" },
      { key: "数据来源", label: "数据来源", rows: 3, placeholder: "病历系统/检验/影像/问卷等" },
      { key: "使用范围", label: "数据使用范围", rows: 3, placeholder: "仅用于本研究的哪些分析" },
      { key: "保密措施", label: "保密与去标识化措施", rows: 3, placeholder: "如何脱敏、存储位置、访问控制" },
      { key: "保存期限", label: "数据保存期限", rows: 2, placeholder: "依据法规与机构要求" },
      { key: "销毁方式", label: "数据销毁/归档方式", rows: 2, placeholder: "研究结束后的处理流程" },
      { key: "研究者", label: "承诺人(PI)", placeholder: "姓名 · 职称" },
      { key: "联系方式", label: "联系方式", placeholder: "电话/邮箱" },
      { key: "机构", label: "所在机构", placeholder: "单位全称" },
      { key: "日期", label: "签署日期", placeholder: "YYYY-MM-DD" },
    ],
  },
];

const FILE_PREFIX: Record<TemplateId, string> = {
  informed_consent: "知情同意书", protocol: "研究方案", crf: "CRF病例报告表", data_use_commitment: "数据使用承诺",
};

const STEPS = [
  { n: 1, title: "准备材料", desc: "附加材料 · 可选内容清单" },
  { n: 2, title: "预览 & 下载", desc: "预览 · Word · 追问/修改" },
];

export default function EthicsModule() {
  const [active, setActive] = usePersistentState<TemplateId>("ethics:active", "informed_consent");
  const tpl = TEMPLATES.find((t) => t.id === active)!;
  const [step, setStep] = usePersistentState<number>("ethics:step", 1);
  const [maxStep, setMaxStep] = usePersistentState<number>("ethics:maxStep", 1);
  const goStep = (n: number) => { setStep(n); if (n > maxStep) setMaxStep(n); };

  return (
    <div className="module ethics-module ethics-wizard">
      <header className="module-head">
        <h1>📋 伦理材料 · 知情同意 / 方案 / CRF / 数据承诺</h1>
        <p>两步走:选模板 → 把材料粘贴/上传到附加材料 → 预览与下载 Word,并可追问/修改。未填内容会在最终 Word 中留空。</p>
      </header>

      <nav className="ethics-tabs" data-testid="ethics-nav" role="tablist" aria-label="伦理材料类型">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            className={`ethics-tab ${active === t.id ? "active" : ""}`}
            onClick={() => setActive(t.id)}
            data-testid={`ethics-nav-${t.id}`}
            role="tab"
            aria-selected={active === t.id}
            title={t.desc}
          >
            <span className="ethics-tab-icon" aria-hidden="true">{t.icon}</span>
            <span className="ethics-tab-title">{t.title}</span>
          </button>
        ))}
      </nav>

      <div className="wiz-steps" data-testid="ethics-steps">
        {STEPS.map((s) => {
          const state = step === s.n ? "current" : s.n < step ? "done" : "todo";
          const clickable = s.n <= maxStep;
          return (
            <button key={s.n} type="button" className={`wiz-step ${state}`} data-testid={`ethics-step-${s.n}`} disabled={!clickable} onClick={() => clickable && setStep(s.n)}>
              <span className="wiz-step-num">{s.n < step ? "✓" : s.n}</span>
              <span className="wiz-step-text"><span className="wiz-step-title">{s.title}</span><span className="wiz-step-desc">{s.desc}</span></span>
            </button>
          );
        })}
      </div>

      <p className="ethics-active-desc" data-testid="ethics-active-desc">
        <span aria-hidden="true">{tpl.icon}</span> {tpl.desc}
      </p>

      <EthicsEditor key={active} template={tpl} step={step} goStep={goStep} />
    </div>
  );
}

function EthicsEditor({ template, step, goStep }: { template: TemplateDef; step: number; goStep: (n: number) => void }) {
  const storageKey = `ethics:${template.id}:fields`;
  const materialsKey = `ethics:${template.id}:materials`;
  const draftKey = `ethics:${template.id}:draft`;
  const followupsKey = `ethics:${template.id}:followups`;

  const [materials, setMaterials] = usePersistentState<string>(materialsKey, "");
  const [draft, setDraft] = usePersistentState<string>(draftKey, "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const lastSavedRef = useRef("");

  // 一次性把旧版本存的字段值合并进 materials,让升级后不丢历史内容
  useEffect(() => {
    const sentinel = `${materialsKey}:migrated-v2`;
    if (readPersisted<boolean>(sentinel, false)) return;
    const stored = readPersisted<Record<string, string>>(storageKey, {}) || {};
    const keys = Object.keys(stored).filter((k) => (stored[k] || "").trim());
    if (keys.length > 0) {
      const parts: string[] = [];
      const existing = (readPersisted<string>(materialsKey, "") || "").trim();
      if (existing) parts.push(existing);
      for (const k of keys) parts.push(`[${k}]\n${stored[k].trim()}`);
      writePersisted(materialsKey, parts.join("\n\n"));
    }
    writePersisted(sentinel, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id]);

  const hintLabels = template.fields.map((f) => f.label);

  const doImport = () => {
    const idea = readPersisted<string>("plan:idea", "");
    const planResult = readPersisted<string>("plan:result", "");
    const parts: string[] = [];
    if (materials.trim()) parts.push(materials);
    if (idea) parts.push(`[从实验规划导入 · 研究想法]\n${idea}`);
    if (planResult) parts.push(`[从实验规划导入 · 方案主体]\n${planResult.slice(0, 4000)}`);
    if (parts.length > (materials.trim() ? 1 : 0)) {
      setMaterials(parts.join("\n\n"));
      setMsg("已把「实验规划」里的想法与方案追加到附加材料");
    } else {
      setMsg("未找到可导入内容——请先在「实验规划」里填写或生成方案");
    }
    window.setTimeout(() => setMsg(""), 5000);
  };

  const clearAll = () => {
    if (busy) return;
    if (fRunning) fctrl.current?.abort();
    if (!confirm(`确定清空"${template.title}"的全部内容?`)) return;
    setMaterials("");
    setDraft("");
  };

  // 附加材料 combo
  const matFileRef = useRef<HTMLInputElement>(null);
  const [matDrag, setMatDrag] = useState(false);
  const [matBusy, setMatBusy] = useState(false);
  const ingestMaterials = async (files: FileList | File[] | null | undefined) => {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    setMatBusy(true);
    for (const f of list) {
      const res = await extractFile(f);
      if (res.ok && res.text) {
        setMaterials((p) => (p ? p + "\n\n" : "") + `[附加材料: ${f.name}]\n` + res.text);
      }
    }
    setMatBusy(false);
    if (matFileRef.current) matFileRef.current.value = "";
  };

  // 预览 = draft 优先(经追问/修订过);否则由 materials 拼出
  const previewText = draft || renderPreview(template, materials);

  // 下载 Word:把 materials 作为独立参数,由后端渲染到"附加材料"段
  const download = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const resp = await fetch(apiUrl("/api/ethics/render"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: template.id, fields: {}, materials }),
      });
      if (!resp.ok) {
        let detail = "";
        try { detail = (await resp.text()).trim(); } catch { /* ignore */ }
        throw new Error(`服务返回 ${resp.status}${detail ? ` · ${detail}` : ""}`);
      }
      const blob = await resp.blob();
      downloadBlob(tsName(FILE_PREFIX[template.id], "docx"), blob);
      const key = `${template.id}:${previewText.slice(0, 60)}`;
      if (lastSavedRef.current !== key) {
        lastSavedRef.current = key;
        addHistory({
          module: "ethics", icon: template.icon,
          title: `${template.title} · ${(materials.trim().split("\n")[0] || "未命名").slice(0, 30)}`,
          data: {
            [materialsKey]: materials, [draftKey]: draft,
            "ethics:active": template.id,
          },
        });
      }
    } catch (e) { setErr(`下载 Word 失败: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  // 追问 / 修改
  const [followups, setFollowups] = usePersistentState<{ q: string; a: string }[]>(followupsKey, []);
  const [followupInput, setFollowupInput] = useState("");
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [fRunning, setFRunning] = useState(false);
  const [fError, setFError] = useState<string | null>(null);
  const fctrl = useRef<AbortController | null>(null);
  const followupBaseDraftRef = useRef("");
  const followupModeRef = useRef<"ask" | "revise">("ask");

  const runFollowup = async (mode: "ask" | "revise") => {
    const q = followupInput.trim();
    // 主生成 (下载 Word) 进行时禁止追问, 避免两个流并发写入 draft 造成穿插错乱
    if (!q || fRunning || busy) return;
    setFError(null); setFRunning(true);
    fctrl.current = new AbortController();
    const baseDraft = previewText;
    followupBaseDraftRef.current = baseDraft;
    followupModeRef.current = mode;
    let buf = "";
    if (mode === "ask") setCurrentAnswer("…"); else setDraft("");
    await streamEthicsFollowup(
      { mode, question: q, draft: baseDraft, template: template.id, materials },
      {
        signal: fctrl.current.signal,
        onDelta: (t) => { buf += t; if (mode === "ask") setCurrentAnswer(buf); else setDraft((p) => p + t); },
        onError: (m) => { setFError(m); setFRunning(false); if (mode === "revise") setDraft(baseDraft); reportLLMError(m); },
        onDone: () => {
          if (mode === "ask") { setFollowups((prev) => [...prev, { q, a: buf }]); setCurrentAnswer(""); }
          setFollowupInput(""); setFRunning(false); window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setFRunning(false);
  };

  return (
    <div className="ethics-editor">
      {step === 1 && (
        <div className="wiz-panel" data-testid={`ethics-panel-1-${template.id}`}>
          <div className="ethics-toolbar">
            <button className="btn-secondary" onClick={doImport} data-testid="ethics-import-btn">⬇ 从实验规划导入到附加材料</button>
            <button className="btn-ghost btn-sm" onClick={clearAll} data-testid="ethics-clear-btn">清空</button>
          </div>
          {msg && <div className="field-hint" data-testid="ethics-import-msg" style={{ marginBottom: 8 }}>{msg}</div>}

          <div className="ethics-form form">
            <div className="field" data-testid="ethics-hint-field">
              <span className="field-label">本模板建议包含以下内容(全部改为可选)</span>
              <p className="field-hint" data-testid="ethics-hint-list">
                {hintLabels.join("、")}。请在下方「附加材料」中粘贴或上传相关内容;
                <strong>未填的项在最终 Word 中会留空</strong>,可事后人工补写或交伦理委员会前再完善。
              </p>
            </div>

            <div className="field" data-testid="ethics-materials-field">
              <span className="field-label">附加材料(粘贴文字或上传附件,越充分越好)</span>
              <p className="field-hint">支持 Word / PDF / txt,<strong>可一次选多个</strong>;下载 Word 时会作为「附加材料」段附在文末。</p>
              <div className={`combo-input${matDrag ? " dragover" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setMatDrag(true); }}
                onDragLeave={() => setMatDrag(false)}
                onDrop={(e) => { e.preventDefault(); setMatDrag(false); ingestMaterials(e.dataTransfer.files); }}>
                <textarea
                  data-testid="ethics-materials"
                  value={materials}
                  onChange={(e) => setMaterials(e.target.value)}
                  placeholder="把上面建议包含的内容粘贴到这里,或把文件拖入本框(可多个)。"
                  rows={12}
                />
                <div className="combo-foot">
                  <button type="button" className="combo-attach" data-testid="ethics-materials-attach" onClick={() => matFileRef.current?.click()}>📎 添加附件(可多选)</button>
                  <span className="combo-hint">{matBusy ? "正在解析附件…" : "支持 Word / PDF / txt,可直接拖入本框"}</span>
                  <input ref={matFileRef} data-testid="ethics-upload" type="file" accept=".docx,.pdf,.txt,.md" multiple style={{ display: "none" }} onChange={(e) => ingestMaterials(e.target.files)} />
                </div>
              </div>
            </div>
          </div>

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={clearAll} data-testid="ethics-reset-btn">清空</button>
            <button className="btn-primary" onClick={() => goStep(2)} data-testid="ethics-next-1">
              下一步:预览 & 下载 →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="wiz-panel" data-testid={`ethics-panel-2-${template.id}`}>
          <CanvasSlot>
            <div className="ethics-preview" data-testid="ethics-preview">
              <div className="ethics-preview-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span>以下为附加材料速览,正式排版以下载的 Word 为准(未填字段会留空)</span>
                {previewText && (
                  <button className="btn-ghost btn-sm" data-testid="ethics-copy-btn" title="复制预览全文到剪贴板"
                    onClick={async () => {
                      try { await navigator.clipboard.writeText(previewText); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
                      catch { /* ignore */ }
                    }}>
                    {copied ? "已复制 ✓" : "复制全文"}
                  </button>
                )}
              </div>
              {draft ? (
                <div className="ethics-preview-body"><Markdown>{draft}</Markdown></div>
              ) : (
                <pre className="ethics-preview-body">{previewText || "(在上一步填入附加材料后,这里会显示预览)"}</pre>
              )}
            </div>
          </CanvasSlot>

          {err && <div className="result-error" data-testid="ethics-error">{err}</div>}

          <div className="form-actions">
            <button className="btn-primary" onClick={download} disabled={busy} data-testid="ethics-download-btn">
              {busy ? "生成中…" : "⬇ 下载 Word"}
            </button>
            <span className="field-hint">下载后请人工核对每一项;最终版本须经伦理委员会审核通过方可使用。</span>
          </div>

          <div className="followup" data-testid="ethics-followup">
            <div className="followup-head">追问 / 修改草案</div>
            <p className="followup-tip">可就草案某段追问,或按意见让 AI 重写完整草案。追问基于当前草案与附加材料。</p>
            {followups.length > 0 && (
              <div className="qa-list" data-testid="ethics-qa-list">
                {followups.map((qa, i) => (
                  <div key={i} className="qa-item">
                    <div className="qa-q">❓ {qa.q}</div>
                    <div className="qa-a"><Markdown>{qa.a}</Markdown></div>
                  </div>
                ))}
              </div>
            )}
            {fRunning && currentAnswer && (
              <div className="qa-item"><div className="qa-a"><Markdown>{currentAnswer}</Markdown><span className="cursor-blink">▍</span></div></div>
            )}
            <textarea
              data-testid="ethics-followup-input"
              value={followupInput}
              onChange={(e) => setFollowupInput(e.target.value)}
              placeholder="例如:隐私保护段是否够详细? / 请把研究流程改得更通俗 / 增加一段针对老年患者的说明"
              rows={2}
              disabled={fRunning}
            />
            {fError && <div className="result-error">{fError}</div>}
            <div className="form-actions">
              <button className="btn-primary" data-testid="ethics-ask-btn" onClick={() => runFollowup("ask")} disabled={!followupInput.trim() || fRunning || busy}>追问</button>
              <button className="btn-ghost" data-testid="ethics-revise-btn" onClick={() => runFollowup("revise")} disabled={!followupInput.trim() || fRunning || busy}>按此修改草案</button>
              {fRunning && <button className="btn-ghost" onClick={() => {
                fctrl.current?.abort();
                if (followupModeRef.current === "revise") setDraft(followupBaseDraftRef.current);
                setFRunning(false);
              }} data-testid="ethics-followup-stop">停止</button>}
              {fRunning && <span className="status-line"><span className="spinner" /> 处理中…</span>}
            </div>
          </div>

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => goStep(1)} data-testid="ethics-back-btn">← 返回填写</button>
            <button className="btn-ghost" onClick={clearAll} data-testid="ethics-reset-btn">重新开始</button>
          </div>
        </div>
      )}
    </div>
  );
}

function renderPreview(tpl: TemplateDef, materials: string): string {
  const lines: string[] = [];
  lines.push(`# ${tpl.title}`);
  lines.push(`\n(未填字段将在最终 Word 中留空)\n`);
  if (materials.trim()) {
    lines.push(`\n## 附加材料\n${materials.trim()}`);
  }
  return lines.join("\n");
}
