import { lazy, Suspense, useState } from "react";
import Markdown from "./Markdown";

// 编辑器较重(TipTap + ProseMirror), 懒加载: 只在首次进入编辑时才拉进 bundle。
const CanvasEditor = lazy(() => import("./CanvasEditor"));

interface Props {
  value: string;
  onSave?: (md: string) => void;       // 不传则纯只读
  running?: boolean;                    // 流式生成中: 不显示编辑入口
  placeholder?: string;
  testId?: string;                      // 透传给只读容器, 保持既有选择器不变
}

// 读模式沿用 <Markdown> 渲染; 点「编辑」切到所见即所得编辑器, 保存写回 onSave。
export default function EditableMarkdown({ value, onSave, running, placeholder, testId }: Props) {
  const [editing, setEditing] = useState(false);
  const canEdit = !!onSave && !!value && !running;

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

  return (
    <div className="result-text" data-testid={testId}>
      {canEdit && (
        <div className="editable-head">
          <button className="btn-ghost btn-sm" data-testid="edit-btn" onClick={() => setEditing(true)} title="编辑这份产出">
            ✎ 编辑
          </button>
        </div>
      )}
      {value ? (
        <Markdown>{value}</Markdown>
      ) : (
        <span className="result-placeholder">{placeholder}</span>
      )}
      {running && <span className="cursor-blink">▍</span>}
    </div>
  );
}
