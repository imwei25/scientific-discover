#!/usr/bin/env node
// 「文件夹分类 + 拖拽排序」这条分支的本地自测入口（分支 feat/session-folders）。
//
// 为什么要单独一个：这次改的全是【左侧会话栏】与【选工作目录】，跟模型一点关系都没有，
// 但要看到效果得先有一堆会话、几个项目、几个文件夹。真去跑模型建二十个会话既慢又费钱，
// 所以这里挂一个假的 opencode（只实现网关会打的那几个会话口），把演示数据一次摆好。
//
//   node web/dev-folders.mjs        # 默认 :3011
//
// 元数据、上传、产物全落系统临时目录，不碰仓库里的 web/sessions-meta.json 与 outputs/。
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// ★ 两个会话同时在这个检出里自测是常态（autoPort 会让后来者换个网关口）。所以
//   【工作目录与假 opencode 的端口都跟着网关口走】：DEV_DIR 起手就 rmSync 整棵删，
//   两个实例共用同一个默认目录的话，后起的那个会把先来的演示数据连根删掉；
//   假 oc 的口写死则直接 EADDRINUSE 起不来（换了口的网关照样连不上原来那个）。
const GW_PORT = Number(process.env.PORT || 3011)
const FAKE_OC_PORT = Number(process.env.OC_FAKE_PORT || GW_PORT + 1000)
const DEV_DIR = process.env.DEV_DIR || path.join(os.tmpdir(), "sci-folders-dev-" + GW_PORT)
fs.rmSync(DEV_DIR, { recursive: true, force: true })
fs.mkdirSync(DEV_DIR, { recursive: true })

// 假装成用户电脑上的几个项目目录，供「选工作目录」浏览与归类
const DEMO_ROOT = path.join(DEV_DIR, "我的电脑")
const DEMO_DIRS = ["甲状腺队列研究", "药物代谢组学", "综述-免疫治疗"].map((n) => path.join(DEMO_ROOT, n))
for (const d of DEMO_DIRS) { fs.mkdirSync(path.join(d, "figures"), { recursive: true }); fs.writeFileSync(path.join(d, "原始数据.xlsx"), "demo") }

const DAY = 86400_000, now = Date.now()
const SESSIONS = [
  { id: "ses_a1", title: "甲状腺结节超声特征与恶性风险", dir: DEMO_DIRS[0], age: 0.2 },
  { id: "ses_a2", title: "队列基线表 Table 1", dir: DEMO_DIRS[0], age: 1.4 },
  { id: "ses_a3", title: "KM 曲线与 Cox 回归", dir: DEMO_DIRS[0], age: 3.1 },
  { id: "ses_b1", title: "血药浓度-时间曲线拟合", dir: DEMO_DIRS[1], age: 0.6 },
  { id: "ses_b2", title: "代谢组学差异物质火山图", dir: DEMO_DIRS[1], age: 2.2 },
  { id: "ses_c1", title: "免疫治疗耐药机制综述提纲", dir: DEMO_DIRS[2], age: 0.9 },
  { id: "ses_x1", title: "帮我看看这份数据有没有问题", age: 0.1 },
  { id: "ses_x2", title: "国自然面上标书立项依据", age: 1.1 },
  { id: "ses_x3", title: "把这篇 PDF 翻译成中文", age: 2.5 },
  { id: "ses_x4", title: "森林图配色调整", age: 4.0 },
  { id: "ses_x5", title: "◆◆◆◆Δθ◆◆Π", age: 6.0 },              // 乱码标题的兜底也顺便看一眼
  { id: "ses_x6", title: "系统综述 PRISMA 流程图", age: 9.0 },
]

let n = 0
const state = {
  sessions: SESSIONS.map((s) => ({ id: s.id, title: s.title, time: { updated: now - s.age * DAY }, directory: s.dir || path.join(DEV_DIR, "outputs", s.id) })),
}
const oc = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x")
  if (u.pathname === "/global/event" || u.pathname === "/event") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
    const t = setInterval(() => res.write(`data: ${JSON.stringify({ type: "server.connected" })}\n\n`), 15_000)
    req.on("close", () => clearInterval(t))
    return
  }
  res.setHeader("content-type", "application/json")
  const m = /^\/session\/([^/]+)$/.exec(u.pathname)
  if (u.pathname === "/session" && req.method === "GET") return res.end(JSON.stringify(state.sessions))
  if (u.pathname === "/session" && req.method === "POST") {
    const s = { id: "ses_new" + ++n, title: "新会话", time: { updated: Date.now() }, directory: u.searchParams.get("directory") || "" }
    state.sessions.unshift(s)
    console.log(`[fake-oc] 建会话 ${s.id}  directory=${s.directory}`)
    return res.end(JSON.stringify(s))
  }
  if (m && req.method === "GET") {
    const s = state.sessions.find((x) => x.id === m[1])
    if (!s) { res.statusCode = 404; return res.end(JSON.stringify({ error: "no such session" })) }
    return res.end(JSON.stringify(s))
  }
  if (m && req.method === "DELETE") { state.sessions = state.sessions.filter((x) => x.id !== m[1]); return res.end("true") }
  if (/\/message$/.test(u.pathname)) return res.end("[]")
  res.end(u.pathname === "/config" || /^\/session\/[^/]+\//.test(u.pathname) ? "{}" : "[]")
})
await new Promise((r) => oc.listen(FAKE_OC_PORT, "127.0.0.1", r))

// 演示数据必须在【导入 server.mjs 之前】写好：网关启动时读一次 sessions-meta.json 到内存，
// 之后一切都以内存那份为准并覆盖回磁盘 —— 起来之后再改文件只会被它盖掉。
const META_FILE = path.join(DEV_DIR, "sessions-meta.json")
{
  const folders = DEMO_DIRS.map((d, i) => ({ id: "f_demo" + i, path: d, name: path.basename(d), created: now, order: i }))
  const projects = [{ id: "p_demo0", name: "2026 国自然", created: now, order: 0 }, { id: "p_demo1", name: "科室日常", created: now, order: 1 }]
  const sessions = {}
  for (const s of SESSIONS) {
    const m = {}
    const f = folders.find((x) => x.path === s.dir)
    if (f) m.folderId = f.id
    sessions[s.id] = m
  }
  // 两条会话【同时】挂项目和文件夹 —— 这次改造的重点之一：两边都要列出它
  sessions.ses_a1.projectId = "p_demo0"
  sessions.ses_x2.projectId = "p_demo0"
  sessions.ses_b1.projectId = "p_demo1"
  sessions.ses_x3.projectId = "p_demo1"
  fs.writeFileSync(META_FILE, JSON.stringify({ version: 1, projects, folders, sessions }, null, 2))
}

// 定时任务也要隔离 + 摆演示数据：侧栏「定时任务」分区（含行内删除按钮）才有东西可看，
// 而且删的是这里的假任务，不会碰真检出 tasks/ 里的定义（unregister 幂等，没注册过就直接 ok）。
const TASKS_DIR = path.join(DEV_DIR, "tasks")
fs.mkdirSync(TASKS_DIR, { recursive: true })
const DEMO_TASKS = [
  { id: "tk_demo0", title: "每周一扫甲状腺新文献", prompt: "扫一遍本周新文献", enabled: true, schedule: { kind: "weekly", days: [1], time: "07:00" }, createdAt: new Date(now - 5 * DAY).toISOString() },
  { id: "tk_demo1", title: "每天早上跑质控日报", prompt: "跑质控日报", enabled: false, schedule: { kind: "daily", time: "08:30" }, createdAt: new Date(now - 2 * DAY).toISOString() },
]
for (const t of DEMO_TASKS) fs.writeFileSync(path.join(TASKS_DIR, t.id + ".json"), JSON.stringify(t, null, 2))
// 档位闸：tierTasks 只认「已登录账号的 profile.tasksMode」，没登录一律 off、界面整个不出定时任务。
// 摆一份假登录态（refresh 随便填，云端地址是空的、不会真发请求）把档位放开到 full。
fs.writeFileSync(path.join(DEV_DIR, "cloud-state.json"),
  JSON.stringify({ refresh: "dev-fake", profile: { tasksMode: "full" } }, null, 2))

Object.assign(process.env, {
  SCI_TASKS_DIR: TASKS_DIR,
  SCI_TASK_SETTINGS_PATH: path.join(TASKS_DIR, ".settings.json"),
  SCI_TASK_SEEN_PATH: path.join(TASKS_DIR, ".news-seen.json"),
  // 别把假任务注册进真 Windows 任务计划（启动对账会补注册），也别拉起聊天桥
  //（第二个实例带 --force 会把用户正在用的那条桥杀掉）。
  SCI_TASK_SYNC: "0",
  SCI_CHAT_BRIDGE: "0",
  MANAGE_OC: "0",
  OC_URL: `http://127.0.0.1:${FAKE_OC_PORT}`,
  PORT: String(GW_PORT),
  LAN_AUTH: "0",
  SESSIONS_META_PATH: META_FILE,
  MODEL_CFG_PATH: path.join(DEV_DIR, "model-config.json"),
  OC_CONFIG_PATH: path.join(DEV_DIR, "opencode.json"),
  CLOUD_STATE_PATH: path.join(DEV_DIR, "cloud-state.json"),
  CLOUD_CFG_PATH: path.join(DEV_DIR, "no-such-cloud.json"),
  SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "", SUGGEST_ENABLED: "0",
})
console.log(`[dev] 假 opencode :${FAKE_OC_PORT}，演示目录在 ${DEMO_ROOT}`)
console.log(`[dev] 网关 :${process.env.PORT}（登录已关）`)
console.log(`[dev] 演示数据就绪：3 个文件夹 / 2 个项目 / ${SESSIONS.length} 个会话`)
await import("./server.mjs")
