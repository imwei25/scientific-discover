# 前端打磨 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有"医学期刊气质"前端按 spec 推到 Editorial / Clinical / Midnight 三主题、苹果级动效、编辑级留白、可折叠侧栏的完成度。

**Architecture:** 全部走 CSS variables + data-attribute 切换。`:root` 写 Editorial（默认），`[data-theme="..."]` 覆盖；侧栏宽度由 JS 控制 `--sidebar-w`。两个新 hook 管 `theme` 和 `sidebar` 状态，持久化复用现有 `usePersistentState`。

**Tech Stack:** React 18 + 纯 CSS（不引入 framer-motion 等任何动效库）+ 自托管字体（Inter + Noto Serif SC）。

**Spec:** `docs/superpowers/specs/2026-06-27-frontend-polish-design.md`

**约定：**
- 工作目录：`C:/Users/Administrator/Desktop/scientific-discover/`
- 所有 npm 命令在 `frontend/` 下运行
- 每个 Task 末尾必须跑 `npx playwright test` 和 `npm run build`，全过才能 commit
- commit 用 `git -c user.name="imwei25" -c user.email="guweihuawei@gmail.com" commit ...`（仓库未设 author，必须显式带）
- commit 消息末尾追加 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

---

## File Structure

### 新建

- `frontend/public/fonts/Inter-Variable.woff2` — Inter 可变字体（Latin 子集）
- `frontend/public/fonts/NotoSerifSC-Bold.woff2` — Noto Serif SC 700（chinese-simplified 子集）
- `frontend/src/lib/theme.ts` — `useTheme` hook：读写 `ui:theme`、写 `documentElement.dataset.theme`
- `frontend/src/lib/sidebar.ts` — `useSidebar` hook：状态机 `expanded | collapsed | peeking`
- `frontend/src/components/ThemeSwitcher.tsx` — 主题切换器组件

### 修改

- `frontend/src/styles.css` — 大改：tokens / 3 主题 / 折叠侧栏 / 页面过渡 / 全部组件类
- `frontend/src/App.tsx` — 中改：sidebar hook、theme init、模块切换 key 动画、ThemeSwitcher 渲染
- `frontend/src/components/ResultPanel.tsx` — 小改：流式段落淡入 wrapper、cursor 类换名
- `frontend/src/components/Dropzone.tsx` — 小改：成功后 600ms success pulse 类
- `frontend/src/components/Markdown.tsx` — 小改：包一层 `markdown` div 已有，无 tsx 变更（CSS 内调）
- `frontend/src/modules/HistoryView.tsx` — 小改：list item stagger + 删除前 exit 动画
- `frontend/index.html` — 加 `<link rel="preload" as="font">` 预加载

### 不动

- `frontend/src/lib/api.ts` / `extract.ts` / `history.ts` / `sse.ts` / `useStream.ts` / `clipboard.ts` / `download.ts`
- `frontend/src/modules/IdeaModule.tsx` / `PlanModule.tsx` / `AnalyzeModule.tsx` / `FormatModule.tsx`
- `package.json`（不加新 npm 依赖）
- 后端 / Tauri / scripts

---

## Task 1: Foundation — Tokens + 字体 + 主题切换基础设施

**Files:**
- Create: `frontend/public/fonts/Inter-Variable.woff2`
- Create: `frontend/public/fonts/NotoSerifSC-Bold.woff2`
- Modify: `frontend/index.html`
- Modify: `frontend/src/styles.css:1-35`（替换 `:root` 整段）

### Step 1.1 · 下载 Inter Variable

- [ ] **下载 Inter Variable（Latin 子集，约 70KB）**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
mkdir -p public/fonts
curl -L "https://gwfh.mranftl.com/api/fonts/inter?download=zip&subsets=latin&variants=regular,500,600,700&formats=woff2" -o /tmp/inter.zip
# 解压并合并到一个 woff2 文件（gwfh 默认提供分权重 woff2，挑 700 当 variable 替身）
# 简化方案：保留 4 个 woff2 而不是 variable，体积更小
unzip -o /tmp/inter.zip -d /tmp/inter
ls /tmp/inter/*.woff2
# 拷贝最常用的 4 个权重
cp /tmp/inter/inter-v*-latin-regular.woff2 public/fonts/Inter-Regular.woff2
cp /tmp/inter/inter-v*-latin-500.woff2 public/fonts/Inter-Medium.woff2
cp /tmp/inter/inter-v*-latin-600.woff2 public/fonts/Inter-SemiBold.woff2
cp /tmp/inter/inter-v*-latin-700.woff2 public/fonts/Inter-Bold.woff2
ls -lh public/fonts/Inter-*.woff2
```

Expected: 4 个 woff2 文件，每个约 15-25KB，总计 < 100KB。

### Step 1.2 · 下载 Noto Serif SC Bold（中文衬线，约 500KB）

- [ ] **下载 Noto Serif SC 700（chinese-simplified 子集）**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
curl -L "https://gwfh.mranftl.com/api/fonts/noto-serif-sc?download=zip&subsets=chinese-simplified&variants=700&formats=woff2" -o /tmp/serif-sc.zip
unzip -o /tmp/serif-sc.zip -d /tmp/serif-sc
cp /tmp/serif-sc/noto-serif-sc-v*-chinese-simplified-700.woff2 public/fonts/NotoSerifSC-Bold.woff2
ls -lh public/fonts/NotoSerifSC-Bold.woff2
```

Expected: `NotoSerifSC-Bold.woff2`，大小 350-550KB。

### Step 1.3 · index.html 预加载字体

- [ ] **改 `frontend/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>科研助手</title>
    <link rel="preload" href="/fonts/Inter-Regular.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="/fonts/Inter-SemiBold.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="/fonts/NotoSerifSC-Bold.woff2" as="font" type="font/woff2" crossorigin />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### Step 1.4 · 重写 styles.css 顶部 tokens 与 @font-face

- [ ] **替换 `frontend/src/styles.css` 第 1-35 行（整个 `:root` 块 + 在它之前加 @font-face）**

替换为：

```css
/* ── @font-face ───────────────────────────────────────────────── */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/Inter-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/Inter-Medium.woff2') format('woff2');
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('/fonts/Inter-SemiBold.woff2') format('woff2');
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/Inter-Bold.woff2') format('woff2');
}
@font-face {
  font-family: 'Noto Serif SC';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/NotoSerifSC-Bold.woff2') format('woff2');
}

/* ── Design Tokens (Editorial default) ────────────────────────── */
:root {
  /* 颜色 */
  --paper: #eef2f1;
  --paper-warm: #fafbfb;
  --surface: #ffffff;
  --surface-2: #f7faf9;
  --petrol: #0e3a39;
  --petrol-700: #0a2b2a;
  --teal: #0f9b94;
  --teal-soft: #e2f1ee;
  --ink: #14201f;
  --muted: #5c6b69;
  --faint: #93a09d;
  --line: #dce5e3;
  --line-soft: #e8eeec;
  --ok: #15885f;
  --ok-soft: #e6f4ee;
  --bad: #c8453a;
  --warn: #9a6a00;

  /* 字体 */
  --sans: 'Inter', 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', system-ui, -apple-system, sans-serif;
  --serif: 'Noto Serif SC', Georgia, 'Songti SC', 'SimSun', serif;
  --mono: 'JetBrains Mono', 'SFMono-Regular', 'Consolas', 'Menlo', monospace;

  /* 字号阶梯 */
  --fs-display: 36px;
  --fs-h1: 28px;
  --fs-h2: 20px;
  --fs-h3: 17px;
  --fs-body: 15px;
  --fs-small: 13px;
  --fs-eyebrow: 11.5px;

  /* 间距 */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 20px;
  --sp-5: 32px;
  --sp-6: 48px;
  --sp-7: 72px;
  --sp-8: 96px;

  /* 圆角 + 阴影 */
  --radius-sm: 10px;
  --radius: 14px;
  --radius-lg: 18px;
  --shadow-sm: 0 1px 2px rgba(14, 58, 57, 0.04), 0 1px 3px rgba(14, 58, 57, 0.05);
  --shadow: 0 2px 8px rgba(14, 58, 57, 0.05), 0 14px 34px rgba(14, 58, 57, 0.07);
  --shadow-lg: 0 4px 18px rgba(14, 58, 57, 0.08), 0 28px 56px rgba(14, 58, 57, 0.1);

  /* 动效 */
  --spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-out-soft: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 150ms;
  --dur-base: 280ms;
  --dur-slow: 480ms;

  /* 侧栏宽度（由 sidebar hook 控制） */
  --sidebar-w: 272px;
}
```

### Step 1.5 · body 全局过渡（为后续主题切换准备）

- [ ] **改 `frontend/src/styles.css` 中 `body{...}` 那段（约第 46-54 行），加 transition**

找到：

```css
body {
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
```

替换为：

```css
body {
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--fs-body);
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  font-variant-numeric: tabular-nums;
  transition: background-color var(--dur-base) var(--ease-out-soft),
              color var(--dur-base) var(--ease-out-soft);
}
```

### Step 1.6 · 验收 Task 1

- [ ] **跑 dev server + 现有测试，确保字体加载 + 没破回归**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npm run build
npx playwright test --reporter=line
```

Expected:
- `npm run build` 成功（tsc 通过 + vite 产出 dist）
- 全部 e2e 测试通过（19 个 test）
- `dist/assets/` 应包含字体 hash 引用

如果 build 报 tsc 错误 → 检查改了什么；如果 e2e 失败 → 看具体失败的 testid 是否被破坏。

### Step 1.7 · 提交 Task 1

- [ ] **commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/public/fonts/ frontend/index.html frontend/src/styles.css
git -c user.name="imwei25" -c user.email="guweihuawei@gmail.com" commit -m "$(cat <<'EOF'
改进(前端): T1 基础 - 引入 Inter+Noto Serif SC + 新 design tokens

- 自托管字体到 public/fonts/（不依赖 CDN，Tauri 离线友好）
- styles.css :root 重写：颜色/字体/间距/阴影/动效全套 token
- body 加全局 transition 为主题切换打底
- index.html preload 关键字体

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 侧栏状态机 + 折叠 UI

**Files:**
- Create: `frontend/src/lib/sidebar.ts`
- Modify: `frontend/src/App.tsx`（导入 hook、用状态控制 sidebar、加折叠态/peek 触发）
- Modify: `frontend/src/styles.css`（`.sidebar` / `.brand` / `.nav` 部分重写，加 24px 折叠态）

### Step 2.1 · 创建 sidebar hook

- [ ] **创建 `frontend/src/lib/sidebar.ts`**

```typescript
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
    setMode(mode === "expanded" ? "collapsed" : "expanded");
  }, [mode, setMode]);

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
```

### Step 2.2 · 改 App.tsx 接入 sidebar hook

- [ ] **改 `frontend/src/App.tsx`**

在文件顶部导入加：

```typescript
import { useSidebar } from "./lib/sidebar";
```

在 `App()` 顶部加：

```typescript
const sidebar = useSidebar();
```

把现有 `<aside className="sidebar">` 行（约 77 行）替换为：

```tsx
<aside
  className="sidebar"
  data-state={sidebar.state}
  onMouseEnter={sidebar.onPeekEnter}
  onMouseLeave={sidebar.onPeekLeave}
>
```

在 `<div className="brand" ...>` 上方插入折叠按钮（展开态显示 «，折叠态没有内容这里）：

找到：

```tsx
<div className="brand" onClick={() => setActive("home")} data-testid="brand">
  <span className="brand-logo">🔬</span>
  <span className="brand-name">科研助手</span>
</div>
```

替换为：

```tsx
<div className="brand-row">
  <div className="brand" onClick={() => setActive("home")} data-testid="brand">
    <span className="brand-logo">🔬</span>
    <span className="brand-name">科研助手</span>
  </div>
  <button
    className="sidebar-toggle"
    onClick={sidebar.toggle}
    data-testid="sidebar-toggle"
    aria-label={sidebar.mode === "expanded" ? "收起侧栏" : "展开侧栏"}
  >
    {sidebar.mode === "expanded" ? "«" : "»"}
  </button>
</div>
```

在 `<aside>` 内的最后（紧贴 `</aside>` 之前），加折叠态指示器（仅在 collapsed/peeking 下用 CSS 控制可见性）：

找到 `</aside>` 之前位置，在 `.sidebar-foot` 之后追加：

```tsx
{/* 折叠态指示条：24px 内的 ticks，用 CSS 在 expanded 下隐藏 */}
<div className="rail-ticks" aria-hidden="true">
  <span className={`rail-tick ${active === "idea" ? "active" : ""}`} />
  <span className={`rail-tick ${active === "plan" ? "active" : ""}`} />
  <span className={`rail-tick ${active === "analyze" ? "active" : ""}`} />
  <span className={`rail-tick ${active === "format" ? "active" : ""}`} />
</div>
```

### Step 2.3 · 改 styles.css：sidebar 重做含折叠态

- [ ] **改 `frontend/src/styles.css`**：找到 `/* ---------- 侧栏：研究流程管线（签名元素） ---------- */` 注释行到 `.sidebar-foot { ... }` 结尾整段（约第 71-228 行），全部替换为：

```css
/* ---------- 侧栏：研究流程管线 + 折叠态 ---------- */
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  background: linear-gradient(to right, var(--paper-warm), #e9efed);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  padding: var(--sp-5) var(--sp-4);
  transition: width var(--dur-slow) var(--ease-out-soft),
              padding var(--dur-slow) var(--ease-out-soft),
              background-color var(--dur-base) var(--ease-out-soft);
  overflow: hidden;
  position: relative;
}
.sidebar[data-state="expanded"] { --sidebar-w: 272px; }
.sidebar[data-state="peeking"]  { --sidebar-w: 272px; }
.sidebar[data-state="collapsed"] {
  --sidebar-w: 24px;
  padding: var(--sp-4) 0;
}

/* brand 行 */
.brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-6);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  cursor: pointer;
}
.brand-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: var(--petrol);
  color: #fff;
  font-size: 19px;
  flex-shrink: 0;
  transition: transform var(--dur-base) var(--spring);
}
.brand:hover .brand-logo { transform: scale(1.05); }
.brand-name {
  font-family: var(--serif);
  font-size: 19px;
  font-weight: 700;
  color: var(--petrol);
  letter-spacing: 0.5px;
  transition: opacity var(--dur-base) var(--ease-out-soft) var(--dur-fast),
              max-width var(--dur-slow) var(--ease-out-soft);
  white-space: nowrap;
  overflow: hidden;
}
.sidebar[data-state="collapsed"] .brand-name { opacity: 0; max-width: 0; }
.sidebar[data-state="expanded"]  .brand-name,
.sidebar[data-state="peeking"]   .brand-name { opacity: 1; max-width: 200px; }

.sidebar-toggle {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur-fast) var(--ease-out-soft);
  flex-shrink: 0;
}
.sidebar-toggle:hover {
  color: var(--petrol);
  border-color: var(--teal);
  background: var(--teal-soft);
}
.sidebar[data-state="collapsed"] .sidebar-toggle {
  /* 折叠态：把 toggle 藏到 24px 之外（折叠态用 rail-toggle 触发） */
  display: none;
}

/* 折叠态：brand-row 直接隐藏整行（24px 不够放） */
.sidebar[data-state="collapsed"] .brand-row { display: none; }

/* nav */
.nav {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.pipeline {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.pipeline::before {
  content: "";
  position: absolute;
  left: 26px;
  top: 26px;
  bottom: 26px;
  width: 1.5px;
  background: var(--line);
  z-index: 0;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 10px 11px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  color: var(--muted);
  position: relative;
  transition: background var(--dur-fast) var(--ease-out-soft),
              color var(--dur-fast) var(--ease-out-soft),
              transform var(--dur-base) var(--spring);
}
.nav-item:hover {
  background: rgba(15, 155, 148, 0.07);
  transform: translateX(2px);
}
.nav-item.active {
  background: var(--teal-soft);
}
.nav-num {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1.5px solid var(--line);
  background: var(--surface);
  font-family: var(--serif);
  font-size: 13px;
  font-weight: 700;
  color: var(--muted);
  transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
}
.nav-item:hover .nav-num { border-color: var(--teal); color: var(--petrol); }
.nav-item.active .nav-num { background: var(--petrol); border-color: var(--petrol); color: #fff; }
.nav-num.aux {
  border-style: dashed;
  font-family: var(--sans);
  font-size: 15px;
}
.nav-aux { margin-top: 10px; }
.nav-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  transition: opacity var(--dur-base) var(--ease-out-soft) var(--dur-fast);
}
.nav-title {
  font-weight: 600;
  font-size: 14.5px;
  color: var(--ink);
  white-space: nowrap;
}
.nav-item.active .nav-title { color: var(--petrol); }
.nav-desc {
  font-size: 11.5px;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 折叠态：隐藏 nav 文本 */
.sidebar[data-state="collapsed"] .nav-text { opacity: 0; }
/* 折叠态：把整个 pipeline 也隐藏，让 rail-ticks 接管 */
.sidebar[data-state="collapsed"] .pipeline,
.sidebar[data-state="collapsed"] .nav-aux,
.sidebar[data-state="collapsed"] .sidebar-foot { display: none; }

/* sidebar-foot */
.sidebar-foot {
  padding: var(--sp-3) var(--sp-2) 2px;
  font-size: 12.5px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: var(--sp-3);
}
.status-ok { color: var(--ok); }
.status-bad { color: var(--bad); }
.status-wait { color: var(--faint); }
.status-warn {
  display: block;
  margin-top: 4px;
  color: var(--warn);
  font-size: 12px;
}
.status-balance {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}

/* 折叠态 rail-ticks 指示器 */
.rail-ticks {
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  margin-top: 28px;
}
.sidebar[data-state="collapsed"] .rail-ticks { display: flex; }
.rail-tick {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #bccac6;
  transition: background var(--dur-fast), box-shadow var(--dur-fast);
}
.rail-tick.active {
  background: var(--teal);
  box-shadow: 0 0 0 3px rgba(15, 155, 148, 0.18);
}
```

### Step 2.4 · 折叠态加唤起手柄（24px 内点击展开）

折叠态用户需要一个方式锁定展开。最简方案：让整个折叠侧栏点击 = 展开。

- [ ] **改 `frontend/src/App.tsx`**：在 `<aside ... >` 行的属性中加 `onClick`（仅在 collapsed 时触发）：

```tsx
<aside
  className="sidebar"
  data-state={sidebar.state}
  onMouseEnter={sidebar.onPeekEnter}
  onMouseLeave={sidebar.onPeekLeave}
  onClick={(e) => {
    // 折叠态：点击空白（非 nav-item / sidebar-toggle）= 展开
    if (sidebar.mode === "collapsed") {
      const t = e.target as HTMLElement;
      if (!t.closest(".nav-item") && !t.closest(".sidebar-toggle")) {
        sidebar.toggle();
      }
    }
  }}
>
```

折叠态下侧栏整条变成可点击的"展开按钮"，让用户操作简单。

### Step 2.5 · 验收 Task 2

- [ ] **手动 + 测试**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npm run build
npx playwright test --reporter=line
```

Expected:
- Build 通过
- 全部 19 个 e2e 通过（侧栏 DOM 多了 `brand-row`、`sidebar-toggle`、`rail-ticks`，但 `data-testid="brand"` 仍存在）

启动 dev：
```bash
npm run dev
```

人工验：
1. 默认侧栏展开 272px
2. 点击 `«` 收为 24px 发丝条，4 个 tick 显示，当前 active 那个亮 teal
3. 折叠态下 hover 整条 → 280-480ms 内展开为 272px peek 态
4. 鼠标离开 → 200ms 后回到 24px
5. 折叠态点空白 → 锁定展开
6. 刷新页面 → 状态保持

### Step 2.6 · 提交 Task 2

- [ ] **commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/lib/sidebar.ts frontend/src/App.tsx frontend/src/styles.css
git -c user.name="imwei25" -c user.email="guweihuawei@gmail.com" commit -m "$(cat <<'EOF'
改进(前端): T2 折叠侧栏 - 24px 发丝条 + hover peek + 点击锁定

- useSidebar hook：expanded/collapsed 持久化 + peeking 内存态
- 折叠态 24px 显示 4 个 tick 当前进度指示
- hover 整条临时展开（peek），点击空白锁定
- 480ms ease-out-soft 过渡，文字延迟 150ms 淡入避免截断闪烁

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 三主题切换器

**Files:**
- Create: `frontend/src/lib/theme.ts`
- Create: `frontend/src/components/ThemeSwitcher.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`（追加 `[data-theme="clinical"]` 和 `[data-theme="midnight"]` 覆盖块）

### Step 3.1 · 创建 theme hook

- [ ] **创建 `frontend/src/lib/theme.ts`**

```typescript
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
```

### Step 3.2 · 创建 ThemeSwitcher 组件

- [ ] **创建 `frontend/src/components/ThemeSwitcher.tsx`**

```tsx
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
```

### Step 3.3 · App.tsx 渲染 ThemeSwitcher

- [ ] **改 `frontend/src/App.tsx`**

顶部加：

```typescript
import ThemeSwitcher from "./components/ThemeSwitcher";
```

在 `.sidebar-foot` 内（balance 之后、`</div>` 之前）追加：

```tsx
<ThemeSwitcher />
```

完整的 `sidebar-foot` 看起来是：

```tsx
<div className="sidebar-foot">
  {health ? (
    <span className="status-ok" data-testid="status">
      ● 已就绪 · {health.mock ? "演示模式" : health.model}
    </span>
  ) : healthErr ? (
    <span className="status-wait" data-testid="status">○ 正在连接本地服务…请稍候</span>
  ) : (
    <span className="status-wait" data-testid="status">○ 连接中…</span>
  )}
  {health && !health.mock && health.configured === false && (
    <span className="status-warn" data-testid="status-warn">⚠ 未配置密钥，请在 backend/.env 填写</span>
  )}
  {balance?.available && (
    <span className="status-balance" data-testid="balance">
      💰 {balance.provider} 余额 ¥{balance.balance}
    </span>
  )}
  <ThemeSwitcher />
</div>
```

### Step 3.4 · styles.css 加 ThemeSwitcher 样式

- [ ] **改 `frontend/src/styles.css`**：找到 `/* 滚动条 */` 注释之前的位置，插入：

```css
/* ---------- 主题切换器 ---------- */
.theme-switcher {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line-soft);
  display: flex;
  gap: var(--sp-1);
}
.theme-seg {
  flex: 1;
  padding: 6px 4px;
  border: 1.5px solid transparent;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  transition: all var(--dur-fast) var(--ease-out-soft);
}
.theme-seg:hover {
  background: var(--surface-2);
  border-color: var(--line);
}
.theme-seg.active {
  background: var(--teal-soft);
  border-color: var(--teal);
}
.theme-preview {
  display: flex;
  width: 100%;
  height: 14px;
  border-radius: 4px;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(14, 58, 57, 0.06);
}
.theme-preview > span {
  flex: 1;
}
.theme-preview > span:first-child { flex: 0 0 28%; }
.theme-name {
  font-family: var(--serif);
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 0.04em;
}
.theme-seg.active .theme-name { color: var(--petrol); }
```

### Step 3.5 · styles.css 追加 Clinical 主题覆盖

- [ ] **改 `frontend/src/styles.css`**：在文件末尾追加：

```css
/* ============================================================
   主题：Clinical · 临床冷调
   ============================================================ */
[data-theme="clinical"] {
  --paper: #f4f6f9;
  --paper-warm: #ffffff;
  --surface: #ffffff;
  --surface-2: #f8fafc;
  --ink: #0f172a;
  --petrol: #1e3a8a;
  --petrol-700: #1e40af;
  --teal: #0ea5e9;
  --teal-soft: #e0f2fe;
  --muted: #475569;
  --faint: #94a3b8;
  --line: #e2e8f0;
  --line-soft: #eef2f6;
  --ok: #047857;
  --ok-soft: #d1fae5;
  --bad: #be123c;
  --warn: #92400e;
  --serif: 'Inter', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
}

[data-theme="clinical"] .eyebrow {
  font-family: var(--sans);
  font-weight: 600;
}

/* ============================================================
   主题：Midnight · 深夜
   ============================================================ */
[data-theme="midnight"] {
  --paper: #0d1817;
  --paper-warm: #15201f;
  --surface: #15201f;
  --surface-2: #1a2625;
  --ink: #e2eae9;
  --petrol: #7fdfd6;
  --petrol-700: #b5ece5;
  --teal: #16d9c8;
  --teal-soft: rgba(22, 217, 200, 0.12);
  --muted: #8a9a97;
  --faint: #5c6b69;
  --line: #26302f;
  --line-soft: #1f2a28;
  --ok: #34d399;
  --ok-soft: rgba(52, 211, 153, 0.12);
  --bad: #f87171;
  --warn: #fbbf24;
}

[data-theme="midnight"] .sidebar {
  background: linear-gradient(to right, #0a1212, #15201f);
}
[data-theme="midnight"] .rail-tick.active {
  box-shadow: 0 0 0 3px rgba(22, 217, 200, 0.2), 0 0 8px rgba(22, 217, 200, 0.5);
}
[data-theme="midnight"] .brand-logo {
  background: var(--teal-soft);
  color: var(--teal);
}
[data-theme="midnight"] .nav-num {
  background: var(--surface-2);
}
[data-theme="midnight"] .nav-item.active .nav-num {
  box-shadow: 0 0 8px rgba(22, 217, 200, 0.4);
}
[data-theme="midnight"] input,
[data-theme="midnight"] textarea,
[data-theme="midnight"] select {
  background: var(--surface-2);
  color: var(--ink);
}
[data-theme="midnight"] .disclaimer {
  background: rgba(251, 191, 36, 0.08);
  border-color: rgba(251, 191, 36, 0.2);
  border-left-color: var(--warn);
  color: #fbd884;
}
[data-theme="midnight"] .disclaimer-close {
  background: var(--surface-2);
  border-color: rgba(251, 191, 36, 0.3);
  color: #fbd884;
}
```

### Step 3.6 · 验收 Task 3

- [ ] **跑 build + 测试**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npm run build
npx playwright test --reporter=line
```

Expected: 全部 19 个测试通过。

启 dev 人工验：
1. 默认主题 Editorial
2. 点 Clinical → 280ms 内全站颜色平滑过渡到冷蓝
3. 点 Midnight → 深 petrol 底，rail-tick 有 teal 微辉光
4. 刷新页面 → 主题保持

### Step 3.7 · 提交 Task 3

- [ ] **commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/lib/theme.ts frontend/src/components/ThemeSwitcher.tsx frontend/src/App.tsx frontend/src/styles.css
git -c user.name="imwei25" -c user.email="guweihuawei@gmail.com" commit -m "$(cat <<'EOF'
改进(前端): T3 三主题 Editorial/Clinical/Midnight + 切换器

- useTheme hook 持久化 + 写 documentElement.dataset.theme
- ThemeSwitcher 组件放在 sidebar-foot
- styles.css 加 [data-theme="clinical"] 钴蓝冷调
- styles.css 加 [data-theme="midnight"] 深 teal + 微辉光
- 切换走 body transition，280ms ease-out-soft 滑过

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 页面切换过渡 + 首页 stagger

**Files:**
- Modify: `frontend/src/App.tsx`（main 包裹层加 key 触发重 mount + 入场动画）
- Modify: `frontend/src/styles.css`（追加 @keyframes 和动画类）

### Step 4.1 · App.tsx 给 main 加动画 key

- [ ] **改 `frontend/src/App.tsx`**：找到 `<main className="content">` 整段，把内容包到一个 key 切换的 wrapper 里：

把：

```tsx
<main className="content">
  {!disclaimerDismissed && (
    <div className="disclaimer" data-testid="disclaimer">
      ...
    </div>
  )}
  {active === "home" && <Home onPick={setActive} />}
  {active === "idea" && <IdeaModule goto={goto} />}
  {active === "plan" && <PlanModule />}
  {active === "analyze" && <AnalyzeModule goto={goto} />}
  {active === "format" && <FormatModule />}
  {active === "history" && <HistoryView goto={goto} />}
</main>
```

替换为：

```tsx
<main className="content">
  {!disclaimerDismissed && (
    <div className="disclaimer" data-testid="disclaimer">
      <span>
        ⚠ 本工具由 AI 辅助：所有生成内容（数字、引用、结论）请务必<strong>人工核对</strong>后使用；
        按 ICMJE / 期刊规范，论文中应<strong>声明 AI 使用情况</strong>。
      </span>
      <button
        className="disclaimer-close"
        data-testid="disclaimer-close"
        onClick={() => setDisclaimerDismissed(true)}
      >
        我已知晓
      </button>
    </div>
  )}
  <div className="page" key={active}>
    {active === "home" && <Home onPick={setActive} />}
    {active === "idea" && <IdeaModule goto={goto} />}
    {active === "plan" && <PlanModule />}
    {active === "analyze" && <AnalyzeModule goto={goto} />}
    {active === "format" && <FormatModule />}
    {active === "history" && <HistoryView goto={goto} />}
  </div>
</main>
```

注：保留原 disclaimer 块的完整 JSX；只把 5 个模块用一个 `<div className="page" key={active}>` 包起来，靠 React 在 key 变化时 unmount/remount 触发 CSS 入场动画。

### Step 4.2 · styles.css 加 @keyframes + 入场动画

- [ ] **改 `frontend/src/styles.css`**：在已有 `/* 滚动条 */` 之前插入：

```css
/* ---------- 页面级过渡 + stagger ---------- */
@keyframes page-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.page {
  animation: page-in var(--dur-slow) var(--ease-out-soft) both;
}

/* 首页卡片 stagger 入场 */
.home-card {
  animation: page-in var(--dur-slow) var(--ease-out-soft) both;
}
.home-card:nth-child(1) { animation-delay: 0ms; }
.home-card:nth-child(2) { animation-delay: 60ms; }
.home-card:nth-child(3) { animation-delay: 120ms; }
.home-card:nth-child(4) { animation-delay: 180ms; }

/* eyebrow / h1 / sub 也淡入，稍微错开 */
.home .eyebrow   { animation: page-in 360ms var(--ease-out-soft) 0ms both; }
.home h1         { animation: page-in 420ms var(--ease-out-soft) 60ms both; }
.home .home-sub  { animation: page-in 420ms var(--ease-out-soft) 120ms both; }
.home .home-grid { animation: none; }
```

### Step 4.3 · 验收 Task 4

- [ ] **跑 build + 测试**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npm run build
npx playwright test --reporter=line
```

Expected: 全过。

人工验：
1. 首次进入首页：标题 + 描述 + 4 张卡片依次淡入 + 下滑（stagger）
2. 切到任意模块：当前页淡出，新页 480ms 内淡入并轻微上滑
3. 切回首页：同样动画

### Step 4.4 · 提交 Task 4

- [ ] **commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/App.tsx frontend/src/styles.css
git -c user.name="imwei25" -c user.email="guweihuawei@gmail.com" commit -m "$(cat <<'EOF'
改进(前端): T4 模块切换过渡 + 首页 stagger 入场

- main 区用 key={active} 包裹触发 React unmount/remount
- @keyframes page-in: fade + 8px slide，480ms ease-out-soft
- 首页 4 张卡片错峰 60ms 入场，标题/副标题独立缓慢淡入

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 组件微交互（纯 CSS 重写：按钮 / 卡片 / 表单 / Markdown / 滚动条 / 免责声明）

**Files:**
- Modify: `frontend/src/styles.css`（全文检查并重写多个组件块）

这一节全是 CSS，按组件分。每个 Step 改一段 CSS。

### Step 5.1 · 按钮（spring + 上浮）

- [ ] **改 `frontend/src/styles.css`** 中 `/* 按钮：实心 petrol，克制有力 */` 之后到 `.form-actions { ... }` 之前整段（约 .btn-primary / .btn-secondary / .btn-ghost），全部替换为：

```css
/* 按钮：实心 petrol + spring 上浮 */
.btn-primary {
  align-self: flex-start;
  padding: 12px 28px;
  background: var(--petrol);
  color: #fff;
  border: none;
  border-radius: var(--radius-sm);
  font-family: var(--sans);
  font-size: var(--fs-body);
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur-base) var(--spring),
              box-shadow var(--dur-base) var(--ease-out-soft),
              background var(--dur-fast);
}
.btn-primary:hover:not(:disabled) {
  background: var(--petrol-700);
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}
.btn-primary:active:not(:disabled) { transform: translateY(0) scale(0.97); }
.btn-primary:disabled {
  background: #b4c2bf;
  cursor: not-allowed;
  opacity: 0.65;
}

.btn-secondary {
  margin-top: 16px;
  padding: 11px 22px;
  background: var(--teal-soft);
  color: var(--petrol);
  border: 1px solid #c3e2dc;
  border-radius: var(--radius-sm);
  font-weight: 600;
  font-family: var(--sans);
  cursor: pointer;
  transition: transform var(--dur-base) var(--spring),
              background var(--dur-fast),
              box-shadow var(--dur-base) var(--ease-out-soft);
}
.btn-secondary:hover {
  background: #d4ebe6;
  transform: translateY(-2px);
  box-shadow: var(--shadow);
}
.btn-secondary:active { transform: translateY(0) scale(0.97); }

.btn-ghost {
  padding: 5px 13px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 9px;
  cursor: pointer;
  font-size: 13px;
  font-family: var(--sans);
  color: var(--muted);
  transition: border-color var(--dur-fast),
              color var(--dur-fast),
              background var(--dur-fast),
              transform var(--dur-fast) var(--spring);
}
.btn-ghost:hover {
  border-color: var(--teal);
  color: var(--petrol);
  background: var(--teal-soft);
  transform: translateY(-1px);
}
.btn-ghost:active { transform: translateY(0) scale(0.96); }
```

### Step 5.2 · home cards（spring + 大留白）

- [ ] **改 `frontend/src/styles.css`** 中 `/* 首页 */` 整段（`.home h1` / `.home-sub` / `.home-grid` / `.home-card`…）替换为：

```css
/* 首页 */
.home {
  max-width: 880px;
  padding-top: var(--sp-3);
}
.home h1 {
  font-family: var(--serif);
  font-size: var(--fs-display);
  font-weight: 700;
  letter-spacing: -0.5px;
  line-height: 1.2;
  margin: 0 0 var(--sp-4);
  color: var(--petrol);
  max-width: 14em;
}
.home .eyebrow {
  margin-bottom: var(--sp-4);
}
.home-sub {
  color: var(--muted);
  margin: 0 0 var(--sp-7);
  font-size: 16px;
  line-height: 1.75;
  max-width: 38em;
}
.home-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-4);
  max-width: 780px;
}
.home-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-5) var(--sp-5) var(--sp-4);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  cursor: pointer;
  text-align: left;
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur-base) var(--spring),
              box-shadow var(--dur-base) var(--ease-out-soft),
              border-color var(--dur-base);
  position: relative;
  min-height: 160px;
}
.home-card::before {
  font-family: var(--serif);
  content: attr(data-step);
  position: absolute;
  top: 22px;
  right: 26px;
  font-size: 13px;
  color: var(--faint);
  letter-spacing: 0.05em;
}
.home-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
  border-color: var(--teal);
}
.home-card:active { transform: translateY(-2px) scale(0.99); }
.home-card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: var(--teal-soft);
  font-size: 24px;
  margin-bottom: var(--sp-2);
  transition: transform var(--dur-base) var(--spring);
}
.home-card:hover .home-card-icon { transform: scale(1.08) rotate(-2deg); }
.home-card-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--ink);
}
.home-card-desc {
  color: var(--muted);
  font-size: 13.5px;
}
```

### Step 5.3 · 模块头（编辑级留白）

- [ ] **改 `frontend/src/styles.css`** 中 `/* 模块 */` 整段：

```css
/* 模块 */
.module {
  max-width: 880px;
  padding-top: var(--sp-3);
}
.module-head {
  margin-bottom: var(--sp-6);
}
.module-head h1 {
  font-family: var(--serif);
  font-size: var(--fs-h1);
  font-weight: 700;
  letter-spacing: -0.3px;
  line-height: 1.3;
  margin: 0 0 var(--sp-2);
  color: var(--petrol);
}
.module-head p {
  color: var(--muted);
  margin: 0;
  font-size: 14.5px;
  max-width: 640px;
  line-height: 1.75;
}
```

### Step 5.4 · 表单 + Dropzone 视觉

- [ ] **改 `frontend/src/styles.css`** 中 `/* 表单 */` 到 `.checkbox-field input { ... }` 整段（input/textarea/select、field、label、hint），重写为：

```css
/* 表单 */
.form {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--sp-5);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.field-label {
  font-weight: 600;
  font-size: 13.5px;
  color: #25302e;
}
.field-label em {
  color: var(--bad);
  font-style: normal;
  font-size: 11.5px;
  margin-left: 6px;
}
.field-hint,
.file-name {
  font-size: 12.5px;
  color: var(--muted);
}
input[type="text"],
input:not([type]),
input[type="file"],
textarea,
select {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font: inherit;
  font-family: var(--sans);
  color: var(--ink);
  background: var(--surface-2);
  resize: vertical;
  transition: border-color var(--dur-fast),
              background var(--dur-fast),
              box-shadow var(--dur-base) var(--ease-out-soft);
}
input:focus,
textarea:focus,
select:focus {
  outline: none;
  border-color: var(--teal);
  background: var(--surface);
  box-shadow: 0 0 0 3px rgba(15, 155, 148, 0.14);
}
select {
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M3 4.5L6 7.5L9 4.5' stroke='%235c6b69' stroke-width='1.4' fill='none' stroke-linecap='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 14px center;
  padding-right: 34px;
}
.form-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.checkbox-field {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  font-size: 13.5px;
  color: var(--muted);
  cursor: pointer;
}
.checkbox-field input {
  width: auto;
  margin-top: 3px;
}
```

- [ ] **同文件 `/* 拖拽上传 */` 整段替换为：**

```css
/* 拖拽上传 */
.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-5);
  border: 1.5px dashed #c4d2cf;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  cursor: pointer;
  text-align: center;
  transition: border-color var(--dur-fast),
              background var(--dur-fast),
              transform var(--dur-base) var(--spring);
}
.dropzone:hover {
  border-color: var(--teal);
  background: var(--teal-soft);
}
.dropzone.dragover {
  border-color: var(--teal);
  background: var(--teal-soft);
  transform: scale(1.01);
}
.dropzone.success {
  animation: dropzone-success 600ms var(--ease-out-soft);
}
@keyframes dropzone-success {
  0%   { background: var(--ok-soft); border-color: var(--ok); }
  100% { background: var(--surface-2); border-color: #c4d2cf; }
}
.dropzone-icon {
  font-size: 26px;
  transition: transform var(--dur-base) var(--spring);
}
.dropzone.dragover .dropzone-icon { transform: translateY(-3px); }
.dropzone-text {
  font-weight: 600;
  color: var(--ink);
}
.dropzone-hint {
  font-size: 12.5px;
  color: var(--muted);
}
```

### Step 5.5 · 结果区 + 流式光标

- [ ] **改 `frontend/src/styles.css`** 中 `/* 结果区 */` 到 `@keyframes blink { ... }` 整段，替换为：

```css
/* 结果区 */
.result-panel {
  margin-top: var(--sp-5);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  transition: box-shadow var(--dur-base) var(--ease-out-soft);
}
.result-panel:hover { box-shadow: var(--shadow); }
.result-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--surface-2);
}
.result-status {
  font-size: 12px;
  color: var(--muted);
  font-family: var(--serif);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.result-actions {
  display: flex;
  gap: var(--sp-2);
}
.result-text {
  padding: var(--sp-5) var(--sp-5) var(--sp-5);
  word-break: break-word;
  min-height: 80px;
}
.result-placeholder { color: var(--faint); }
.result-error {
  margin-top: var(--sp-4);
  padding: 14px 18px;
  background: #fbece9;
  color: var(--bad);
  border: 1px solid #f1c7c1;
  border-left: 3px solid var(--bad);
  border-radius: var(--radius-sm);
}
.cursor-blink {
  display: inline-block;
  margin-left: 2px;
  color: var(--teal);
  font-weight: 700;
  animation: cursor-soft 1.2s var(--ease-out-soft) infinite;
}
@keyframes cursor-soft {
  0%, 100% { opacity: 0.35; }
  50%      { opacity: 1; }
}
```

### Step 5.6 · 状态行 spinner + 历史项 stagger 准备

- [ ] **改 `frontend/src/styles.css`** 中 `/* 状态行 / 文献 / 校验 */` 段中 `.status-line` 和 `.spinner` 部分：

找：

```css
.status-line {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-top: 20px;
  padding: 13px 18px;
  background: var(--teal-soft);
  border: 1px solid #c8e6e0;
  border-radius: var(--radius-sm);
  color: var(--petrol);
  font-size: 14px;
}
```

替换为：

```css
.status-line {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-top: var(--sp-4);
  padding: 13px 18px;
  background: var(--teal-soft);
  border: 1px solid #c8e6e0;
  border-radius: var(--radius-sm);
  color: var(--petrol);
  font-size: 14px;
  animation: status-pulse 2.2s ease-in-out infinite;
}
@keyframes status-pulse {
  0%, 100% { opacity: 0.92; }
  50%      { opacity: 1; }
}
```

### Step 5.7 · 历史记录 hover + 删除动画

- [ ] **改 `frontend/src/styles.css`** 中 `/* 历史记录 */` 段中 `.history-item` 部分：

找：

```css
.history-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px 18px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  transition: transform 0.14s, box-shadow 0.14s;
}
.history-item:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow);
}
```

替换为：

```css
.history-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px 18px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur-base) var(--spring),
              box-shadow var(--dur-base) var(--ease-out-soft),
              border-color var(--dur-base),
              opacity var(--dur-base);
  animation: page-in 360ms var(--ease-out-soft) both;
}
.history-item:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow);
  border-color: var(--teal);
}
.history-item:nth-child(1) { animation-delay: 0ms; }
.history-item:nth-child(2) { animation-delay: 40ms; }
.history-item:nth-child(3) { animation-delay: 80ms; }
.history-item:nth-child(4) { animation-delay: 120ms; }
.history-item:nth-child(5) { animation-delay: 160ms; }
.history-item:nth-child(n+6) { animation-delay: 200ms; }
```

### Step 5.8 · Markdown 排版（编辑级阅读宽度）

- [ ] **改 `frontend/src/styles.css`** 中 `/* Markdown */` 整段重写：

```css
/* Markdown */
.markdown {
  max-width: 42em;
  font-size: var(--fs-body);
  line-height: 1.8;
}
.markdown a {
  color: var(--petrol);
  text-decoration: none;
  border-bottom: 1px solid var(--teal);
  transition: border-width var(--dur-fast), color var(--dur-fast);
}
.markdown a:hover {
  color: var(--teal);
  border-bottom-width: 2px;
}
.markdown h1 {
  font-family: var(--serif);
  font-size: 22px;
  font-weight: 700;
  margin: var(--sp-5) 0 var(--sp-3);
  color: var(--petrol);
}
.markdown h2 {
  font-family: var(--serif);
  font-size: 18px;
  font-weight: 700;
  margin: var(--sp-5) 0 var(--sp-3);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--petrol);
}
.markdown h3 {
  font-size: 16px;
  font-weight: 700;
  margin: var(--sp-4) 0 var(--sp-2);
  color: var(--ink);
}
.markdown p { margin: 10px 0; }
.markdown ol,
.markdown ul { padding-left: 22px; }
.markdown li { margin: 6px 0; }
.markdown table {
  border-collapse: collapse;
  width: 100%;
  margin: var(--sp-3) 0;
  font-size: 13.5px;
}
.markdown th,
.markdown td {
  border: 1px solid var(--line);
  padding: 8px 12px;
  text-align: left;
}
.markdown th {
  background: var(--teal-soft);
  font-weight: 700;
}
.markdown tr {
  transition: background var(--dur-fast);
}
.markdown tbody tr:hover { background: var(--surface-2); }
.markdown code {
  background: var(--surface-2);
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 0.92em;
  font-family: var(--mono);
}
.markdown pre {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-left: 3px solid var(--teal);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.65;
}
.markdown pre code {
  background: transparent;
  padding: 0;
}
```

### Step 5.9 · 免责声明 + 滚动条

- [ ] **改 `frontend/src/styles.css`** 中 `/* 免责声明 */` 整段重写：

```css
/* 免责声明 */
.disclaimer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: var(--sp-5);
  padding: 13px 18px;
  background: #fbf6ea;
  border: 1px solid #ecdcb4;
  border-left: 3px solid #d9b85a;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: #7a5b00;
  line-height: 1.6;
  animation: disclaimer-in 380ms var(--ease-out-soft);
}
@keyframes disclaimer-in {
  from { opacity: 0; transform: translateY(-10px); }
  to   { opacity: 1; transform: translateY(0); }
}
.disclaimer-close {
  flex-shrink: 0;
  padding: 7px 15px;
  background: #fff;
  border: 1px solid #e6c870;
  border-radius: 9px;
  color: #7a5b00;
  cursor: pointer;
  font-size: 12.5px;
  white-space: nowrap;
  transition: background var(--dur-fast), transform var(--dur-fast) var(--spring);
}
.disclaimer-close:hover {
  background: #fbf0d5;
  transform: translateY(-1px);
}
```

- [ ] **改 `frontend/src/styles.css`** 中 `/* 滚动条 */` 整段重写：

```css
/* 滚动条 */
.content::-webkit-scrollbar { width: 8px; }
.content::-webkit-scrollbar-track { background: transparent; }
.content::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 4px;
  transition: background var(--dur-fast);
}
.content::-webkit-scrollbar-thumb:hover { background: var(--faint); }
```

### Step 5.10 · 验收 Task 5

- [ ] **跑 build + 测试**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npm run build
npx playwright test --reporter=line
```

Expected: 全过。

人工验：
1. 按钮 hover 弹起 + 阴影变深，按下回弹
2. 表单 focus 时背景白 + teal 描边 + 光晕
3. 拖文件到 Dropzone：整个 zone 染色 + scale(1.01) + 图标轻浮
4. 首页 4 张卡：hover 上浮 4px，图标轻微 scale+rotate
5. 历史记录：每条 stagger 入场
6. Markdown 链接：hover 时下划线变粗
7. 切到 Midnight 主题：所有以上效果仍然丝滑，颜色全变深

### Step 5.11 · 提交 Task 5

- [ ] **commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/styles.css
git -c user.name="imwei25" -c user.email="guweihuawei@gmail.com" commit -m "$(cat <<'EOF'
改进(前端): T5 组件微交互全面打磨

- 按钮：spring 上浮+阴影，按下 scale(.97) 回弹
- home/history 卡片：hover -4px + 阴影到 lg + teal 描边
- 表单 focus：背景白 + 描边 teal + 3px 光晕
- Dropzone：dragover scale(1.01) + success 600ms ok-pulse
- ResultPanel：cursor 从 step-start 改为柔和 ease-out-soft
- Markdown：max-width 42em，pre/table/链接全部 token 化
- 状态行：2.2s 周期微脉冲
- 免责声明：从顶部滑入入场
- 滚动条：8px 极细，hover 加深

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Dropzone 成功脉冲 + ResultPanel 段落淡入 + HistoryView 删除动画

**Files:**
- Modify: `frontend/src/components/Dropzone.tsx`
- Modify: `frontend/src/components/ResultPanel.tsx`
- Modify: `frontend/src/modules/HistoryView.tsx`

### Step 6.1 · Dropzone success 类触发

- [ ] **整文件替换 `frontend/src/components/Dropzone.tsx` 为以下内容**

变更点：
- 加 `useEffect` import
- 加 `success` state + 触发动画的 effect（用双 rAF 重启 CSS 动画）
- `.dropzone` className 拼接 `success` 类

```tsx
import { useEffect, useRef, useState } from "react";
import { extractFile } from "../lib/extract";

interface Props {
  testId: string;
  accept: string;
  label: string;
  hint?: string;
  mode: "file" | "text";
  onFile?: (file: File) => void;
  onText?: (text: string, filename: string, truncated: boolean) => void;
}

export default function Dropzone({ testId, accept, label, hint, mode, onFile, onText }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (info.startsWith("已导入") || info.startsWith("已选择")) {
      setSuccess(false);
      requestAnimationFrame(() => requestAnimationFrame(() => setSuccess(true)));
      const t = setTimeout(() => setSuccess(false), 700);
      return () => clearTimeout(t);
    }
  }, [info]);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setErr("");
    if (mode === "file") {
      setInfo(`已选择：${file.name}`);
      onFile?.(file);
      return;
    }
    setBusy(true);
    setInfo(`正在解析 ${file.name} …`);
    const res = await extractFile(file);
    setBusy(false);
    if (!res.ok || !res.text) {
      setInfo("");
      setErr(res.error || "解析失败");
      return;
    }
    setInfo(`已导入：${file.name}${res.truncated ? "（内容较长已截断）" : ""}`);
    onText?.(res.text, file.name, !!res.truncated);
  };

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div
        className={`dropzone ${drag ? "dragover" : ""} ${success ? "success" : ""}`}
        data-testid={`${testId}-zone`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handle(e.dataTransfer.files?.[0]);
        }}
      >
        <span className="dropzone-icon">📎</span>
        <span className="dropzone-text">
          {busy ? "正在解析…" : "把文件拖到这里，或点击选择"}
        </span>
        {hint && <span className="dropzone-hint">{hint}</span>}
        <input
          ref={inputRef}
          data-testid={testId}
          type="file"
          accept={accept}
          style={{ display: "none" }}
          onChange={(e) => handle(e.target.files?.[0] ?? undefined)}
        />
      </div>
      {info && <span className="file-name" data-testid={`${testId}-info`}>{info}</span>}
      {err && <span className="result-error" data-testid={`${testId}-error`}>{err}</span>}
    </div>
  );
}
```

### Step 6.2 · ResultPanel（不改 tsx，仅核对）

- [ ] **打开 `frontend/src/components/ResultPanel.tsx`**，确认 cursor span 类名仍是 `cursor-blink`（CSS 已重写为柔和闪烁），无需 tsx 修改。

### Step 6.3 · HistoryView 删除动画 + 清空整体淡出

- [ ] **改 `frontend/src/modules/HistoryView.tsx`**：把"清空历史"的 onClick 加上淡出延迟（用 className 触发 exit 动画）：

完整替换内容：

```tsx
import { useState } from "react";
import { getHistory, clearHistory, formatTime } from "../lib/history";
import type { Goto, ModuleId } from "../App";

const NAMES: Record<string, string> = {
  idea: "找选题",
  plan: "实验规划",
  analyze: "数据分析",
  format: "期刊排版",
};

export default function HistoryView({ goto }: { goto: Goto }) {
  const [items, setItems] = useState(getHistory());
  const [exiting, setExiting] = useState(false);

  const handleClear = () => {
    setExiting(true);
    setTimeout(() => {
      clearHistory();
      setItems([]);
      setExiting(false);
    }, 280);
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>📜 历史记录</h1>
        <p>你最近的生成结果都在这里，可点击"恢复"回到对应功能继续编辑或导出。</p>
      </header>

      {items.length === 0 ? (
        <p className="result-placeholder">还没有历史记录。生成一次结果后会自动保存到这里。</p>
      ) : (
        <>
          <button
            className="btn-ghost"
            data-testid="clear-history"
            onClick={handleClear}
          >
            清空历史
          </button>
          <ul className={`history-list ${exiting ? "exiting" : ""}`} data-testid="history-list">
            {items.map((it) => (
              <li key={it.id} className="history-item" data-testid="history-item">
                <span className="history-icon">{it.icon}</span>
                <span className="history-main">
                  <span className="history-title">{it.title}</span>
                  <span className="history-time">
                    {NAMES[it.module] ?? it.module} · {formatTime(it.time)}
                  </span>
                </span>
                <button className="btn-ghost" data-testid="restore-btn" onClick={() => goto(it.module as ModuleId, it.data)}>
                  恢复 →
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
```

- [ ] **再改 `frontend/src/styles.css`**，找到 `.history-list { ... }` 段，在它之后加：

```css
.history-list.exiting .history-item {
  animation: history-exit 280ms var(--ease-out-soft) forwards;
}
@keyframes history-exit {
  to { opacity: 0; transform: scale(0.96); }
}
```

### Step 6.4 · 验收 Task 6

- [ ] **跑 build + 测试**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npm run build
npx playwright test --reporter=line
```

Expected: 全过。**特别注意 `历史记录: 生成后可在历史中恢复` 和 `期刊排版: 上传Word自动填入稿件` 这两个测试**，它们触及 Dropzone success 和 history-item testid。

人工验：
1. 上传任意 .docx 文件 → Dropzone 闪一下 ok 绿（600ms）再回正常态
2. 在历史列表点击"清空历史" → 所有 item 在 280ms 内同时 scale(0.96) + 淡出再消失

### Step 6.5 · 提交 Task 6

- [ ] **commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/components/Dropzone.tsx frontend/src/modules/HistoryView.tsx frontend/src/styles.css
git -c user.name="imwei25" -c user.email="guweihuawei@gmail.com" commit -m "$(cat <<'EOF'
改进(前端): T6 Dropzone 成功脉冲 + 历史清空淡出

- Dropzone 成功导入后触发 600ms ok 绿背景脉冲
- HistoryView 清空时所有 item scale(.96)+fade 280ms 退场

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 收尾验收 + dist 提交

**Files:**
- 重新 build 生成 `frontend/dist/`
- 全套人工 + 自动验收
- 提交 dist

### Step 7.1 · 全套人工验收（按 spec 第 12 节）

- [ ] **按以下清单走一遍，每条勾掉**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npm run dev
```

打开 http://localhost:5173（或 vite 默认端口）：

1. [ ] 切换三套主题，全站 280ms 内顺滑过渡，无白屏闪烁
2. [ ] 侧栏默认展开（272px），点击顶部 « 收为 24px 发丝条
3. [ ] 折叠态下 hover 整条触发临时展开（peek），移开 200ms 后收回
4. [ ] 折叠态下点击空白展开锁定，刷新页面后展开状态保持
5. [ ] 模块切换：旧内容淡出，新内容 480ms 内淡入并轻微下滑
6. [ ] 首页 4 张卡片错峰入场（stagger 60ms）
7. [ ] 任意按钮 hover 时上浮 2px 带阴影，按下 scale(.97) 弹性回弹
8. [ ] 表单 focus 时背景变白、描边 teal、外圈光晕
9. [ ] Dropzone 拖文件时整体 scale(1.01) 并染色；成功后闪一下 ok 绿
10. [ ] 历史记录 hover 时上浮，清空时缩小淡出
11. [ ] 启用系统 reduce-motion 后所有动效降到 0.01ms（System Preferences / 控制面板里测）

### Step 7.2 · 跑全套 Playwright

- [ ] **测试通过**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npx playwright test --reporter=line
```

Expected: 全部 19 个测试通过。

如果有失败，根据具体 testid 修复（最常见原因：DOM 结构改了但 testid 仍在，但选择器变了；或动画期间 visibility 未及时变化）。

### Step 7.3 · 最终 build

- [ ] **生产构建**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
rm -rf dist
npm run build
ls -lh dist/assets/
ls -lh dist/fonts/ 2>/dev/null || ls -lh dist/
```

Expected:
- `tsc -b` 通过（无 TypeScript 错误）
- `vite build` 通过
- `dist/assets/` 有新 CSS / JS hash 文件
- 字体应在 `dist/fonts/`（vite 会拷贝 public/）

### Step 7.4 · 提交 dist

- [ ] **commit dist（按 .gitignore 注释要求）**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/dist/
git status
git -c user.name="imwei25" -c user.email="guweihuawei@gmail.com" commit -m "$(cat <<'EOF'
改进(前端): T7 build dist - 完成前端打磨整轮

- 三主题（Editorial/Clinical/Midnight）+ 折叠侧栏 + 苹果级动效
- 编辑级留白 + 自托管 Inter/Noto Serif SC 字体
- 全套 19 个 e2e 测试通过

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Step 7.5 · 推送（仅在用户明确允许下推送）

- [ ] **询问用户是否 push 到 origin/main，得到许可后再 push**

```bash
# 用户允许后：
cd C:/Users/Administrator/Desktop/scientific-discover
git push origin main
```

---

## 总结

完成后，本次工作产出：

- 1 个 spec 文档（已提交）
- 1 个 plan 文档（本文件）
- 7 个 task commit
- 5 个新文件（2 字体 + 2 lib + 1 component）
- 7 个改文件（styles.css + App.tsx + index.html + 4 component/module）
- 0 个新 npm 依赖

视觉/交互产出：

- 3 套可切换主题
- 24px 极细发丝条 + hover-peek 折叠侧栏
- 全站 spring + ease-out-soft 苹果级动效
- 编辑级排版（Noto Serif SC 中文大标题 + Inter 数字 tabular-nums）
- 全部按钮 / 卡片 / 表单 / dropzone / markdown / 历史 / disclaimer 微交互升级
