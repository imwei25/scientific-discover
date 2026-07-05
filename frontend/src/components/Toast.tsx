// W2-2 ToastContainer: 顶部居中堆叠最多 5 条 Toast。
// 监听 lib/toast.ts 派发的全局 event, 渲染 + 自动消失逻辑也在这里。

import { useEffect, useState } from "react";
import { _TOAST_DISMISS_EVENT, _TOAST_EVENT, ToastEntry, ToastKind } from "../lib/toast";

const MAX_STACK = 5;

export default function ToastContainer() {
  const [stack, setStack] = useState<ToastEntry[]>([]);

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    // 记录每条 (message+kind) 的最近显示时刻; 只在 1 秒内视为重复, 之外照常再触发
    const lastShown = new Map<string, number>();
    const DEDUP_WINDOW_MS = 1000;
    // 30 秒清理一次超过 30s 的 dedup 条目, 避免长会话下 map 只增不减 (R18 内存泄漏)
    const gcInterval = setInterval(() => {
      const now = Date.now();
      for (const [k, ts] of lastShown) {
        if (now - ts > 30_000) lastShown.delete(k);
      }
    }, 30_000);

    const onShow = (ev: Event) => {
      const detail = (ev as CustomEvent<ToastEntry>).detail;
      if (!detail) return;
      const key = `${detail.kind}::${detail.message}`;
      const prevTs = lastShown.get(key) ?? 0;
      const now = Date.now();
      if (now - prevTs < DEDUP_WINDOW_MS) {
        // 1 秒内的连点/连发, 忽略以防 toast 洪水
        return;
      }
      lastShown.set(key, now);
      setStack((prev) => {
        // 栈里若已有可见的同文案 toast (例如上一次 error 还没被 × 掉), 用新 id 替换,
        // 让用户看到"确实又发生了一次", 而不是完全静默.
        const existingIdx = prev.findIndex(
          (p) => p.message === detail.message && p.kind === detail.kind,
        );
        if (existingIdx >= 0) {
          const next = prev.slice();
          const oldTm = timers.get(prev[existingIdx].id);
          if (oldTm) { clearTimeout(oldTm); timers.delete(prev[existingIdx].id); }
          next[existingIdx] = detail;
          return next;
        }
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
      clearInterval(gcInterval);
    };
  }, []);

  return (
    <div className="toast-container" data-testid="toast-container" role="log" aria-live="polite" aria-relevant="additions">
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
