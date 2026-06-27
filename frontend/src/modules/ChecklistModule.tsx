import { useEffect, useRef, useState } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import ResultPanel from "../components/ResultPanel";
import Dropzone from "../components/Dropzone";

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

  const downloadDocx = async () => {
    if (!text || docxBusy) return;
    setDocxBusy(true);
    try {
      const resp = await fetch(apiUrl("/api/docx"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, journal_id: "", references: [] }),
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "报告规范核对.docx";
      a.click();
      URL.revokeObjectURL(url);
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
