import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { scanAiFlavor, streamDeai, DeaiScanResult, DeaiSegmentInfo } from "../lib/sse";

// 去 AI 味: 自包含组件。渲染一个触发按钮 + 模态面板, 全流程为
//   扫描(启发式, 不调 LLM) → 逐段流式改写(可停) → 逐段采纳/保留 → 采纳后原地写回。
// 采纳/撤回都走 onApply 这条唯一写回路径, 与编辑器内撤销互不干扰(见 CanvasEditor)。
// 自带一步「撤回去AI味」: 记住采纳前的原文, 重新生成(disabled 变 true)时自动失效以防还原到过时文档。

interface Seg extends DeaiSegmentInfo {
  rewritten: string;
  streaming: boolean;
  done: boolean;
  citationWarn: boolean;
  accepted: boolean;
}

type Phase = "scanning" | "scanned" | "rewriting" | "review" | "error";

interface Props {
  value: string;               // 当前 Canvas 正文(Markdown)
  onApply: (md: string) => void; // 写回正文(采纳与撤回共用)
  disabled?: boolean;          // 生成中: 禁用入口, 并让上一次的撤回失效
}

export default function DeaiPanel({ value, onApply, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("scanning");
  const [scan, setScan] = useState<DeaiScanResult | null>(null);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [undoSnap, setUndoSnap] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // 重新生成时(disabled=生成中), 上一次的「撤回去AI味」指向的旧文档已失效, 清掉。
  useEffect(() => {
    if (disabled) setUndoSnap(null);
  }, [disabled]);

  const close = () => {
    ctrl.current?.abort();
    setOpen(false);
  };

  const openPanel = async () => {
    setOpen(true);
    setPhase("scanning");
    setError(null);
    setScan(null);
    setSegs([]);
    const res = await scanAiFlavor(value);
    setScan(res);
    setPhase("scanned");
  };

  const startRewrite = () => {
    if (!scan || scan.flagged_blocks.length === 0) return;
    setSegs([]);
    setPhase("rewriting");
    const c = new AbortController();
    ctrl.current = c;
    streamDeai(value, scan.flagged_blocks, "", {
      onSegment: (s) =>
        setSegs((prev) => [...prev, { ...s, rewritten: "", streaming: true, done: false, citationWarn: false, accepted: true }]),
      onDelta: (block, t) =>
        setSegs((prev) => prev.map((sg) => (sg.block === block ? { ...sg, rewritten: sg.rewritten + t } : sg))),
      onSegmentDone: (block, rewritten, warn) =>
        setSegs((prev) => prev.map((sg) => (sg.block === block
          ? { ...sg, rewritten, streaming: false, done: true, citationWarn: warn, accepted: !warn } // 引用有变默认不采纳
          : sg))),
      onDone: () => setPhase("review"),
      onError: (m) => { setError(m); setPhase("error"); },
      signal: c.signal,
    });
  };

  const stopRewrite = () => {
    ctrl.current?.abort();
    setPhase("review"); // 保留已完成的段落, 未完成的不参与采纳
  };

  const toggle = (block: number) =>
    setSegs((prev) => prev.map((sg) => (sg.block === block ? { ...sg, accepted: !sg.accepted } : sg)));

  const acceptedSegs = segs.filter((s) => s.done && s.accepted);

  const apply = () => {
    if (acceptedSegs.length === 0) return;
    // 从右向左替换, 保证靠前片段的 start/end 不因替换而位移。
    let out = value;
    [...acceptedSegs].sort((a, b) => b.start - a.start).forEach((s) => {
      out = out.slice(0, s.start) + s.rewritten + out.slice(s.end);
    });
    setUndoSnap(value);
    onApply(out);
    setOpen(false);
  };

  const undo = () => {
    if (undoSnap === null) return;
    onApply(undoSnap);
    setUndoSnap(null);
  };

  const flagged = scan?.flagged_blocks.length ?? 0;

  return (
    <>
      <button
        className="btn-ghost btn-sm"
        data-testid="deai-btn"
        disabled={disabled || !value}
        onClick={openPanel}
        title="扫描并去除文中的 AI 腔"
      >
        ✨ 去AI味
      </button>
      {undoSnap !== null && (
        <button className="btn-ghost btn-sm" data-testid="deai-undo-btn" onClick={undo} title="还原到去AI味之前">
          ↩ 撤回去AI味
        </button>
      )}

      {open && createPortal(
        <div className="deai-overlay" data-testid="deai-overlay" role="dialog" aria-modal="true" aria-label="去 AI 味">
          <div className="deai-modal">
            <div className="deai-modal-head">
              <strong>去 AI 味</strong>
              <button className="btn-ghost btn-sm" data-testid="deai-close-btn" onClick={close} aria-label="关闭">×</button>
            </div>

            <div className="deai-modal-body">
              {phase === "scanning" && <p className="deai-hint">正在扫描 AI 味…</p>}

              {phase === "scanned" && scan && (
                flagged === 0 ? (
                  <p className="deai-hint" data-testid="deai-scan-summary">未发现明显的 AI 味，无需改写。✓</p>
                ) : (
                  <>
                    <p className="deai-hint" data-testid="deai-scan-summary">
                      发现 <strong>{scan.stats.flagged}</strong> 处 AI 味较重的句子（共 {scan.stats.sentences} 句），涉及 {flagged} 个段落。
                    </p>
                    <ul className="deai-span-list">
                      {scan.spans.map((sp, i) => (
                        <li key={i} className="deai-span">
                          <span className="deai-span-text">{sp.sentence}</span>
                          <span className="deai-span-reasons">
                            {sp.reasons.map((r, j) => <span key={j} className="deai-tag">{r}</span>)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )
              )}

              {(phase === "rewriting" || phase === "review") && (
                <div className="deai-segs">
                  {segs.length === 0 && <p className="deai-hint">正在改写…</p>}
                  {segs.map((s) => (
                    <div className="deai-seg" data-testid="deai-seg" key={s.block}>
                      <div className="deai-seg-col">
                        <div className="deai-col-label">原文</div>
                        <div className="deai-text deai-old">{s.original}</div>
                      </div>
                      <div className="deai-seg-col">
                        <div className="deai-col-label">
                          改写{s.streaming && <span className="cursor-blink">▍</span>}
                          {s.citationWarn && <span className="deai-warn" title="改写前后引用标记不一致，请核对后再采纳">⚠ 引用有变</span>}
                        </div>
                        <div className="deai-text deai-new">{s.rewritten || (s.streaming ? "" : "（无输出）")}</div>
                        {phase === "review" && s.done && (
                          <label className="deai-accept">
                            <input type="checkbox" checked={s.accepted} onChange={() => toggle(s.block)} /> 采纳这段
                          </label>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {phase === "error" && <p className="result-error" role="alert">{error}</p>}
            </div>

            <div className="deai-modal-foot">
              {phase === "scanned" && flagged > 0 && (
                <button className="btn-primary" data-testid="deai-rewrite-btn" onClick={startRewrite}>
                  一键改写这 {flagged} 段
                </button>
              )}
              {phase === "rewriting" && (
                <button className="btn-ghost" data-testid="deai-stop-btn" onClick={stopRewrite}>停止</button>
              )}
              {phase === "review" && (
                <button className="btn-primary" data-testid="deai-apply-btn" onClick={apply} disabled={acceptedSegs.length === 0}>
                  采纳选中（{acceptedSegs.length}）
                </button>
              )}
              <button className="btn-ghost" data-testid="deai-dismiss-btn" onClick={close}>
                {phase === "review" ? "放弃" : "关闭"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
