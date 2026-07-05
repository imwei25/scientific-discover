import { useEffect, useRef, useState } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import { streamPlanFollowup } from "../lib/sse";
import { reportLLMError } from "../lib/errorToast";
import { mergeLegacyIntoMaterials } from "../lib/legacyMerge";
import ResultPanel from "../components/ResultPanel";
import { CanvasSlot } from "../components/Canvas";
import { HelpButton } from "../components/HelpButton";
import Markdown from "../components/Markdown";
import { extractFile } from "../lib/extract";
import { downloadCsv, downloadDocxFromText, tsName } from "../lib/download";

const STEPS = [
  { n: 1, title: "准备材料", desc: "研究想法 · 附加材料" },
  { n: 2, title: "预览 & 精修", desc: "生成 · 追问 · 修改" },
];

export default function PlanModule() {
  const [idea, setIdea] = usePersistentState("plan:idea", "");
  const [materials, setMaterials] = usePersistentState("plan:materials", "");
  const [step, setStep] = usePersistentState<number>("plan:step", 1);
  const [maxStep, setMaxStep] = usePersistentState<number>("plan:maxStep", 1);
  const goStep = (n: number) => { setStep(n); if (n > maxStep) setMaxStep(n); };

  // 一次性把老的 plan:field / plan:resources 合并进 plan:materials
  useEffect(() => {
    mergeLegacyIntoMaterials("plan:materials", [
      { key: "plan:field", label: "学科领域" },
      { key: "plan:resources", label: "可用资源/条件" },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { text, running, error, start, stop, setText } = useStream("plan:result");
  const sap = useStream("plan:sap");
  const dmp = useStream("plan:dmp");
  const consent = useStream("plan:consent");
  const [docxBusy, setDocxBusy] = useState("");
  const [docxErr, setDocxErr] = useState("");

  const downloadDocx = async (txt: string, name: string, which: string) => {
    if (!txt || docxBusy) return;
    setDocxBusy(which);
    setDocxErr("");
    try {
      await downloadDocxFromText(`${name}.docx`, txt);
    } catch (e) {
      setDocxErr(`导出 Word 失败: ${(e as Error).message}`);
    } finally {
      setDocxBusy("");
    }
  };

  // 附加材料 combo 框: 拖拽 + 附件按钮
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

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "plan",
        icon: "🗺️",
        title: idea.slice(0, 40) || "实验规划",
        data: {
          "plan:idea": idea, "plan:materials": materials, "plan:result": text,
          "plan:step": step, "plan:maxStep": Math.max(maxStep, step),
        },
      });
    }
  }, [running, error, text, idea, materials, step, maxStep]);

  // 4 个生成入口:方案主体 / SAP / DMP / 知情同意书
  // 把 materials 作为 resources 字段传给后端(prompts.py 里 4 个 builder 都接受 resources)。
  const submit = () => {
    if (!idea.trim() || running) return;
    // 重新生成方案:保留历史追问,插入一条分隔标记以指示上下文断点,
    // 避免用户 20 分钟的追问成果被"一键归零"。
    if (text) {
      setFollowups((prev) => (
        prev.length && prev[prev.length - 1]?.q === "[方案已重新生成]"
          ? prev
          : [...prev, { q: "[方案已重新生成]", a: "" }]
      ));
    }
    goStep(2);
    start("plan", { idea, resources: withSampleSize(materials) });
  };
  const genSap = () => {
    if (!idea.trim() || sap.running) return;
    sap.start("sap", { idea, resources: withSampleSize(materials) });
  };
  const genDmp = () => {
    if (!idea.trim() || dmp.running) return;
    dmp.start("dmp", { idea, resources: materials });
  };
  const genConsent = () => {
    if (!idea.trim() || consent.running) return;
    consent.start("consent", { idea, resources: materials });
  };

  const reset = () => {
    if (running) stop();
    if (fRunning) fctrl.current?.abort();
    if (sap.running) sap.stop();
    if (dmp.running) dmp.stop();
    if (consent.running) consent.stop();
    setIdea("");
    setMaterials("");
    setText("");
    sap.setText("");
    dmp.setText("");
    consent.setText("");
    setSsChosen(0);
    setSsChosenMeta(null);
    setSsVerifyMsg("");
    setSvResult(null);
    setFollowups([]);
    setFollowupInput("");
    setCurrentAnswer("");
    setStep(1);
    setMaxStep(1);
  };

  // ── 追问 / 按此修改 ──────────────────────────────────────────
  const [followups, setFollowups] = usePersistentState<{ q: string; a: string }[]>("plan:followups", []);
  const [followupInput, setFollowupInput] = useState("");
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [fRunning, setFRunning] = useState(false);
  const [fError, setFError] = useState<string | null>(null);
  const fctrl = useRef<AbortController | null>(null);
  const followupBaseDraftRef = useRef("");
  const followupModeRef = useRef<"ask" | "revise">("ask");

  const runFollowup = async (mode: "ask" | "revise") => {
    const q = followupInput.trim();
    if (!q || fRunning || running) return;
    setFError(null);
    setFRunning(true);
    fctrl.current = new AbortController();
    const baseDraft = text;
    followupBaseDraftRef.current = baseDraft;
    followupModeRef.current = mode;
    let buf = "";
    if (mode === "ask") setCurrentAnswer("…");
    else setText("");
    await streamPlanFollowup(
      { mode, question: q, draft: baseDraft, idea, materials },
      {
        signal: fctrl.current.signal,
        onDelta: (t) => { buf += t; if (mode === "ask") setCurrentAnswer(buf); else setText((p) => p + t); },
        onError: (m) => { setFError(m); setFRunning(false); if (mode === "revise") setText(baseDraft); reportLLMError(m); },
        onDone: () => {
          if (mode === "ask") { setFollowups((prev) => [...prev, { q, a: buf }]); setCurrentAnswer(""); }
          setFollowupInput(""); setFRunning(false); window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setFRunning(false);
  };

  // ── 样本量 / 随机化(逻辑保持不变,只是搬到 Step 2 底部)──────
  const [ssScene, setSsScene] = usePersistentState<string>("plan:samplesize:scene", "proportion");
  const [ssEffect, setSsEffect] = usePersistentState<number>("plan:samplesize:effect", 0.3);
  const [ssAlpha, setSsAlpha] = usePersistentState<number>("plan:samplesize:alpha", 0.05);
  const [ssPower, setSsPower] = usePersistentState<number>("plan:samplesize:power", 0.8);
  const [ssSweep, setSsSweep] = usePersistentState<string>("plan:samplesize:sweep", "effect");
  const [ssChosen, setSsChosen] = usePersistentState<number>("plan:sampleSize", 0);
  type SsMeta = {
    alpha: number; power: number; effect: number; scene: string; source: string;
    // 生存分析扩展字段(可选, 兼容老快照)
    hr?: number; event_rate?: number; alloc_ratio?: number;
    events?: number; n_total?: number; n_per_group?: number[];
  };
  const [ssChosenMeta, setSsChosenMeta] = usePersistentState<SsMeta | null>("plan:sampleSizeMeta", null);
  const [ssVerifyMsg, setSsVerifyMsg] = useState<string>("");
  const [ssVerifyBusy, setSsVerifyBusy] = useState(false);

  // 生存分析专用参数
  const [svHR, setSvHR] = usePersistentState<number>("plan:samplesize:sv:hr", 0.7);
  const [svEventRate, setSvEventRate] = usePersistentState<number>("plan:samplesize:sv:eventRate", 0.3);
  const [svAllocRatio, setSvAllocRatio] = usePersistentState<number>("plan:samplesize:sv:alloc", 1.0);
  const [svResult, setSvResult] = useState<{
    ok?: boolean; error?: string; events?: number; n_total?: number; n_per_group?: number[]; notes?: string[];
  } | null>(null);
  const [svBusy, setSvBusy] = useState(false);

  const withSampleSize = (base: string): string => {
    if (!(ssChosen > 0)) return base;
    const m = ssChosenMeta;
    const scene = m?.scene ?? ssScene;
    const alpha = m?.alpha ?? ssAlpha;
    const power = m?.power ?? ssPower;
    const src = m?.source === "backend" ? "（本地精确计算）" : "";
    let note: string;
    if (scene === "survival") {
      const hr = m?.hr ?? svHR;
      const er = m?.event_rate ?? svEventRate;
      const k = m?.alloc_ratio ?? svAllocRatio;
      const events = m?.events;
      const nTotal = m?.n_total ?? ssChosen;
      const per = m?.n_per_group;
      const perStr = per && per.length === 2 ? `（对照 ${per[0]} / 试验 ${per[1]}）` : "";
      note =
        `【已确定样本量】用户已用样本量计算器（生存分析 · log-rank / Cox, Schoenfeld 公式${src}）确定：` +
        `总 N=${nTotal}${perStr}${events ? `（对应总事件数 E=${events}）` : ""}；` +
        `HR=${hr}，随访期事件率=${er}，α=${alpha}，power=${power}，分配比=${k}。` +
        `请在方案/统计部分直接采用该样本量并据此论证可行性；生存研究请额外说明随访时长与预期删失/失访率（建议再上浮 10–20%）。`;
    } else {
      const effect = m?.effect ?? ssEffect;
      const sceneLabel = scene === "proportion" ? "两组率比较(双比例)" : "两组均值比较(双均值, Cohen's d)";
      note =
        `【已确定样本量】用户已用样本量计算器确定：每组约 ${ssChosen} 例${src}（合计约 ${ssChosen * 2} 例）；` +
        `设计场景=${sceneLabel}，α=${alpha}，检验效能(power)=${power}，效应量=${effect}。` +
        `请在方案/统计部分直接采用该样本量并据此论证可行性；若为临床试验，请提醒按预期失访率（如 10–20%）适当上浮。`;
    }
    return base ? base + "\n\n" + note : note;
  };

  const useSurvivalN = async () => {
    setSsVerifyMsg("");
    setSvBusy(true);
    try {
      const resp = await fetch(apiUrl("/api/samplesize/survival"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hr: svHR, event_rate: svEventRate, alloc_ratio: svAllocRatio,
          alpha: ssAlpha, power: ssPower,
        }),
      });
      const j = await resp.json();
      setSvResult(j);
      if (j.ok && j.n_total) {
        setSsChosen(j.n_total);
        setSsChosenMeta({
          alpha: ssAlpha, power: ssPower, effect: svHR, scene: "survival", source: "backend",
          hr: svHR, event_rate: svEventRate, alloc_ratio: svAllocRatio,
          events: j.events, n_total: j.n_total, n_per_group: j.n_per_group,
        });
        setSsVerifyMsg(`已采用后端精确值：总 N=${j.n_total}（事件数 E=${j.events}）。`);
      } else {
        setSsVerifyMsg(`生存分析样本量计算失败：${j.error || "未知错误"}`);
      }
    } catch (e) {
      setSsVerifyMsg(`请求失败：${(e as Error).message}`);
    } finally {
      setSvBusy(false);
    }
  };

  const zTable: Record<string, number> = {
    "0.005": 2.576, "0.010": 2.326, "0.025": 1.96, "0.050": 1.645, "0.100": 1.282, "0.200": 0.842,
  };
  const approxZ = (tail: number): number => {
    const keys = Object.keys(zTable).map((k) => ({ k, v: parseFloat(k) })).sort((a, b) => a.v - b.v);
    if (tail <= keys[0].v) return zTable[keys[0].k];
    if (tail >= keys[keys.length - 1].v) return zTable[keys[keys.length - 1].k];
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i]; const b = keys[i + 1];
      if (tail >= a.v && tail <= b.v) {
        const t = (tail - a.v) / (b.v - a.v);
        return zTable[a.k] + t * (zTable[b.k] - zTable[a.k]);
      }
    }
    return 1.96;
  };
  const calcN = (scene: string, effect: number, alpha: number, power: number): number => {
    if (!isFinite(effect) || effect <= 0) return Infinity;
    if (alpha <= 0 || alpha >= 1 || power <= 0 || power >= 1) return NaN;
    const zA = approxZ(alpha / 2);
    const zB = approxZ(1 - power);
    const c = (zA + zB) * (zA + zB);
    let n: number;
    if (scene === "proportion") {
      const p1 = 0.3;
      let p2 = p1 + effect;
      if (p2 >= 1) p2 = 0.99;
      const pbar = (p1 + p2) / 2;
      const diff = p2 - p1;
      n = (2 * c * pbar * (1 - pbar)) / (diff * diff);
    } else {
      n = (2 * c) / (effect * effect);
    }
    return Math.max(2, Math.ceil(n));
  };
  const ssN = calcN(ssScene, ssEffect, ssAlpha, ssPower);
  const sweepCurve = (): { x: number; y: number }[] => {
    const pts: { x: number; y: number }[] = [];
    let minX = 0, maxX = 1, steps = 40;
    if (ssSweep === "effect") { minX = 0.1; maxX = 1.0; }
    else if (ssSweep === "alpha") { minX = 0.01; maxX = 0.1; }
    else if (ssSweep === "power") { minX = 0.6; maxX = 0.99; }
    for (let i = 0; i <= steps; i++) {
      const x = minX + ((maxX - minX) * i) / steps;
      let n: number;
      if (ssSweep === "effect") n = calcN(ssScene, x, ssAlpha, ssPower);
      else if (ssSweep === "alpha") n = calcN(ssScene, ssEffect, x, ssPower);
      else n = calcN(ssScene, ssEffect, ssAlpha, x);
      if (isFinite(n) && n < 100000) pts.push({ x, y: n });
    }
    return pts;
  };
  const curvePts = sweepCurve();
  const currentX = ssSweep === "effect" ? ssEffect : ssSweep === "alpha" ? ssAlpha : ssPower;
  const chartW = 420, chartH = 220, padL = 46, padR = 12, padT = 14, padB = 30;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;
  const xs = curvePts.map((p) => p.x);
  const ys = curvePts.map((p) => p.y);
  const xMin = xs.length ? Math.min(...xs) : 0;
  const xMax = xs.length ? Math.max(...xs) : 1;
  const yMin = 0;
  const yMax = ys.length ? Math.max(...ys) * 1.1 : 100;
  const sx = (x: number) => padL + ((x - xMin) / (xMax - xMin || 1)) * innerW;
  const sy = (y: number) => padT + innerH - ((y - yMin) / (yMax - yMin || 1)) * innerH;
  const path = curvePts.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");

  const useThisN = async () => {
    setSsVerifyMsg("");
    setSsVerifyBusy(true);
    const snap = { alpha: ssAlpha, power: ssPower, effect: ssEffect, scene: ssScene };
    try {
      const params: Record<string, string> = { alpha: String(ssAlpha), power: String(ssPower) };
      let design = "ttest";
      if (ssScene === "proportion") {
        design = "proportion";
        const p1 = 0.3;
        let p2 = p1 + ssEffect;
        if (p2 >= 1) p2 = 0.99;
        params.p1 = String(p1);
        params.p2 = String(p2);
      } else {
        params.effect_size = String(ssEffect);
      }
      const resp = await fetch(apiUrl("/api/sample-size"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design, params }),
      });
      const j = await resp.json();
      if (j.ok && j.per_group) {
        setSsChosen(j.per_group);
        setSsChosenMeta({ ...snap, source: "backend" });
        const diff = Math.abs(j.per_group - ssN);
        if (diff <= Math.max(2, ssN * 0.1)) setSsVerifyMsg(`已采用后端精确值:每组 ${j.per_group} 例(与前端快速近似 ${ssN} 基本一致)。`);
        else setSsVerifyMsg(`已采用后端精确值:每组 ${j.per_group} 例。前端快速近似为 ${ssN},两者差异较大——以精确值为准。`);
      } else {
        setSsChosen(ssN);
        setSsChosenMeta({ ...snap, source: "frontend" });
        setSsVerifyMsg(`已采用前端快速估算:每组 ${ssN} 例(后端精确验证未成功: ${j.error || "未知错误"};建议联网后重新「使用此参数」以精确值为准)。`);
      }
    } catch (e) {
      setSsChosen(ssN);
      setSsChosenMeta({ ...snap, source: "frontend" });
      setSsVerifyMsg(`已采用前端快速估算:每组 ${ssN} 例(后端验证失败: ${(e as Error).message})。`);
    } finally {
      setSsVerifyBusy(false);
    }
  };

  // 随机化
  const [rzN, setRzN] = useState("60");
  const [rzGroups, setRzGroups] = useState("试验组,对照组");
  const [rzRatio, setRzRatio] = useState("1,1");
  const [rzMethod, setRzMethod] = useState("block");
  const [rzBlock, setRzBlock] = useState("4");
  const [rzSeed, setRzSeed] = useState("2026");
  const [rzResult, setRzResult] = useState<{ ok?: boolean; error?: string; rows?: { seq: number; group: string }[]; counts?: Record<string, number>; method?: string; block_size?: number | null } | null>(null);
  const [rzBusy, setRzBusy] = useState(false);

  const genRandomize = async () => {
    setRzBusy(true);
    setRzResult(null);
    try {
      const resp = await fetch(apiUrl("/api/randomize"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          design: "randomize",
          params: { n: rzN, groups: rzGroups, ratio: rzRatio, method: rzMethod, block_size: rzBlock, seed: rzSeed },
        }),
      });
      setRzResult(await resp.json());
    } catch (e) {
      setRzResult({ ok: false, error: `生成失败: ${(e as Error).message}` });
    } finally {
      setRzBusy(false);
    }
  };
  const exportRandomize = () => {
    if (!rzResult?.rows) return;
    downloadCsv(tsName("随机化分组表", "csv"), ["序号", "分组"], rzResult.rows.map((r) => [r.seq, r.group]));
  };

  return (
    <div className="module plan-wizard">
      <header className="module-head">
        <h1>🗺️ 实验规划 · 医学/药学/生物</h1>
        <p>两步走:填写研究想法与附加材料 → 生成并在预览里追问/修改。方案主体、SAP、DMP、知情同意书四类产出都在第 2 步。</p>
      </header>

      <div className="wiz-steps" data-testid="plan-steps">
        {STEPS.map((s) => {
          const state = step === s.n ? "current" : s.n < step ? "done" : "todo";
          const clickable = s.n <= maxStep;
          return (
            <button key={s.n} type="button" className={`wiz-step ${state}`} data-testid={`plan-step-${s.n}`} disabled={!clickable} onClick={() => clickable && setStep(s.n)}>
              <span className="wiz-step-num">{s.n < step ? "✓" : s.n}</span>
              <span className="wiz-step-text"><span className="wiz-step-title">{s.title}</span><span className="wiz-step-desc">{s.desc}</span></span>
            </button>
          );
        })}
      </div>

      {error && <div className="result-error" data-testid="plan-error">{error}</div>}

      {/* ── Step 1 ── */}
      {step === 1 && (
        <div className="wiz-panel" data-testid="plan-panel-1">
          <div className="form">
            <label className="field">
              <span className="field-label">你的研究想法 / 课题 <em>必填</em></span>
              <textarea
                data-testid="input-idea"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="例如:评估二甲双胍辅助治疗对2型糖尿病合并NAFLD患者肝纤维化的改善作用"
                rows={4}
              />
            </label>

            <div className="field" data-testid="plan-materials-field">
              <span className="field-label">附加材料(可选,越充分越好)</span>
              <p className="field-hint">
                可粘贴或上传:<strong>学科领域、可用资源(经费/设备/样本量/时间/团队)、已有草案/预实验数据、既往文献</strong>等。支持 Word / PDF / txt,<strong>可一次选多个</strong>;会作为方案撰写与 SAP/DMP/知情同意书的补充资料。
              </p>
              <div className={`combo-input${matDrag ? " dragover" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setMatDrag(true); }}
                onDragLeave={() => setMatDrag(false)}
                onDrop={(e) => { e.preventDefault(); setMatDrag(false); ingestMaterials(e.dataTransfer.files); }}>
                <textarea
                  data-testid="input-materials"
                  value={materials}
                  onChange={(e) => setMaterials(e.target.value)}
                  placeholder="把学科领域、资源限制、已有草案/预实验/文献粘贴到这里,或把文件直接拖进本框(可多个)。"
                  rows={5}
                />
                <div className="combo-foot">
                  <button type="button" className="combo-attach" data-testid="plan-materials-attach" onClick={() => matFileRef.current?.click()}>📎 添加附件(可多选)</button>
                  <span className="combo-hint">{matBusy ? "正在解析附件…" : "支持 Word / PDF / txt,可直接拖入本框"}</span>
                  <input ref={matFileRef} data-testid="plan-upload" type="file" accept=".docx,.pdf,.txt,.md,.csv,.xlsx,.xls" multiple style={{ display: "none" }} onChange={(e) => ingestMaterials(e.target.files)} />
                </div>
              </div>
            </div>
          </div>

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={reset} data-testid="reset-btn">清空</button>
            <button className="btn-primary" onClick={submit} disabled={!idea.trim() || running} data-testid="run-btn">
              {running ? "生成中…" : "下一步:生成方案 →"}
            </button>
          </div>
          {!idea.trim() && (
            <p className="field-hint" data-testid="plan-gate-hint" style={{ marginTop: 6 }}>
              开始前请先填写<strong>你的研究想法 / 课题</strong>。
            </p>
          )}
        </div>
      )}

      {/* ── Step 2 ── */}
      {step === 2 && (
        <div className="wiz-panel" data-testid="plan-panel-2">
          <div className="form-actions">
            <button className="btn-primary" onClick={submit} disabled={!idea.trim() || running} data-testid="plan-regen-btn">
              {running ? "生成中…" : text ? "🔄 重新生成方案" : "生成实验计划"}
            </button>
            <button className="btn-secondary" onClick={genSap} disabled={!idea.trim() || sap.running} data-testid="gen-sap-btn">
              {sap.running ? "生成中…" : "生成 SAP"}
            </button>
            <button className="btn-secondary" onClick={genDmp} disabled={!idea.trim() || dmp.running} data-testid="gen-dmp-btn">
              {dmp.running ? "生成中…" : "生成 DMP"}
            </button>
            <button className="btn-secondary" onClick={genConsent} disabled={!idea.trim() || consent.running} data-testid="gen-consent-btn">
              {consent.running ? "生成中…" : "知情同意书"}
            </button>
          </div>

          {docxErr && <div className="result-error" data-testid="docx-error">{docxErr}</div>}

          <CanvasSlot>
            <ResultPanel text={text} running={running} error={error} onStop={stop} exportName="实验计划"
              placeholder="研究路线、实验设计、里程碑和风险点会显示在这里。"
              onExportDocx={() => downloadDocx(text, "实验计划", "plan")} exportingDocx={docxBusy === "plan"} onSave={setText} />

            {(sap.text || sap.running || sap.error) && (
              <>
                <h2 className="section-title" data-testid="sap-title">📐 统计分析计划(SAP · 基于 ICH E9 规范)</h2>
                <ResultPanel text={sap.text} running={sap.running} error={sap.error} onStop={sap.stop} exportName="统计分析计划"
                  placeholder="ITT/PP 分析集、主要终点分析、缺失数据与多重比较校正等会显示在这里。"
                  onExportDocx={() => downloadDocx(sap.text, "统计分析计划", "sap")} exportingDocx={docxBusy === "sap"} panelTestId="sap-panel" onSave={sap.setText} />
              </>
            )}

            {(dmp.text || dmp.running || dmp.error) && (
              <>
                <h2 className="section-title" data-testid="dmp-title">🗄️ 数据管理计划(DMP)<HelpButton helpKey="dmp" /></h2>
                <ResultPanel text={dmp.text} running={dmp.running} error={dmp.error} onStop={dmp.stop} exportName="数据管理计划"
                  placeholder="数据类型/存储备份/安全隐私/共享归档等会显示在这里。"
                  onExportDocx={() => downloadDocx(dmp.text, "数据管理计划", "dmp")} exportingDocx={docxBusy === "dmp"} panelTestId="dmp-panel" onSave={dmp.setText} />
              </>
            )}

            {(consent.text || consent.running || consent.error) && (
              <>
                <h2 className="section-title" data-testid="consent-title">📝 知情同意书(草案 · 需伦理委员会审核)<HelpButton helpKey="consent" /></h2>
                <ResultPanel text={consent.text} running={consent.running} error={consent.error} onStop={consent.stop} exportName="知情同意书"
                  placeholder="研究目的/流程/风险获益/隐私/自愿退出/签字栏等会显示在这里。"
                  onExportDocx={() => downloadDocx(consent.text, "知情同意书", "consent")} exportingDocx={docxBusy === "consent"} panelTestId="consent-panel" onSave={consent.setText} />
              </>
            )}
          </CanvasSlot>

          {/* 追问 / 修改 */}
          {text && !running && (
            <div className="followup" data-testid="plan-followup">
              <div className="followup-head">追问 / 修改主方案</div>
              <p className="followup-tip">可就主方案某段追问,或按意见让 AI 重写完整方案。追问基于当前主稿与附加材料,不会引入未提供的数据。</p>
              {followups.length > 0 && (
                <div className="qa-list" data-testid="plan-qa-list">
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
                data-testid="plan-followup-input"
                value={followupInput}
                onChange={(e) => setFollowupInput(e.target.value)}
                placeholder="例如:入排标准能否再严格些?/ 把样本量加到 200 例/组 / 主要终点改成 6 个月 HbA1c"
                rows={2}
                disabled={fRunning}
              />
              {fError && <div className="result-error">{fError}</div>}
              <div className="form-actions">
                <button className="btn-primary" data-testid="plan-ask-btn" onClick={() => runFollowup("ask")} disabled={!followupInput.trim() || fRunning}>追问</button>
                <button className="btn-ghost" data-testid="plan-revise-btn" onClick={() => runFollowup("revise")} disabled={!followupInput.trim() || fRunning}>按此修改主方案</button>
                {fRunning && <button className="btn-ghost" onClick={() => {
                  fctrl.current?.abort();
                  if (followupModeRef.current === "revise") setText(followupBaseDraftRef.current);
                  setFRunning(false);
                }} data-testid="plan-followup-stop">停止</button>}
                {fRunning && <span className="status-line"><span className="spinner" /> 处理中…</span>}
              </div>
            </div>
          )}

          {/* 样本量计算器 */}
          <details className="ss-calc" data-testid="ss-calc" open>
            <summary>🧮 样本量交互式探索(滑块 + 实时曲线,免费不消耗额度)</summary>
            <div className="form" style={{ marginTop: 12 }}>
              <label className="field">
                <span className="field-label">研究场景</span>
                <select data-testid="ss-scene" value={ssScene} onChange={(e) => setSsScene(e.target.value)}>
                  <option value="proportion">双比例(两组率比较)</option>
                  <option value="ttest">双均值(两组均值比较,Cohen's d)</option>
                  <option value="survival">生存分析(log-rank / Cox, Schoenfeld)</option>
                </select>
              </label>

              {ssScene === "survival" && (
                <div className="ss-explore">
                  <div className="ss-controls">
                    <label className="field">
                      <span className="field-label">风险比 HR <strong>{svHR.toFixed(2)}</strong>
                        <span className="field-hint">(试验组 vs 对照组; ≠1; 例 0.7 = 事件风险降低 30%)</span>
                      </span>
                      <input type="range" min={0.3} max={2.0} step={0.05} data-testid="sv-hr" value={svHR} onChange={(e) => setSvHR(parseFloat(e.target.value))} />
                    </label>
                    <label className="field">
                      <span className="field-label">随访期事件发生率 <strong>{(svEventRate * 100).toFixed(0)}%</strong>
                        <span className="field-hint">(全人群随访结束时的累积事件发生比例)</span>
                      </span>
                      <input type="range" min={0.05} max={0.95} step={0.01} data-testid="sv-event-rate" value={svEventRate} onChange={(e) => setSvEventRate(parseFloat(e.target.value))} />
                    </label>
                    <label className="field">
                      <span className="field-label">分配比 (试验:对照) <strong>{svAllocRatio.toFixed(2)}</strong>
                        <span className="field-hint">(1 = 1:1 均衡; 2 = 试验组人数为对照组的 2 倍)</span>
                      </span>
                      <input type="range" min={0.5} max={4.0} step={0.1} data-testid="sv-alloc" value={svAllocRatio} onChange={(e) => setSvAllocRatio(parseFloat(e.target.value))} />
                    </label>
                    <label className="field">
                      <span className="field-label">显著性水平 α <strong>{ssAlpha.toFixed(3)}</strong>
                        <span className="field-hint">(双侧,常用 0.05)</span>
                      </span>
                      <input type="range" min={0.01} max={0.1} step={0.005} data-testid="sv-alpha" value={ssAlpha} onChange={(e) => setSsAlpha(parseFloat(e.target.value))} />
                    </label>
                    <label className="field">
                      <span className="field-label">检验效能 power <strong>{ssPower.toFixed(2)}</strong>
                        <span className="field-hint">(常用 0.8 / 0.9)</span>
                      </span>
                      <input type="range" min={0.6} max={0.99} step={0.01} data-testid="sv-power" value={ssPower} onChange={(e) => setSsPower(parseFloat(e.target.value))} />
                    </label>
                  </div>
                </div>
              )}

              {ssScene !== "survival" && (
              <div className="ss-explore">
                <div className="ss-controls">
                  <label className="field">
                    <span className="field-label">效应量 <strong>{ssEffect.toFixed(2)}</strong>
                      <span className="field-hint">{ssScene === "proportion" ? "(两组率差,参考 p₁=0.3)" : "(Cohen's d:小0.2 / 中0.5 / 大0.8)"}</span>
                    </span>
                    <input type="range" min={0.05} max={1.0} step={0.01} data-testid="ss-effect" value={ssEffect} onChange={(e) => setSsEffect(parseFloat(e.target.value))} />
                  </label>
                  <label className="field">
                    <span className="field-label">显著性水平 α <strong>{ssAlpha.toFixed(3)}</strong>
                      <span className="field-hint">(双侧,常用 0.05)</span>
                    </span>
                    <input type="range" min={0.01} max={0.1} step={0.005} data-testid="ss-alpha" value={ssAlpha} onChange={(e) => setSsAlpha(parseFloat(e.target.value))} />
                  </label>
                  <label className="field">
                    <span className="field-label">检验效能 power <strong>{ssPower.toFixed(2)}</strong>
                      <span className="field-hint">(常用 0.8 / 0.9)</span>
                    </span>
                    <input type="range" min={0.6} max={0.99} step={0.01} data-testid="ss-power" value={ssPower} onChange={(e) => setSsPower(parseFloat(e.target.value))} />
                  </label>
                  <div className="ss-sweep-row">
                    <span className="field-label" style={{ marginBottom: 0 }}>扫描变量:</span>
                    {[{ k: "effect", label: "效应量" }, { k: "alpha", label: "α" }, { k: "power", label: "power" }].map((opt) => (
                      <button key={opt.k} type="button" className={ssSweep === opt.k ? "btn-primary btn-sm" : "btn-ghost btn-sm"} onClick={() => setSsSweep(opt.k)} data-testid={`ss-sweep-${opt.k}`}>{opt.label}</button>
                    ))}
                  </div>
                </div>

                <div className="ss-chart">
                  <svg viewBox={`0 0 ${chartW} ${chartH}`} width="100%" role="img" aria-label="样本量曲线" data-testid="ss-chart">
                    <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="#bcd0cb" strokeWidth={1} />
                    <line x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} stroke="#bcd0cb" strokeWidth={1} />
                    {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
                      const v = yMin + (yMax - yMin) * (1 - t);
                      const y = padT + innerH * t;
                      return (<g key={`y${i}`}><line x1={padL - 4} y1={y} x2={padL} y2={y} stroke="#bcd0cb" /><text x={padL - 6} y={y + 3} fontSize={10} textAnchor="end" fill="#5f6f6c">{Math.round(v)}</text></g>);
                    })}
                    {[0, 0.5, 1].map((t, i) => {
                      const x = padL + innerW * t;
                      const v = xMin + (xMax - xMin) * t;
                      return (<g key={`x${i}`}><line x1={x} y1={padT + innerH} x2={x} y2={padT + innerH + 4} stroke="#bcd0cb" /><text x={x} y={padT + innerH + 16} fontSize={10} textAnchor="middle" fill="#5f6f6c">{v.toFixed(2)}</text></g>);
                    })}
                    {path && <path d={path} fill="none" stroke="#2f8074" strokeWidth={2} />}
                    {isFinite(ssN) && currentX >= xMin && currentX <= xMax && (
                      <g>
                        <line x1={sx(currentX)} y1={padT} x2={sx(currentX)} y2={padT + innerH} stroke="#2f8074" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />
                        <circle cx={sx(currentX)} cy={sy(Math.min(ssN, yMax))} r={5} fill="#fff" stroke="#2f8074" strokeWidth={2} />
                      </g>
                    )}
                    <text x={padL + innerW / 2} y={chartH - 4} fontSize={11} textAnchor="middle" fill="#5f6f6c">{ssSweep === "effect" ? "效应量" : ssSweep === "alpha" ? "α" : "power"}</text>
                    <text x={12} y={padT + innerH / 2} fontSize={11} textAnchor="middle" fill="#5f6f6c" transform={`rotate(-90 12 ${padT + innerH / 2})`}>每组 N</text>
                  </svg>
                </div>
              </div>
              )}

              {ssScene !== "survival" && (
                <div className="ss-result" data-testid="ss-result">
                  <strong style={{ fontSize: 20 }}>约需 N ≈ {isFinite(ssN) ? ssN * 2 : "—"} 例(每组 {isFinite(ssN) ? ssN : "—"})</strong>
                  <span className="field-hint">
                    这是<strong>快速近似</strong>(前端估算);点「使用此参数」会用本地精确计算得到并采用的 N。
                    公式:{ssScene === "proportion" ? "Lehr 近似 n ≈ 2(z_{α/2}+z_β)² p̄(1-p̄) / (p₁-p₂)²(默认 p₁=0.3)" : "n ≈ 2(z_{α/2}+z_β)² / d²"}
                  </span>
                </div>
              )}

              {ssScene === "survival" && (
                <div className="ss-result" data-testid="ss-sv-result">
                  {svResult?.ok ? (
                    <>
                      <strong style={{ fontSize: 20 }} data-testid="sv-n-total">
                        总 N ≈ {svResult.n_total} 例（对照 {svResult.n_per_group?.[0]} / 试验 {svResult.n_per_group?.[1]}）
                      </strong>
                      <span className="field-hint" data-testid="sv-events">对应总事件数 E ≈ {svResult.events} 次</span>
                      <span className="field-hint">
                        公式:E = (z<sub>α/2</sub>+z<sub>β</sub>)²·(1+k)² / (k·(ln HR)²)，N = E / 事件率
                      </span>
                    </>
                  ) : (
                    <span className="field-hint">
                      点「使用此参数」调用后端 Schoenfeld 精确计算总事件数与总样本；公式：
                      E = (z<sub>α/2</sub>+z<sub>β</sub>)²·(1+k)² / (k·(ln HR)²)，N = E / 事件率。
                    </span>
                  )}
                </div>
              )}

              <div className="form-actions" style={{ marginTop: 8 }}>
                {ssScene === "survival" ? (
                  <button className="btn-primary" onClick={useSurvivalN} disabled={svBusy} data-testid="sv-use-btn">
                    {svBusy ? "计算中…" : "使用此参数"}
                  </button>
                ) : (
                  <button className="btn-primary" onClick={useThisN} disabled={ssVerifyBusy || !isFinite(ssN)} data-testid="ss-use-btn">
                    {ssVerifyBusy ? "验证中…" : "使用此参数"}
                  </button>
                )}
                {ssChosen > 0 && (
                  <span className="field-hint" data-testid="ss-chosen">
                    ✓ 已采用 {ssChosenMeta?.scene === "survival"
                      ? `总 N = ${ssChosen}${ssChosenMeta?.events ? `（E = ${ssChosenMeta.events} 事件）` : ""}`
                      : `N = ${ssChosen}(每组)`}
                    ——生成「实验计划」/「SAP」时会带入此样本量
                  </span>
                )}
              </div>
              {ssVerifyMsg && <div className="field-hint" data-testid="ss-verify-msg" style={{ marginTop: 6 }}>{ssVerifyMsg}</div>}
            </div>
          </details>

          {/* 随机化分组 */}
          <details className="ss-calc" data-testid="rz-calc">
            <summary>🎲 随机化分组表(确定性,固定种子可复现,免费)<HelpButton helpKey="randomize" /></summary>
            <div className="form" style={{ marginTop: 12 }}>
              <div className="ss-row">
                <label className="field"><span className="field-label">样本量 n</span><input data-testid="rz-n" value={rzN} onChange={(e) => setRzN(e.target.value)} /></label>
                <label className="field"><span className="field-label">随机方法</span>
                  <select data-testid="rz-method" value={rzMethod} onChange={(e) => setRzMethod(e.target.value)}>
                    <option value="block">置换区组随机(推荐,均衡)</option>
                    <option value="simple">简单随机</option>
                  </select>
                </label>
              </div>
              <div className="ss-row">
                <label className="field"><span className="field-label">分组(逗号分隔)</span><input data-testid="rz-groups" value={rzGroups} onChange={(e) => setRzGroups(e.target.value)} /></label>
                <label className="field"><span className="field-label">分配比例(如 1,1 / 2,1)</span><input data-testid="rz-ratio" value={rzRatio} onChange={(e) => setRzRatio(e.target.value)} /></label>
              </div>
              <div className="ss-row">
                {rzMethod === "block" && (<label className="field"><span className="field-label">区组大小(比例和的整数倍)</span><input data-testid="rz-block" value={rzBlock} onChange={(e) => setRzBlock(e.target.value)} /></label>)}
                <label className="field"><span className="field-label">随机种子(同种子→同序列)</span><input data-testid="rz-seed" value={rzSeed} onChange={(e) => setRzSeed(e.target.value)} /></label>
              </div>
              <button className="btn-primary" onClick={genRandomize} disabled={rzBusy} data-testid="rz-btn">{rzBusy ? "生成中…" : "生成随机化分组表"}</button>

              {rzResult && (rzResult.ok && rzResult.rows?.length ? (
                <div className="ss-result" data-testid="rz-result">
                  <strong>共 {rzResult.rows.length} 例:{Object.entries(rzResult.counts || {}).map(([g, c]) => `${g} ${c}`).join(",")}</strong>
                  <span className="field-hint">方法:{rzResult.method === "block" ? `置换区组(区组大小 ${rzResult.block_size})` : "简单随机"},种子 {rzSeed}(可复现)</span>
                  <div className="md-table-wrap" style={{ maxHeight: 220, overflow: "auto" }}>
                    <table className="evidence-table">
                      <thead><tr><th>序号</th><th>分组</th></tr></thead>
                      <tbody>{rzResult.rows.slice(0, 20).map((r) => (<tr key={r.seq}><td>{r.seq}</td><td>{r.group}</td></tr>))}</tbody>
                    </table>
                  </div>
                  {rzResult.rows.length > 20 && <span className="field-hint">(仅预览前 20 行,导出 CSV 查看全部)</span>}
                  <button className="btn-ghost btn-sm" onClick={exportRandomize} data-testid="rz-export-btn">导出 CSV</button>
                </div>
              ) : (
                <div className="result-error" data-testid="rz-error">
                  {rzResult?.error || (rzResult?.ok ? "生成失败:返回结果缺少分组数据,请重试。" : "生成失败,请重试。")}
                </div>
              ))}
            </div>
          </details>

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => setStep(1)} data-testid="plan-back-btn">← 返回准备</button>
            <button className="btn-ghost" onClick={reset} disabled={running} data-testid="plan-reset-btn">重新开始</button>
          </div>
        </div>
      )}
    </div>
  );
}
