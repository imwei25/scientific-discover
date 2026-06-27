import { useEffect, useRef, useState } from "react";
import { extractFile } from "../lib/extract";

interface Props {
  testId: string;
  accept: string;
  label: string;
  hint?: string;
  mode: "file" | "text";
  onFile?: (file: File) => void;
  onText?: (text: string, filename: string, truncated: boolean) => void;
}

// 单个上传文件大小上限: 超过则前端直接拒绝, 避免把超大文件读入内存/上传导致卡死或后端 OOM。
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30MB

// 可复用的拖拽上传区: 支持点击选择与拖拽; 支持 Word/PDF/Excel/CSV/txt。
export default function Dropzone({ testId, accept, label, hint, mode, onFile, onText }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [successKey, setSuccessKey] = useState(0);
  const [success, setSuccess] = useState(false);

  // 由 successKey 自增触发：清→次帧打开→700ms 关，确保 CSS 动画每次成功都重启。
  useEffect(() => {
    if (successKey === 0) return;
    setSuccess(false);
    const r1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => setSuccess(true));
    });
    const t = setTimeout(() => setSuccess(false), 700);
    return () => {
      cancelAnimationFrame(r1);
      clearTimeout(t);
    };
  }, [successKey]);

  const triggerSuccess = () => setSuccessKey((k) => k + 1);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setErr("");
    setInfo("");
    if (file.size > MAX_UPLOAD_BYTES) {
      setErr(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），请上传小于 30MB 的文件。`);
      return;
    }
    if (mode === "file") {
      setInfo(`已选择：${file.name}`);
      onFile?.(file);
      triggerSuccess();
      return;
    }
    setBusy(true);
    setInfo(`正在解析 ${file.name} …`);
    const res = await extractFile(file);
    setBusy(false);
    if (!res.ok || !res.text) {
      setInfo("");
      setErr(res.error || "解析失败");
      return;
    }
    setInfo(`已导入：${file.name}${res.truncated ? "（内容较长已截断）" : ""}`);
    onText?.(res.text, file.name, !!res.truncated);
    triggerSuccess();
  };

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div
        className={`dropzone ${drag ? "dragover" : ""} ${success ? "success" : ""}`}
        data-testid={`${testId}-zone`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handle(e.dataTransfer.files?.[0]);
        }}
      >
        <span className="dropzone-icon">📎</span>
        <span className="dropzone-text">
          {busy ? "正在解析…" : "把文件拖到这里，或点击选择"}
        </span>
        {hint && <span className="dropzone-hint">{hint}</span>}
        <input
          ref={inputRef}
          data-testid={testId}
          type="file"
          accept={accept}
          style={{ display: "none" }}
          onChange={(e) => handle(e.target.files?.[0] ?? undefined)}
        />
      </div>
      {info && <span className="file-name" data-testid={`${testId}-info`}>{info}</span>}
      {err && <span className="result-error" data-testid={`${testId}-error`}>{err}</span>}
    </div>
  );
}
