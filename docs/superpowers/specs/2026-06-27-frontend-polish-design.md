# 前端打磨设计文档 · Frontend Polish

> 日期：2026-06-27
> 范围：`frontend/` 全部 UI 资源（`styles.css` + 所有 `tsx` 组件 + 字体资源）

## 1. 目标

把现有"医学期刊气质"的前端，按以下两条主轴打磨：

1. **节奏（呼吸感）**——编辑级留白 + 严格的字号/间距阶梯；
2. **动效（丝滑感）**——苹果级 spring 缓动，所有交互、入场、切换都"贵"一点。

不重做设计语言（保留 petrol/teal + 衬线眉题的医学/学术气场），而是把它推到完成度更高的形态。

附带两个能力：

- **侧栏可折叠**：默认 24px 极细发丝条，鼠标 hover 临时展开，点击锁定/解锁。
- **三套风格可切换**：Editorial（默认）/ Clinical / Midnight，由用户在侧栏底部一键切换。

## 2. 不做（Out of Scope）

- 重写 React 数据流、状态管理、API 层
- 引入任何新运行时依赖（React 18、react-markdown、自托管字体之外不加东西，**不引入 framer-motion / tailwind / shadcn**）
- 移动端响应式（保持现状，桌面优先）
- 重做交互逻辑（表单/流式/上传/历史 的行为不变，只换皮和动效）
- 后端、构建链、Tauri 配置（除字体需要被打包外）

## 3. Design Tokens（底层变量）

`frontend/src/styles.css` 顶部 `:root` 重做。新增 token 必须有一处明确用途。

### 3.1 颜色

保留 petrol / teal 系，新增 `--paper-warm` 与 `--surface-2` 制造层级。

```
--petrol      : #0E3A39   主色 · 信任
--petrol-700  : #0A2B2A   悬停加深
--teal        : #0F9B94   唯一强调色
--teal-soft   : #E2F1EE   teal 软背景
--paper       : #EEF2F1   纸面（最外层）
--paper-warm  : #FAFBFB   纸面亮版（展开侧栏/弹层）  ← 新
--surface     : #FFFFFF   卡片表面
--surface-2   : #F7FAF9   卡片次表面（输入、内嵌区） ← 新
--ink         : #14201F   文字
--muted       : #5C6B69   次要文字
--faint       : #93A09D   极淡文字
--line        : #DCE5E3   描边
--line-soft   : #E8EEEC   软描边（分隔条）
--ok / --bad / --warn      语义色（不变）
```

### 3.2 字体

自托管 `Inter` + `Noto Sans SC` + `Noto Serif SC`，子集化以控制体积。**离线打包友好**（Tauri 必需）。

```
--sans  : 'Inter','Noto Sans SC','PingFang SC','Microsoft YaHei',system-ui,sans-serif
--serif : 'Noto Serif SC',Georgia,'Songti SC',serif
--mono  : 'JetBrains Mono','SFMono-Regular','Consolas',monospace
```

字号阶梯（rem 基准 16px）：

| Token | 数值 | 行高 | 用途 |
|---|---|---|---|
| `--fs-display` | 36 / 2.25rem | 1.2 | 首页大标题（仅一处） |
| `--fs-h1` | 28 / 1.75rem | 1.3 | 模块头 |
| `--fs-h2` | 20 / 1.25rem | 1.4 | 章节小标题 |
| `--fs-h3` | 17 / 1.0625rem | 1.5 | 卡片/表单分组标题 |
| `--fs-body` | 15 / .9375rem | 1.75 | 正文 |
| `--fs-small` | 13 / .8125rem | 1.65 | hint / meta / 时间戳 |
| `--fs-eyebrow` | 11.5 / .72rem | 1.4 | 衬线眉题（letter-spacing .18em，全大写） |

数字一律 `font-variant-numeric: tabular-nums`（统计表对齐）。

### 3.3 间距阶梯

基于 4px，编辑级用大档位。命名 `--sp-{n}`。

```
--sp-1: 4px    行内
--sp-2: 8px    label↔input
--sp-3: 12px   表单项之间
--sp-4: 20px   卡片内段落
--sp-5: 32px   模块块之间
--sp-6: 48px   章节之间
--sp-7: 72px   首页大标题前后
--sp-8: 96px   页面顶部呼吸
```

### 3.4 圆角 + 阴影（三层 surface elevation）

```
--radius-sm : 10px
--radius    : 14px
--radius-lg : 18px   ← 新（用于浮起的弹层、展开侧栏）

--shadow-sm : 0 1px 2px rgba(14,58,57,.04), 0 1px 3px rgba(14,58,57,.05)
--shadow    : 0 2px 8px rgba(14,58,57,.05), 0 14px 34px rgba(14,58,57,.07)
--shadow-lg : 0 4px 18px rgba(14,58,57,.08), 0 28px 56px rgba(14,58,57,.10)   ← 新
```

### 3.5 动效

仅两条曲线、三档时长。全站统一。

```
--spring        : cubic-bezier(0.34, 1.56, 0.64, 1)   带超调（交互反馈）
--ease-out-soft : cubic-bezier(0.16, 1, 0.3, 1)       无超调极尾长（页面级）

--dur-fast : 150ms   hover / focus / 状态切换
--dur-base : 280ms   按钮 / 卡片 / 切换器
--dur-slow : 480ms   模块切换 / 入场
```

## 4. 三套主题

主题切换通过 `<html data-theme="editorial|clinical|midnight">` 实现。CSS 用 `:root` 写 Editorial，再用 `[data-theme="clinical"]` 和 `[data-theme="midnight"]` 覆盖。

切换时全局 `body` 加 `transition: background-color var(--dur-base), color var(--dur-base), border-color var(--dur-base)`，避免一闪。

### 4.1 Editorial（默认）

= 第 3 节定义的所有 token。气质：暖纸面、衬线眉题、医学期刊。

### 4.2 Clinical 临床冷调

覆盖项：

```
--paper       : #F4F6F9
--paper-warm  : #FFFFFF
--surface     : #FFFFFF
--surface-2   : #F8FAFC
--ink         : #0F172A
--petrol      : #1E3A8A   钴蓝（替换主色）
--petrol-700  : #1E40AF
--teal        : #0EA5E9   sky（替换强调）
--teal-soft   : #E0F2FE
--muted       : #475569
--faint       : #94A3B8
--line        : #E2E8F0
--line-soft   : #EEF2F6
--serif       : 'Inter','Noto Sans SC',sans-serif    /* 整体退衬线，eyebrow 改用 sans */
```

气质：冷调、高对比、Inter 主导、JetBrains Mono 数字，像 Linear / Apple Health / 现代 EHR。

### 4.3 Midnight 深夜模式

覆盖项：

```
--paper       : #0D1817
--paper-warm  : #15201F
--surface     : #15201F
--surface-2   : #1A2625
--ink         : #E2EAE9
--petrol      : #7FDFD6   反转：原 ink 角色
--teal        : #16D9C8   微辉光
--teal-soft   : rgba(22,217,200,.12)
--muted       : #8A9A97
--faint       : #5C6B69
--line        : #26302F
--line-soft   : #1F2A28
```

气质：深 petrol 底 + teal 微辉光（在 active 状态加 `box-shadow: 0 0 8px teal/0.5`），适合夜间长写作。

不自动跟随 `prefers-color-scheme`（用户显式选择，避免外部触发）。

### 4.4 切换器 UI

放在展开态侧栏底部。三段式 segmented control，每段是一个 28×16 的迷你 swatch + 名称。点击：

1. 写 `localStorage.setItem('ui:theme', value)`
2. 设 `document.documentElement.dataset.theme = value`
3. 触发全局 transition（已在 body 上）

初始化时 `App.tsx` 读 localStorage，默认 `editorial`。

## 5. 侧栏折叠行为

### 5.1 三种状态

```
expanded (默认) ─── 272px 完整展开
       │ 点击展开态侧栏顶部的 «
       ↓
collapsed ─── 24px 极细发丝条
       │ hover
       ↓                  (临时)
peeking ─── 272px 完整展开（不修改 localStorage）
       │ mouseleave 后 200ms 收回 (清除 timer)
       ↑
       │ 点击发丝条上的 » 按钮
       ↓
locked-open ─── 写 localStorage 为 expanded
```

实际状态机：`ui:sidebar = 'expanded' | 'collapsed'`（持久化，默认 `expanded` 便于新用户发现完整流程），加一个 React 状态 `peeking` 仅内存。

视觉宽度始终是 `--sidebar-w` 变量，由 JS 切换为 `24px` / `272px`，transition 用 `--ease-out-soft` + `--dur-slow`（480ms）。

### 5.2 24px 折叠态

- 背景：linear-gradient(to right, `paper-warm` 0%, `paper` 100%)，比主区稍亮
- 顶部 8px 实心 petrol 圆点 = brand 提示
- 中部 4 个 4px tick 圆点，当前 active 一个用 teal + `box-shadow: 0 0 0 3px teal/.18`
- 底部一个 18×32 的小凸块 »，点击 = 锁定展开
- hover 整条：进入 peeking 态

### 5.3 272px 展开态

完全保留现有 `pipeline` 设计（编号衬线圆 + 竖向连接线 + 名称 + 描述），只调间距按新 token：

- 内边距 `var(--sp-5) var(--sp-4)`（32 / 20）
- nav-item 之间 `--sp-1`（4）
- 顶部 brand 和 nav 之间 `--sp-6`（48）
- 底部 sidebar-foot + 主题切换器

### 5.4 入场动效

切换时同时滑动 `width` 和 fade-in 名称/描述：

```css
.sidebar { width: var(--sidebar-w); transition: width var(--dur-slow) var(--ease-out-soft); }
.nav-text { opacity: 0; transition: opacity var(--dur-base) var(--ease-out-soft) var(--dur-fast); }
.sidebar[data-state="expanded"] .nav-text,
.sidebar[data-state="peeking"]  .nav-text { opacity: 1; }
```

时序：宽度先动，名称等 150ms 再淡入，避免文字被截断时一闪。

## 6. 页面级过渡（模块切换）

主区是 `<main className="content">`，当 `active` 改变时：

- 旧内容 fade-out + 上移 6px（`--dur-fast` 150ms）
- 新内容 fade-in + 下移 6px → 0（`--dur-slow` 480ms，`--ease-out-soft`）

实现：用一个简单的 `useTransition` 模式或纯 CSS `key` + animation。**不依赖 framer-motion**。

```css
.content > * {
  animation: page-in var(--dur-slow) var(--ease-out-soft) both;
}
@keyframes page-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

首页卡片 stagger 入场（每张延迟 60ms）：

```css
.home-card:nth-child(1) { animation-delay: 0ms; }
.home-card:nth-child(2) { animation-delay: 60ms; }
.home-card:nth-child(3) { animation-delay: 120ms; }
.home-card:nth-child(4) { animation-delay: 180ms; }
```

`@media (prefers-reduced-motion: reduce)` 把所有 animation/transition 限制到 0.01ms（已存在，保留）。

## 7. 组件微交互

### 7.1 按钮 `.btn-primary`、`.btn-secondary`、`.btn-ghost`

- hover：`translateY(-2px)` + 阴影从 sm 升到 lg（用 `--spring`）
- active（按下）：`scale(.97)` 瞬间，松开回弹
- disabled：透明度 .55，无 hover 效果
- transition：`transform var(--dur-base) var(--spring), box-shadow var(--dur-base) var(--ease-out-soft), background var(--dur-fast)`

### 7.2 卡片 `.home-card`、`.analysis-block`、`.history-item`

- hover：`translateY(-3px)` + 阴影到 lg + 描边色 teal
- transition：用 `--spring` 280ms

### 7.3 表单 input / textarea / select

- 默认 `--surface-2` 背景，描边 `--line`
- focus：背景 `--surface`、描边 `--teal`、外圈 3px teal/.14 光晕
- transition：`background var(--dur-fast), border-color var(--dur-fast), box-shadow var(--dur-base) var(--ease-out-soft)`

### 7.4 Dropzone（拖拽上传）

- 默认虚线描边 + `--surface-2` 背景
- `dragover`：描边 → teal，背景 → teal-soft，整个 dropzone `scale(1.01)`（spring）
- 文件成功后：1 次 600ms 的 ok 色背景脉冲（`background: ok-soft → surface-2`），描边同步从 ok 退回 line

### 7.5 ResultPanel（结果区）

- 流式接收过程中，光标用 teal，闪烁更柔（`opacity: 0.4 → 1` 替代 step-start）
- 全部接收完毕：底部出现淡淡的 `--shadow-lg` 上滑提示工具栏（复制/导出）
- 流式期间，文字逐段淡入（每段加 `animation: fade-in 240ms`）

### 7.6 状态行 `.status-line` / spinner

- 现 spinner 保留，整个 status-line 背景做 2s 周期的微脉冲（`opacity: 0.92 ↔ 1`）
- 完成态：spinner 淡出 200ms 后，ok 勾号淡入 240ms，避免瞬切

### 7.7 Markdown 渲染

- 标题用 `--serif`（h1/h2 用 Noto Serif SC，h3 用 sans 700）
- 段落 max-width 38em（编辑级阅读宽度）
- 链接：保留 teal 下划线，hover 时下划线变粗（border-bottom 1→2px）
- 代码块 `--surface-2` 背景，`--mono`，左侧 3px teal 线
- 表格：表头 teal-soft，行间距更松，hover 整行 teal-soft

### 7.8 历史记录 `.history-item`

- 入场 stagger（每条延迟 40ms）
- hover：`translateY(-1px)` + 阴影 sm→md + 描边 teal
- 删除时：先 `scale(.96)` + 淡出再从 DOM 移除（300ms）

### 7.9 滚动条

- 保留现有 webkit 样式，宽度调整为 8px（更细），thumb 用 `--line` → `--faint` on hover

### 7.10 免责声明 `.disclaimer`

- 入场：从顶部滑入（`translateY(-12px)` → 0，`--ease-out-soft`）
- 关闭：当前态 fade-out + 高度收起（max-height 动画）

## 8. 可达性

- 保留 `:focus-visible { outline: 2px solid teal; outline-offset: 2px }`
- `prefers-reduced-motion: reduce` 完全保留并扩展到所有新动效
- 主题切换器、侧栏折叠按钮都要有 `aria-label` 和键盘可达
- 折叠态 24px 发丝条整体作为按钮 `<button aria-label="展开侧栏">`，回车/空格唤起

## 9. 字体打包

- 在 `frontend/public/fonts/` 放：
  - `Inter-Regular/Medium/SemiBold/Bold.woff2`（Latin 子集，4 个静态权重，合计 ~96KB）
  - `NotoSerifSC-Bold.woff2`（chinese-simplified 子集，仅 700 权重，~1.5MB；用于 display / h1 / eyebrow）
- **不打包 Noto Sans SC**：中文正文走 `--sans` 栈中 `'PingFang SC', 'Microsoft YaHei'` 的系统字体，质量足够高且更"原生"，省 ~800KB。
- `styles.css` 顶部 `@font-face` 引用 `/fonts/xxx.woff2`，`font-display: swap`
- 总体积 ~1.6MB（CJK serif 一旦自托管就无法做小，分析过：常用 6800 字 GB2312 子集本身就是 1.2-1.7MB；强行裁更小会丢科研术语字）
- 不依赖外部 CDN（Tauri 离线场景必需）

## 10. localStorage 持久化键

通过 `usePersistentState` 写入，自动加 `ra:` 前缀。

| Key（实际 localStorage） | 值 | 默认 |
|---|---|---|
| `ra:theme` | `'editorial' \| 'clinical' \| 'midnight'` | `'editorial'` |
| `ra:sidebar` | `'expanded' \| 'collapsed'` | `'expanded'` |
| `ra:disclaimerDismissed` | `boolean` | `false`（已存在） |

## 11. 文件变更清单

### 改

- `frontend/src/styles.css` — 大改：tokens、3 主题、所有组件类
- `frontend/src/App.tsx` — 中改：折叠侧栏状态机、主题切换器、模块切换动画 key
- `frontend/src/components/ResultPanel.tsx` — 小改：流式光标、工具栏入场
- `frontend/src/components/Dropzone.tsx` — 小改：dragover/success 反馈
- `frontend/src/components/Markdown.tsx` — 小改：max-width、间距
- `frontend/src/modules/HistoryView.tsx` — 小改：stagger 入场、删除动画
- `frontend/src/modules/IdeaModule.tsx`、`PlanModule.tsx`、`AnalyzeModule.tsx`、`FormatModule.tsx` — 极小改：仅在需要 stagger 的列表/卡片处加 `style={{animationDelay}}`
- `frontend/index.html` — 加字体 preload link

### 新增

- `frontend/public/fonts/*.woff2` — 字体文件
- `frontend/src/lib/theme.ts` — 主题切换 hook（读写 localStorage + 写 dataset）
- `frontend/src/lib/sidebar.ts` — 折叠/展开/peek 状态机 hook
- `frontend/src/components/ThemeSwitcher.tsx` — 切换器组件

### 不动

- `frontend/src/lib/api.ts`、`extract.ts`、`history.ts`、`sse.ts`、`useStream.ts`
- 后端任何文件
- `package.json`（不加新依赖）

## 12. 验收标准

人工浏览验收：

1. 切换三套主题，全站 280ms 内顺滑过渡，无白屏闪烁
2. 侧栏默认展开（272px），点击顶部 « 收为 24px 发丝条
3. 折叠态下 hover 整条触发临时展开（peeking），移开 200ms 后收回
4. 点击发丝条 » 按钮锁定展开，状态保持到下次会话
4. 模块切换：旧内容 150ms 淡出，新内容 480ms 淡入并轻微下滑
5. 首页 4 张卡片错峰入场（stagger 60ms）
6. 任意按钮 hover 时上浮 2px 带阴影，按下 scale(.97) 弹性回弹
7. 表单 focus 时背景变白、描边 teal、外圈光晕
8. Dropzone 拖文件时整体 scale(1.01) 并染色
9. 历史记录 hover 时上浮，删除时缩小淡出
10. 启用系统 reduce-motion 后所有动效降到 0.01ms

构建验收：

- `npm run build` 通过
- 不引入新 npm 依赖（diff `package.json` 仅可能增加 `vite.config.ts` 中的字体相关设置）
- 字体总体积约 1.6MB（参考 §9 现实分析）

## 13. 实施分块（供 plan 使用）

按依赖顺序、可并行处分块标注：

```
T1. Foundation（必须先做）
    - styles.css 顶部 tokens 重写（颜色/字体/间距/阴影/动效变量）
    - 加 @font-face、字体 woff2 放到 public/fonts/
    - index.html preload 链接
    - body 全局 transition

T2. Sidebar 折叠（依赖 T1）
    - lib/sidebar.ts 状态机 hook
    - App.tsx 侧栏接入 hook + data-state 属性
    - styles.css .sidebar / .nav 重做含折叠态

T3. Theme switcher（依赖 T1，可与 T2 并行）
    - lib/theme.ts hook
    - components/ThemeSwitcher.tsx
    - styles.css [data-theme="clinical"] [data-theme="midnight"] 覆盖
    - App.tsx 接入 hook

T4. 页面级过渡（依赖 T1，可与 T2/T3 并行）
    - App.tsx main 区加 key + animation 类
    - styles.css @keyframes page-in、stagger 规则

T5. 组件微交互（依赖 T1，可与 T2/T3/T4 并行）
    - 按钮 / 卡片 / 表单 / dropzone / result panel / markdown / history / disclaimer
    - 主要是 styles.css 重写各 class，ResultPanel / Dropzone / HistoryView 小改

T6. 收尾验收
    - 人工浏览四个模块 + 三套主题 + 折叠/展开
    - npm run build 验证
    - dist 提交（按 .gitignore 注释要求）
```

T2/T3/T4/T5 互相不冲突，可并行 sub-agent 执行（共享 styles.css 是冲突点，需要协调先后或一个 agent 串行处理 styles.css）。

## 14. 风险

| 风险 | 缓解 |
|---|---|
| 字体加载导致 FOUT/FOIT | `font-display: swap` + preload + 子集化 |
| 三套主题颜色对比度 | 完成后用对比度检查工具验证 ≥ AA |
| 苹果级动效在低性能机卡顿 | 只动 transform / opacity，避免 width/height（侧栏宽度变化是唯一例外，必要时降级） |
| dist 与 src 不同步 | 按现有 .gitignore 注释，build 后 dist 一起提交 |
| 主题切换中途用户点击其他元素 | transition 期间不阻挡交互（不加 mask） |
