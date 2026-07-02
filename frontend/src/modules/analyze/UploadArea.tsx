import { useRef, useState } from "react";
import { CHART_TYPES, type ChartType } from "./types";

// ─── 文件上传区(所有图表类型共用) + 分析类型/脱敏开关 ──────────
interface UploadAreaProps {
  file: File | null;
  fileErr: string;
  question: string;
  chartType: ChartType;
  deidEnabled: boolean;
  onPickFile: (f: File | undefined) => void;
  onRemoveFile: () => void;
  onQuestionChange: (v: string) => void;
  onChartTypeChange: (t: ChartType) => void;
  onDeidEnabledChange: (v: boolean) => void;
}
export default function UploadArea({
  file,
  fileErr,
  question,
  chartType,
  deidEnabled,
  onPickFile,
  onRemoveFile,
  onQuestionChange,
  onChartTypeChange,
  onDeidEnabledChange,
}: UploadAreaProps) {
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <>
      <div
        className={`analyze-input ${drag ? "dragover" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); onPickFile(e.dataTransfer.files?.[0]); }}
      >
        <div className="analyze-file-bar">
          {file ? (
            <span className="file-chip" data-testid="input-file-info">
              📎 {file.name}
              <button className="chip-x" onClick={onRemoveFile} aria-label="移除文件">✕</button>
            </span>
          ) : (
            <span className="file-placeholder">
              📎 把数据文件（.csv / .xlsx）拖到此处，或{" "}
              <button type="button" className="link-btn" onClick={() => fileInput.current?.click()}>
                点击选择
              </button>
            </span>
          )}
          <input
            ref={fileInput}
            data-testid="input-file"
            type="file"
            accept=".csv,.xlsx,.xls"
            style={{ display: "none" }}
            onChange={(e) => onPickFile(e.target.files?.[0] ?? undefined)}
          />
        </div>
        {chartType === "general" && (
          <textarea
            data-testid="input-question"
            value={question}
            onChange={(e) => onQuestionChange(e.target.value)}
            placeholder="说明研究目的；也可以直接要求画图。例如：比较治疗组与对照组疗效，并画箱线图；按生存时间画 KM 曲线；画各指标相关性热图、ROC 曲线"
            rows={3}
          />
        )}
      </div>
      {fileErr && (
        <span className="result-error" data-testid="input-file-error">{fileErr}</span>
      )}

      {/* 分析类型 + 脱敏开关 */}
      <div className="analyze-type-row">
        <label className="field-inline">
          分析类型
          <select
            data-testid="analyze-chart-type"
            value={chartType}
            onChange={(e) => onChartTypeChange(e.target.value as ChartType)}
          >
            {CHART_TYPES.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </label>
        <label className="analyze-deid-toggle">
          <input
            type="checkbox"
            checked={deidEnabled}
            onChange={(e) => onDeidEnabledChange(e.target.checked)}
            data-testid="analyze-deid-toggle"
          />
          上传时自动检测患者隐私信息
        </label>
      </div>
    </>
  );
}
