// W2-4-a 字体可调: 3 档下拉, 写 html[data-font-size], CSS 变量驱动全局字号。
import { useEffect } from "react";
import { usePersistentState } from "../lib/usePersistentState";

export type FontSize = "normal" | "large" | "xlarge";

const OPTIONS: { id: FontSize; label: string }[] = [
  { id: "normal", label: "标准 15px" },
  { id: "large", label: "大 17px" },
  { id: "xlarge", label: "特大 19px" },
];

export function useFontSize(): [FontSize, (s: FontSize) => void] {
  const [size, setSize] = usePersistentState<FontSize>("ui:fontSize", "normal");
  useEffect(() => {
    document.documentElement.dataset.fontSize = size;
  }, [size]);
  return [size, setSize];
}

export default function FontSizeSwitcher() {
  const [size, setSize] = useFontSize();
  return (
    <div className="font-size-switcher" data-testid="font-size-switcher">
      <label htmlFor="fs-select" className="font-size-label" aria-label="字号">
        字号
      </label>
      <select
        id="fs-select"
        value={size}
        onChange={(e) => setSize(e.target.value as FontSize)}
        className="font-size-select"
        data-testid="font-size-select"
      >
        {OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
