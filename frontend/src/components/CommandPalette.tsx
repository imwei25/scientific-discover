// W2-4-g 命令面板 (Cmd/Ctrl+K)
// 模糊搜索: NAV 模块 + 历史记录标题。
// ↑↓ 选择, 回车跳转, Esc 关闭。简单 substring + 子序列匹配, 不引第三方库。

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getHistory, type HistoryEntry } from "../lib/history";
import { writePersisted } from "../lib/usePersistentState";

export interface CommandItem {
  id: string;
  /** "module" 走 onPickModule, "history" 走 onPickHistory */
  kind: "module" | "history";
  title: string;
  desc?: string;
  icon?: ReactNode;
  /** 命中目标 id (module id 或 history entry id) */
  target: string;
  /** history 项专用: 该条目的恢复数据 */
  data?: Record<string, unknown>;
  /** history 项专用: 目标模块 */
  module?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  modules: { id: string; title: string; desc: string; icon?: ReactNode }[];
  /** 命中模块 → 跳转 */
  onPickModule: (id: string) => void;
  /** 命中历史 → 恢复并跳转 (与 HistoryView 的恢复逻辑同) */
  onPickHistory: (entry: HistoryEntry) => void;
}

// 简单模糊评分: 优先全词包含, 然后子序列匹配。返回得分或 -1 (不匹配)。
function fuzzyScore(q: string, text: string): number {
  if (!q) return 0;
  const ql = q.toLowerCase();
  const tl = text.toLowerCase();
  if (tl === ql) return 1000;
  if (tl.startsWith(ql)) return 500;
  const idx = tl.indexOf(ql);
  if (idx >= 0) return 200 - idx;
  // 子序列
  let ti = 0;
  let qi = 0;
  while (qi < ql.length && ti < tl.length) {
    if (ql[qi] === tl[ti]) qi++;
    ti++;
  }
  return qi === ql.length ? 50 : -1;
}

export default function CommandPalette({
  open,
  onClose,
  modules,
  onPickModule,
  onPickHistory,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 重置 query, focus input
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // 计算候选项
  const items = useMemo<CommandItem[]>(() => {
    if (!open) return [];
    const moduleItems: CommandItem[] = modules.map((m) => ({
      id: `mod-${m.id}`,
      kind: "module",
      title: m.title,
      desc: m.desc,
      icon: m.icon,
      target: m.id,
    }));
    const history = getHistory().slice(0, 30);
    const histItems: CommandItem[] = history.map((h) => ({
      id: `his-${h.id}`,
      kind: "history",
      title: h.title,
      desc: `${h.module} · ${new Date(h.time).toLocaleString()}`,
      target: h.id,
      data: h.data,
      module: h.module,
    }));
    const all = [...moduleItems, ...histItems];
    if (!query.trim()) return all.slice(0, 20);
    return all
      .map((it) => ({ it, score: Math.max(fuzzyScore(query, it.title), fuzzyScore(query, it.desc || "")) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((x) => x.it);
  }, [open, modules, query]);

  // 高亮跟随键盘
  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  const pick = (item: CommandItem) => {
    if (item.kind === "module") {
      onPickModule(item.target);
    } else {
      // 调用者把 entry 找回来传过去 (简化: 直接调 onPickHistory)
      const entry: HistoryEntry = {
        id: item.target,
        module: item.module || "",
        icon: "",
        title: item.title,
        time: 0,
        data: item.data || {},
      };
      onPickHistory(entry);
    }
    onClose();
  };

  // 键盘
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(items.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = items[activeIdx];
        if (it) pick(it);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, activeIdx]);

  if (!open) return null;

  return (
    <div className="cmdk-overlay" data-testid="command-palette" onClick={onClose}>
      <div className="cmdk-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          data-testid="cmdk-input"
          placeholder="搜索模块 或 历史记录…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="cmdk-results" ref={listRef}>
          {items.length === 0 ? (
            <div className="cmdk-empty">没有匹配项</div>
          ) : (
            <>
              {items.map((it, idx) => (
                <div
                  key={it.id}
                  className={`cmdk-item ${idx === activeIdx ? "active" : ""}`}
                  data-testid={`cmdk-item-${it.id}`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => pick(it)}
                >
                  {it.icon && <span className="cmdk-item-icon">{it.icon}</span>}
                  <span className="cmdk-item-title">{it.title}</span>
                  <span className="cmdk-item-desc">{it.desc}</span>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="cmdk-foot">
          <span>↑↓ 选择</span>
          <span>Enter 跳转</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}

/** 帮 App.tsx 完成"恢复历史并跳转"的逻辑 (与 HistoryView 一致) */
export function restoreHistoryEntry(entry: HistoryEntry, setActive: (m: string) => void): void {
  if (!entry.data) return;
  for (const [k, v] of Object.entries(entry.data)) writePersisted(k, v);
  if (entry.module) setActive(entry.module);
}
