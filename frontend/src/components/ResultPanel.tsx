import { useState } from "react";
import Markdown from "./Markdown";
import { downloadText, tsName } from "../lib/download";
import { copyToClipboard } from "../lib/clipboard";

interface Props {
  text: string;
  running: boolean;
  error: string | null;
  onStop?: () => void;
  placeholder?: string;
  exportName?: string;
  onExportDocx?: () => void;
  exportingDocx?: boolean;
  panelTestId?: string;
}

// 统一的结果展示区: 流式文本 + 复制 + 导出(MD/Word) + 停止 + 状态。
export default function ResultPanel({ text, running, error, onStop, placeholder, exportName, onExportDocx, exportingDocx, panelTestId }: Props) {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  const copy = async () => {
    const ok = await copyToClipboard(text);
    setCopied(ok ? "ok" : "fail");
    setTimeout(() => setCopied(null), 1500);
  };

  const exportMd = () => downloadText(tsName(exportName ?? "结果", "md"), text);

  return (
    <div className="result-panel" data-testid={panelTestId ?? "result-panel"} aria-busy={running}>
      <div className="result-toolbar">
        {/* aria-live: 让读屏软件播报状态变化(生成中/已完成/出错), 但不逐字播报流式正文以免刷屏 */}
        <span className="result-status" role="status" aria-live="polite">
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
              {copied === "ok" ? "已复制" : copied === "fail" ? "复制失败" : "复制"}
            </button>
          )}
          {text && !running && (
            <button className="btn-ghost" onClick={exportMd} data-testid="export-md-btn">
              导出 Markdown
            </button>
          )}
          {text && !running && onExportDocx && (
            <button className="btn-ghost" onClick={onExportDocx} disabled={exportingDocx} data-testid="export-docx-btn">
              {exportingDocx ? "导出中…" : "导出 Word"}
            </button>
          )}
        </div>
      </div>
      {error ? (
        <div className="result-error" data-testid="result-error" role="alert">
          {error}
        </div>
      ) : (
        <div className="result-text" data-testid="result-text">
          {text ? (
            <Markdown>{text}</Markdown>
          ) : (
            <span className="result-placeholder">{placeholder ?? "填好左侧信息后点击上方按钮，结果会显示在这里。"}</span>
          )}
          {running && <span className="cursor-blink">▍</span>}
        </div>
      )}
    </div>
  );
}
