import { useEffect, useRef, useState, useCallback } from "react";
import { usePersistentState } from "./usePersistentState";

export type SidebarMode = "expanded" | "collapsed";

interface SidebarApi {
  mode: SidebarMode;
  peeking: boolean;
  /** 实际渲染态：expanded | collapsed | peeking */
  state: "expanded" | "collapsed" | "peeking";
  toggle: () => void;
  /** hover 进入：仅 collapsed 下生效，启动 peeking */
  onPeekEnter: () => void;
  /** hover 离开：200ms 后回收 peeking */
  onPeekLeave: () => void;
}

const PEEK_DELAY_MS = 200;

// 侧栏状态机：持久化的 expanded/collapsed + 内存中的 peeking。
// 折叠时 hover 整条 24px 触发临时展开；点击锁定按钮在两种持久化状态之间切换。
export function useSidebar(): SidebarApi {
  const [mode, setMode] = usePersistentState<SidebarMode>("sidebar", "expanded");
  const [peeking, setPeeking] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const toggle = useCallback(() => {
    clearTimer();
    setPeeking(false);
    setMode((prev) => (prev === "expanded" ? "collapsed" : "expanded"));
  }, [setMode]);

  const onPeekEnter = useCallback(() => {
    if (mode !== "collapsed") return;
    clearTimer();
    setPeeking(true);
  }, [mode]);

  const onPeekLeave = useCallback(() => {
    if (mode !== "collapsed") return;
    clearTimer();
    leaveTimer.current = setTimeout(() => setPeeking(false), PEEK_DELAY_MS);
  }, [mode]);

  useEffect(() => () => clearTimer(), []);

  const state: SidebarApi["state"] = mode === "expanded" ? "expanded" : peeking ? "peeking" : "collapsed";

  return { mode, peeking, state, toggle, onPeekEnter, onPeekLeave };
}
