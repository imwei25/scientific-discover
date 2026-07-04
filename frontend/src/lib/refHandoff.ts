import type { Reference, EvidenceItem } from "./sse";

export interface RefHandoff {
  refs: Reference[];
  evidence: Record<string, EvidenceItem>;
  from: "idea" | "grant";
}

let _stash: RefHandoff | null = null;

export const REFHANDOFF_EVENT = "refhandoff:pending";

export function stash(h: RefHandoff): void {
  _stash = h;
  try {
    window.dispatchEvent(new CustomEvent(REFHANDOFF_EVENT, { detail: { from: h.from, count: h.refs.length } }));
  } catch {
    // no-op: SSR / non-DOM
  }
}

export function peek(): RefHandoff | null {
  return _stash;
}

export function consume(): RefHandoff | null {
  const s = _stash;
  _stash = null;
  return s;
}
