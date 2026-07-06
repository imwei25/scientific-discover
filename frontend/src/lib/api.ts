// 决定 API 基地址:
// - Vite 开发(http://localhost:5173): 用相对路径, 经 vite proxy 转发。
// - 单进程模式(后端直接托管前端, http://127.0.0.1:8756): 同源, 相对路径即可。
// - Tauri 桌面 webview: 前端由 webview 从打包资源加载, 必须指向本地 sidecar 绝对地址。
//   ⚠️ 关键: Tauri v2 在 Windows 上的源是 http://tauri.localhost(scheme 仍是 http:),
//   所以不能只看 location.protocol(那样会误判为同源相对路径, 请求打到 webview 自身而非 sidecar)。
//   用 Tauri 注入的全局 + 主机名兜底来识别桌面环境。
const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
export const isTauri =
  typeof w.__TAURI_INTERNALS__ !== "undefined" ||
  typeof w.__TAURI__ !== "undefined" ||
  location.protocol === "tauri:" ||
  location.hostname === "tauri.localhost";
// 桌面版初始默认端口; 启动时会被 initApiBase() 用外壳分配的真实端口覆盖。
// 非 Tauri(浏览器开发经 vite proxy / 单进程同源)用相对路径即可。
let apiBase = isTauri ? "http://127.0.0.1:8756" : "";

export function apiUrl(path: string): string {
  return apiBase + path;
}

// 启动时(首个请求发出前)从 Tauri 外壳读取 sidecar 实际监听的端口, 覆盖默认 8756。
// 外壳每次启动为后端分配一个空闲端口(见 src-tauri/src/main.rs), 前端必须读回同一端口 ——
// 否则用户在 .env 改了端口、或 8756 被占用换了端口时, 写死 8756 会全线连不上。
// 非 Tauri 无外壳, 直接返回(保持相对路径)。读取失败(旧外壳未注册命令)则保留默认 8756。
export async function initApiBase(): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const port = await invoke<number>("get_backend_port");
    if (typeof port === "number" && port > 0) {
      apiBase = `http://127.0.0.1:${port}`;
    }
  } catch {
    /* 保留默认 8756 */
  }
}
