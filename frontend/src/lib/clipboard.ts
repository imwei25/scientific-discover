// 复制到剪贴板，兼容局域网 http 访问（非安全上下文）。
//
// 背景：navigator.clipboard 仅在安全上下文（https 或 localhost）可用。
// 本应用支持局域网访问（http://192.168.x.x），此时 navigator.clipboard 为 undefined，
// 直接调用会抛错、复制按钮静默失效。这里在非安全上下文下回退到 execCommand 方案。
export async function copyToClipboard(text: string): Promise<boolean> {
  // 安全上下文优先用现代异步剪贴板 API。
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 继续走下面的兜底（某些环境即便有 API 也可能因权限失败）。
    }
  }
  // 兜底：临时 textarea + execCommand('copy')，可在 http 局域网下工作。
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
