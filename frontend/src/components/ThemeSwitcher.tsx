import { THEMES, useTheme, type ThemeId } from "../lib/theme";

export default function ThemeSwitcher() {
  const [current, setTheme] = useTheme();
  return (
    <div className="theme-switcher" role="radiogroup" aria-label="主题切换">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={current === t.id}
          className={`theme-seg ${current === t.id ? "active" : ""}`}
          onClick={() => setTheme(t.id as ThemeId)}
          data-testid={`theme-${t.id}`}
          title={t.name}
        >
          <span className="theme-preview" aria-hidden="true">
            <span style={{ background: t.swatch[0] }} />
            <span style={{ background: t.swatch[1] }} />
          </span>
          <span className="theme-name">{t.name}</span>
        </button>
      ))}
    </div>
  );
}
