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
              title={`移除 ${f.name} (点击后需确认)`}
              data-testid={testId ? `${testId}-remove-${i}` : undefined}
              onClick={() => {
                // 附件通常是用户刚上传/拖入的 File 对象, 未持久化 — 误删无法恢复,
                // 需二次确认避免一点即丢
                if (window.confirm(`确认移除附件「${f.name}」? 移除后需重新上传。`)) {
                  onRemove(i);
                }
              }}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
