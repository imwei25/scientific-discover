import type { ForestRow } from "./types";

// ─── 森林图编辑器 ───────────────────────────────────────────────
interface ForestEditorProps {
  rows: ForestRow[];
  effect: "OR" | "RR";
  busy: boolean;
  onChange: (i: number, k: keyof ForestRow, v: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onEffect: (e: "OR" | "RR") => void;
  onRun: () => void;
}
export default function ForestEditor({ rows, effect, busy, onChange, onAdd, onRemove, onEffect, onRun }: ForestEditorProps) {
  return (
    <div className="forest-editor" data-testid="forest-editor">
      <div className="forest-row forest-head">
        <span>研究名</span>
        <span>治疗 N</span>
        <span>治疗事件</span>
        <span>对照 N</span>
        <span>对照事件</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div className="forest-row" key={i}>
          <input
            value={r.study}
            placeholder={`研究 ${i + 1}`}
            onChange={(e) => onChange(i, "study", e.target.value)}
            data-testid={`forest-study-${i}`}
          />
          <input
            type="number" inputMode="numeric"
            value={r.n_treat}
            onChange={(e) => onChange(i, "n_treat", e.target.value)}
            data-testid={`forest-ntreat-${i}`}
          />
          <input
            type="number" inputMode="numeric"
            value={r.event_treat}
            onChange={(e) => onChange(i, "event_treat", e.target.value)}
            data-testid={`forest-etreat-${i}`}
          />
          <input
            type="number" inputMode="numeric"
            value={r.n_ctrl}
            onChange={(e) => onChange(i, "n_ctrl", e.target.value)}
            data-testid={`forest-nctrl-${i}`}
          />
          <input
            type="number" inputMode="numeric"
            value={r.event_ctrl}
            onChange={(e) => onChange(i, "event_ctrl", e.target.value)}
            data-testid={`forest-ectrl-${i}`}
          />
          <button className="row-x" onClick={() => onRemove(i)} aria-label="删除此行">✕</button>
        </div>
      ))}
      <div className="forest-actions">
        <button className="btn-ghost btn-sm" onClick={onAdd} data-testid="forest-add-row">+ 添加一行</button>
        <label className="field-inline">
          效应量
          <select value={effect} onChange={(e) => onEffect(e.target.value as "OR" | "RR")} data-testid="forest-effect">
            <option value="OR">OR(优势比)</option>
            <option value="RR">RR(风险比)</option>
          </select>
        </label>
        <button className="btn-primary" onClick={onRun} disabled={busy} data-testid="forest-run-btn">
          {busy ? "生成中…" : "生成森林图"}
        </button>
      </div>
    </div>
  );
}
