# 结果区宽版布局 + 图表放大预览 · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让数据分析结果区突破 `.module` 880px 上限,结论拿宽版阅读带,图表缩略图移到右侧 sticky rail,点击缩略图弹全屏 modal(滚轮以鼠标位置为锚缩放、拖拽平移、键盘翻图)。

**Architecture:** 新建 `ImageViewer.tsx` 组件(自持 zoom/pan/键盘状态,co-locate 自己的样式)。改 `GeneralResults.tsx` 加 viewer state、包宽版 wrapper、缩略图点击。改 `AnalyzeModule.tsx` 内联样式加 `.analyze-results-wide` 和 rail CSS。仅前端,不动后端。

**Tech Stack:** React 18 + TypeScript + Vite。CSS Grid + `position: sticky`。DOM 事件(wheel / mousedown / mousemove / keydown)。零新依赖。

Spec 参考:`docs/superpowers/specs/2026-07-04-analyze-wide-layout-image-viewer-design.md`

---

## File Structure

**新增**
- `frontend/src/components/ImageViewer.tsx` — 全屏放大预览 modal 组件(约 220 行:props、state、wheel/mouse/keydown 处理、渲染、内联 `<style>`)

**修改**
- `frontend/src/modules/analyze/GeneralResults.tsx` — 加 `viewer` state + wide wrapper + 缩略图 onClick + 引入并挂载 `<ImageViewer>`
- `frontend/src/modules/AnalyzeModule.tsx` — 内联 `<style>` 加 `.analyze-results-wide` + `.analyze-cols` 新 grid + `.analyze-col-right` sticky + 缩略图小图样式

**构建**
- `frontend/dist/*` — `npm run build` 后 commit

---

## Task 1: 新组件 `ImageViewer.tsx`

**Files:**
- Create: `frontend/src/components/ImageViewer.tsx`

- [ ] **Step 1: 创建组件文件,写完整实现**

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadBase64, tsName, chartMime } from "../lib/download";

interface Chart {
  png: string;   // base64, 内嵌用于展示
  data: string;  // base64, 用户选择的 ext 格式,用于下载
  ext: string;   // "png" | "svg" | "pdf" 等
}

interface ImageViewerProps {
  charts: Chart[];
  index: number;
  captions?: string[];
  onClose: () => void;
  onNav?: (nextIndex: number) => void;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const WHEEL_IN = 1.25;
const WHEEL_OUT = 0.8;

export default function ImageViewer({ charts, index, captions, onClose, onNav }: ImageViewerProps) {
  const current = charts[index];
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const resetFit = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  // 换图/开关 viewer 时重置 fit
  useEffect(() => {
    resetFit();
  }, [index, resetFit]);

  // 键盘: Esc 关, ←/→ 翻图
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (!onNav) return;
      if (e.key === "ArrowLeft" && index > 0) { e.preventDefault(); onNav(index - 1); }
      else if (e.key === "ArrowRight" && index < charts.length - 1) { e.preventDefault(); onNav(index + 1); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, charts.length, onClose, onNav]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = e.deltaY < 0 ? WHEEL_IN : WHEEL_OUT;
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    if (nextScale === scale) return;
    // 鼠标相对 canvas 中心
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    // 保持鼠标下的图像点不动: 平移量按 scale 变化调整
    const k = nextScale / scale - 1;
    setTx(tx - cx * k);
    setTy(ty - cy * k);
    setScale(nextScale);
  }, [scale, tx, ty]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (scale <= 1) return; // 不放大时不允许拖
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, tx, ty };
  };
  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging || !dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setTx(dragStart.current.tx + dx);
    setTy(dragStart.current.ty + dy);
  };
  const onMouseUp = () => { setDragging(false); dragStart.current = null; };

  const onDoubleClick = () => resetFit();

  const download = () => {
    downloadBase64(tsName(`图${index + 1}`, current.ext), current.data, chartMime(current.ext));
  };

  return (
    <div
      className="img-viewer-overlay"
      data-testid="img-viewer"
      onClick={onClose}
    >
      <div
        className="img-viewer-content"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="img-viewer-close"
          data-testid="img-viewer-close"
          onClick={onClose}
          aria-label="关闭"
        >
          ✕
        </button>
        <div
          className={`img-viewer-canvas${dragging ? " dragging" : ""}`}
          ref={canvasRef}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onDoubleClick={onDoubleClick}
        >
          <img
            src={`data:image/png;base64,${current.png}`}
            alt={`图 ${index + 1}`}
            data-testid="img-viewer-image"
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              cursor: scale > 1 ? (dragging ? "grabbing" : "grab") : "default",
            }}
            draggable={false}
          />
        </div>
        <div className="img-viewer-toolbar">
          {charts.length > 1 && onNav && (
            <>
              <button
                className="img-viewer-nav"
                data-testid="img-viewer-prev"
                onClick={() => onNav(index - 1)}
                disabled={index === 0}
                aria-label="上一张"
              >‹</button>
              <span className="img-viewer-count">{index + 1} / {charts.length}</span>
              <button
                className="img-viewer-nav"
                data-testid="img-viewer-next"
                onClick={() => onNav(index + 1)}
                disabled={index === charts.length - 1}
                aria-label="下一张"
              >›</button>
            </>
          )}
          <span className="img-viewer-caption">{captions?.[index] ?? ""}</span>
          <span className="img-viewer-scale">{Math.round(scale * 100)}%</span>
          <button
            className="img-viewer-download"
            data-testid="img-viewer-download"
            onClick={download}
          >下载 {current.ext.toUpperCase()}</button>
        </div>
      </div>
      <style>{`
        .img-viewer-overlay {
          position: fixed; inset: 0; z-index: 1000;
          background: rgba(0, 0, 0, 0.85);
          display: flex; align-items: center; justify-content: center;
          animation: img-viewer-fadein 200ms ease-out;
        }
        @keyframes img-viewer-fadein { from { opacity: 0; } to { opacity: 1; } }
        .img-viewer-content {
          position: relative; width: 90vw; height: 90vh;
          display: flex; flex-direction: column;
        }
        .img-viewer-close {
          position: absolute; top: 8px; right: 8px; z-index: 2;
          background: rgba(255, 255, 255, 0.15); color: #fff;
          border: none; border-radius: 50%;
          width: 32px; height: 32px; font-size: 16px;
          cursor: pointer; line-height: 1;
        }
        .img-viewer-close:hover { background: rgba(255, 255, 255, 0.28); }
        .img-viewer-canvas {
          flex: 1; overflow: hidden;
          display: flex; align-items: center; justify-content: center;
          user-select: none;
        }
        .img-viewer-canvas img {
          max-width: 100%; max-height: 100%; object-fit: contain;
          transform-origin: center center;
          transition: transform 40ms linear;
          will-change: transform;
        }
        .img-viewer-canvas.dragging img { transition: none; }
        .img-viewer-toolbar {
          display: flex; align-items: center; gap: 12px;
          padding: 8px 16px; color: #fff;
          background: rgba(0, 0, 0, 0.45);
        }
        .img-viewer-toolbar .img-viewer-nav {
          background: rgba(255, 255, 255, 0.15); color: #fff;
          border: none; border-radius: 4px;
          width: 28px; height: 28px; font-size: 18px;
          cursor: pointer; line-height: 1;
        }
        .img-viewer-toolbar .img-viewer-nav:disabled {
          opacity: 0.35; cursor: not-allowed;
        }
        .img-viewer-toolbar .img-viewer-nav:not(:disabled):hover {
          background: rgba(255, 255, 255, 0.28);
        }
        .img-viewer-toolbar .img-viewer-count { font-size: 13px; opacity: 0.85; }
        .img-viewer-toolbar .img-viewer-caption {
          flex: 1; font-size: 13px; opacity: 0.9;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .img-viewer-toolbar .img-viewer-scale {
          font-size: 12px; opacity: 0.75; min-width: 44px; text-align: right;
        }
        .img-viewer-toolbar .img-viewer-download {
          background: rgba(255, 255, 255, 0.15); color: #fff;
          border: none; border-radius: 4px;
          padding: 4px 10px; font-size: 12.5px; cursor: pointer;
        }
        .img-viewer-toolbar .img-viewer-download:hover {
          background: rgba(255, 255, 255, 0.28);
        }
      `}</style>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `cd C:\Users\Administrator\Desktop\scientific-discover\frontend && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "ImageViewer|error" | head -20`
Expected: 0 errors from `ImageViewer.tsx` (unused-file warnings are OK — it's not imported yet).

如果报 `downloadBase64/tsName/chartMime` 找不到,先 `grep -n "export.*downloadBase64\|export.*tsName\|export.*chartMime" frontend/src/lib/download.ts` 确认导出名。GeneralResults.tsx 里已经用了这三个函数,所以它们必然存在。

- [ ] **Step 3: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add frontend/src/components/ImageViewer.tsx
git commit -m "$(cat <<'EOF'
feat(analyze): 新增 ImageViewer 全屏放大预览组件

滚轮以鼠标位置为锚点缩放(0.25-8x),支持拖拽平移、
键盘 Esc/←/→ 翻图、双击一键 fit、右下角显缩放百分比。
样式与组件同文件 co-locate。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `GeneralResults.tsx` 挂载 ImageViewer + 缩略图 onClick + 宽版 wrapper

**Files:**
- Modify: `frontend/src/modules/analyze/GeneralResults.tsx`

- [ ] **Step 1: 引入 ImageViewer + state**

在文件顶部 imports 加(第 4 行 `import EditableMarkdown from "../../components/EditableMarkdown";` 之后):

```typescript
import ImageViewer from "../../components/ImageViewer";
```

在 `useState` 声明区(P14 后现在是 `const [popup, setPopup] = useState<...>(null);` 那一段附近)追加:

```typescript
const [viewer, setViewer] = useState<{ index: number } | null>(null);
```

- [ ] **Step 2: 给 analyze 模式的缩略图 figure 加 onClick,download 按钮阻止冒泡**

定位 analyze 模式渲染 charts 的 `.charts` 区块(P14 后大约在原第 149-183 行位置,现在因 P14 追加 popup 而更靠下,搜索 `<figure key={i} className="chart">` 定位)。

把整个 figure 从:

```tsx
<figure key={i} className="chart">
  <img src={`data:image/png;base64,${c.png}`} alt={`图 ${i + 1}`} data-testid={`chart-${i}`} />
  <figcaption>
    {captions[i] && <p className="chart-caption" data-testid={`chart-caption-${i}`}>{captions[i]}</p>}
    <button
      className="btn-ghost btn-sm"
      data-testid={`chart-download-${i}`}
      onClick={() => downloadBase64(tsName(`图${i + 1}`, c.ext), c.data, chartMime(c.ext))}
    >
      下载 {c.ext.toUpperCase()}
    </button>
  </figcaption>
</figure>
```

改为(figure 加 onClick + role/tabIndex 可访问性;download 按钮 stopPropagation):

```tsx
<figure
  key={i}
  className="chart"
  onClick={() => setViewer({ index: i })}
  role="button"
  tabIndex={0}
  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setViewer({ index: i }); } }}
>
  <img src={`data:image/png;base64,${c.png}`} alt={`图 ${i + 1}`} data-testid={`chart-${i}`} />
  <figcaption>
    {captions[i] && <p className="chart-caption" data-testid={`chart-caption-${i}`}>{captions[i]}</p>}
    <button
      className="btn-ghost btn-sm"
      data-testid={`chart-download-${i}`}
      onClick={(e) => { e.stopPropagation(); downloadBase64(tsName(`图${i + 1}`, c.ext), c.data, chartMime(c.ext)); }}
    >
      下载 {c.ext.toUpperCase()}
    </button>
  </figcaption>
</figure>
```

- [ ] **Step 3: 同一处理 draw 模式的 figure**

定位 P14 加入的 draw 短路块(搜索 `data-testid="analysis-block-draw"`)。draw 模式里也有一个 `<figure key={i} className="chart">`。改为(不含 figcaption 里的额外 caption,只有下载按钮):

```tsx
<figure
  key={i}
  className="chart"
  onClick={() => setViewer({ index: i })}
  role="button"
  tabIndex={0}
  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setViewer({ index: i }); } }}
>
  <img src={`data:image/png;base64,${c.png}`} alt={`图 ${i + 1}`} data-testid={`chart-${i}`} />
  <figcaption>
    <button
      className="btn-ghost btn-sm"
      data-testid={`chart-download-${i}`}
      onClick={(e) => { e.stopPropagation(); downloadBase64(tsName(`图${i + 1}`, c.ext), c.data, chartMime(c.ext)); }}
    >
      下载 {c.ext.toUpperCase()}
    </button>
  </figcaption>
</figure>
```

- [ ] **Step 4: 在 draw 短路块的返回 fragment 末尾挂 ImageViewer**

Draw 短路块当前结构是:

```tsx
if (mode === "draw" && chartType === "general") {
  return (
    <>
      {status && (...)}
      {error && (...)}
      {charts.length > 0 && (...)}
      {!charts.length && !running && !error && (...)}
    </>
  );
}
```

在最后一个 `{...}` 之后、`</>` 之前追加:

```tsx
      {viewer && charts.length > 0 && (
        <ImageViewer
          charts={charts}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onNav={(i) => setViewer({ index: i })}
        />
      )}
```

- [ ] **Step 5: 在 analyze 模式主返回块末尾挂 ImageViewer**

主 return 结构末尾(在最后一个 popup 渲染 `{popup === "quality" && ...}` 之后、组件根 `</>`前),追加:

```tsx
      {viewer && charts.length > 0 && (
        <ImageViewer
          charts={charts}
          index={viewer.index}
          captions={captions}
          onClose={() => setViewer(null)}
          onNav={(i) => setViewer({ index: i })}
        />
      )}
```

注意 analyze 模式传 `captions`,draw 模式不传(draw 不生成图注)。

- [ ] **Step 6: 用 `.analyze-results-wide` 包住 popbar + disclaimer + analyze-cols**

定位 `{hasResult && (` 那一段。原本它直接包 popbar / disclaimer / analyze-cols。在最外层 `<>`(fragment)内加 `<div className="analyze-results-wide">` 包起来,末尾对应关。

原样(P14 后):

```tsx
{hasResult && (
  <>
    {/* popbar */}
    {(plan.length > 0 || code || ...) && (
      <div className="analyze-popbar" ...>...</div>
    )}
    <div className="analyze-disclaimer" ...>...</div>
    <div className="analyze-cols" ...>...</div>
  </>
)}
```

改为:

```tsx
{hasResult && (
  <div className="analyze-results-wide">
    {/* popbar */}
    {(plan.length > 0 || code || ...) && (
      <div className="analyze-popbar" ...>...</div>
    )}
    <div className="analyze-disclaimer" ...>...</div>
    <div className="analyze-cols" ...>...</div>
  </div>
)}
```

**注意**:根 fragment 换成 `<div>`,后续的 popup 渲染(`{popup === ...}` 等)需要**移出这个 `<div>`**——它们是 modal,不该被 wide wrapper 的宽度约束。所以整体结构变为:

```tsx
return (
  <>
    {status && (...)}
    {error && (...)}
    {hasResult && (
      <div className="analyze-results-wide">
        {/* popbar / disclaimer / analyze-cols */}
      </div>
    )}
    {/* 所有 popup 渲染 */}
    {popup === "plan" && ...}
    {popup === "code" && ...}
    {popup === "output" && ...}
    {popup === "method" && ...}
    {popup === "assumption" && ...}
    {popup === "quality" && ...}
    {/* ImageViewer 也在 fragment 顶层 */}
    {viewer && charts.length > 0 && (
      <ImageViewer .../>
    )}
  </>
);
```

原本 popup 就已经在 `hasResult` 之外的 fragment 顶层,不用动。**只是把 hasResult 里面从 `<>` 变成 `<div className="analyze-results-wide">`**。

- [ ] **Step 7: 类型检查**

Run: `cd C:\Users\Administrator\Desktop\scientific-discover\frontend && npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`
Expected: 0 errors.

如果报 `viewer` 使用相关错误,回头检查 state 声明是否有 typo。

- [ ] **Step 8: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add frontend/src/modules/analyze/GeneralResults.tsx
git commit -m "$(cat <<'EOF'
feat(analyze): GeneralResults 挂 ImageViewer + 缩略图 onClick + wide 包装

- 缩略图 figure 加 onClick 打开 ImageViewer, 下载按钮 stopPropagation
- analyze 和 draw 两条路径都能弹放大预览
- hasResult 内层由 fragment 改成 .analyze-results-wide 包装, popup/viewer 保持顶层

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `AnalyzeModule.tsx` 加宽版 + rail CSS

**Files:**
- Modify: `frontend/src/modules/AnalyzeModule.tsx`

- [ ] **Step 1: 定位现有内联样式段**

打开 `frontend/src/modules/AnalyzeModule.tsx`。找到内联的 `<style>{...}</style>`(包含 `.analyze-cols` 定义,大约第 100-160 行)。

- [ ] **Step 2: 替换 `.analyze-cols` 相关 rule + 追加新 rule**

**替换**:

```css
/* 第二阶段: 结论左 / 图片右 两栏 */
.analyze-cols {
  display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  gap: 16px; align-items: start;
}
@media (max-width: 900px) { .analyze-cols { grid-template-columns: 1fr; } }
.analyze-col-right .analysis-block { margin-top: 0; }
.analyze-col-right .charts { display: flex; flex-direction: column; gap: 12px; }
```

为:

```css
/* 宽版结果区: 突破 .module 880px 上限, 结论拿舒适阅读带 + 缩略图右侧 sticky rail */
.analyze-results-wide {
  width: min(1200px, calc(100vw - 32px));
  margin-left: 0;  /* 左对齐, 不居中, 避免结论飘走 */
}
/* 第二阶段: 结论左 / 图片右 两栏 (宽版) */
.analyze-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 240px;
  gap: 24px; align-items: start;
}
.analyze-col-right {
  position: sticky; top: 16px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
}
.analyze-col-right .analysis-block { margin-top: 0; }
.analyze-col-right .charts { display: flex; flex-direction: column; gap: 12px; }
/* 缩略图小图化 */
.analyze-col-right .chart {
  cursor: pointer; margin: 0;
  border: 1px solid var(--line, #e3e8ef); border-radius: 8px;
  padding: 6px; background: #fff;
  transition: transform 120ms ease, box-shadow 120ms ease;
}
.analyze-col-right .chart:hover {
  transform: scale(1.015);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.analyze-col-right .chart img {
  width: 100%; max-height: 160px; object-fit: contain; display: block;
}
.analyze-col-right .chart figcaption {
  margin-top: 4px; font-size: 11.5px; text-align: right;
}
.analyze-col-right .chart-caption {
  font-size: 11px; color: var(--faint, #5b6675);
  text-align: left; margin: 4px 0;
  overflow: hidden; text-overflow: ellipsis;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
@media (max-width: 1140px) {
  .analyze-results-wide { width: 100%; }
  .analyze-cols { grid-template-columns: 1fr; }
  .analyze-col-right {
    position: static; max-height: none; overflow-y: visible;
  }
  .analyze-col-right .charts {
    flex-direction: row; flex-wrap: wrap;
  }
  .analyze-col-right .chart {
    flex: 0 0 calc(50% - 6px);
  }
}
@media (max-width: 720px) {
  .analyze-col-right .chart {
    flex: 0 0 100%;
  }
}
```

**注意**:确保原本的 `@media (max-width: 900px)` 那条已经被新 `@media (max-width: 1140px)` 取代;删干净不留残句。

- [ ] **Step 3: 快速视觉验证(启动 vite dev 或直接看类型编译)**

Run: `cd C:\Users\Administrator\Desktop\scientific-discover\frontend && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 0 errors.

CSS 不参与 tsc 编译。手工冒烟在 Task 4。

- [ ] **Step 4: Commit**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add frontend/src/modules/AnalyzeModule.tsx
git commit -m "$(cat <<'EOF'
feat(analyze): 加 .analyze-results-wide 宽版 + rail 缩略图样式

- .analyze-results-wide 突破 .module 880px, 用 min(1200px, calc(100vw-32px))
- .analyze-cols 改 minmax(0,1fr) 240px 两列
- .analyze-col-right position: sticky, 缩略图小图化 + hover 微升
- <1140px 回退单列 + 缩略图横向 flex-wrap

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 构建 + 手工冒烟

**Files:** 无源码修改(纯打包 + 人工验证)

- [ ] **Step 1: build 前端 dist**

Run: `cd C:\Users\Administrator\Desktop\scientific-discover\frontend && npm run build 2>&1 | tail -6`
Expected: `✓ built in Ns` 且 dist 更新。

- [ ] **Step 2: 手工冒烟(需启动后端)**

用 `启动科研助手.bat` 启动。逐个走:

- **A · analyze 宽版**:
  - 选 📊 数据分析,传 CSV,输入"跑一下两组的 t 检验"
  - 验证:结论明显变宽(比之前宽 ~50%);缩略图 rail 在右侧,窄小
  - 滚长结论时缩略图 rail 应粘顶(sticky)

- **B · 放大预览基本**:
  - 点击任一缩略图 → 全屏 modal 弹出,dark backdrop,图居中
  - 底部工具条:上一/下一(如多图)、页码、图注、缩放百分比、下载

- **C · 滚轮缩放锚点**:
  - 鼠标悬停在图**左上角**滚轮向上 → 图放大,鼠标下的图点保持不动(观察相对位置)
  - 反复放大/缩小 → 缩放百分比正确显示

- **D · 拖拽平移**:
  - 缩放到 2x 后,left-click 拖拽 → 图跟随移动
  - 缩放 1x 时,拖拽应无反应

- **E · 键盘**:
  - `←` 上一张;`→` 下一张;首尾禁用(灰按钮)
  - `Esc` 关闭
  - 双击图 → 恢复 1x fit

- **F · 关闭方式**:
  - 点击 backdrop(图之外空白)关闭
  - 右上 `✕` 关闭

- **G · draw 模式**:
  - 切 🎨 只画图,传 CSV,"画个柱状图"
  - 图表居中显示(无 rail);点击图 → 同样弹 modal(无 captions)

- **H · 窄屏**:
  - 浏览器窗口拉到 <1140px → 结论满宽,缩略图横排在下方 flex 换行
  - viewer 不受宽度影响,仍全屏

- [ ] **Step 3: commit dist**

```bash
cd C:\Users\Administrator\Desktop\scientific-discover
git add frontend/dist
git commit -m "$(cat <<'EOF'
build(frontend): rebuild dist for wide layout + ImageViewer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 验收清单(实施完成后自检)

- [ ] `npx tsc --noEmit` 无新错(sse/GeneralResults/DataPane/AnalyzeModule/ImageViewer 全绿)
- [ ] `npm run build` 无警告级以上错误
- [ ] Case A~H 手工冒烟通过
- [ ] `git log --oneline -6` 可看到 4 个 Task 每个至少一个 commit(共 4-5 个 commit)
- [ ] ImageViewer 组件放在 `frontend/src/components/ImageViewer.tsx`
- [ ] wide/rail 样式放 `AnalyzeModule.tsx` 内联 `<style>`,`img-viewer-*` 样式随 `ImageViewer.tsx` 走
