import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { apiUrl } from "./api";

// ── 类型 ───────────────────────────────────────────────────
export interface ProjectMeta {
  id: string;
  name: string;
  updated_at: number;
}

export interface ProjectFull extends ProjectMeta {
  created_at: number;
  state: Record<string, string>;     // 值是已 JSON.stringify 的字符串(对应 localStorage 原始值)
  history: unknown[];
}

export type SyncStatus = "idle" | "saving" | "error";

// ── 不被项目切换覆盖的全局 UI 偏好键 (含 ra: 前缀) ─────────
export const UI_PREF_KEYS: ReadonlySet<string> = new Set([
  "ra:theme",
  "ra:sidebar",
  "ra:ui:disclaimerDismissed",
]);
const HISTORY_KEY = "ra:history";

const STATE_CHANGED_EVENT = "ra:state-changed";
const DEBOUNCE_MS = 1000;
const RETRY_DELAYS_MS = [1000, 3000, 10000];

// ── UUID v4 (浏览器 crypto 优先) ────────────────────────────
export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  (typeof crypto !== "undefined" ? crypto : { getRandomValues: (b: Uint8Array) => { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); return b; } }).getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── API 客户端 ──────────────────────────────────────────────
async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(apiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  if (r.status === 204) return undefined as unknown as T;
  return (await r.json()) as T;
}

export const api = {
  list: () => http<ProjectMeta[]>("/api/projects"),
  get: (id: string) => http<ProjectFull>(`/api/projects/${id}`),
  create: (id: string, name: string) => http<ProjectFull>("/api/projects", { method: "POST", body: JSON.stringify({ id, name }) }),
  updateState: (id: string, state: Record<string, string>, history: unknown[]) =>
    http<{ updated_at: number }>(`/api/projects/${id}/state`, { method: "PUT", body: JSON.stringify({ state, history }) }),
  rename: (id: string, name: string) => http<ProjectMeta>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  remove: (id: string) => http<void>(`/api/projects/${id}`, { method: "DELETE" }),
};

// ── localStorage 工具 ──────────────────────────────────────
/** 收集所有"项目状态"键(ra:* 但排除 UI 偏好与 history)。 */
function collectStateKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (!k.startsWith("ra:")) continue;
    if (UI_PREF_KEYS.has(k)) continue;
    if (k === HISTORY_KEY) continue;
    out.push(k);
  }
  return out;
}

/** 把当前 localStorage 中的项目状态 dump 成 {key (无 ra: 前缀): value} 的字典。 */
function dumpStateFromLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const fullKey of collectStateKeys()) {
    const v = localStorage.getItem(fullKey);
    if (v !== null) out[fullKey.slice(3)] = v;
  }
  return out;
}

/** 读 ra:history → 数组(失败返回 [])。 */
function dumpHistoryFromLocalStorage(): unknown[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as unknown[]) : [];
  } catch {
    return [];
  }
}

/** 清空所有项目状态键(保留 UI 偏好), 然后写入新项目的 state + history。 */
function replaceLocalStorage(state: Record<string, string>, history: unknown[]): void {
  for (const k of collectStateKeys()) localStorage.removeItem(k);
  localStorage.removeItem(HISTORY_KEY);
  for (const [k, v] of Object.entries(state)) {
    localStorage.setItem(`ra:${k}`, v);
  }
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* 配额溢出忽略 */
  }
}

// ── Context ────────────────────────────────────────────────
export interface ProjectContextValue {
  projects: ProjectMeta[];
  current: ProjectMeta | null;
  syncStatus: SyncStatus;
  offline: boolean;
  switchTo: (id: string) => Promise<void>;
  create: (name: string) => Promise<ProjectMeta>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  flushNow: () => Promise<void>;
}

const ProjectCtx = createContext<ProjectContextValue | null>(null);

export function useProjects(): ProjectContextValue {
  const v = useContext(ProjectCtx);
  if (!v) throw new Error("useProjects must be used inside <ProjectProvider>");
  return v;
}

// ── Provider ───────────────────────────────────────────────
export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [current, setCurrent] = useState<ProjectMeta | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [offline, setOffline] = useState(false);
  const [booted, setBooted] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const suppressEventsRef = useRef(false);  // 切项目期间忽略事件, 防止刚写入又被同步

  // 同步 currentIdRef
  useEffect(() => {
    currentIdRef.current = current?.id ?? null;
  }, [current]);

  const refreshList = useCallback(async () => {
    const list = await api.list();
    setProjects(list);
    return list;
  }, []);

  // 把当前 localStorage 状态推到后端(防抖触发或显式 flush)
  const flushNow = useCallback(async (): Promise<void> => {
    const id = currentIdRef.current;
    if (!id) return;
    if (inflightRef.current) {
      await inflightRef.current;
    }
    const state = dumpStateFromLocalStorage();
    const history = dumpHistoryFromLocalStorage();

    const attempt = async (i: number): Promise<void> => {
      try {
        setSyncStatus("saving");
        await api.updateState(id, state, history);
        setSyncStatus("idle");
        setOffline(false);
        // 列表里这个项目的 updated_at 改了, 顺便刷一下
        refreshList().catch(() => {});
      } catch (e) {
        if (i < RETRY_DELAYS_MS.length) {
          await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[i]));
          return attempt(i + 1);
        }
        setSyncStatus("error");
      }
    };

    inflightRef.current = attempt(0);
    try {
      await inflightRef.current;
    } finally {
      inflightRef.current = null;
    }
  }, [refreshList]);

  const scheduleFlush = useCallback(() => {
    if (suppressEventsRef.current) return;
    if (!currentIdRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      flushNow().catch(() => {});
    }, DEBOUNCE_MS);
  }, [flushNow]);

  // 监听 ra:state-changed
  useEffect(() => {
    const onChange = () => scheduleFlush();
    window.addEventListener(STATE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(STATE_CHANGED_EVENT, onChange);
  }, [scheduleFlush]);

  // 切项目
  const switchTo = useCallback(async (id: string) => {
    suppressEventsRef.current = true;
    try {
      // 1. flush 当前
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (currentIdRef.current && currentIdRef.current !== id) {
        await flushNow();
      }
      // 2. 拉目标
      const target = await api.get(id);
      // 3. 替换 localStorage
      replaceLocalStorage(target.state, target.history);
      // 4. 更新 context
      setCurrent({ id: target.id, name: target.name, updated_at: target.updated_at });
      await refreshList();
    } finally {
      // 允许下一帧后再放开事件(避免 React 重挂载触发的 setItem 立即又同步)
      setTimeout(() => { suppressEventsRef.current = false; }, 50);
    }
  }, [flushNow, refreshList]);

  const create = useCallback(async (name: string): Promise<ProjectMeta> => {
    const id = newId();
    const trimmed = (name || "").trim() || "未命名项目";
    const p = await api.create(id, trimmed);
    await refreshList();
    await switchTo(p.id);
    return { id: p.id, name: p.name, updated_at: p.updated_at };
  }, [refreshList, switchTo]);

  const rename = useCallback(async (id: string, name: string) => {
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    await api.rename(id, trimmed);
    await refreshList();
    if (currentIdRef.current === id) {
      setCurrent((c) => (c ? { ...c, name: trimmed } : c));
    }
  }, [refreshList]);

  const remove = useCallback(async (id: string) => {
    await api.remove(id);
    let list = await refreshList();
    if (currentIdRef.current === id) {
      if (list.length === 0) {
        await create("未命名项目");
        return;
      }
      await switchTo(list[0].id);
    }
  }, [create, refreshList, switchTo]);

  // ── 启动: 列表 → (有就选最新) (没有就迁移老 ra:* 或建默认) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.list();
        if (cancelled) return;
        if (list.length > 0) {
          setProjects(list);
          await switchTo(list[0].id);
        } else {
          // 检测老 localStorage 数据
          const legacyState = dumpStateFromLocalStorage();
          const legacyHistory = dumpHistoryFromLocalStorage();
          const hasLegacy = Object.keys(legacyState).length > 0 || legacyHistory.length > 0;
          const id = newId();
          const name = hasLegacy ? "默认项目" : "未命名项目";
          const created = await api.create(id, name);
          if (hasLegacy) {
            try {
              await api.updateState(id, legacyState, legacyHistory);
            } catch {
              /* 即使迁移 state 失败, 项目本身已存在, 用户也不会丢 localStorage */
            }
          }
          await refreshList();
          setCurrent({ id: created.id, name: created.name, updated_at: created.updated_at });
        }
        setOffline(false);
      } catch {
        setOffline(true);
      } finally {
        if (!cancelled) setBooted(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<ProjectContextValue>(() => ({
    projects,
    current,
    syncStatus,
    offline,
    switchTo,
    create,
    rename,
    remove,
    flushNow,
  }), [projects, current, syncStatus, offline, switchTo, create, rename, remove, flushNow]);

  // booted 之前不渲染子树, 避免模块用空状态闪一下
  if (!booted) return null;
  return <ProjectCtx.Provider value={value}>{children}</ProjectCtx.Provider>;
}
