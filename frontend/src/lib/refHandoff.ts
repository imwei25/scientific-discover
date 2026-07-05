import type { Reference, EvidenceItem } from "./sse";

export interface RefHandoff {
  refs: Reference[];
  evidence: Record<string, EvidenceItem>;
  from: "idea" | "grant";
}

// 内存 stash 作为快路径; sessionStorage 作为持久层, 防止 F5 / 懒加载首帧丢失.
// 用 sessionStorage 而非 localStorage: tab 关闭即清, 避免"陈旧文献回魂"到下次启动.
let _stash: RefHandoff | null = null;
const SS_KEY = "ra:refhandoff:stash";

export const REFHANDOFF_EVENT = "refhandoff:pending";

function _persist(h: RefHandoff | null): void {
  try {
    if (h) sessionStorage.setItem(SS_KEY, JSON.stringify(h));
    else sessionStorage.removeItem(SS_KEY);
  } catch {
    // 配额溢出或被禁用: 无所谓, 内存仍有兜底
  }
}

function _restore(): RefHandoff | null {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as RefHandoff;
  } catch {
    return null;
  }
}

export function stash(h: RefHandoff): void {
  _stash = h;
  _persist(h);
  try {
    window.dispatchEvent(new CustomEvent(REFHANDOFF_EVENT, { detail: { from: h.from, count: h.refs.length } }));
  } catch {
    // no-op: SSR / non-DOM
  }
}

export function peek(): RefHandoff | null {
  return _stash || _restore();
}

export function consume(): RefHandoff | null {
  const s = _stash || _restore();
  _stash = null;
  _persist(null);
  return s;
}
