import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 打包时前端是静态资源; 开发期通过 proxy 把 /api 转发到本地 sidecar,
// 避免 CORS, 也让 Playwright 测试只需面对一个 origin。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8756",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
