import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Markdown, { CiteInfo, wrapHighlights } from "./Markdown";
import DeaiPanel from "./DeaiPanel";
import { surgicalEdit, type EditPatch, type Reference } from "../lib/sse";

// 编辑器较重(TipTap + ProseMirror), 懒加载: 只在首次进入编辑时才拉进 bundle。
const CanvasEditor = lazy(() => import("./CanvasEditor"));

// 一处改动的高亮区间(相对当前正文的字符偏移) + 说明。
interface HLRange { start: number; end: number; note?: string }

// 把补丁按顺序应用到 base 文本上, 同步维护高亮区间(老区间随插入/删除偏移平移)。
function applyPatches(text: string, ranges: HLRange[], patches: EditPatch[]): { text: string; ranges: HLRange[]; applied: number; skipped: number } {
  let work = text;
  let rs: HLRange[] = ranges.map((r) => ({ ...r }));
  let applied = 0;
  let skipped = 0;
  for (const p of patches) {
    if (!p.find) { skipped++; continue; }
    const idx = work.indexOf(p.find);
    if (idx === -1) { skipped++; continue; }
    const findLen = p.find.length;
    const repLen = p.replace.length;
    work = work.slice(0, idx) + p.replace + work.slice(idx + findLen);
    const delta = repLen - findLen;
    const endOld = idx + findLen;
    rs = rs.map((r) => (r.start >= endOld ? { start: r.start + delta, end: r.end + delta, note: r.note } : r));
    rs.push({ start: idx, end: idx + repLen, note: p.note });
    applied++;
  }
  return { text: work, ranges: rs, applied, skipped };
}

interface Props {
  value: string;
  onSave?: (md: string) => void;       // 不传则纯只读
  running?: boolean;                    // 流式生成中: 不显示编辑入口
  placeholder?: string;
  testId?: string;                      // 透传给只读容器, 保持既有选择器不变
  refInfo?: Record<string, CiteInfo>;   // 引用悬浮卡数据(支持句/文献要点), 透传给只读渲染
  deaiStyle?: string;                   // 文风档案, 透传给 DeaiPanel 让"去AI味"也向样例靠拢
  // 直接作用在正文上的 AI 精修(不再分源码/预览): 在预览里选中一段或直接提意见, 改动就地标黄, 可撤回。
  enableRefine?: boolean;
  refs?: Reference[];
  refineTestId?: string;
}

// 读模式沿用 <Markdown> 渲染; 点「编辑」切到所见即所得编辑器, 保存写回 onSave。
export default function EditableMarkdown({ value, onSave, running, placeholder, testId, refInfo, deaiStyle, enableRefine, refs = [], refineTestId = "refine" }: Props) {
  const [editing, setEditing] = useState(false);
  const canEdit = !!onSave && !!value && !running;

  // —— AI 精修状态(就地标黄 + 撤回) ——
  const [ranges, setRanges] = useState<HLRange[]>([]);
  const [undo, setUndo] = useState<{ ranges: HLRange[]; text: string }[]>([]);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const baseRef = useRef(value); // 我们上次提交出的正文; 用于识别"外部改动"以清空标黄
  const previewRef = useRef<HTMLDivElement | null>(null);

  // 外部把 value 改成了不是我们产出的版本(新生成/编辑/去AI味) → 清掉标黄与撤回栈。
  useEffect(() => {
    if (value !== baseRef.current) {
      baseRef.current = value;
      if (ranges.length || undo.length) { setRanges([]); setUndo([]); }
    }
  }, [value]);

  const runRefine = async () => {
    const ins = instruction.trim();
    if (!ins || busy || !onSave) return;
    setBusy(true); setErr(""); setNote("");
    // 选中的正文文本(从预览里直接选)作为局部修改范围; 没选中则全局给若干处最小改动。
    let selection = "";
    const sel = window.getSelection();
    if (sel && sel.toString() && previewRef.current && sel.anchorNode && previewRef.current.contains(sel.anchorNode)) {
      selection = sel.toString();
    }
    try {
      const res = await surgicalEdit({ text: value, instruction: ins, selection, references: refs });
      if (!res.edits.length) { setNote(res.note || "AI 没有给出可应用的改动。"); return; }
      const applied = applyPatches(value, ranges, res.edits);
      if (applied.applied === 0) { setNote("AI 返回的改动无法在当前正文定位（可能正文已改动），未应用。"); return; }
      setUndo((u) => [...u, { ranges, text: value }]);
      baseRef.current = applied.text;
      setRanges(applied.ranges);
      onSave(applied.text);
      setInstruction("");
      const parts = [`已应用 ${applied.applied} 处改动`];
      if (applied.skipped) parts.push(`${applied.skipped} 处未定位跳过`);
      if (res.note) parts.push(res.note);
      setNote(parts.join("；") + "。改动处已标黄，可撤回。");
    } catch (e) {
      setErr(`精修失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doUndo = () => {
    if (!undo.length || !onSave) return;
    const prev = undo[undo.length - 1];
    setUndo((u) => u.slice(0, -1));
    baseRef.current = prev.text;
    setRanges(prev.ranges);
    onSave(prev.text);
    setNote("已撤回上一步改动。");
  };

  if (editing && onSave) {
    return (
      <Suspense fallback={<div className="result-text"><span className="result-placeholder">正在载入编辑器…</span></div>}>
        <CanvasEditor
          value={value}
          onSave={(md) => { onSave(md); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      </Suspense>
    );
  }

  const shown = enableRefine && ranges.length ? wrapHighlights(value, ranges) : value;

  return (
    <div className="result-text" data-testid={testId}>
      {canEdit && (
        <div className="editable-head">
          <button className="btn-ghost btn-sm" data-testid="edit-btn" onClick={() => setEditing(true)} title="编辑这份产出">
            ✎ 编辑
          </button>
          <DeaiPanel value={value} onApply={onSave!} disabled={running} styleProfile={deaiStyle} />
          {enableRefine && undo.length > 0 && (
            <button className="btn-ghost btn-sm" data-testid={`${refineTestId}-undo`} onClick={doUndo} disabled={busy} title="回退上一步 AI 精修改动">
              ↩ 撤回精修（{undo.length}）
            </button>
          )}
          {enableRefine && ranges.length > 0 && (
            <button className="btn-ghost btn-sm" data-testid={`${refineTestId}-clear`} onClick={() => setRanges([])} disabled={busy} title="接受改动并清除标黄">
              清除标黄
            </button>
          )}
        </div>
      )}
      {enableRefine && canEdit && (
        <div className="refine-inline" data-testid={`${refineTestId}-bar`}>
          <span className="refine-inline-icon" title="在下方正文里选中一段再点，就只改这段；不选中则按意见给出若干处最小改动，改动就地标黄可撤回">✏️ AI 精修</span>
          <input
            className="refine-inline-input"
            data-testid={`${refineTestId}-instruction`}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="选中正文一段或直接写意见，例如：删掉空话套话 / 这段更学术 / 补上机制细节"
            disabled={busy}
            onKeyDown={(e) => { if (e.key === "Enter") runRefine(); }}
          />
          <button className="btn-primary btn-sm" data-testid={`${refineTestId}-run`} onClick={runRefine} disabled={busy || !instruction.trim()}>
            {busy ? "精修中…" : "精修"}
          </button>
        </div>
      )}
      {enableRefine && err && <div className="result-error">{err}</div>}
      {enableRefine && note && <div className="refine-note">{note}</div>}
      {value ? (
        <div ref={previewRef}>
          <Markdown refInfo={refInfo} highlight={enableRefine && ranges.length > 0 ? true : undefined}>{shown}</Markdown>
        </div>
      ) : (
        <span className="result-placeholder">{placeholder}</span>
      )}
      {running && <span className="cursor-blink">▍</span>}
    </div>
  );
}
