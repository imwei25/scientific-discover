import { useEffect, useRef, useState } from "react";
import { getHistory, clearHistory, formatTime } from "../lib/history";
import type { Goto, ModuleId } from "../App";

const NAMES: Record<string, string> = {
  idea: "找选题",
  plan: "实验规划",
  analyze: "数据分析",
  format: "期刊排版",
};

export default function HistoryView({ goto }: { goto: Goto }) {
  const [items, setItems] = useState(getHistory());
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleClear = () => {
    setExiting(true);
    timerRef.current = setTimeout(() => {
      clearHistory();
      setItems([]);
      setExiting(false);
      timerRef.current = null;
    }, 280);
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>📜 历史记录</h1>
        <p>你最近的生成结果都在这里，可点击"恢复"回到对应功能继续编辑或导出。</p>
      </header>

      {items.length === 0 ? (
        <p className="result-placeholder">还没有历史记录。生成一次结果后会自动保存到这里。</p>
      ) : (
        <>
          <button
            className="btn-ghost"
            data-testid="clear-history"
            onClick={handleClear}
          >
            清空历史
          </button>
          <ul className={`history-list ${exiting ? "exiting" : ""}`} data-testid="history-list">
            {items.map((it) => (
              <li key={it.id} className="history-item" data-testid="history-item">
                <span className="history-icon">{it.icon}</span>
                <span className="history-main">
                  <span className="history-title">{it.title}</span>
                  <span className="history-time">
                    {NAMES[it.module] ?? it.module} · {formatTime(it.time)}
                  </span>
                </span>
                <button className="btn-ghost" data-testid="restore-btn" onClick={() => goto(it.module as ModuleId, it.data)}>
                  恢复 →
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
