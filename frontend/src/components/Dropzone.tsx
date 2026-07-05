import { useEffect, useRef, useState } from "react";
import { extractFile } from "../lib/extract";

interface Props {
  testId: string;
  accept: string;
  label: string;
  hint?: string;
  mode: "file" | "text";
  /** 紧凑样式: 更小的内边距/图标, 用于空间有限处 */
  compact?: boolean;
  /** 允许一次选择/拖入多个文件(默认允许) */
  multiple?: boolean;
  onFile?: (file: File) => void;
  onText?: (text: string, filename: string, truncated: boolean) => void;
}

// 单个上传文件大小上限: 超过则前端直接拒绝, 避免把超大文件读入内存/上传导致卡死或后端 OOM。
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30MB

// 可复用的拖拽上传区: 支持点击选择与拖拽; 支持 Word/PDF/Excel/CSV/txt。
export default function Dropzone({ testId, accept, label, hint, mode, compact, multiple = true, onFile, onText }: Props) {
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

  // 逐个处理多文件(串行, 保证解析结果按选择顺序追加)。
  const handleMany = async (files: FileList | File[] | null | undefined) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    if (list.length === 1) return handle(list[0]);
    let ok = 0;
    for (const f of list) {
      await handle(f);
      ok += 1;
      setInfo(`已处理 ${ok}/${list.length} 个文件…`);
    }
    setInfo(`已导入 ${ok} 个文件`);
  };

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div
        className={`dropzone${compact ? " compact" : ""} ${drag ? "dragover" : ""} ${success ? "success" : ""}`}
        data-testid={`${testId}-zone`}
        // 无障碍: 让屏幕阅读器识别为可点击的"上传区", 键盘 Enter/空格 也能触发选择
        role="button"
        tabIndex={0}
        aria-label={`${label} · 上传文件区, 可拖拽或点击选择; 支持${multiple ? "多文件" : "单文件"}, 单文件不超过 30MB`}
        aria-busy={busy}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handleMany(e.dataTransfer.files);
        }}
      >
        <span className="dropzone-icon">📎</span>
        <span className="dropzone-text">
          {busy ? "正在解析…" : multiple ? "把文件拖到这里，或点击选择（可多选）" : "把文件拖到这里，或点击选择"}
        </span>
        {/* 30MB 上限的预告 —— 之前用户上传 40MB 才看到"文件过大"报错, 现在提前告知 */}
        {hint ? <span className="dropzone-hint">{hint} · 单文件 ≤ 30MB</span>
              : <span className="dropzone-hint">单文件 ≤ 30MB</span>}
        <input
          ref={inputRef}
          data-testid={testId}
          type="file"
          accept={accept}
          multiple={multiple}
          style={{ display: "none" }}
          onChange={(e) => handleMany(e.target.files)}
        />
      </div>
      {info && <span className="file-name" data-testid={`${testId}-info`}>{info}</span>}
      {err && <span className="result-error" data-testid={`${testId}-error`}>{err}</span>}
    </div>
  );
}
