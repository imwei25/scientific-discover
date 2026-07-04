# 数据分析结果 · 宽版布局 + 图表放大预览 · 设计文档

- 日期:2026-07-04
- 涉及模块:`frontend/src/modules/analyze/GeneralResults.tsx`、`frontend/src/modules/AnalyzeModule.tsx`(内联样式)
- 新增:`frontend/src/components/ImageViewer.tsx`
- 关联前置工作:`docs/superpowers/specs/2026-07-04-analyze-intent-routing-design.md`

## 1 · 背景

前置工作(P1-P15)已经把"分析 vs 画图"意图分流做完。用户随后反馈:

- 结论区太窄——现在 `.analyze-cols` 是 `1.05fr / 0.95fr` 的 2 列布局,套在 `.module { max-width: 880px }` 里,结论只占约 450px,阅读体验狭窄
- 浏览器右侧还有大量空白没利用——想让结论区拿到更多宽度、图片"往右移"到那片空白里
- 缩略图小、点击弹放大预览、要支持鼠标滚轮缩放

## 2 · 目标

- **G1 结论宽版**:结论区拿到接近现有 `.analyze-cols` 全宽的舒适阅读宽度(~880px)
- **G2 图表右移**:图表缩略图移到 `.module` 上限之外的右侧空白 rail 区
- **G3 放大预览**:点击缩略图弹全屏 modal,鼠标滚轮缩放(以鼠标位置为锚点),可拖拽平移
- **G4 draw 模式复用**:draw 模式虽然不需要宽版布局,但点击图片同样调出 `ImageViewer`

## 3 · 版式

### 3.1 宽版容器 `.analyze-results-wide`

- 新 CSS 类,包住 P14 之后的 `.analyze-cols` 和它上方的 disclaimer、popbar
- 突破 `.module` 的 880px 上限:

  ```css
  .analyze-results-wide {
    width: min(1200px, calc(100vw - 32px));
    margin-left: 0;  /* 左对齐,不居中,避免结论飘走 */
  }
  ```

  最外侧 `.module` 保持 `max-width: 880px` 不改(不影响其它模块页)。宽版容器**只用在数据分析结果区**,通过在 `GeneralResults` 里包一层实现。

- 视口 <1140px 时,退回单列(缩略图跟随结论下方横排)

### 3.2 两列 grid

`.analyze-cols` 改为:

```css
.analyze-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 240px;
  gap: 24px;
  align-items: start;
}
@media (max-width: 1140px) {
  .analyze-cols { grid-template-columns: 1fr; }
  .analyze-col-right { position: static; }
}
```

- 左列 = 结论 + `EditableMarkdown`(占 `minmax(0, 1fr)`,自然拿到 ~880px)
- 右列 = 240px 缩略图 rail(浏览器"剩下的空间")

### 3.3 缩略图 rail

- `.analyze-col-right`:`position: sticky; top: 16px;`——滚结论时跟随
- 每个 `figure`:
  - 宽 100%(即 240px)
  - `<img>` `object-fit: contain; max-height: 160px;`
  - 悬停:`transform: scale(1.02); box-shadow: ...`
  - `cursor: pointer`
- 每张图下方保留:序号"图 1"、下载按钮
- **点击整个 figure 打开 `ImageViewer`**——不只是图,方便触达
- 生成图注按钮 + 全部下载按钮 保留在 rail 顶部

## 4 · `ImageViewer` 组件

**文件**:`frontend/src/components/ImageViewer.tsx`(新)

### 4.1 API

```typescript
interface ImageViewerProps {
  charts: { png: string; data: string; ext: string }[];
  index: number;             // 当前显示的第几张
  captions?: string[];
  onClose: () => void;
  onNav?: (nextIndex: number) => void;  // 键盘/按钮切图
}
```

调用方(`GeneralResults`):

```tsx
{viewer && (
  <ImageViewer
    charts={charts}
    index={viewer.index}
    captions={captions}
    onClose={() => setViewer(null)}
    onNav={(i) => setViewer({ index: i })}
  />
)}
```

### 4.2 交互

| 交互 | 行为 |
|---|---|
| 打开 | 淡入 overlay 200ms;图 fit-to-viewport `max-width: 90vw; max-height: 82vh` |
| 滚轮向上 | 缩放 ×1.25,以**鼠标当前位置**为锚点 |
| 滚轮向下 | 缩放 ×0.8,同锚 |
| 缩放范围 | 0.25× ~ 8× |
| 鼠标按下拖拽 | 平移(仅当缩放 >1×) |
| 双击 | 一键 fit(缩放回 1×,居中) |
| `←` / `→` | 上一张 / 下一张(只在 `charts.length > 1` 时) |
| `Esc` | 关闭 |
| 点击背景(非图) | 关闭 |
| 右上 `×` | 关闭 |
| 底部工具条 | `图 N/M · <caption>` + `下载 EXT` 按钮 + 计数(1/3) |

### 4.3 缩放锚点数学

以鼠标位置为锚点缩放的核心公式:

```typescript
// state
const [scale, setScale] = useState(1);
const [tx, setTx] = useState(0);  // translate
const [ty, setTy] = useState(0);

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.25 : 0.8;
  const nextScale = Math.min(8, Math.max(0.25, scale * factor));
  const rect = imgWrapperRef.current!.getBoundingClientRect();
  const cx = e.clientX - rect.left - rect.width / 2;   // 鼠标相对图中心
  const cy = e.clientY - rect.top  - rect.height / 2;
  // 保持鼠标下的图像点不动 → 平移量按 scale 变化调整
  const k = nextScale / scale - 1;
  setTx(tx - cx * k);
  setTy(ty - cy * k);
  setScale(nextScale);
}
```

### 4.4 结构

```tsx
<div className="img-viewer-overlay" onClick={onClose} onKeyDown={onKey}>
  <div className="img-viewer-content" onClick={(e) => e.stopPropagation()}>
    <button className="img-viewer-close" onClick={onClose}>✕</button>
    <div
      className="img-viewer-canvas"
      ref={canvasRef}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      <img
        src={`data:image/png;base64,${current.png}`}
        style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
        draggable={false}
      />
    </div>
    <div className="img-viewer-toolbar">
      {charts.length > 1 && (
        <>
          <button onClick={() => onNav?.(prevIdx)} disabled={index === 0}>‹</button>
          <span>{index + 1} / {charts.length}</span>
          <button onClick={() => onNav?.(nextIdx)} disabled={index === charts.length - 1}>›</button>
        </>
      )}
      <span className="img-viewer-caption">{captions?.[index]}</span>
      <button onClick={download}>下载 {current.ext.toUpperCase()}</button>
    </div>
  </div>
</div>
```

### 4.5 键盘捕获

- 组件挂载时 `document.addEventListener("keydown", onKey)`,卸载时移除
- `onKey` 分发:`Escape → onClose`;`ArrowLeft / ArrowRight → onNav`

### 4.6 样式

**样式归位**:`.img-viewer-*` 全部随 `ImageViewer.tsx` 一起走(该组件内部一段 `<style>` 或 styled 段),co-locate 便于维护。`.analyze-results-wide` / `.analyze-cols` / `.analyze-col-right` 的宽版覆盖放在 `AnalyzeModule.tsx` 内联 `<style>` 里(挨着现有 analyze 样式)。约:

```css
.img-viewer-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.85);
  display: flex; align-items: center; justify-content: center;
  animation: fadein 200ms ease-out;
}
.img-viewer-content {
  position: relative; width: 90vw; height: 90vh;
  display: flex; flex-direction: column;
}
.img-viewer-canvas {
  flex: 1; overflow: hidden; display: flex;
  align-items: center; justify-content: center;
  cursor: grab; user-select: none;
}
.img-viewer-canvas:active { cursor: grabbing; }
.img-viewer-canvas img {
  max-width: 100%; max-height: 100%; object-fit: contain;
  transition: transform 40ms linear;  /* 40ms 让 zoom 更平滑但不 laggy */
}
.img-viewer-close {
  position: absolute; top: 8px; right: 8px; z-index: 1;
  background: rgba(255,255,255,0.15); color: #fff;
  border: none; border-radius: 50%; width: 32px; height: 32px;
  cursor: pointer; font-size: 18px;
}
.img-viewer-toolbar {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 16px; color: #fff;
  background: rgba(0,0,0,0.4);
}
.img-viewer-caption { flex: 1; font-size: 13px; opacity: 0.9; }
@keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
```

## 5 · `GeneralResults` 改动

### 5.1 State

```typescript
const [viewer, setViewer] = useState<{ index: number } | null>(null);
```

### 5.2 缩略图 `<figure>` 加 `onClick`

```tsx
<figure key={i} className="chart" onClick={() => setViewer({ index: i })}>
  ...
</figure>
```

下载按钮阻止事件冒泡(避免点下载也开 viewer):

```tsx
<button
  onClick={(e) => { e.stopPropagation(); downloadBase64(...); }}
  ...
>下载 {c.ext.toUpperCase()}</button>
```

### 5.3 draw 模式短路

P14 引入的 draw 短路分支同样加 `onClick={() => setViewer(...)}` 和渲染 `<ImageViewer>`,但**不用宽版容器**——draw 模式没有结论,居中显示图表更清爽。

### 5.4 宽版容器包装

analyze 模式的 `hasResult` 分支渲染时,把 popbar + disclaimer + analyze-cols 一起包在 `<div className="analyze-results-wide">` 里。

## 6 · 响应式

| 视口宽度 | 版式 |
|---|---|
| ≥ 1140px | 宽版:结论左 + 240px 缩略图 rail 右 |
| 900-1139px | 单列:结论上,缩略图横排下方(缩略图 flex 换行) |
| < 900px | 单列:与现有窄屏行为一致 |

`ImageViewer` overlay 全屏适配所有视口。

## 7 · 边界与错误

| 场景 | 行为 |
|---|---|
| 空 charts 数组 | viewer 不能被打开;缩略图 rail 不渲染 |
| viewer 打开时用户切 tab/mode | `viewer` state 存在于 `GeneralResults`,切 mode 会 remount → 自动关闭 |
| png 损坏 → `<img onError>` | 显示占位;不阻塞其它图 |
| 键盘输入焦点在其它 input | Esc 全局仍关 viewer(捕获阶段监听)—— OK |
| viewer 内滚动误伤 | `wheel` 事件 `preventDefault()`,不让页面滚 |

## 8 · 测试

**手工冒烟(实施完后跑一遍)**:
- (a) analyze 模式:结论明显变宽;右侧缩略图 rail;滚长结论时 rail sticky
- (b) 点击缩略图 → 大图 modal 弹出;滚轮缩放以鼠标位置为锚;左键拖拽平移
- (c) 键盘:`←/→` 翻图、`Esc` 关闭
- (d) draw 模式:居中图表点击也弹 modal
- (e) 缩到 900-1139px:回退单列,缩略图横排在下
- (f) 双击图片 → 恢复 1× fit

**不加自动化测试**——纯 UI 交互,手工验证成本更低。

## 9 · 非目标

- 不做图片编辑(裁剪/旋转)
- 不做多图对比(两图并列)
- 不改变现有下载逻辑
- 不改变 popbar 里的 3 个透明化 popup(那是 P14 的成果)
- 不做 pinch-zoom(触控)——桌面场景优先,触控可后续

## 10 · 落地清单

**新增**:
- `frontend/src/components/ImageViewer.tsx`

**修改**:
- `frontend/src/modules/analyze/GeneralResults.tsx`(加 viewer state + wide wrapper + onClick)
- `frontend/src/modules/AnalyzeModule.tsx`(内联样式加 `.analyze-results-wide` + 缩略图 rail 覆盖)

**部署**:
- `npm run build` + commit dist(遵循 MEMORY.md)

## 11 · 已做但没问的判断

1. **突破 `.module` 用新 wrapper 而非改 `.module`**——避免影响其它模块页
2. **右列 sticky**——长结论时避免用户来回滚找图
3. **滚轮缩放锚定鼠标位置**——匹配 Figma / Photoshop 直觉
4. **视口 <1140px 回退单列**——避免右列越界
5. **draw 模式不套 wide wrapper**——没有结论,居中更清爽,但仍能弹放大预览
