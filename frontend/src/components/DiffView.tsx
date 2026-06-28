// W2-3 DiffView: 原文/改后并排 line-diff 视图, 顶部"接受/拒绝/关闭"。
// YAGNI: 不做"逐句接受/拒绝", 时间紧 + 价值低。

import { diffLines } from "diff";
import { useMemo } from "react";

export interface DiffViewProps {
  original: string;
  modified: string;
  onAccept: () => void;
  onReject: () => void;
  open: boolean;
  /** 可选标题, 默认 "AI 修改预览" */
  title?: string;
}

type Row = {
  left: string;
  right: string;
  /** "same" | "add" | "del" | "change" */
  kind: "same" | "add" | "del" | "change";
};

/** 把 diffLines 结果配成左右对照表(简化版: 把连续 del+add 视为 change)。 */
function buildRows(orig: string, mod: string): Row[] {
  const parts = diffLines(orig, mod);
  const rows: Row[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      // same: 拆行各自一条
      for (const line of part.value.split("\n")) {
        if (line === "" && parts.length === 1) continue;
        rows.push({ left: line, right: line, kind: "same" });
      }
      i++;
      continue;
    }
    // del + add 连续 → change (并排同行显示)
    if (part.removed && i + 1 < parts.length && parts[i + 1].added) {
      const leftLines = part.value.split("\n");
      const rightLines = parts[i + 1].value.split("\n");
      const maxLen = Math.max(leftLines.length, rightLines.length);
      for (let k = 0; k < maxLen; k++) {
        rows.push({
          left: leftLines[k] ?? "",
          right: rightLines[k] ?? "",
          kind: "change",
        });
      }
      i += 2;
      continue;
    }
    if (part.removed) {
      for (const line of part.value.split("\n")) {
        rows.push({ left: line, right: "", kind: "del" });
      }
      i++;
      continue;
    }
    if (part.added) {
      for (const line of part.value.split("\n")) {
        rows.push({ left: "", right: line, kind: "add" });
      }
      i++;
      continue;
    }
    i++;
  }
  // 去掉首尾空行
  while (rows.length && rows[0].left === "" && rows[0].right === "" && rows[0].kind === "same") rows.shift();
  while (rows.length && rows[rows.length - 1].left === "" && rows[rows.length - 1].right === "" && rows[rows.length - 1].kind === "same") rows.pop();
  return rows;
}

export default function DiffView({
  original,
  modified,
  onAccept,
  onReject,
  open,
  title = "AI 修改预览",
}: DiffViewProps) {
  const rows = useMemo(() => (open ? buildRows(original, modified) : []), [open, original, modified]);

  if (!open) return null;

  const addedCount = rows.filter((r) => r.kind === "add" || r.kind === "change").length;
  const removedCount = rows.filter((r) => r.kind === "del" || r.kind === "change").length;

  return (
    <div className="diff-overlay" data-testid="diff-view">
      <div className="diff-modal" role="dialog" aria-modal="true">
        <div className="diff-head">
          <h2 className="diff-title">{title}</h2>
          <div className="diff-stat">
            <span className="diff-stat-add">+{addedCount}</span>
            <span className="diff-stat-del">-{removedCount}</span>
          </div>
          <div className="diff-actions">
            <button
              className="diff-btn-secondary"
              onClick={onReject}
              data-testid="diff-reject"
            >
              拒绝全部
            </button>
            <button
              className="diff-btn-primary"
              onClick={onAccept}
              data-testid="diff-accept"
            >
              接受全部
            </button>
            <button
              className="diff-btn-close"
              onClick={onReject}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
        </div>
        <div className="diff-body">
          <div className="diff-col diff-col-left">
            <div className="diff-col-head">原文</div>
            {rows.map((r, idx) => (
              <div
                key={`l-${idx}`}
                className={`diff-line diff-${r.kind === "add" ? "empty" : r.kind === "same" ? "same" : "del"}`}
              >
                <span className="diff-line-num">{idx + 1}</span>
                <span className="diff-line-text">{r.left || "\u00a0"}</span>
              </div>
            ))}
          </div>
          <div className="diff-col diff-col-right">
            <div className="diff-col-head">修改后</div>
            {rows.map((r, idx) => (
              <div
                key={`r-${idx}`}
                className={`diff-line diff-${r.kind === "del" ? "empty" : r.kind === "same" ? "same" : "add"}`}
              >
                <span className="diff-line-num">{idx + 1}</span>
                <span className="diff-line-text">{r.right || "\u00a0"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
