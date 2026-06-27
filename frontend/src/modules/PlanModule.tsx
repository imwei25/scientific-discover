import { useEffect, useRef, useState } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import ResultPanel from "../components/ResultPanel";
import Dropzone from "../components/Dropzone";
import { downloadCsv, tsName } from "../lib/download";

export default function PlanModule() {
  const [idea, setIdea] = usePersistentState("plan:idea", "");
  const [field, setField] = usePersistentState("plan:field", "");
  const [resources, setResources] = usePersistentState("plan:resources", "");
  const { text, running, error, start, stop, setText } = useStream("plan:result");
  const sap = useStream("plan:sap"); // 统计分析计划(SAP) 独立流
  const [docxBusy, setDocxBusy] = useState(""); // "" | "plan" | "sap"

  const downloadDocx = async (txt: string, name: string, which: string) => {
    if (!txt || docxBusy) return;
    setDocxBusy(which);
    try {
      const resp = await fetch(apiUrl("/api/docx"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: txt, journal_id: "", references: [] }),
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.docx`;
      a.click();
      URL.revokeObjectURL(url);
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
    start("plan", { idea, field, resources });
  };

  const genSap = () => {
    if (!idea.trim() || sap.running) return;
    sap.start("sap", { idea, field, resources });
  };

  const reset = () => {
    if (running) stop();
    if (sap.running) sap.stop();
    setIdea("");
    setField("");
    setResources("");
    setText("");
    sap.setText("");
  };

  // —— 样本量 / 检验效能计算器（确定性，零额度）——
  const [ssDesign, setSsDesign] = useState("ttest");
  const [ssAlpha, setSsAlpha] = useState("0.05");
  const [ssPower, setSsPower] = useState("0.8");
  const [ssD, setSsD] = useState("0.5"); // Cohen's d
  const [ssP1, setSsP1] = useState("0.3");
  const [ssP2, setSsP2] = useState("0.5");
  const [ssF, setSsF] = useState("0.25"); // Cohen's f
  const [ssK, setSsK] = useState("3");
  const [ssResult, setSsResult] = useState<{ per_group?: number; total?: number; note?: string; ok?: boolean; error?: string } | null>(null);
  const [ssBusy, setSsBusy] = useState(false);

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

  const calcSampleSize = async () => {
    setSsBusy(true);
    setSsResult(null);
    const params: Record<string, string> = { alpha: ssAlpha, power: ssPower };
    if (ssDesign === "ttest") params.effect_size = ssD;
    else if (ssDesign === "proportion") { params.p1 = ssP1; params.p2 = ssP2; }
    else if (ssDesign === "anova") { params.effect_size = ssF; params.k_groups = ssK; }
    try {
      const resp = await fetch(apiUrl("/api/sample-size"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design: ssDesign, params }),
      });
      setSsResult(await resp.json());
    } catch (e) {
      setSsResult({ ok: false, error: `计算失败：${(e as Error).message}` });
    } finally {
      setSsBusy(false);
    }
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
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">
            清空
          </button>
        </div>
      </div>

      <ResultPanel
        text={text}
        running={running}
        error={error}
        onStop={stop}
        exportName="实验计划"
        placeholder="研究路线、实验设计、里程碑和风险点会显示在这里。"
        onExportDocx={() => downloadDocx(text, "实验计划", "plan")}
        exportingDocx={docxBusy === "plan"}
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
          />
        </>
      )}

      <details className="ss-calc" data-testid="ss-calc">
        <summary>🧮 样本量 / 检验效能计算器（确定性，免费，不消耗额度）</summary>
        <div className="form" style={{ marginTop: 12 }}>
          <label className="field">
            <span className="field-label">研究设计</span>
            <select data-testid="ss-design" value={ssDesign} onChange={(e) => setSsDesign(e.target.value)}>
              <option value="ttest">两组均值比较（t 检验）</option>
              <option value="proportion">两组率比较（卡方/Z 检验）</option>
              <option value="anova">多组均值比较（单因素方差分析）</option>
            </select>
          </label>

          <div className="ss-row">
            <label className="field">
              <span className="field-label">显著性水平 α</span>
              <input data-testid="ss-alpha" value={ssAlpha} onChange={(e) => setSsAlpha(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">检验效能 power</span>
              <input data-testid="ss-power" value={ssPower} onChange={(e) => setSsPower(e.target.value)} />
            </label>
          </div>

          {ssDesign === "ttest" && (
            <label className="field">
              <span className="field-label">效应量 Cohen's d（小0.2/中0.5/大0.8）</span>
              <input data-testid="ss-d" value={ssD} onChange={(e) => setSsD(e.target.value)} />
            </label>
          )}
          {ssDesign === "proportion" && (
            <div className="ss-row">
              <label className="field">
                <span className="field-label">对照组率 p1（0~1）</span>
                <input data-testid="ss-p1" value={ssP1} onChange={(e) => setSsP1(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">试验组率 p2（0~1）</span>
                <input data-testid="ss-p2" value={ssP2} onChange={(e) => setSsP2(e.target.value)} />
              </label>
            </div>
          )}
          {ssDesign === "anova" && (
            <div className="ss-row">
              <label className="field">
                <span className="field-label">效应量 Cohen's f（小0.1/中0.25/大0.4）</span>
                <input data-testid="ss-f" value={ssF} onChange={(e) => setSsF(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">组数 k</span>
                <input data-testid="ss-k" value={ssK} onChange={(e) => setSsK(e.target.value)} />
              </label>
            </div>
          )}

          <button className="btn-primary" onClick={calcSampleSize} disabled={ssBusy} data-testid="ss-calc-btn">
            {ssBusy ? "计算中…" : "计算样本量"}
          </button>

          {ssResult && (
            ssResult.ok ? (
              <div className="ss-result" data-testid="ss-result">
                <strong>每组 {ssResult.per_group} 例，总计 {ssResult.total} 例</strong>
                <span className="field-hint">{ssResult.note}（结果由统计公式确定性计算，可写入方案）</span>
              </div>
            ) : (
              <div className="result-error" data-testid="ss-error">{ssResult.error}</div>
            )
          )}
        </div>
      </details>

      <details className="ss-calc" data-testid="rz-calc">
        <summary>🎲 随机化分组表（确定性，固定种子可复现，免费）</summary>
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
