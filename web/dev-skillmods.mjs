#!/usr/bin/env node
// 本 worktree（feat/skill-modules）的自测网关。
//
// 【为什么不直接 `node web/server.mjs`】主检出同时被别的会话用着，而 server.mjs 默认会
// 【接管本机 opencode】—— 它会先 kill 掉 4098 端口上那个再重起一个，把别人正在跑的一轮打断。
// 所以这里 MANAGE_OC=0：只连现成的那个，不碰它的生命周期。
//
// 端口另挑一个（3007），避开主检出的 3000/3001 与 v3 worktree 的 3003。
// 会话目录、上传、产物仍落在【本 worktree】下（server.mjs 全部路径基于 __dirname），
// 不会污染主检出。
import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_DIR = process.env.DEV_DIR || path.join(os.tmpdir(), "sci-skillmods-dev")
fs.mkdirSync(DEV_DIR, { recursive: true })

// ★ 起【自己的】opencode，端口另挑一个（4099）。
// 一开始试过 MANAGE_OC=0 + 共用主检出那个 4098，想着"不去 kill 别人的"。结果是：那个
// opencode 一旦不在（主检出的网关被停掉了），本网关既不会拉起它、也没有任何提示，
// 只是每次 /api/upload 都回 500 —— 界面上只看到"上传失败（HTTP 500）"，排查了半天。
// 各起各的最省事：既不碰主检出那一个，自己这边也永远是活的。
Object.assign(process.env, {
  PORT: process.env.PORT || "3007",
  // 变量名是 OC_URL，不是 OC —— 写错了不会报错，只会静默落回 4098（也就是主检出那一个）
  OC_URL: process.env.OC_URL || "http://127.0.0.1:4099",
  MANAGE_OC: process.env.MANAGE_OC || "1",
  CLOUD_STATE_PATH: process.env.CLOUD_STATE_PATH || path.join(DEV_DIR, "cloud-state.json"),
  MODEL_CFG_PATH: process.env.MODEL_CFG_PATH || path.join(DEV_DIR, "model-config.json"),
  API_PROFILES_PATH: process.env.API_PROFILES_PATH || path.join(DEV_DIR, "api-profiles.json"),
})
// ---- 登录态播种 ----
// 登录态与模型配置落在 DEV_DIR（不污染 worktree 里被 git 跟踪的那两个文件）。但空目录起步
// 意味着【没有任何模型凭据】—— route=none、hasKey=false，发一条消息就报没配模型，
// 而界面上一切正常，只有真去跑一轮才发现。所以首次启动从主检出的 web/ 复制一份过来。
// 只复制、之后各写各的：刷新 token 不会写回主检出，也就不会把那边的登录挤掉。
const MAIN_WEB = process.env.MAIN_WEB || "D:/projects/scientific-discover/web"
for (const [f, dest] of [["cloud-state.json", process.env.CLOUD_STATE_PATH], ["model-config.json", process.env.MODEL_CFG_PATH]]) {
  try {
    if (fs.existsSync(dest)) continue
    const src = path.join(MAIN_WEB, f)
    if (fs.existsSync(src)) { fs.copyFileSync(src, dest); console.log(`[dev] 已从主检出播种 ${f}`) }
    else console.warn(`[dev] 主检出没有 ${f} —— 本网关将没有模型凭据，真实生成会失败`)
  } catch (e) { console.warn(`[dev] 播种 ${f} 失败：${e.message}`) }
}

console.log(`[dev] skill-modules worktree 网关：端口=${process.env.PORT}，自带 opencode=${process.env.OC_URL}`)
await import("./server.mjs")
