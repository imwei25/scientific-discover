import { useState, type ReactNode } from "react";
import type { Reference } from "../lib/sse";
import { downloadText, downloadDocxFromText, downloadPdfFromText, tsName } from "../lib/download";
import { copyToClipboard } from "../lib/clipboard";
import { stripSupportQuotes } from "../lib/exportPrep";

interface Props {
  text: string;
  refs: Reference[];
  title: string;                                 // 报告主题 (导出文件名前缀)
  extraMarkdown?: string;                        // 追加在正文后 (如选题卡候选段)
  running: boolean;
  reportCollapsed: boolean;
  onToggleCollapsed: () => void;
  onCopyDone?: () => void;
  onStatus?: (msg: string) => void;
  extraLeadingActions?: ReactNode;               // 用于加"送到实验规划"等按钮
  extraTrailingActions?: ReactNode;
  testIdPrefix?: string;
}

export default function ReportExportBar(props: Props) {
  const {
    text, refs, title, extraMarkdown = "",
    running, reportCollapsed, onToggleCollapsed, onCopyDone, onStatus,
    extraLeadingActions, extraTrailingActions, testIdPrefix = "",
  } = props;
  const [wordBusy, setWordBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refMd = refs.length
    ? "\n\n## 参考文献\n" + refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n")
    : "";
  const compose = () => stripSupportQuotes(text) + extraMarkdown + refMd;

  if (running || !text) return null;

  return (
    <div className="result-actions">
      {extraLeadingActions}
      <button
        className="btn-ghost" data-testid={`${testIdPrefix}toggle-report-btn`}
        onClick={onToggleCollapsed}
        title={reportCollapsed ? "展开调研报告" : "折叠调研报告"}
      >
        {reportCollapsed ? "展开报告 ▾" : "折叠报告 ▴"}
      </button>
      <button
        className="btn-ghost" data-testid={`${testIdPrefix}copy-report-btn`}
        onClick={async () => {
          const ok = await copyToClipboard(compose());
          if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1800); onCopyDone?.(); }
          else onStatus?.("复制失败:请手动选择复制");
        }}
      >
        {copied ? "已复制 ✓" : "复制"}
      </button>
      <button
        className="btn-ghost" data-testid={`${testIdPrefix}export-md-btn`}
        onClick={() => downloadText(tsName(title, "md"), compose())}
      >导出 Markdown</button>
      <button
        className="btn-ghost" data-testid={`${testIdPrefix}export-docx-btn`}
        disabled={wordBusy}
        onClick={async () => {
          setWordBusy(true);
          try { await downloadDocxFromText(tsName(title, "docx"), compose()); }
          catch (e) { onStatus?.(`导出 Word 失败:${(e as Error).message}`); }
          finally { setWordBusy(false); }
        }}
      >{wordBusy ? "导出中…" : "导出 Word"}</button>
      <button
        className="btn-ghost" data-testid={`${testIdPrefix}export-pdf-btn`}
        disabled={wordBusy}
        onClick={async () => {
          setWordBusy(true);
          try { await downloadPdfFromText(tsName(title, "pdf"), compose(), title); }
          catch (e) { onStatus?.(`导出 PDF 失败:${(e as Error).message}`); }
          finally { setWordBusy(false); }
        }}
      >{wordBusy ? "导出中…" : "导出 PDF"}</button>
      {extraTrailingActions}
    </div>
  );
}
