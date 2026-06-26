import { useEffect, useState } from "react";

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
