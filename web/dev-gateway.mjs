#!/usr/bin/env node
// 本地开发：以【桌面版】的形态起网关进程 —— 接入云端账号（登录 sci-auth 换 key）。
//   node server/dev-server.mjs      # 先起 sci-auth（:8099，带演示账号）
//   node web/dev-gateway.mjs        # 再起本进程（:3001）
//
// 直接 `node web/server.mjs` 起的是"没有平台、只能自设 API"的纯单机形态，
// 测不到登录、续期、api-config 里「切回云端」那几条路。
//
// 默认指向本机 sci-auth：SCI_CLOUD_URL=http://127.0.0.1:8099（可用环境变量覆盖，指线上也行）。
// 不需要预置任何 key —— 在界面里输入 account 登录即可，key 由本进程代持并自动续期。
//
// 想测【静态网关 key】那条老路（云端多用户容器的形态），显式给 OC_GATEWAY_URL/OC_GATEWAY_KEY。
import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_DIR = process.env.DEV_DIR || path.join(os.tmpdir(), "sci-web-dev")
fs.mkdirSync(DEV_DIR, { recursive: true })

// 仓库根有 cloud.json（真实部署的形态）就用它，别用 SCI_CLOUD_URL 盖掉 ——
// 想对着线上联调时，写一个 cloud.json 指过去即可，不必改代码或造第二份启动配置。
const hasCloudJson = fs.existsSync(path.join(__dirname, "..", "cloud.json"))
Object.assign(process.env, {
  ...(hasCloudJson && !process.env.SCI_CLOUD_URL ? {} : { SCI_CLOUD_URL: process.env.SCI_CLOUD_URL || "http://127.0.0.1:8099" }),
  // 登录态与模型配置都落临时目录，别污染仓库里的 web/cloud-state.json、web/model-config.json
  CLOUD_STATE_PATH: process.env.CLOUD_STATE_PATH || path.join(DEV_DIR, "cloud-state.json"),
  MODEL_CFG_PATH: process.env.MODEL_CFG_PATH || path.join(DEV_DIR, "model-config.json"),
  API_PROFILES_PATH: process.env.API_PROFILES_PATH || path.join(DEV_DIR, "api-profiles.json"),
  PORT: process.env.PORT || "3001",
})
console.log(`[dev] 桌面形态启动：云端=${process.env.SCI_CLOUD_URL || "(取自 cloud.json)"}  端口=${process.env.PORT}`)
console.log(`[dev] 登录态落 ${process.env.CLOUD_STATE_PATH}（删掉它 = 回到未登录）`)
console.log(`[dev] 在界面对话框输入 account 登录`)
await import("./server.mjs")
