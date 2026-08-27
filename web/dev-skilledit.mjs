#!/usr/bin/env node
// 「编辑技能」这个面板的本地自测入口（内部版专属功能，见 web/skill-edit.mjs 头注）。
//
//   node web/dev-skilledit.mjs        # 默认 :3013
//
// 【为什么不能用 dev-folders.mjs 那套】那套把 MANAGE_OC 设成 0（它挂的是假 opencode，
// 不该去杀真的）。而「编辑技能」的可用判据恰恰含 OC_MANAGED —— 保存后要重启后台才生效，
// 管不着 opencode 的形态下这个面板本就不该出现。设成 0 就等于把被测功能整个关掉了。
// 所以这里 MANAGE_OC=1，但把 opencode 指到一个【专用端口】(4199)：killPort 只会动这个口，
// 碰不到你正在用的那个 :4096。
//
// 【会真的改到仓库里的技能】SKILLS_DIR 是从代码位置推出来的（ROOT/.opencode/skills），没有
// 环境变量能改道。所以自测时只改一个技能、改完点「恢复出厂」还原，跑完 git status 核一眼。
// 状态文件（会话元数据、模型配置等）都落临时目录，不碰仓库。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const GW_PORT = Number(process.env.PORT || 3013)
const OC_PORT = Number(process.env.OC_DEV_PORT || 4199)
const DEV_DIR = process.env.DEV_DIR || path.join(os.tmpdir(), "sci-skilledit-dev-" + GW_PORT)
fs.rmSync(DEV_DIR, { recursive: true, force: true })
fs.mkdirSync(DEV_DIR, { recursive: true })

Object.assign(process.env, {
  PORT: String(GW_PORT),
  LAN_AUTH: "0",                       // 自测不走登录
  MANAGE_OC: "1",                      // ★ 被测功能的可用判据之一，不能关
  OC_URL: `http://127.0.0.1:${OC_PORT}`,
  SCI_TASK_SYNC: "0",                  // 别把自测任务注册进真的 Windows 任务计划
  SCI_CHAT_BRIDGE: "0",                // 别拉起聊天桥（会把用户正在用的那条杀掉）
  SCI_TASKS_DIR: path.join(DEV_DIR, "tasks"),
  SESSIONS_META_PATH: path.join(DEV_DIR, "sessions-meta.json"),
  MODEL_CFG_PATH: path.join(DEV_DIR, "model-config.json"),
  API_PROFILES_PATH: path.join(DEV_DIR, "api-profiles.json"),
  OC_CONFIG_PATH: path.join(DEV_DIR, "opencode.json"),
  CLOUD_STATE_PATH: path.join(DEV_DIR, "cloud-state.json"),
  CLOUD_CFG_PATH: path.join(DEV_DIR, "no-such-cloud.json"),
  SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "", SUGGEST_ENABLED: "0",
})
console.log(`[dev] 编辑技能自测：网关 :${GW_PORT}（登录已关），opencode 专用口 :${OC_PORT}`)
console.log(`[dev] 临时状态目录 ${DEV_DIR}；技能改动会真的落到仓库的 .opencode/skills，记得还原`)
await import("./server.mjs")
