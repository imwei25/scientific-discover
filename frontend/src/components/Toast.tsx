// W2-2 ToastContainer: 顶部居中堆叠最多 5 条 Toast。
// 监听 lib/toast.ts 派发的全局 event, 渲染 + 自动消失逻辑也在这里。

import { useEffect, useState } from "react";
import { _TOAST_DISMISS_EVENT, _TOAST_EVENT, ToastEntry, ToastKind } from "../lib/toast";

const MAX_STACK = 5;

export default function ToastContainer() {
  const [stack, setStack] = useState<ToastEntry[]>([]);

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const onShow = (ev: Event) => {
      const detail = (ev as CustomEvent<ToastEntry>).detail;
      if (!detail) return;
      setStack((prev) => {
        // 同一条 message + kind 在 1 秒内的重复, 跳过
        const dedupe = prev.find(
          (p) => p.message === detail.message && p.kind === detail.kind,
        );
        if (dedupe) return prev;
        const next = [...prev, detail].slice(-MAX_STACK);
        return next;
      });
      // 安排自动消失(error 默认不消失, 其他 4s)
      const dur =
        detail.duration === undefined
          ? detail.kind === "error"
            ? 0
            : 4000
          : detail.duration;
      if (dur > 0) {
        const tm = setTimeout(() => {
          setStack((prev) => prev.filter((p) => p.id !== detail.id));
          timers.delete(detail.id);
        }, dur);
        timers.set(detail.id, tm);
      }
    };

    const onDismiss = (ev: Event) => {
      const id = (ev as CustomEvent<string>).detail;
      if (!id) return;
      setStack((prev) => prev.filter((p) => p.id !== id));
      const tm = timers.get(id);
      if (tm) {
        clearTimeout(tm);
        timers.delete(id);
      }
    };

    window.addEventListener(_TOAST_EVENT, onShow);
    window.addEventListener(_TOAST_DISMISS_EVENT, onDismiss);
    return () => {
      window.removeEventListener(_TOAST_EVENT, onShow);
      window.removeEventListener(_TOAST_DISMISS_EVENT, onDismiss);
      for (const tm of timers.values()) clearTimeout(tm);
    };
  }, []);

  return (
    <div className="toast-container" data-testid="toast-container" aria-live="polite">
      {stack.map((t) => (
        <ToastItem key={t.id} entry={t} onClose={() => {
          setStack((prev) => prev.filter((p) => p.id !== t.id));
        }} />
      ))}
    </div>
  );
}

function ToastItem({ entry, onClose }: { entry: ToastEntry; onClose: () => void }) {
  return (
    <div
      className={`toast toast-${entry.kind}`}
      data-testid={`toast-${entry.kind}`}
      role={entry.kind === "error" ? "alert" : "status"}
    >
      <span className="toast-icon" aria-hidden="true">{iconOf(entry.kind)}</span>
      <span className="toast-msg">{entry.message}</span>
      {entry.action && (
        <button
          className="toast-action"
          onClick={() => {
            entry.action!.onClick();
            onClose();
          }}
        >
          {entry.action.label}
        </button>
      )}
      <button className="toast-close" onClick={onClose} aria-label="关闭通知">×</button>
    </div>
  );
}

function iconOf(k: ToastKind): string {
  switch (k) {
    case "success": return "✓";
    case "warn": return "⚠";
    case "error": return "✗";
    default: return "i";
  }
}
