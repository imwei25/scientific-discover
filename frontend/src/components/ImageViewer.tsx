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
