import { useEffect, useRef, useState } from "react";
import { useProjects } from "../lib/projects";

export default function ProjectPicker() {
  const { projects, current, offline, switchTo, create, rename, remove } = useProjects();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"list" | "create" | "rename" | "delete">("list");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点外面收起
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setMode("list");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // 切到 rename 时预填当前名字
  useEffect(() => {
    if (mode === "rename") setDraft(current?.name ?? "");
    if (mode === "create") setDraft("");
  }, [mode, current]);

  const close = () => { setOpen(false); setMode("list"); };

  const onPick = async (id: string) => {
    if (id === current?.id) return close();
    setBusy(true);
    try { await switchTo(id); } finally { setBusy(false); close(); }
  };

  const onCreate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await create(draft.trim() || "未命名项目");
      close();
    } finally { setBusy(false); }
  };

  const onRename = async () => {
    if (busy || !current) return;
    const name = draft.trim();
    if (!name) return;
    setBusy(true);
    try { await rename(current.id, name); close(); } finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (busy || !current) return;
    setBusy(true);
    try { await remove(current.id); close(); } finally { setBusy(false); }
  };

  return (
    <div className="project-picker" ref={rootRef} data-testid="project-picker">
      <button
        className="project-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={offline && !current}
        data-testid="project-picker-trigger"
        title={offline ? "离线，无法切换项目" : undefined}
      >
        <span className="pp-icon" aria-hidden>📁</span>
        <span className="pp-name">{current?.name ?? "（无项目）"}</span>
        <span className="pp-caret" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="project-picker-panel" data-testid="project-picker-panel">
          {mode === "list" && (
            <>
              <ul className="pp-list">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button
                      className={`pp-item ${p.id === current?.id ? "active" : ""}`}
                      onClick={() => onPick(p.id)}
                      data-testid={`project-item-${p.id}`}
                    >
                      <span className="pp-dot">{p.id === current?.id ? "●" : "○"}</span>
                      <span className="pp-item-name">{p.name}</span>
                      {p.id === current?.id && <span className="pp-current">（当前）</span>}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="pp-sep" />
              <button className="pp-action" onClick={() => setMode("create")} disabled={offline} data-testid="project-new">
                + 新建项目
              </button>
              <button className="pp-action" onClick={() => setMode("rename")} disabled={offline || !current} data-testid="project-rename">
                ✎ 重命名当前
              </button>
              <button className="pp-action danger" onClick={() => setMode("delete")} disabled={offline || !current} data-testid="project-delete">
                🗑 删除当前
              </button>
            </>
          )}

          {mode === "create" && (
            <div className="pp-form">
              <label htmlFor="pp-create-input">新建项目</label>
              <input
                id="pp-create-input"
                data-testid="project-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onCreate(); if (e.key === "Escape") close(); }}
                placeholder="项目名"
                autoFocus
                maxLength={80}
              />
              <div className="pp-form-actions">
                <button onClick={close}>取消</button>
                <button className="primary" onClick={onCreate} disabled={busy} data-testid="project-create-confirm">创建</button>
              </div>
            </div>
          )}

          {mode === "rename" && (
            <div className="pp-form">
              <label htmlFor="pp-rename-input">重命名</label>
              <input
                id="pp-rename-input"
                data-testid="project-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onRename(); if (e.key === "Escape") close(); }}
                autoFocus
                maxLength={80}
              />
              <div className="pp-form-actions">
                <button onClick={close}>取消</button>
                <button className="primary" onClick={onRename} disabled={busy} data-testid="project-rename-confirm">保存</button>
              </div>
            </div>
          )}

          {mode === "delete" && current && (
            <div className="pp-form">
              <div className="pp-confirm-text">
                将永久删除项目 <strong>「{current.name}」</strong> 及其所有数据，无法恢复。
              </div>
              <div className="pp-form-actions">
                <button onClick={close}>取消</button>
                <button className="danger" onClick={onDelete} disabled={busy} data-testid="project-delete-confirm">
                  删除
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
