import { apiUrl } from "./api";

// 触发浏览器下载一个 Blob(安全模式: 锚点入 DOM + 延迟 revoke, 兼容 Firefox/大文件)。
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

// 把文本(Markdown/纯文本)发到 /api/docx 转 Word 并下载。失败抛错(由调用方提示)。
export async function downloadDocxFromText(
  filename: string,
  text: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const resp = await fetch(apiUrl("/api/docx"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, journal_id: "", references: [], ...body }),
  });
  if (!resp.ok) throw new Error(`服务返回错误 ${resp.status}`);
  downloadBlob(filename, await resp.blob());
}

// 把文本保存为本地文件(纯前端, 不经服务器)。
export function downloadText(filename: string, text: string, mime = "text/markdown"): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}

// 下载 base64 编码的二进制(图表 png/svg/pdf 等)。
export function downloadBase64(filename: string, b64: string, mime: string): void {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  downloadBlob(filename, new Blob([bytes], { type: mime }));
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};
export function chartMime(ext: string): string {
  return EXT_MIME[ext] || "application/octet-stream";
}

// 生成带时间戳的文件名, 避免覆盖。形如 prefix-20260626-0655.md
export function tsName(prefix: string, ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${prefix}-${stamp}.${ext}`;
}

// 导出证据表为 CSV(A4)。前置 UTF-8 BOM 让 Excel 正确识别中文。
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))];
  downloadText(filename, "﻿" + lines.join("\r\n"), "text/csv");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 极简 Markdown→HTML(覆盖标题/加粗/链接/列表/段落), 用于报告导出。
function mdToHtml(md: string): string {
  const lines = escapeHtml(md).split("\n");
  const out: string[] = [];
  let inList = false;
  const inline = (t: string) =>
    t
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\[(.+?)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^###\s+/.test(line)) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h3>${inline(line.replace(/^###\s+/, ""))}</h3>`); }
    else if (/^##\s+/.test(line)) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`); }
    else if (/^#\s+/.test(line)) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h1>${inline(line.replace(/^#\s+/, ""))}</h1>`); }
    else if (/^[-*]\s+/.test(line)) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`); }
    else if (line === "") { if (inList) { out.push("</ul>"); inList = false; } }
    else { if (inList) { out.push("</ul>"); inList = false; } out.push(`<p>${inline(line)}</p>`); }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

export interface AnalysisReport {
  title: string;
  question: string;
  code: string;
  charts: string[]; // base64 png
  output: string;
  conclusion: string;
}

// 导出自包含的 HTML 分析报告(图表内嵌, 可用浏览器打开并打印成 PDF)。
export function downloadAnalysisReport(report: AnalysisReport): void {
  const charts = report.charts
    .map((b64, i) => `<figure><img src="data:image/png;base64,${b64}" alt="图${i + 1}"/></figure>`)
    .join("\n");
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>${escapeHtml(report.title)}</title>
<style>
body{font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif;max-width:820px;margin:32px auto;padding:0 20px;color:#1f2733;line-height:1.7}
h1{font-size:24px}h2{font-size:19px;margin-top:24px}h3{font-size:16px}
pre{background:#f7f9fc;border:1px solid #e3e8ef;border-radius:8px;padding:12px;overflow-x:auto;font-size:12.5px;white-space:pre-wrap}
figure{margin:14px 0;text-align:center}img{max-width:100%;border:1px solid #e3e8ef;border-radius:8px}
.muted{color:#5b6675}a{color:#2f6df6}
details summary{cursor:pointer;font-weight:600;margin:16px 0 8px}
</style></head><body>
<h1>${escapeHtml(report.title)}</h1>
${report.question ? `<p class="muted"><strong>研究目的：</strong>${escapeHtml(report.question)}</p>` : ""}
<h2>分析结论</h2>
${mdToHtml(report.conclusion)}
${charts ? `<h2>图表</h2>${charts}` : ""}
<details><summary>分析代码（本地执行，可复现）</summary><pre>${escapeHtml(report.code)}</pre></details>
<details><summary>代码运行的原始输出</summary><pre>${escapeHtml(report.output)}</pre></details>
<p class="muted" style="margin-top:28px;font-size:12px">本报告由科研助手生成；统计数字由本地代码真实计算，结论请人工核对后使用。</p>
</body></html>`;
  downloadText(tsName("数据分析报告", "html"), html, "text/html");
}
