import { useState } from "react";
import Markdown from "./Markdown";
import { downloadText, tsName } from "../lib/download";

interface Props {
  text: string;
  running: boolean;
  error: string | null;
  onStop?: () => void;
  placeholder?: string;
  exportName?: string;
}

// 统一的结果展示区: 流式文本 + 复制 + 导出 + 停止 + 状态。
export default function ResultPanel({ text, running, error, onStop, placeholder, exportName }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportMd = () => downloadText(tsName(exportName ?? "结果", "md"), text);

  return (
    <div className="result-panel" data-testid="result-panel">
      <div className="result-toolbar">
        <span className="result-status">
          {running ? "生成中…" : error ? "出错了" : text ? "已完成" : "等待开始"}
        </span>
        <div className="result-actions">
          {running && onStop && (
            <button className="btn-ghost" onClick={onStop} data-testid="stop-btn">
              停止
            </button>
          )}
          {text && !running && (
            <button className="btn-ghost" onClick={copy} data-testid="copy-btn">
              {copied ? "已复制" : "复制"}
            </button>
          )}
          {text && !running && (
            <button className="btn-ghost" onClick={exportMd} data-testid="export-md-btn">
              导出 Markdown
            </button>
          )}
        </div>
      </div>
      {error ? (
        <div className="result-error" data-testid="result-error">
          {error}
        </div>
      ) : (
        <div className="result-text" data-testid="result-text">
          {text ? (
            <Markdown>{text}</Markdown>
          ) : (
            <span className="result-placeholder">{placeholder ?? "结果会显示在这里。"}</span>
          )}
          {running && <span className="cursor-blink">▍</span>}
        </div>
      )}
    </div>
  );
}
