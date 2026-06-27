// 本地历史记录: 保存每次生成的结果, 供回看/恢复到对应模块。
export interface HistoryEntry {
  id: string;
  module: string; // idea | plan | analyze | imrad | journal | format | checklist | rebuttal
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
  // localStorage 配额有限(分析结果含 base64 图, 单条可能很大)。写入失败时不要静默丢掉
  // 这条新记录, 而是逐步淘汰最旧的记录后重试, 保证最新结果总能存下。
  let trimmed = list.slice(0, CAP);
  while (trimmed.length > 0) {
    try {
      localStorage.setItem(KEY, JSON.stringify(trimmed));
      return;
    } catch {
      if (trimmed.length === 1) return; // 连最新一条都放不下: 放弃, 不影响使用
      trimmed = trimmed.slice(0, Math.ceil(trimmed.length / 2)); // 保留较新的一半(含最新)
    }
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
