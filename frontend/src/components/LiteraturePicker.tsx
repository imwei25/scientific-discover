import { useMemo, type ReactNode } from "react";
import type { Reference, EvidenceItem } from "../lib/sse";
import RefIO from "./RefIO";
import ZoteroPanel from "./ZoteroPanel";

/** Key precedence must match backend _ref_key and frontend refKey (evidenceExtract.ts). */
export function pickerKey(r: Reference): string {
  if (r.pmid) return `pmid:${r.pmid}`;
  if (r.doi) return `doi:${r.doi}`;
  if (r.url) return `url:${r.url}`;
  return `title:${(r.title || "").trim().slice(0, 60)}`;
}

export interface LiteraturePickerProps {
  refs: Reference[];
  evidenceByKey: Record<string, EvidenceItem & { _ev_status?: string }>;
  selectedKeys: string[];
  onSelectionChange: (keys: string[]) => void;
  onImport?: (imported: Reference[]) => void;
  /** Key function — defaults to pickerKey. Pass IdeaModule's legacy refKey if needed. */
  keyFn?: (r: Reference) => string;
  mode?: "picker" | "list";
  primaryAction?: { label: string; onClick: (checked: Reference[]) => void; disabled?: boolean };
  secondaryAction?: { label: string; onClick: (checked: Reference[]) => void; disabled?: boolean };
  exportFilename?: string;
  showZotero?: boolean;
  header?: ReactNode;
  extractionStatus?: { done: number; total: number } | null;
}

export function LiteraturePicker(props: LiteraturePickerProps) {
  const {
    refs, evidenceByKey, selectedKeys, onSelectionChange,
    onImport, keyFn = pickerKey, mode = "picker", primaryAction, secondaryAction,
    exportFilename = "references", showZotero = true, header, extractionStatus,
  } = props;

  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const checkedRefs = useMemo(
    () => refs.filter((r) => selectedSet.has(keyFn(r))),
    [refs, selectedSet, keyFn],
  );

  const toggle = (key: string) => {
    if (selectedSet.has(key)) {
      onSelectionChange(selectedKeys.filter((k) => k !== key));
    } else {
      onSelectionChange([...selectedKeys, key]);
    }
  };

  const toggleAll = () => {
    if (selectedSet.size === refs.length) onSelectionChange([]);
    else onSelectionChange(refs.map(keyFn));
  };

  return (
    <div className="lit-picker">
      {header}
      <div className="lit-picker-toolbar">
        <button type="button" onClick={toggleAll} disabled={!refs.length}>
          {selectedSet.size === refs.length && refs.length ? "取消全选" : "全选"}
        </button>
        <span className="lit-picker-count">
          已选 {selectedSet.size} / {refs.length}
        </span>
        {extractionStatus && (
          <span className="lit-picker-progress">
            正在提取核心发现 {extractionStatus.done}/{extractionStatus.total}…
          </span>
        )}
        <div className="lit-picker-io">
          <RefIO
            currentRefs={refs}
            onImport={(imported) => onImport?.(imported)}
            exportFilename={exportFilename}
          />
          {showZotero && (
            <ZoteroPanel
              currentRefs={refs}
              onImport={(imported) => onImport?.(imported)}
              selectedForPush={checkedRefs}
            />
          )}
        </div>
      </div>

      <ul className="lit-picker-list">
        {refs.map((r) => {
          const k = keyFn(r);
          const ev = evidenceByKey[k];
          const checked = selectedSet.has(k);
          return (
            <li key={k} className={"lit-picker-row" + (checked ? " selected" : "")}>
              <label className="lit-picker-check">
                <input type="checkbox" checked={checked} onChange={() => toggle(k)} />
              </label>
              <div className="lit-picker-body">
                <div className="lit-picker-title">
                  <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a>
                </div>
                <div className="lit-picker-meta">
                  {r.first_author} · {r.year} · {r.journal}
                  {r.journal_impact != null && <> · IF {r.journal_impact}</>}
                  {r.journal_quartile && <> · {r.journal_quartile}</>}
                  {r.source && <> · {r.source}</>}
                </div>
                <div className="lit-picker-evidence">
                  {ev?._ev_status === "no_abstract" ? (
                    <span className="ev-chip ev-empty">无摘要，未提取</span>
                  ) : ev?._ev_status === "extract_error" ? (
                    <span className="ev-chip ev-error">核心发现提取失败</span>
                  ) : ev ? (
                    <>
                      <span className="ev-chip">对象: {ev.pop || "—"}</span>
                      <span className="ev-chip">设计: {ev.design || "—"}</span>
                      <span className="ev-chip ev-finding">发现: {ev.finding || "—"}</span>
                      <span className="ev-chip">局限: {ev.gap || "—"}</span>
                    </>
                  ) : (
                    <span className="ev-chip ev-pending">待提取…</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {mode === "picker" && (primaryAction || secondaryAction) && (
        <div className="lit-picker-actions">
          {secondaryAction && (
            <button type="button" onClick={() => secondaryAction.onClick(checkedRefs)}
              disabled={secondaryAction.disabled || checkedRefs.length === 0}>
              {secondaryAction.label}
            </button>
          )}
          {primaryAction && (
            <button type="button" className="primary" onClick={() => primaryAction.onClick(checkedRefs)}
              disabled={primaryAction.disabled || checkedRefs.length === 0}>
              {primaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
