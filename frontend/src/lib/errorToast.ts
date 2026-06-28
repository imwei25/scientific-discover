// W2-2 通用错误 → Toast 映射
// 模块在收到 sse onError 回调时调用 reportLLMError(msg) 即可:
// 自动归类 LLMError 子类, 弹分类提示 + 操作按钮。

import { BalanceError, KeyError, RateLimitError, TimeoutError, classifyError } from "./sse";
import { showToast } from "./toast";

/** 把错误字符串映射为合适的 Toast; 返回归类后的 LLMError, 调用者可选择再 throw 或忽略。 */
export function reportLLMError(message: string): void {
  const err = classifyError(message);
  if (err instanceof BalanceError) {
    showToast({
      kind: "error",
      message: `余额不足: ${message}`,
      action: {
        label: "去充值",
        onClick: () => {
          // 大多数情况是 DeepSeek, 给个跳链接; 用户也可自行去其它平台
          window.open("https://platform.deepseek.com/usage", "_blank");
        },
      },
    });
    return;
  }
  if (err instanceof KeyError) {
    showToast({
      kind: "error",
      message: `API key 失效或未授权: ${message}`,
      action: {
        label: "去重新配置",
        onClick: () => {
          try { localStorage.removeItem("onboarding:done"); } catch { /* ignore */ }
          window.dispatchEvent(new Event("onboarding:reopen"));
        },
      },
    });
    return;
  }
  if (err instanceof TimeoutError) {
    showToast({
      kind: "warn",
      message: `请求超时, 请稍后重试: ${message}`,
    });
    return;
  }
  if (err instanceof RateLimitError) {
    showToast({
      kind: "warn",
      message: `速率限制, 请稍等再试: ${message}`,
    });
    return;
  }
  // 兜底
  showToast({ kind: "error", message });
}
