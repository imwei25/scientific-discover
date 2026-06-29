import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "../lib/api";

// 检测到的 PHI 列
export interface DeidColumn {
  name: string;
  phi_types: string[];
  count: number;
  samples: string[];
}

export interface DeidScanResult {
  columns: DeidColumn[];
  total_rows: number;
}

export interface DeidentifyDialogProps {
  open: boolean;
  scanResult: DeidScanResult | null;
  originalFile: File | null;
  onAccept: (redactedFile: File, mapping: Record<string, string>) => void;
  onCancel: () => void;
}

// PHI 类型代码 → 中文标签
const PHI_LABELS: Record<string, string> = {
  name: "姓名",
  id_card: "身份证",
  phone: "手机",
  mrn: "MRN",
  birthdate: "出生日期",
};
function phiLabel(t: string): string {
  return PHI_LABELS[t] || t;
}

// 把 base64 转回 File(保留原文件名加 _deid 后缀)。
function base64ToFile(b64: string, originalName: string, mime: string): File {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dot = originalName.lastIndexOf(".");
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot > 0 ? originalName.slice(dot) : "";
  const newName = `${stem}_deid${ext}`;
  return new File([bytes], newName, { type: mime });
}

// 可复用的脱敏确认对话框: 列出检测到的 PHI 列, 用户勾选要脱敏的列后一键脱敏。
export default function DeidentifyDialog({ open, scanResult, originalFile, onAccept, onCancel }: DeidentifyDialogProps) {
  // 默认全选
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open && scanResult) {
      const init: Record<string, boolean> = {};
      for (const c of scanResult.columns) init[c.name] = true;
      setSelected(init);
      setErr(null);
    }
  }, [open, scanResult]);

  const cols = scanResult?.columns ?? [];
  const checkedNames = useMemo(
    () => cols.filter((c) => selected[c.name]).map((c) => c.name),
    [cols, selected],
  );

  if (!open || !scanResult || !originalFile) return null;

  const toggle = (name: string) => setSelected((p) => ({ ...p, [name]: !p[name] }));
  const toggleAll = (v: boolean) => {
    const next: Record<string, boolean> = {};
    for (const c of cols) next[c.name] = v;
    setSelected(next);
  };

  const apply = async () => {
    if (!checkedNames.length || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", originalFile);
      fd.append("columns", JSON.stringify(checkedNames));
      const resp = await fetch(apiUrl("/api/deidentify/apply"), { method: "POST", body: fd });
      if (!resp.ok) throw new Error(`服务返回错误 ${resp.status}`);
      const data = await resp.json();
      const b64 = data.data_base64 || data.dataBase64;
      if (!b64) throw new Error("脱敏服务未返回数据");
      const file = base64ToFile(b64, originalFile.name, originalFile.type || "application/octet-stream");
      onAccept(file, data.mapping || {});
    } catch (e) {
      setErr(`脱敏失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const allChecked = cols.length > 0 && cols.every((c) => selected[c.name]);
  const noneChecked = checkedNames.length === 0;

  return (
    <div className="deid-overlay" data-testid="deid-overlay" role="dialog" aria-modal="true" aria-labelledby="deid-title">
      <div className="deid-dialog">
        <header className="deid-head">
          <h3 id="deid-title">🔒 检测到可能的患者隐私信息</h3>
          <p className="deid-sub">
            在上传到云端分析前建议先脱敏。共扫描 <strong>{scanResult.total_rows}</strong> 行，发现 <strong>{cols.length}</strong> 个含 PHI 的列。
            勾选的列会用占位符替换（如 <code>P00001</code>），并生成本地保留的映射表。
          </p>
        </header>

        <div className="deid-table-wrap">
          <table className="deid-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => toggleAll(e.target.checked)}
                    aria-label={allChecked ? "全部取消" : "全部勾选"}
                    data-testid="deid-check-all"
                  />
                </th>
                <th>列名</th>
                <th>PHI 类型</th>
                <th style={{ width: 90 }}>命中行数</th>
                <th>样本（已部分打码）</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => (
                <tr key={c.name} data-testid={`deid-row-${c.name}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={!!selected[c.name]}
                      onChange={() => toggle(c.name)}
                      aria-label={`选择列 ${c.name}`}
                      data-testid={`deid-check-${c.name}`}
                    />
                  </td>
                  <td className="deid-col-name">{c.name}</td>
                  <td>
                    {c.phi_types.map((t) => (
                      <span key={t} className="deid-tag">
                        {phiLabel(t)}
                      </span>
                    ))}
                  </td>
                  <td className="deid-num">{c.count}</td>
                  <td className="deid-samples">
                    {c.samples.slice(0, 3).map((s, i) => (
                      <code key={i} className="deid-sample">
                        {s}
                      </code>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {err && <div className="result-error" data-testid="deid-error">{err}</div>}

        <footer className="deid-foot">
          <button className="btn-ghost" onClick={onCancel} disabled={busy} data-testid="deid-cancel">
            取消（用原文件）
          </button>
          <button
            className="btn-primary"
            onClick={apply}
            disabled={busy || noneChecked}
            data-testid="deid-apply"
          >
            {busy ? "脱敏中…" : "一键脱敏并继续"}
          </button>
        </footer>
      </div>

      <style>{`
        .deid-overlay {
          position: fixed; inset: 0; z-index: 9999;
          background: rgba(15, 23, 31, 0.55);
          display: flex; align-items: center; justify-content: center;
          padding: 24px;
          animation: deid-fade-in 160ms ease-out both;
        }
        @keyframes deid-fade-in { from { opacity: 0; } to { opacity: 1; } }
        .deid-dialog {
          background: var(--bg, #fff);
          color: var(--ink, #1f2733);
          border-radius: 12px;
          box-shadow: 0 16px 48px rgba(0,0,0,0.25);
          max-width: 880px; width: 100%;
          max-height: 86vh;
          display: flex; flex-direction: column;
          overflow: hidden;
          animation: deid-pop-in 200ms cubic-bezier(.2,.9,.3,1.2) both;
        }
        @keyframes deid-pop-in {
          from { transform: translateY(8px) scale(0.98); opacity: 0; }
          to   { transform: translateY(0) scale(1);    opacity: 1; }
        }
        .deid-head { padding: 20px 24px 12px; border-bottom: 1px solid var(--line, #e3e8ef); }
        .deid-head h3 { margin: 0 0 6px; font-size: 18px; }
        .deid-sub { margin: 0; color: var(--faint, #5b6675); font-size: 13.5px; line-height: 1.6; }
        .deid-sub code { background: var(--surface, #f3f5f8); padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }
        .deid-table-wrap { overflow: auto; padding: 8px 24px; flex: 1 1 auto; }
        .deid-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
        .deid-table th, .deid-table td {
          padding: 10px 8px; text-align: left;
          border-bottom: 1px solid var(--line-soft, #eef1f5);
          vertical-align: top;
        }
        .deid-table th { font-weight: 600; color: var(--faint, #5b6675); position: sticky; top: 0; background: var(--bg, #fff); }
        .deid-col-name { font-family: var(--mono, ui-monospace, monospace); font-weight: 600; }
        .deid-num { text-align: right; font-variant-numeric: tabular-nums; }
        .deid-tag {
          display: inline-block; margin: 0 4px 4px 0;
          padding: 2px 8px; border-radius: 999px;
          background: rgba(20, 130, 120, 0.12); color: var(--petrol, #14635c);
          font-size: 12px; font-weight: 600;
        }
        .deid-sample {
          display: inline-block; margin: 0 4px 4px 0;
          padding: 2px 6px; border-radius: 4px;
          background: var(--surface, #f3f5f8);
          font-size: 12px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          vertical-align: middle;
        }
        .deid-foot {
          padding: 14px 24px 18px;
          border-top: 1px solid var(--line, #e3e8ef);
          display: flex; justify-content: flex-end; gap: 10px;
        }
      `}</style>
    </div>
  );
}
