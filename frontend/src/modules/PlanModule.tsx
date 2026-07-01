import { useEffect, useRef, useState } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import ResultPanel from "../components/ResultPanel";
import { CanvasSlot } from "../components/Canvas";
import Dropzone from "../components/Dropzone";
import { HelpButton } from "../components/HelpButton";
import { downloadCsv, downloadDocxFromText, tsName } from "../lib/download";

export default function PlanModule() {
  const [idea, setIdea] = usePersistentState("plan:idea", "");
  const [field, setField] = usePersistentState("plan:field", "");
  const [resources, setResources] = usePersistentState("plan:resources", "");
  const { text, running, error, start, stop, setText } = useStream("plan:result");
  const sap = useStream("plan:sap"); // 统计分析计划(SAP) 独立流
  const dmp = useStream("plan:dmp"); // 数据管理计划
  const consent = useStream("plan:consent"); // 知情同意书
  const [docxBusy, setDocxBusy] = useState(""); // "" | "plan" | "sap" | "dmp" | "consent"

  const [docxErr, setDocxErr] = useState("");
  const downloadDocx = async (txt: string, name: string, which: string) => {
    if (!txt || docxBusy) return;
    setDocxBusy(which);
    setDocxErr("");
    try {
      await downloadDocxFromText(`${name}.docx`, txt);
    } catch (e) {
      setDocxErr(`导出 Word 失败：${(e as Error).message}`);
    } finally {
      setDocxBusy("");
    }
  };

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "plan",
        icon: "🗺️",
        title: idea.slice(0, 40) || "实验规划",
        data: { "plan:idea": idea, "plan:field": field, "plan:resources": resources, "plan:result": text },
      });
    }
  }, [running, error, text, idea, field, resources]);

  const submit = () => {
    if (!idea.trim() || running) return;
    start("plan", { idea, field, resources: withSampleSize(resources) });
  };

  const genSap = () => {
    if (!idea.trim() || sap.running) return;
    sap.start("sap", { idea, field, resources: withSampleSize(resources) });
  };
  const genDmp = () => {
    if (!idea.trim() || dmp.running) return;
    dmp.start("dmp", { idea, field, resources });
  };
  const genConsent = () => {
    if (!idea.trim() || consent.running) return;
    consent.start("consent", { idea, field, resources });
  };

  const reset = () => {
    if (running) stop();
    if (sap.running) sap.stop();
    if (dmp.running) dmp.stop();
    if (consent.running) consent.stop();
    setIdea("");
    setField("");
    setResources("");
    setText("");
    sap.setText("");
    dmp.setText("");
    consent.setText("");
  };

  // —— 样本量交互式探索：场景 + 滑块 + 实时曲线（纯前端计算）——
  // 场景：proportion = 双比例（两组率），ttest = 双均值（Cohen's d）
  const [ssScene, setSsScene] = usePersistentState<string>("plan:samplesize:scene", "proportion");
  const [ssEffect, setSsEffect] = usePersistentState<number>("plan:samplesize:effect", 0.3);
  const [ssAlpha, setSsAlpha] = usePersistentState<number>("plan:samplesize:alpha", 0.05);
  const [ssPower, setSsPower] = usePersistentState<number>("plan:samplesize:power", 0.8);
  const [ssSweep, setSsSweep] = usePersistentState<string>("plan:samplesize:sweep", "effect");
  const [ssChosen, setSsChosen] = usePersistentState<number>("plan:sampleSize", 0);
  const [ssVerifyMsg, setSsVerifyMsg] = useState<string>("");
  const [ssVerifyBusy, setSsVerifyBusy] = useState(false);

  // 把用户在样本量计算器里确定的 N 作为事实并入生成载荷——避免"算了却没进方案"。
  // 只在已通过"使用此参数"确定 N 时追加(ssChosen>0)。生成实验计划 / SAP 会读到它。
  const withSampleSize = (base: string): string => {
    if (!(ssChosen > 0)) return base;
    const sceneLabel = ssScene === "proportion" ? "两组率比较(双比例)" : "两组均值比较(双均值, Cohen's d)";
    const note =
      `【已确定样本量】用户已用样本量计算器确定：每组约 ${ssChosen} 例（合计约 ${ssChosen * 2} 例）；` +
      `设计场景=${sceneLabel}，α=${ssAlpha}，检验效能(power)=${ssPower}，效应量=${ssEffect}。` +
      `请在方案/统计部分直接采用该样本量并据此论证可行性；若为临床试验，请提醒按预期失访率（如 10–20%）适当上浮。`;
    return base ? base + "\n\n" + note : note;
  };

  // 标准正态分位数表（常用 α/β 对应）
  const zTable: Record<string, number> = {
    "0.005": 2.576,
    "0.010": 2.326,
    "0.025": 1.96,
    "0.050": 1.645,
    "0.100": 1.282,
    "0.200": 0.842,
  };

  // 简单近似 z 分位：用最接近的查表值（够用）；对 1-power 取右尾分位
  const approxZ = (tail: number): number => {
    // tail 是右尾概率 (0,1)，返回 z 使 P(Z>z)=tail
    const keys = Object.keys(zTable)
      .map((k) => ({ k, v: parseFloat(k) }))
      .sort((a, b) => a.v - b.v);
    // 线性插值
    if (tail <= keys[0].v) return zTable[keys[0].k];
    if (tail >= keys[keys.length - 1].v) return zTable[keys[keys.length - 1].k];
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (tail >= a.v && tail <= b.v) {
        const t = (tail - a.v) / (b.v - a.v);
        return zTable[a.k] + t * (zTable[b.k] - zTable[a.k]);
      }
    }
    return 1.96;
  };

  // 公式：返回每组 N（向上取整，下限 2）
  const calcN = (scene: string, effect: number, alpha: number, power: number): number => {
    if (!isFinite(effect) || effect <= 0) return Infinity;
    if (alpha <= 0 || alpha >= 1 || power <= 0 || power >= 1) return NaN;
    const zA = approxZ(alpha / 2); // 双侧
    const zB = approxZ(1 - power);
    const c = (zA + zB) * (zA + zB);
    let n: number;
    if (scene === "proportion") {
      // 双比例 Lehr 近似：假设 p1=0.3, p2=p1+effect（如超界则取对称）
      const p1 = 0.3;
      let p2 = p1 + effect;
      if (p2 >= 1) p2 = 0.99;
      const pbar = (p1 + p2) / 2;
      const diff = p2 - p1;
      n = (2 * c * pbar * (1 - pbar)) / (diff * diff);
    } else {
      // 双均值：n = 2 c / d^2
      n = (2 * c) / (effect * effect);
    }
    return Math.max(2, Math.ceil(n));
  };

  const ssN = calcN(ssScene, ssEffect, ssAlpha, ssPower);

  // 扫描曲线：固定其他两个参数，沿 sweep 变量扫描
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

  // SVG 视口
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
    setSsChosen(ssN);
    setSsVerifyMsg("");
    setSsVerifyBusy(true);
    try {
      // 调后端精确验证（沿用现有 /api/sample-size）
      const params: Record<string, string> = {
        alpha: String(ssAlpha),
        power: String(ssPower),
      };
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
        const diff = Math.abs(j.per_group - ssN);
        if (diff <= Math.max(2, ssN * 0.1)) {
          setSsVerifyMsg(`已采用 N=${ssN}（后端精确验证：每组 ${j.per_group}，偏差 ≤ 10%，可信）`);
        } else {
          setSsVerifyMsg(`已采用 N=${ssN}（前端估算）。后端精确值为每组 ${j.per_group}，差异较大，建议参考精确值。`);
        }
      } else {
        setSsVerifyMsg(`已采用 N=${ssN}（前端估算，后端验证未成功：${j.error || "未知错误"}）`);
      }
    } catch (e) {
      setSsVerifyMsg(`已采用 N=${ssN}（前端估算，后端验证失败：${(e as Error).message}）`);
    } finally {
      setSsVerifyBusy(false);
    }
  };


  // —— 随机化分组表（确定性，零额度）——
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
      setRzResult({ ok: false, error: `生成失败：${(e as Error).message}` });
    } finally {
      setRzBusy(false);
    }
  };

  const exportRandomize = () => {
    if (!rzResult?.rows) return;
    downloadCsv(tsName("随机化分组表", "csv"), ["序号", "分组"], rzResult.rows.map((r) => [r.seq, r.group]));
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>🗺️ 实验规划 · 医学/药学/生物</h1>
        <p>把研究想法变成符合生物医学规范的方案：研究设计、入排标准、样本量与检验效能、统计计划、伦理合规、时间表。</p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">你的研究想法 / 课题 <em>必填</em></span>
          <textarea
            data-testid="input-idea"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="例如：评估二甲双胍辅助治疗对2型糖尿病合并NAFLD患者肝纤维化的改善作用"
            rows={4}
          />
        </label>
        <label className="field">
          <span className="field-label">学科领域（可选）</span>
          <input
            data-testid="input-field"
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder="例如：材料化学、临床医学、社会学"
          />
        </label>
        <label className="field">
          <span className="field-label">可用资源 / 条件（可选）</span>
          <textarea
            data-testid="input-resources"
            value={resources}
            onChange={(e) => setResources(e.target.value)}
            placeholder="例如：经费、设备、样本量、时间、团队规模等限制"
            rows={3}
          />
        </label>
        <Dropzone
          testId="upload-doc"
          accept=".docx,.pdf,.txt,.md,.csv,.xlsx,.xls"
          label="附加文档（可选：已有草案/方案/预实验数据）"
          hint="支持 Word/PDF/Excel/CSV/txt；内容会作为补充资料"
          mode="text"
          onText={(t, name) =>
            setResources((prev) => (prev ? prev + "\n\n" : "") + `[附加文档：${name}]\n` + t)
          }
        />
        <div className="form-actions">
          <button className="btn-primary" onClick={submit} disabled={!idea.trim() || running} data-testid="run-btn">
            {running ? "生成中…" : "生成实验计划"}
          </button>
          <button className="btn-secondary" onClick={genSap} disabled={!idea.trim() || sap.running} data-testid="gen-sap-btn">
            {sap.running ? "生成中…" : "生成统计分析计划(SAP)"}
          </button>
          <button className="btn-secondary" onClick={genDmp} disabled={!idea.trim() || dmp.running} data-testid="gen-dmp-btn">
            {dmp.running ? "生成中…" : "数据管理计划(DMP)"}
          </button>
          <button className="btn-secondary" onClick={genConsent} disabled={!idea.trim() || consent.running} data-testid="gen-consent-btn">
            {consent.running ? "生成中…" : "知情同意书草案"}
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">
            清空
          </button>
        </div>
        {!idea.trim() && (
          <p className="field-hint" data-testid="plan-gate-hint" style={{ marginTop: 6 }}>
            开始前请先填写<strong>你的研究想法 / 课题</strong>，才能生成实验计划、SAP、DMP 或知情同意书。
          </p>
        )}
      </div>

      {docxErr && <div className="result-error" data-testid="docx-error">{docxErr}</div>}

      <CanvasSlot>
      <ResultPanel
        text={text}
        running={running}
        error={error}
        onStop={stop}
        exportName="实验计划"
        placeholder="研究路线、实验设计、里程碑和风险点会显示在这里。"
        onExportDocx={() => downloadDocx(text, "实验计划", "plan")}
        exportingDocx={docxBusy === "plan"}
        onSave={setText}
      />

      {(sap.text || sap.running || sap.error) && (
        <>
          <h2 className="section-title" data-testid="sap-title">📐 统计分析计划（SAP · 基于 ICH E9 规范）</h2>
          <ResultPanel
            text={sap.text}
            running={sap.running}
            error={sap.error}
            onStop={sap.stop}
            exportName="统计分析计划"
            placeholder="ITT/PP 分析集、主要终点分析、缺失数据与多重比较校正、敏感性分析等会显示在这里。"
            onExportDocx={() => downloadDocx(sap.text, "统计分析计划", "sap")}
            exportingDocx={docxBusy === "sap"}
            panelTestId="sap-panel"
            onSave={sap.setText}
          />
        </>
      )}

      {(dmp.text || dmp.running || dmp.error) && (
        <>
          <h2 className="section-title" data-testid="dmp-title">🗄️ 数据管理计划（DMP）<HelpButton helpKey="dmp" /></h2>
          <ResultPanel
            text={dmp.text}
            running={dmp.running}
            error={dmp.error}
            onStop={dmp.stop}
            exportName="数据管理计划"
            placeholder="数据类型/存储备份/安全隐私/共享归档等会显示在这里。"
            onExportDocx={() => downloadDocx(dmp.text, "数据管理计划", "dmp")}
            exportingDocx={docxBusy === "dmp"}
            panelTestId="dmp-panel"
            onSave={dmp.setText}
          />
        </>
      )}

      {(consent.text || consent.running || consent.error) && (
        <>
          <h2 className="section-title" data-testid="consent-title">📝 知情同意书（草案 · 需伦理委员会审核）<HelpButton helpKey="consent" /></h2>
          <ResultPanel
            text={consent.text}
            running={consent.running}
            error={consent.error}
            onStop={consent.stop}
            exportName="知情同意书"
            placeholder="研究目的/流程/风险获益/隐私/自愿退出/签字栏等会显示在这里。"
            onExportDocx={() => downloadDocx(consent.text, "知情同意书", "consent")}
            exportingDocx={docxBusy === "consent"}
            panelTestId="consent-panel"
            onSave={consent.setText}
          />
        </>
      )}
      </CanvasSlot>

      <details className="ss-calc" data-testid="ss-calc" open>
        <summary>🧮 样本量交互式探索（滑块 + 实时曲线，免费不消耗额度）</summary>
        <div className="form" style={{ marginTop: 12 }}>
          <label className="field">
            <span className="field-label">研究场景</span>
            <select data-testid="ss-scene" value={ssScene} onChange={(e) => setSsScene(e.target.value)}>
              <option value="proportion">双比例（两组率比较）</option>
              <option value="ttest">双均值（两组均值比较，Cohen's d）</option>
            </select>
          </label>

          <div className="ss-explore">
            <div className="ss-controls">
              <label className="field">
                <span className="field-label">
                  效应量 <strong>{ssEffect.toFixed(2)}</strong>
                  <span className="field-hint">
                    {ssScene === "proportion" ? "（两组率差，参考 p₁=0.3）" : "（Cohen's d：小0.2 / 中0.5 / 大0.8）"}
                  </span>
                </span>
                <input
                  type="range" min={0.05} max={1.0} step={0.01}
                  data-testid="ss-effect"
                  value={ssEffect}
                  onChange={(e) => setSsEffect(parseFloat(e.target.value))}
                />
              </label>
              <label className="field">
                <span className="field-label">
                  显著性水平 α <strong>{ssAlpha.toFixed(3)}</strong>
                  <span className="field-hint">（双侧，常用 0.05）</span>
                </span>
                <input
                  type="range" min={0.01} max={0.1} step={0.005}
                  data-testid="ss-alpha"
                  value={ssAlpha}
                  onChange={(e) => setSsAlpha(parseFloat(e.target.value))}
                />
              </label>
              <label className="field">
                <span className="field-label">
                  检验效能 power <strong>{ssPower.toFixed(2)}</strong>
                  <span className="field-hint">（常用 0.8 / 0.9）</span>
                </span>
                <input
                  type="range" min={0.6} max={0.99} step={0.01}
                  data-testid="ss-power"
                  value={ssPower}
                  onChange={(e) => setSsPower(parseFloat(e.target.value))}
                />
              </label>

              <div className="ss-sweep-row">
                <span className="field-label" style={{ marginBottom: 0 }}>扫描变量：</span>
                {[
                  { k: "effect", label: "效应量" },
                  { k: "alpha", label: "α" },
                  { k: "power", label: "power" },
                ].map((opt) => (
                  <button
                    key={opt.k}
                    type="button"
                    className={ssSweep === opt.k ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                    onClick={() => setSsSweep(opt.k)}
                    data-testid={`ss-sweep-${opt.k}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="ss-chart">
              <svg viewBox={`0 0 ${chartW} ${chartH}`} width="100%" role="img" aria-label="样本量曲线" data-testid="ss-chart">
                {/* 坐标轴 */}
                <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="#bcd0cb" strokeWidth={1} />
                <line x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} stroke="#bcd0cb" strokeWidth={1} />
                {/* Y 轴刻度 */}
                {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
                  const v = yMin + (yMax - yMin) * (1 - t);
                  const y = padT + innerH * t;
                  return (
                    <g key={`y${i}`}>
                      <line x1={padL - 4} y1={y} x2={padL} y2={y} stroke="#bcd0cb" />
                      <text x={padL - 6} y={y + 3} fontSize={10} textAnchor="end" fill="#5f6f6c">{Math.round(v)}</text>
                    </g>
                  );
                })}
                {/* X 轴刻度 */}
                {[0, 0.5, 1].map((t, i) => {
                  const x = padL + innerW * t;
                  const v = xMin + (xMax - xMin) * t;
                  return (
                    <g key={`x${i}`}>
                      <line x1={x} y1={padT + innerH} x2={x} y2={padT + innerH + 4} stroke="#bcd0cb" />
                      <text x={x} y={padT + innerH + 16} fontSize={10} textAnchor="middle" fill="#5f6f6c">{v.toFixed(2)}</text>
                    </g>
                  );
                })}
                {/* 曲线 */}
                {path && <path d={path} fill="none" stroke="#2f8074" strokeWidth={2} />}
                {/* 当前点 */}
                {isFinite(ssN) && currentX >= xMin && currentX <= xMax && (
                  <g>
                    <line x1={sx(currentX)} y1={padT} x2={sx(currentX)} y2={padT + innerH} stroke="#2f8074" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />
                    <circle cx={sx(currentX)} cy={sy(Math.min(ssN, yMax))} r={5} fill="#fff" stroke="#2f8074" strokeWidth={2} />
                  </g>
                )}
                {/* 轴标签 */}
                <text x={padL + innerW / 2} y={chartH - 4} fontSize={11} textAnchor="middle" fill="#5f6f6c">
                  {ssSweep === "effect" ? "效应量" : ssSweep === "alpha" ? "α" : "power"}
                </text>
                <text x={12} y={padT + innerH / 2} fontSize={11} textAnchor="middle" fill="#5f6f6c" transform={`rotate(-90 12 ${padT + innerH / 2})`}>每组 N</text>
              </svg>
            </div>
          </div>

          <div className="ss-result" data-testid="ss-result">
            <strong style={{ fontSize: 20 }}>
              当前需要 N = {isFinite(ssN) ? ssN * 2 : "—"} 例（每组 {isFinite(ssN) ? ssN : "—"}）
            </strong>
            <span className="field-hint">
              公式：{ssScene === "proportion"
                ? "Lehr 近似 n ≈ 2(z_{α/2}+z_β)² p̄(1-p̄) / (p₁-p₂)²（默认 p₁=0.3）"
                : "n ≈ 2(z_{α/2}+z_β)² / d²"}
            </span>
          </div>

          <div className="form-actions" style={{ marginTop: 8 }}>
            <button className="btn-primary" onClick={useThisN} disabled={ssVerifyBusy || !isFinite(ssN)} data-testid="ss-use-btn">
              {ssVerifyBusy ? "验证中…" : "使用此参数"}
            </button>
            {ssChosen > 0 && (
              <span className="field-hint" data-testid="ss-chosen">
                ✓ 已采用 N = {ssChosen}（每组）——生成「实验计划」/「SAP」时会带入此样本量
              </span>
            )}
          </div>
          {ssVerifyMsg && (
            <div className="field-hint" data-testid="ss-verify-msg" style={{ marginTop: 6 }}>{ssVerifyMsg}</div>
          )}
        </div>
      </details>

      <details className="ss-calc" data-testid="rz-calc">
        <summary>🎲 随机化分组表（确定性，固定种子可复现，免费）<HelpButton helpKey="randomize" /></summary>
        <div className="form" style={{ marginTop: 12 }}>
          <div className="ss-row">
            <label className="field">
              <span className="field-label">样本量 n</span>
              <input data-testid="rz-n" value={rzN} onChange={(e) => setRzN(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">随机方法</span>
              <select data-testid="rz-method" value={rzMethod} onChange={(e) => setRzMethod(e.target.value)}>
                <option value="block">置换区组随机（推荐，均衡）</option>
                <option value="simple">简单随机</option>
              </select>
            </label>
          </div>
          <div className="ss-row">
            <label className="field">
              <span className="field-label">分组（逗号分隔）</span>
              <input data-testid="rz-groups" value={rzGroups} onChange={(e) => setRzGroups(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">分配比例（如 1,1 / 2,1）</span>
              <input data-testid="rz-ratio" value={rzRatio} onChange={(e) => setRzRatio(e.target.value)} />
            </label>
          </div>
          <div className="ss-row">
            {rzMethod === "block" && (
              <label className="field">
                <span className="field-label">区组大小（比例和的整数倍）</span>
                <input data-testid="rz-block" value={rzBlock} onChange={(e) => setRzBlock(e.target.value)} />
              </label>
            )}
            <label className="field">
              <span className="field-label">随机种子（同种子→同序列）</span>
              <input data-testid="rz-seed" value={rzSeed} onChange={(e) => setRzSeed(e.target.value)} />
            </label>
          </div>
          <button className="btn-primary" onClick={genRandomize} disabled={rzBusy} data-testid="rz-btn">
            {rzBusy ? "生成中…" : "生成随机化分组表"}
          </button>

          {rzResult && (
            rzResult.ok && rzResult.rows ? (
              <div className="ss-result" data-testid="rz-result">
                <strong>
                  共 {rzResult.rows.length} 例：
                  {Object.entries(rzResult.counts || {}).map(([g, c]) => `${g} ${c}`).join("，")}
                </strong>
                <span className="field-hint">
                  方法：{rzResult.method === "block" ? `置换区组（区组大小 ${rzResult.block_size}）` : "简单随机"}，种子 {rzSeed}（可复现）
                </span>
                <div className="md-table-wrap" style={{ maxHeight: 220, overflow: "auto" }}>
                  <table className="evidence-table">
                    <thead><tr><th>序号</th><th>分组</th></tr></thead>
                    <tbody>
                      {rzResult.rows.slice(0, 20).map((r) => (
                        <tr key={r.seq}><td>{r.seq}</td><td>{r.group}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rzResult.rows.length > 20 && <span className="field-hint">（仅预览前 20 行，导出 CSV 查看全部）</span>}
                <button className="btn-ghost btn-sm" onClick={exportRandomize} data-testid="rz-export-btn">导出 CSV</button>
              </div>
            ) : (
              <div className="result-error" data-testid="rz-error">{rzResult.error}</div>
            )
          )}
        </div>
      </details>
    </div>
  );
}
