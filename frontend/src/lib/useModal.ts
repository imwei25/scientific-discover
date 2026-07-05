import { useEffect, useRef } from "react";

// 通用模态框 a11y hook: Esc 关闭 + focus 陷阱 + focus 还原.
// 三件套本来在 HelpModal 里就有, 这里抽公用, 供 DeidentifyDialog / CommandPalette 等复用.
//
// 用法:
//   const containerRef = useRef<HTMLDivElement>(null);
//   useModal(open, onClose, containerRef);
//   return <div ref={containerRef} role="dialog" aria-modal="true">...</div>
//
// open: 是否显示 (为 false 时不挂 listener)
// onClose: Esc 或 backdrop 触发关闭时调用
// containerRef: 模态框根元素 ref; 用于 focus 陷阱与 focus 还原
export function useModal(
  open: boolean,
  onClose: () => void,
  containerRef: React.RefObject<HTMLElement>,
): void {
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // 记住打开前的 focus, 关闭时还原
    previousFocus.current = document.activeElement as HTMLElement | null;

    // 打开时聚焦模态框第一个可 focus 元素
    const first = containerRef.current?.querySelector<HTMLElement>(
      "input, textarea, button, [href], [tabindex]:not([tabindex='-1'])",
    );
    if (first) first.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && containerRef.current) {
        // 焦点陷阱: 在模态内循环
        const focusables = Array.from(
          containerRef.current.querySelectorAll<HTMLElement>(
            "input, textarea, button, [href], [tabindex]:not([tabindex='-1'])",
          ),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const idx = focusables.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && idx <= 0) {
          e.preventDefault();
          focusables[focusables.length - 1].focus();
        } else if (!e.shiftKey && idx === focusables.length - 1) {
          e.preventDefault();
          focusables[0].focus();
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // 关闭时还原 focus
      previousFocus.current?.focus?.();
    };
  }, [open, onClose, containerRef]);
}
