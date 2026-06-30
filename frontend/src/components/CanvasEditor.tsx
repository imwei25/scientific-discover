import { useEditor, EditorContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import { toastWarn } from "../lib/toast";

// 所见即所得编辑器(懒加载): 在右侧画布里编辑 Markdown 文档,
// 支持 Word 式表格操作 + 有界撤回(最多 10 步)。保存时序列化回 Markdown。
interface Props {
  value: string;
  onSave: (md: string) => void;
  onCancel: () => void;
}

export default function CanvasEditor({ value, onSave, onCancel }: Props) {
  const editor = useEditor({
    extensions: [
      // undoRedo.depth=10 → 撤回最多保留 10 步(超出的最老操作丢弃, 即撤回上限)
      StarterKit.configure({ undoRedo: { depth: 10 } }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown,
    ],
    content: value,
    autofocus: "end",
    editorProps: { attributes: { class: "ProseMirror canvas-prose" } },
  });

  if (!editor) return null;

  const inTable = editor.isActive("table");

  // 撤回/重做: 到达上限(栈空)时提示, 不执行。
  const doUndo = () => {
    if (!editor.can().undo()) {
      toastWarn("已撤回到最早版本（最多 10 步），无法再撤回");
      return;
    }
    editor.chain().focus().undo().run();
  };
  const doRedo = () => {
    if (!editor.can().redo()) {
      toastWarn("没有可重做的操作了");
      return;
    }
    editor.chain().focus().redo().run();
  };

  // tiptap-markdown 把序列化器挂在 storage.markdown 上(其类型增强未被默认拾取, 故显式断言)
  const save = () => {
    const storage = editor.storage as unknown as { markdown: { getMarkdown: () => string } };
    onSave(storage.markdown.getMarkdown());
  };

  return (
    <div className="canvas-editor" data-testid="canvas-editor">
      <div className="editor-toolbar" role="toolbar" aria-label="编辑工具">
        <button className="btn-ghost btn-sm" onClick={doUndo} data-testid="undo-btn" title="撤回（最多 10 步）">↶ 撤回</button>
        <button className="btn-ghost btn-sm" onClick={doRedo} data-testid="redo-btn" title="重做">↷ 重做</button>
        <span className="editor-sep" aria-hidden="true" />

        <button className={`btn-ghost btn-sm ${editor.isActive("bold") ? "on" : ""}`} onClick={() => editor.chain().focus().toggleBold().run()} title="加粗"><b>B</b></button>
        <button className={`btn-ghost btn-sm ${editor.isActive("heading", { level: 2 }) ? "on" : ""}`} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="二级标题">H2</button>
        <button className={`btn-ghost btn-sm ${editor.isActive("heading", { level: 3 }) ? "on" : ""}`} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="三级标题">H3</button>
        <button className={`btn-ghost btn-sm ${editor.isActive("bulletList") ? "on" : ""}`} onClick={() => editor.chain().focus().toggleBulletList().run()} title="无序列表">• 列表</button>
        <span className="editor-sep" aria-hidden="true" />

        {/* 表格: Word 式操作。插入表格随时可用; 其余命令仅在光标位于表格内启用。 */}
        <button className="btn-ghost btn-sm" data-testid="table-insert" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="插入 3×3 表格">⊞ 插入表格</button>
        <button className="btn-ghost btn-sm" data-testid="table-add-row" onClick={() => editor.chain().focus().addRowAfter().run()} disabled={!inTable} title="在下方插入一行">＋行</button>
        <button className="btn-ghost btn-sm" onClick={() => editor.chain().focus().addRowBefore().run()} disabled={!inTable} title="在上方插入一行">行＋</button>
        <button className="btn-ghost btn-sm" data-testid="table-add-col" onClick={() => editor.chain().focus().addColumnAfter().run()} disabled={!inTable} title="在右侧插入一列">＋列</button>
        <button className="btn-ghost btn-sm" onClick={() => editor.chain().focus().addColumnBefore().run()} disabled={!inTable} title="在左侧插入一列">列＋</button>
        <button className="btn-ghost btn-sm" data-testid="table-del-row" onClick={() => editor.chain().focus().deleteRow().run()} disabled={!inTable} title="删除当前行">删行</button>
        <button className="btn-ghost btn-sm" onClick={() => editor.chain().focus().deleteColumn().run()} disabled={!inTable} title="删除当前列">删列</button>
        <button className="btn-ghost btn-sm" onClick={() => editor.chain().focus().toggleHeaderRow().run()} disabled={!inTable} title="切换表头行">表头</button>
        <button className="btn-ghost btn-sm" onClick={() => editor.chain().focus().mergeCells().run()} disabled={!inTable} title="合并所选单元格">合并</button>
        <button className="btn-ghost btn-sm" onClick={() => editor.chain().focus().splitCell().run()} disabled={!inTable} title="拆分单元格">拆分</button>
        <button className="btn-ghost btn-sm" onClick={() => editor.chain().focus().deleteTable().run()} disabled={!inTable} title="删除整个表格">删表</button>

        <span className="editor-actions">
          <button className="btn-ghost" onClick={onCancel} data-testid="cancel-btn">取消</button>
          <button className="btn-primary" onClick={save} data-testid="save-btn">保存</button>
        </span>
      </div>
      <EditorContent editor={editor} className="canvas-editor-body" data-testid="editor-body" />
    </div>
  );
}
