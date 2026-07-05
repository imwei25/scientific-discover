import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import AttachmentChips from "./AttachmentChips";

interface Props {
  label: string;                 // 字段标签,如 "相关资料"、"上传文献"
  hint?: string;                 // 说明文字
  textValue?: string;            // 文本 textarea 值 (仅"相关资料"型用);不传则不渲染文本框
  onTextChange?: (v: string) => void;
  pendingFiles: File[];
  onFilesAdd: (files: File[]) => void;
  onFileRemove: (index: number) => void;
  disabled?: boolean;
  accept?: string;
  testId: string;
  placeholder?: string;
  rows?: number;
}

export default function AttachmentUploadBox(props: Props) {
  const {
    label, hint, textValue, onTextChange,
    pendingFiles, onFilesAdd, onFileRemove, disabled,
    accept = ".docx,.pdf,.txt,.md", testId, placeholder, rows = 4,
  } = props;

  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const ingest = (fl: FileList | File[] | null | undefined) => {
    const list = fl ? Array.from(fl) : [];
    if (list.length === 0) return;
    onFilesAdd(list);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="field" data-testid={testId}>
      <span className="field-label">{label}</span>
      <div
        className={`combo-input${drag ? " dragover" : ""}`}
        onDragOver={(e: DragEvent) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e: DragEvent) => { e.preventDefault(); setDrag(false); ingest(e.dataTransfer.files); }}
      >
        {onTextChange !== undefined && (
          <textarea
            data-testid={`${testId}-text`}
            value={textValue || ""}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder={placeholder}
            rows={rows}
          />
        )}
        <div className="combo-foot">
          <button
            type="button" className="combo-attach"
            data-testid={`${testId}-attach`}
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
          >
            📎 添加附件 (可多选)
          </button>
          {hint && <span className="combo-hint">{hint}</span>}
          <input
            ref={fileRef}
            data-testid={`${testId}-input`}
            type="file"
            accept={accept}
            multiple
            style={{ display: "none" }}
            onChange={(e: ChangeEvent<HTMLInputElement>) => ingest(e.target.files)}
          />
        </div>
        <AttachmentChips
          files={pendingFiles}
          onRemove={onFileRemove}
          disabled={disabled}
          testId={`${testId}-chips`}
        />
      </div>
    </div>
  );
}
