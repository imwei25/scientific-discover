// 决定 API 基地址:
// - Vite 开发(http://localhost:5173): 用相对路径, 经 vite proxy 转发。
// - 单进程模式(后端直接托管前端, http://127.0.0.1:8756): 同源, 相对路径即可。
// - Tauri 桌面(tauri://localhost 等非 http 源): 需指向本地 sidecar 绝对地址。
const isHttp = location.protocol === "http:" || location.protocol === "https:";
export const API_BASE = isHttp ? "" : "http://127.0.0.1:8756";

export function apiUrl(path: string): string {
  return API_BASE + path;
}
