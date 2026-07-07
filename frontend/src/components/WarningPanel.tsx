import { memo } from "react";

// 通用后端 SSE warning 事件展示面板。
// 后端多个模块(checklist/idea/analyze/...) 在流式过程中会 yield
//   {event: "warning", data: {message: "..."}}
// 例如 checklist 的 verify_references 幻觉回引校验、
// PHI 前置扫描的出站提示、analyze wave2 的统计一致性告警等。
// 空数组时不渲染, 有内容时以浅黄底 + 橙色左 border 提示, 支持一键清除。
//
// 条目可为纯字符串, 也可为带 action 的对象: 后者在该条右侧渲染一个操作按钮
// (如文献源连接失败时的"重试失败源"按钮)。
export interface WarningAction {
  label: string;
  onClick: () => void;
  busy?: boolean;
  busyLabel?: string;
}
export type WarningEntry = string | { message: string; action?: WarningAction };

interface Props {
  warnings: WarningEntry[];
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
        {warnings.map((w, i) => {
          const message = typeof w === "string" ? w : w.message;
          const action = typeof w === "string" ? undefined : w.action;
          return (
            <li key={i} className="warning-panel-item">
              <span className="warning-panel-msg">{message}</span>
              {action && (
                <button
                  type="button"
                  className="warning-panel-action"
                  onClick={action.onClick}
                  disabled={action.busy}
                  data-testid={`${testId ?? "warning-panel"}-action-${i}`}
                >
                  {action.busy ? action.busyLabel ?? "处理中…" : action.label}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default memo(WarningPanel);
