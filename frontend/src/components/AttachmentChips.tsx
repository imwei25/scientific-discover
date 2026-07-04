interface Props {
  files: File[];
  onRemove: (index: number) => void;
  disabled?: boolean;
  testId?: string;
}

// 附件卡片列表：横排显示 [📄 文件名 ×]，×  在 disabled 时隐藏。
// 用于替代旧的"立即解析后追加到输入框"UX。
export default function AttachmentChips({ files, onRemove, disabled, testId }: Props) {
  if (files.length === 0) return null;
  return (
    <div className="attach-chips" data-testid={testId}>
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} className="attach-chip" data-testid={testId ? `${testId}-item-${i}` : undefined}>
          <span className="attach-chip-icon">📄</span>
          <span className="attach-chip-name" title={f.name}>{f.name}</span>
          {!disabled && (
            <button
              type="button"
              className="attach-chip-remove"
              aria-label={`移除 ${f.name}`}
              data-testid={testId ? `${testId}-remove-${i}` : undefined}
              onClick={() => onRemove(i)}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
