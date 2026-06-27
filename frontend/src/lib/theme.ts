import { useEffect } from "react";
import { usePersistentState } from "./usePersistentState";

export type ThemeId = "editorial" | "clinical" | "midnight";

export const THEMES: { id: ThemeId; name: string; swatch: [string, string] }[] = [
  { id: "editorial", name: "Editorial", swatch: ["#0e3a39", "#fafbfb"] },
  { id: "clinical",  name: "Clinical",  swatch: ["#1e3a8a", "#f4f6f9"] },
  { id: "midnight",  name: "Midnight",  swatch: ["#0a1212", "#0d1817"] },
];

export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const [theme, setTheme] = usePersistentState<ThemeId>("theme", "editorial");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return [theme, setTheme];
}
