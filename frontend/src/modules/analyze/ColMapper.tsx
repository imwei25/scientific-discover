// ─── 列映射通用组件(KM / ROC 用) ────────────────────────────────
interface ColField {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  allowEmpty?: boolean;
  testId?: string;
}
interface ColMapperProps {
  title: string;
  file: File | null;
  headers: string[];
  fields: ColField[];
  busy: boolean;
  onRun: () => void;
  runTestId?: string;
  runLabel: string;
}
export default function ColMapper({ title, file, headers, fields, busy, onRun, runTestId, runLabel }: ColMapperProps) {
  if (!file) {
    return <p className="field-hint">请先在上方上传 CSV 文件以选择列。</p>;
  }
  // 未能解析出表头(如 xlsx)时, 退化为「手动输入列名」而非死路
  const manual = headers.length === 0;
  return (
    <div data-testid="col-mapper">
      <p className="field-hint" style={{ marginTop: 10 }}>{title}</p>
      {manual && (
        <p className="field-hint" style={{ marginTop: 6 }}>
          未能自动解析表头（xlsx 等）。请手动输入列名，需与表格首行列名<strong>完全一致</strong>（区分大小写与空格）。
        </p>
      )}
      <div className="col-map-grid">
        {fields.map((f) => (
          <Frag key={f.label}>
            <span>{f.label}</span>
            {manual ? (
              <input
                value={f.value}
                onChange={(e) => f.onChange(e.target.value)}
                data-testid={f.testId}
                placeholder={f.allowEmpty ? "列名（可留空 = 不使用）" : "输入列名"}
              />
            ) : (
              <select
                value={f.value}
                onChange={(e) => f.onChange(e.target.value)}
                data-testid={f.testId}
              >
                {f.allowEmpty && <option value="">(不使用)</option>}
                {!f.allowEmpty && <option value="">请选择…</option>}
                {headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            )}
          </Frag>
        ))}
      </div>
      <div className="form-actions">
        <button className="btn-primary" onClick={onRun} disabled={busy} data-testid={runTestId}>
          {busy ? "生成中…" : runLabel}
        </button>
      </div>
    </div>
  );
}
function Frag({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
