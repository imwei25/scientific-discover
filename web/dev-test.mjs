// 本地冒烟测试入口：不接管 opencode（指向一个空端口），只起网关看前端。仅供开发验证。
process.env.MANAGE_OC = "0"
process.env.OC_URL = process.env.OC_URL || "http://127.0.0.1:4098"
process.env.PORT = process.env.PORT || "3299"
process.env.DAILY_COST_LIMIT = process.env.DAILY_COST_LIMIT || "0.30"   // 演示额度条（生产由 deploy/.env 配）
process.env.STORAGE_LIMIT_MB = process.env.STORAGE_LIMIT_MB || "2000"   // 演示存储上限（可测上传超限 413）
await import("./server.mjs")
