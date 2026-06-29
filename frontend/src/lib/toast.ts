// W2-2 Toast: 全局 Toast 系统
// 使用方式:
//   showToast({ kind: "error", message: "余额不足", action: { label: "去充值", onClick: () => ... } });
// 在 App.tsx 顶部挂 <ToastContainer /> 监听全局 toast 事件即可。

export type ToastKind = "info" | "success" | "warn" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  /** 毫秒, 0 = 不自动消失。error 默认 0; 其他默认 4000。 */
  duration?: number;
}

export interface ToastEntry extends ToastOptions {
  id: string;
}

// 简单的发布/订阅: 用 window event 解耦, 不依赖 React context。
const TOAST_EVENT = "ra:toast:show";
const TOAST_DISMISS_EVENT = "ra:toast:dismiss";

export function showToast(opts: ToastOptions): string {
  const id = `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const detail: ToastEntry = {
    id,
    kind: opts.kind,
    message: opts.message,
    action: opts.action,
    duration: opts.duration,
  };
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail }));
  return id;
}

export function dismissToast(id: string): void {
  window.dispatchEvent(new CustomEvent(TOAST_DISMISS_EVENT, { detail: id }));
}

// 内部: 让 <ToastContainer /> 订阅这两个事件
export const _TOAST_EVENT = TOAST_EVENT;
export const _TOAST_DISMISS_EVENT = TOAST_DISMISS_EVENT;

// ── 便捷快捷 ───────────────────────────────────────────────────
export function toastInfo(message: string, action?: ToastAction): string {
  return showToast({ kind: "info", message, action });
}
export function toastSuccess(message: string, action?: ToastAction): string {
  return showToast({ kind: "success", message, action });
}
export function toastWarn(message: string, action?: ToastAction): string {
  return showToast({ kind: "warn", message, action });
}
export function toastError(message: string, action?: ToastAction): string {
  return showToast({ kind: "error", message, action });
}
