// 决定 API 基地址:
// - Vite 开发(http://localhost:5173): 用相对路径, 经 vite proxy 转发。
// - 单进程模式(后端直接托管前端, http://127.0.0.1:8756): 同源, 相对路径即可。
// - Tauri 桌面 webview: 前端由 webview 从打包资源加载, 必须指向本地 sidecar 绝对地址。
//   ⚠️ 关键: Tauri v2 在 Windows 上的源是 http://tauri.localhost(scheme 仍是 http:),
//   所以不能只看 location.protocol(那样会误判为同源相对路径, 请求打到 webview 自身而非 sidecar)。
//   用 Tauri 注入的全局 + 主机名兜底来识别桌面环境。
const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
const isTauri =
  typeof w.__TAURI_INTERNALS__ !== "undefined" ||
  typeof w.__TAURI__ !== "undefined" ||
  location.protocol === "tauri:" ||
  location.hostname === "tauri.localhost";
export const API_BASE = isTauri ? "http://127.0.0.1:8756" : "";

export function apiUrl(path: string): string {
  return API_BASE + path;
}
