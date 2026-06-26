import { defineConfig, devices } from "@playwright/test";

// 像真实用户一样在浏览器里操作界面。
// UI 测试把后端 /api 用 route 拦截 mock 掉, 保证确定性、快速、不消耗 API 额度。
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  // 使用系统自带的 Edge(Chromium 内核), 免去下载浏览器二进制(国内镜像常缺特定版本)。
  projects: [{ name: "edge", use: { ...devices["Desktop Edge"], channel: "msedge" } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
