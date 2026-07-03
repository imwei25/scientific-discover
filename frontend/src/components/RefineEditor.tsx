import { useEffect, useMemo, useRef, useState } from "react";
import Markdown, { type CiteInfo, wrapHighlights } from "./Markdown";
import { surgicalEdit, type EditPatch, type Reference } from "../lib/sse";

// 一处改动的高亮区间(相对当前正文的字符偏移) + 说明。
interface HLRange {
  start: number;
  end: number;
  note?: string;
}

// 把补丁按顺序应用到 base 文本上, 同步维护高亮区间(老区间随插入/删除偏移平移)。
// 返回新文本、新高亮区间, 以及成功/跳过数。补丁 find 若在当前文本找不到则跳过。
function applyPatches(
  text: string,
  ranges: HLRange[],
  patches: EditPatch[],
): { text: string; ranges: HLRange[]; applied: number; skipped: number } {
  let work = text;
  let rs: HLRange[] = ranges.map((r) => ({ ...r }));
  let applied = 0;
  let skipped = 0;
  for (const p of patches) {
    if (!p.find) {
      skipped++;
      continue;
    }
    const idx = work.indexOf(p.find);
    if (idx === -1) {
      skipped++;
      continue;
    }
    const findLen = p.find.length;
    const repLen = p.replace.length;
    work = work.slice(0, idx) + p.replace + work.slice(idx + findLen);
    const delta = repLen - findLen;
    const endOld = idx + findLen;
    // 位于本次替换之后的旧高亮区间整体平移; 之前的不动(补丁互不重叠)。
    rs = rs.map((r) => (r.start >= endOld ? { start: r.start + delta, end: r.end + delta, note: r.note } : r));
    rs.push({ start: idx, end: idx + repLen, note: p.note });
    applied++;
  }
  return { text: work, ranges: rs, applied, skipped };
}

// AI 精修编辑器: 生成完毕后, 对文档做【精准局部修改】而非重写全文。
//   - 在左侧源码里选中一段 → "AI 修改选中"只重写这段;
//   - 或不选中、直接写修改意见 → AI 返回若干处最小补丁;
//   - 改动处在右侧预览里【背景标黄】, 可【撤回】上一步, 也可手动编辑源码。
// text/onChange 让父组件持有正文(导出/核验用改后的); refs 给引用类修改当上下文。
export default function RefineEditor({
  text,
  onChange,
  refs = [],
  refInfo,
  testid = "refine",
}: {
  text: string;
  onChange: (next: string) => void;
  refs?: Reference[];
  refInfo?: Record<string, CiteInfo>;
  testid?: string;
}) {
  const [src, setSrc] = useState(text);
  const [ranges, setRanges] = useState<HLRange[]>([]);
  const [undo, setUndo] = useState<{ src: string; ranges: HLRange[] }[]>([]);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [hasSel, setHasSel] = useState(false);

  // 只在编辑器「干净」(无待处理标黄、无可撤回步骤)时, 才从父组件正文同步进来。
  // 这样: 新生成文档 / 外部手动改动会被采纳; 而我们自己刚 AI 改动(有标黄)后,
  // 父组件因写回而重算出的正文不会反过来清掉我们的标黄。
  useEffect(() => {
    if (ranges.length === 0 && undo.length === 0 && text !== src) {
      setSrc(text);
      setNote("");
      setErr("");
    }
  }, [text, src, ranges.length, undo.length]);

  const commit = (nextSrc: string, nextRanges: HLRange[]) => {
    setSrc(nextSrc);
    setRanges(nextRanges);
    onChange(nextSrc);
  };

  const syncSel = () => {
    const ta = taRef.current;
    setHasSel(!!ta && ta.selectionEnd > ta.selectionStart);
  };

  const run = async () => {
    const ins = instruction.trim();
    if (!ins || busy) return;
    setBusy(true);
    setErr("");
    setNote("");
    const ta = taRef.current;
    const selection = ta && ta.selectionEnd > ta.selectionStart ? src.slice(ta.selectionStart, ta.selectionEnd) : "";
    try {
      const res = await surgicalEdit({ text: src, instruction: ins, selection, references: refs });
      if (!res.edits.length) {
        setNote(res.note || "AI 没有给出可应用的改动。");
        return;
      }
      const applied = applyPatches(src, ranges, res.edits);
      if (applied.applied === 0) {
        setNote("AI 返回的改动无法在当前正文定位（可能正文已改动），未应用。");
        return;
      }
      setUndo((u) => [...u, { src, ranges }]);
      commit(applied.text, applied.ranges);
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
    if (!undo.length) return;
    const prev = undo[undo.length - 1];
    setUndo((u) => u.slice(0, -1));
    commit(prev.src, prev.ranges);
    setNote("已撤回上一步改动。");
  };

  // 手动编辑源码: 高亮区间无法可靠跟随任意输入, 直接清空标黄并提交。
  const onManual = (v: string) => {
    setSrc(v);
    setRanges([]);
    onChange(v);
  };

  const preview = useMemo(() => wrapHighlights(src, ranges), [src, ranges]);

  return (
    <details className="refine-editor" data-testid={testid}>
      <summary>
        ✏️ AI 精修（选中一段或直接提意见 · 改动标黄 · 可撤回）
        {ranges.length > 0 && <span className="refine-count">{ranges.length} 处改动</span>}
      </summary>
      <div className="refine-hint">
        在左侧「源码」里<strong>选中一段</strong>再点“AI 修改”，就只改这一段；不选中则按你的意见给出若干处最小改动。
        AI 用代码执行替换（不重写全文），改动在右侧预览<mark className="ai-edit">背景标黄</mark>，可随时“撤回”。
      </div>
      <div className="refine-toolbar">
        <textarea
          className="refine-instruction"
          data-testid={`${testid}-instruction`}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={hasSel ? "对选中段落的修改意见，例如：更学术、补上机制细节" : "修改意见，例如：删掉空话套话 / 把第二段引用补齐 / 摘要更凝练"}
          rows={2}
          disabled={busy}
        />
        <div className="refine-actions">
          <button
            className="btn-primary btn-sm"
            data-testid={`${testid}-run`}
            onClick={run}
            disabled={busy || !instruction.trim()}
          >
            {busy ? "精修中…" : hasSel ? "AI 修改选中" : "按意见修改"}
          </button>
          <button
            className="btn-ghost btn-sm"
            data-testid={`${testid}-undo`}
            onClick={doUndo}
            disabled={busy || !undo.length}
            title="回退上一步 AI 改动"
          >
            撤回{undo.length ? `（${undo.length}）` : ""}
          </button>
          {ranges.length > 0 && (
            <button
              className="btn-ghost btn-sm"
              data-testid={`${testid}-clear`}
              onClick={() => setRanges([])}
              disabled={busy}
              title="接受改动并清除标黄"
            >
              清除标黄
            </button>
          )}
        </div>
      </div>
      {err && <div className="result-error">{err}</div>}
      {note && <div className="refine-note">{note}</div>}
      <div className="refine-panes">
        <div className="refine-pane">
          <div className="refine-pane-label">源码（可选中）</div>
          <textarea
            ref={taRef}
            className="refine-src"
            data-testid={`${testid}-src`}
            value={src}
            onChange={(e) => onManual(e.target.value)}
            onSelect={syncSel}
            onKeyUp={syncSel}
            onMouseUp={syncSel}
            spellCheck={false}
          />
        </div>
        <div className="refine-pane">
          <div className="refine-pane-label">预览（改动标黄）</div>
          <div className="refine-preview">
            <Markdown highlight refInfo={refInfo}>
              {preview}
            </Markdown>
          </div>
        </div>
      </div>
    </details>
  );
}
