import { useRef, useState } from "react";
import { runModule } from "./sse";
import { usePersistentState } from "./usePersistentState";

// 管理一次模块运行的状态: 文本累积 / 运行中 / 错误 / 中止 / 后端告警。
// 传入 persistKey 时, 结果文本会被持久化, 切换模块/重开后仍在。
// warnings 是后端 SSE `warning` 事件累积(如 PHI 前置扫描 / checklist 回引校验),
// 与 error 并存: error 是失败, warning 是可继续但需关注。每次 start 会清空。
export function useStream(persistKey?: string) {
  const persisted = usePersistentState<string>(persistKey ?? "__nostore__", "");
  const ephemeral = useState("");
  const [text, setText] = persistKey ? persisted : ephemeral;

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const ctrl = useRef<AbortController | null>(null);

  const start = async (module: string, inputs: Record<string, string>) => {
    setText("");
    setError(null);
    setWarnings([]);
    setRunning(true);
    ctrl.current = new AbortController();
    await runModule(module, inputs, {
      signal: ctrl.current.signal,
      onDelta: (t) => setText((prev) => prev + t),
      onWarning: (m) => setWarnings((prev) => [...prev, m]),
      onError: (m) => {
        setError(m);
        setRunning(false);
      },
      onDone: () => setRunning(false),
    });
    setRunning(false);
  };

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
  };

  const clearWarnings = () => setWarnings([]);

  return { text, running, error, warnings, start, stop, setText, setError, clearWarnings };
}
