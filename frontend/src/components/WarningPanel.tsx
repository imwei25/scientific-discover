import { memo } from "react";

// 通用后端 SSE warning 事件展示面板。
// 后端多个模块(checklist/idea/analyze/...) 在流式过程中会 yield
//   {event: "warning", data: {message: "..."}}
// 例如 checklist 的 verify_references 幻觉回引校验、
// PHI 前置扫描的出站提示、analyze wave2 的统计一致性告警等。
// 空数组时不渲染, 有内容时以浅黄底 + 橙色左 border 提示, 支持一键清除。
interface Props {
  warnings: string[];
  onClear?: () => void;
  testId?: string;
}

function WarningPanel({ warnings, onClear, testId }: Props) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="warning-panel" data-testid={testId ?? "warning-panel"}>
      <div className="warning-panel-head">
        <div className="warning-panel-title">
          <span aria-hidden="true">⚠️</span>
          <span> 注意 · 共 {warnings.length} 条提示</span>
        </div>
        {onClear && (
          <button
            type="button"
            className="warning-panel-close"
            onClick={onClear}
            data-testid={`${testId ?? "warning-panel"}-close`}
            aria-label="关闭提示"
            title="关闭"
          >
            ×
          </button>
        )}
      </div>
      <ul className="warning-panel-list">
        {warnings.map((w, i) => (
          <li key={i} className="warning-panel-item">
            {w}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default memo(WarningPanel);
