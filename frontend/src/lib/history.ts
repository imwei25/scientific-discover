// 本地历史记录: 保存每次生成的结果, 供回看/恢复到对应模块。
export interface HistoryEntry {
  id: string;
  module: string; // idea | plan | analyze | format
  icon: string;
  title: string;
  time: number;
  data: Record<string, unknown>; // 要恢复到目标模块的持久化字段
}

const KEY = "ra:history";
const CAP = 30;

export function getHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function addHistory(e: Omit<HistoryEntry, "id" | "time">): void {
  const list = getHistory();
  const entry: HistoryEntry = {
    ...e,
    id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    time: Date.now(),
  };
  list.unshift(entry);
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, CAP)));
  } catch {
    /* 忽略(超额等) */
  }
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function formatTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
