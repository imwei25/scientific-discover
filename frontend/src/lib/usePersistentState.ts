import { useEffect, useState } from "react";

// 直接写入持久化存储(供跨模块传递数据时, 预填目标模块的字段)。
export function writePersisted(key: string, value: unknown): void {
  try {
    localStorage.setItem(`ra:${key}`, JSON.stringify(value));
  } catch {
    /* 忽略写入失败 */
  }
}

// 读取另一模块已持久化的值(用于跨模块导入已有成果)。读不到/解析失败返回 fallback。
export function readPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`ra:${key}`);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// 与 useState 用法一致, 但自动把值同步到 localStorage,
// 用于在切换模块/重开浏览器后保留用户的输入与结果。
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const storageKey = `ra:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* 忽略写入失败(如隐私模式) */
    }
  }, [storageKey, value]);

  return [value, setValue];
}
