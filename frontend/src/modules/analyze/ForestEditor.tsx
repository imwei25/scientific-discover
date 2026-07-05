import type { ForestRow, ForestFieldKey } from "./types";
import { validateForestRow, isForestRowBlank } from "./types";

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

// 每个字段: 占位符 + 悬停提示. 明确"这里填的是样本量, 不是事件数"以避免列填反。
const FIELD_META: Record<Exclude<ForestFieldKey, "study">, { placeholder: string; title: string }> = {
  n_treat: { placeholder: "治疗组样本量 (如 3302)", title: "治疗组总人数, 不是事件数" },
  event_treat: { placeholder: "治疗组事件数 (如 174)", title: "治疗组发生事件的人数, 应 ≤ 治疗 N" },
  n_ctrl: { placeholder: "对照组样本量 (如 3293)", title: "对照组总人数, 不是事件数" },
  event_ctrl: { placeholder: "对照组事件数 (如 248)", title: "对照组发生事件的人数, 应 ≤ 对照 N" },
};

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
      {rows.map((r, i) => {
        const issues = isForestRowBlank(r) ? [] : validateForestRow(r);
        const issueByField = new Map<ForestFieldKey, string>();
        for (const iss of issues) {
          const prev = issueByField.get(iss.field);
          issueByField.set(iss.field, prev ? `${prev}; ${iss.message}` : iss.message);
        }
        const cellProps = (field: Exclude<ForestFieldKey, "study">) => {
          const err = issueByField.get(field);
          const meta = FIELD_META[field];
          return {
            "aria-invalid": err ? true : undefined,
            className: err ? "is-invalid" : undefined,
            placeholder: meta.placeholder,
            title: err || meta.title,
          } as const;
        };
        const studyErr = issueByField.get("study");
        return (
          <div className="forest-row-wrap" key={i}>
            <div className="forest-row">
              <input
                value={r.study}
                placeholder={`研究 ${i + 1}`}
                aria-invalid={studyErr ? true : undefined}
                className={studyErr ? "is-invalid" : undefined}
                title={studyErr || "研究名"}
                onChange={(e) => onChange(i, "study", e.target.value)}
                data-testid={`forest-study-${i}`}
              />
              <input
                type="number" inputMode="numeric" min={0}
                value={r.n_treat}
                onChange={(e) => onChange(i, "n_treat", e.target.value)}
                data-testid={`forest-ntreat-${i}`}
                {...cellProps("n_treat")}
              />
              <input
                type="number" inputMode="numeric" min={0}
                value={r.event_treat}
                onChange={(e) => onChange(i, "event_treat", e.target.value)}
                data-testid={`forest-etreat-${i}`}
                {...cellProps("event_treat")}
              />
              <input
                type="number" inputMode="numeric" min={0}
                value={r.n_ctrl}
                onChange={(e) => onChange(i, "n_ctrl", e.target.value)}
                data-testid={`forest-nctrl-${i}`}
                {...cellProps("n_ctrl")}
              />
              <input
                type="number" inputMode="numeric" min={0}
                value={r.event_ctrl}
                onChange={(e) => onChange(i, "event_ctrl", e.target.value)}
                data-testid={`forest-ectrl-${i}`}
                {...cellProps("event_ctrl")}
              />
              <button className="row-x" onClick={() => onRemove(i)} aria-label="删除此行">✕</button>
            </div>
            {issues.length > 0 && (
              <div className="forest-row-issues" data-testid={`forest-row-issues-${i}`}>
                {issues.map((iss, k) => (
                  <span key={k}>· {iss.message}</span>
                ))}
              </div>
            )}
          </div>
        );
      })}
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
