import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 右半屏「画布」机制：App 提供一个 Portal 目标节点(右画布容器),
// 各产出模块用 <CanvasSlot> 把自己的最终产出面板送进去渲染。
// 目标缺失时(非分屏模块 / 首帧未挂载)原地降级渲染, 不丢内容。
const CanvasTargetContext = createContext<HTMLElement | null>(null);

export function CanvasProvider({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
  return <CanvasTargetContext.Provider value={target}>{children}</CanvasTargetContext.Provider>;
}

// 把 children 投送到右画布; 没有画布目标时原地渲染。
export function CanvasSlot({ children }: { children: ReactNode }) {
  const target = useContext(CanvasTargetContext);
  if (!target) return <>{children}</>;
  return createPortal(children, target);
}
