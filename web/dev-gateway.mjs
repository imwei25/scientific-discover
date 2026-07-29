#!/usr/bin/env node
// 本地开发：以【接入云端网关】的形态起网关进程（桌面版/云端多用户的真实形态）。
//   node web/dev-gateway.mjs
//
// 直接 `node web/server.mjs` 起的是"没有网关、只能自设 API"的单机形态，
// 测不到 api-config 里「默认走网关 / 切回网关」那条路。
//
// 默认指向本机 sci-auth 的 /llm（node server/dev-server.mjs 起在 :8099）：
//   OC_GATEWAY_URL=http://127.0.0.1:8099/llm/v1
//   OC_GATEWAY_KEY=<某个用户的 access key>
// 两者都可用环境变量覆盖，指到线上或 one-api 也行。
//
// key 从哪来：起 sci-auth 后建号 → 登录 → 改密 → 拿 access。没有真 key 也能跑，
// 路由切换/界面那部分不依赖上游真的可用（真调模型才会失败）。
import path from "node:path"
import { fileURLToPath } from "node:url"
import fs from "node:fs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KEY_FILE = path.join(__dirname, "..", ".dev-gateway-key")   // 可选：把 access key 放这里，已 gitignore

let key = process.env.OC_GATEWAY_KEY || ""
if (!key) { try { key = fs.readFileSync(KEY_FILE, "utf8").trim() } catch {} }
if (!key) {
  key = "dev-no-real-key"
  console.log(`[dev] 没找到 access key（可放进 ${KEY_FILE} 或设 OC_GATEWAY_KEY）——`)
  console.log("[dev] 界面与路由切换照常可测，真发消息给模型会失败。")
}

Object.assign(process.env, {
  OC_GATEWAY_URL: process.env.OC_GATEWAY_URL || "http://127.0.0.1:8099/llm/v1",
  OC_GATEWAY_KEY: key,
  PORT: process.env.PORT || "3001",
})
console.log(`[dev] 以网关形态启动：OC_GATEWAY_URL=${process.env.OC_GATEWAY_URL}  端口=${process.env.PORT}`)
await import("./server.mjs")
