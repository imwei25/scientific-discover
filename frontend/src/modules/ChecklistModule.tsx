import { useEffect, useRef, useState } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import ResultPanel from "../components/ResultPanel";
import Dropzone from "../components/Dropzone";
import { downloadBase64, chartMime, tsName, downloadDocxFromText } from "../lib/download";

interface StatItem {
  raw: string;
  type: string;
  p_reported: string;
  p_computed: number | null;
  status: string;
}

const STAT_BADGE: Record<string, { label: string; cls: string }> = {
  consistent: { label: "✓ 一致", cls: "rc-real" },
  inconsistent: { label: "⚠ 不一致", cls: "rc-warn" },
  decision_error: { label: "✗ 严重(显著性翻转)", cls: "rc-bad" },
  unparsable: { label: "? 无法核验", cls: "rc-gray" },
};

type FlowField = { key: string; label: string; type: "num" | "text" };
const FLOW_FIELDS: Record<string, FlowField[]> = {
  prisma: [
    { key: "identified", label: "数据库识别记录数", type: "num" },
    { key: "duplicates", label: "筛选前剔除(去重等)", type: "num" },
    { key: "screened", label: "筛选的记录数", type: "num" },
    { key: "records_excluded", label: "排除的记录数", type: "num" },
    { key: "sought", label: "获取全文的报告数", type: "num" },
    { key: "not_retrieved", label: "未能获取全文数", type: "num" },
    { key: "assessed", label: "评估合格性的全文数", type: "num" },
    { key: "reports_excluded", label: "排除全文的原因/数量", type: "text" },
    { key: "included", label: "纳入研究数", type: "num" },
  ],
  consort: [
    { key: "assessed", label: "评估合格性", type: "num" },
    { key: "excluded", label: "排除总数", type: "num" },
    { key: "excluded_reasons", label: "排除原因", type: "text" },
    { key: "randomized", label: "随机化总数", type: "num" },
    { key: "arm1_label", label: "组1名称", type: "text" },
    { key: "arm1_alloc", label: "组1分配", type: "num" },
    { key: "arm1_received", label: "组1接受", type: "num" },
    { key: "arm1_notreceived", label: "组1未接受", type: "num" },
    { key: "arm1_lost", label: "组1失访", type: "num" },
    { key: "arm1_discont", label: "组1中止", type: "num" },
    { key: "arm1_analysed", label: "组1纳入分析", type: "num" },
    { key: "arm1_excl", label: "组1剔除分析", type: "num" },
    { key: "arm2_label", label: "组2名称", type: "text" },
    { key: "arm2_alloc", label: "组2分配", type: "num" },
    { key: "arm2_received", label: "组2接受", type: "num" },
    { key: "arm2_notreceived", label: "组2未接受", type: "num" },
    { key: "arm2_lost", label: "组2失访", type: "num" },
    { key: "arm2_discont", label: "组2中止", type: "num" },
    { key: "arm2_analysed", label: "组2纳入分析", type: "num" },
    { key: "arm2_excl", label: "组2剔除分析", type: "num" },
  ],
};

const GUIDELINES = [
  { key: "strobe", label: "STROBE · 观察性研究（队列/病例对照/横断面）" },
  { key: "consort", label: "CONSORT · 随机对照试验（RCT）" },
  { key: "prisma", label: "PRISMA · 系统综述 / Meta 分析" },
  { key: "spirit", label: "SPIRIT · 临床试验方案（protocol）" },
  { key: "arrive", label: "ARRIVE · 动物实验" },
];

export default function ChecklistModule() {
  const [manuscript, setManuscript] = usePersistentState("checklist:manuscript", "");
  const [guideline, setGuideline] = usePersistentState("checklist:guideline", "strobe");
  const { text, running, error, start, stop, setText } = useStream("checklist:result");
  const [docxBusy, setDocxBusy] = useState(false);

  // statcheck 统计一致性自查
  const [statText, setStatText] = usePersistentState("checklist:statText", "");
  const [statItems, setStatItems] = usePersistentState<StatItem[]>("checklist:statItems", []);
  const [statBusy, setStatBusy] = useState(false);
  const [statErr, setStatErr] = useState<string | null>(null);

  // 流程图生成 (PRISMA / CONSORT)
  const [flowKind, setFlowKind] = usePersistentState("checklist:flowKind", "prisma");
  const [flowCounts, setFlowCounts] = usePersistentState<Record<string, string>>("checklist:flowCounts", {});
  const [flowImg, setFlowImg] = useState<{ png: string; svg: string; pdf: string } | null>(null);
  const [flowBusy, setFlowBusy] = useState(false);
  const [flowErr, setFlowErr] = useState<string | null>(null);

  const runFlow = async () => {
    if (flowBusy) return;
    setFlowBusy(true);
    setFlowErr(null);
    setFlowImg(null);
    try {
      const resp = await fetch(apiUrl("/api/flow-diagram"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: flowKind, counts: flowCounts }),
      });
      const d = await resp.json();
      if (d.ok) setFlowImg({ png: d.png, svg: d.svg, pdf: d.pdf });
      else setFlowErr(d.error || "绘制失败");
    } catch (e) {
      setFlowErr(`绘制失败：${(e as Error).message}`);
    } finally {
      setFlowBusy(false);
    }
  };

  const runStatcheck = async () => {
    if (!statText.trim() || statBusy) return;
    setStatBusy(true);
    setStatErr(null);
    setStatItems([]);
    try {
      const resp = await fetch(apiUrl("/api/statcheck"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: statText }),
      });
      const d = await resp.json();
      if (d.ok) setStatItems(d.items || []);
      else setStatErr(d.error || "统计自查失败");
    } catch (e) {
      setStatErr(`统计自查失败：${(e as Error).message}`);
    } finally {
      setStatBusy(false);
      window.dispatchEvent(new Event("usage-updated"));
    }
  };

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "checklist",
        icon: "✅",
        title: (GUIDELINES.find((g) => g.key === guideline)?.label.split(" ")[0] || "规范核对") + " 核对",
        data: { "checklist:manuscript": manuscript, "checklist:guideline": guideline, "checklist:result": text },
      });
    }
  }, [running, error, text, manuscript, guideline]);

  const submit = () => {
    if (!manuscript.trim() || running) return;
    start("checklist", { manuscript, guideline });
  };

  const reset = () => {
    if (running) stop();
    setManuscript("");
    setText("");
  };

  const [docxErr, setDocxErr] = useState<string | null>(null);
  const downloadDocx = async () => {
    if (!text || docxBusy) return;
    setDocxBusy(true);
    setDocxErr(null);
    try {
      await downloadDocxFromText("报告规范核对.docx", text);
    } catch (e) {
      setDocxErr(`导出 Word 失败：${(e as Error).message}`);
    } finally {
      setDocxBusy(false);
    }
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>✅ 报告规范核对 · STROBE / CONSORT / PRISMA</h1>
        <p>
          按目标期刊要求的报告规范（EQUATOR 清单）<strong>逐条核对</strong>你的稿件/方案，
          标出已报告 / 不充分 / 缺失，并给出正文定位与修改建议——投稿前自查，少被退稿。
        </p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">报告规范（按研究类型选择）</span>
          <select data-testid="input-guideline" value={guideline} onChange={(e) => setGuideline(e.target.value)}>
            {GUIDELINES.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">稿件 / 方案全文 <em>必填</em></span>
          <textarea
            data-testid="input-manuscript"
            value={manuscript}
            onChange={(e) => setManuscript(e.target.value)}
            placeholder="粘贴稿件或方案全文（越完整核对越准），或用下方上传"
            rows={6}
          />
        </label>
        <Dropzone
          testId="upload-manuscript"
          accept=".docx,.pdf,.txt,.md"
          label="或上传稿件 / 方案（可选）"
          hint="支持 Word/PDF/txt；内容会填入上面的全文"
          mode="text"
          onText={(t) => setManuscript(t)}
        />
        <div className="form-actions">
          <button className="btn-primary" onClick={submit} disabled={!manuscript.trim() || running} data-testid="run-btn">
            {running ? "核对中…" : "开始规范核对"}
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
        exportName="报告规范核对"
        placeholder="逐条核对结果（已报告/不充分/缺失 + 修改建议）会显示在这里。"
        onExportDocx={downloadDocx}
        exportingDocx={docxBusy}
      />
      {docxErr && <div className="result-error" data-testid="docx-error">{docxErr}</div>}

      <h2 className="section-title">📈 流程图生成（PRISMA 2020 / CONSORT 2025）</h2>
      <p className="section-hint">
        填入各阶段数字，本地确定性绘制期刊级流程图（数字来自你的输入，不经 AI 编造），导出 PNG/SVG/PDF。
      </p>
      <div className="form">
        <label className="field">
          <span className="field-label">流程图类型</span>
          <select data-testid="flow-kind" value={flowKind} onChange={(e) => setFlowKind(e.target.value)}>
            <option value="prisma">PRISMA 2020（系统综述 / Meta 分析）</option>
            <option value="consort">CONSORT 2025（随机对照试验）</option>
          </select>
        </label>
        <div className="flow-grid">
          {FLOW_FIELDS[flowKind].map((f) => (
            <label key={f.key} className="field">
              <span className="field-label">{f.label}</span>
              <input
                data-testid={`flow-${f.key}`}
                value={flowCounts[f.key] ?? ""}
                inputMode={f.type === "num" ? "numeric" : "text"}
                onChange={(e) => setFlowCounts({ ...flowCounts, [f.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <button className="btn-primary" onClick={runFlow} disabled={flowBusy} data-testid="flow-btn">
          {flowBusy ? "绘制中…" : "生成流程图"}
        </button>
      </div>

      {flowErr && (
        <div className="result-error" data-testid="flow-error">
          {flowErr}
        </div>
      )}

      {flowImg && (
        <div className="analysis-block" data-testid="flow-result">
          <figure className="chart">
            <img src={`data:image/png;base64,${flowImg.png}`} alt="流程图" data-testid="flow-img" />
            <figcaption className="flow-downloads">
              {(["png", "svg", "pdf"] as const).map((fmt) => (
                <button
                  key={fmt}
                  className="btn-ghost btn-sm"
                  data-testid={`flow-download-${fmt}`}
                  onClick={() => downloadBase64(tsName(flowKind === "consort" ? "CONSORT流程图" : "PRISMA流程图", fmt), flowImg[fmt], chartMime(fmt))}
                >
                  下载 {fmt.toUpperCase()}
                </button>
              ))}
            </figcaption>
          </figure>
        </div>
      )}

      <h2 className="section-title">🔢 统计一致性自查（statcheck）</h2>
      <p className="section-hint">
        粘贴结果段/表格，自动抽取 t/F/χ²/r/z 统计量并<strong>本地重算 p 值</strong>，
        标出报告值与重算值是否一致（重算用 scipy，确定性、可复现）。
      </p>
      <div className="form">
        <label className="field">
          <span className="field-label">结果文字（含统计量与 p 值）</span>
          <textarea
            data-testid="input-stattext"
            value={statText}
            onChange={(e) => setStatText(e.target.value)}
            placeholder="例如：两组差异显著，t(38)=2.10, p=0.04；相关分析 r=0.31, p<0.001 ……"
            rows={5}
          />
        </label>
        <button className="btn-primary" onClick={runStatcheck} disabled={!statText.trim() || statBusy} data-testid="statcheck-btn">
          {statBusy ? "核验中…" : "统计一致性自查"}
        </button>
      </div>

      {statErr && (
        <div className="result-error" data-testid="statcheck-error">
          {statErr}
        </div>
      )}

      {statItems.length > 0 && (
        <div className="result-panel" data-testid="statcheck">
          <div className="result-toolbar">
            <span className="result-status">
              核验 {statItems.length} 处 · 不一致 {statItems.filter((x) => x.status === "inconsistent" || x.status === "decision_error").length}
            </span>
          </div>
          <ol className="ref-list" data-testid="statcheck-list">
            {statItems.map((it, i) => {
              const b = STAT_BADGE[it.status] || STAT_BADGE.unparsable;
              return (
                <li key={i}>
                  <span className={`ref-badge ${b.cls}`}>{b.label}</span>
                  <code>{it.raw}</code>
                  {it.p_computed != null && (
                    <span className="refcheck-note">
                      报告 p={it.p_reported}，重算 p≈{it.p_computed}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
