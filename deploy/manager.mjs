#!/usr/bin/env node
// 多用户按需生命周期管理器（宿主 systemd 服务，不是容器 —— 避免把 docker.sock 交给任何容器）。
//
//   Internet ─HTTPS─> Caddy(单域名) ──> 127.0.0.1:8090(本进程) ──按路径首段(/用户名/)分发并剥前缀──> 127.0.0.1:<port>(用户容器)
//
// 职责：
//   1) 唤醒：请求到来时若对应容器已停 → docker start，轮询就绪后再反代（single-flight，避免并发首请求重复启动）。
//   2) 反代：透明流式转发，SSE 不缓冲（Node 管道天然不攒包）。
//   3) 空闲停机：60s 巡检，停掉「无在途连接且空闲超 IDLE_MS」的容器（开着的流 = 活跃，绝不打断十几分钟的流水线）。
//   4) 并发上限：最多 WARM_CAP 个容器同时在跑；要再起新的先按 LRU 停掉一个空闲容器（这是小内存机扛住多用户的关键闸）。
//
// 用户表来自 deploy/users/*.env（每个含 NAME/PORT）。改动后 systemctl reload sci-manager（SIGHUP）即热加载。

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---- 配置（全部可用环境变量覆盖，systemd unit 里注入）----
const USERS_DIR   = process.env.USERS_DIR   || path.join(__dirname, "users")
const LISTEN      = process.env.LISTEN      || "127.0.0.1:8090"   // 只监听回环，仅本机 Caddy 能连
const WARM_CAP    = Number(process.env.WARM_CAP    || 2)          // 同时在跑的容器上限（4G 机 2，16G 机 ~6）
const IDLE_MS     = Number(process.env.IDLE_MS     || 25 * 60 * 1000)   // 空闲多久后停机
const START_TIMEOUT_MS = Number(process.env.START_TIMEOUT_MS || 60 * 1000) // 冷启动就绪等待上限（含 opencode 预热）
const SWEEP_MS    = Number(process.env.SWEEP_MS    || 60 * 1000)  // 空闲巡检周期
const READY_PROBE_MS = 500                                        // 就绪轮询间隔

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---- 用户表 ----
/** name -> { name, port, base, container, lastActive, conns, starting } */
let users = new Map()

function parseEnvFile(file) {
  const out = {}
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
  return out
}

function loadUsers() {
  const next = new Map()
  let files = []
  try { files = fs.readdirSync(USERS_DIR).filter((f) => f.endsWith(".env")) } catch { /* 目录还没建 */ }
  for (const f of files) {
    const e = parseEnvFile(path.join(USERS_DIR, f))
    if (!e.NAME || !e.PORT) { log(`[users] 跳过 ${f}（缺 NAME/PORT）`); continue }
    const name = e.NAME
    // 保留已在跑用户的运行时状态（热加载不该清空计数/时间戳）
    const prev = users.get(name)
    next.set(name, prev
      ? Object.assign(prev, { port: Number(e.PORT) })
      : { name, port: Number(e.PORT), base: `/${name}`, container: `agent-${name}`, lastActive: 0, conns: 0, starting: null })
  }
  users = next
  log(`[users] 已加载 ${users.size} 个用户：${[...users.values()].map((u) => `${u.name}→:${u.port}`).join(", ") || "(空)"}`)
}

// ---- docker 封装 ----
const dockerExec = (args) => new Promise((resolve) => {
  execFile("docker", args, { timeout: 30000 }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() }))
})
async function isRunning(container) {
  const r = await dockerExec(["inspect", "-f", "{{.State.Running}}", container])
  if (r.code !== 0) { log(`[docker] inspect ${container} 失败：${r.stderr}`); return null } // null=容器不存在
  return r.stdout === "true"
}
const dockerStart = (c) => dockerExec(["start", c])
const dockerStop  = (c) => dockerExec(["stop", c])

// ---- 就绪探测：容器网关起来后能应答 HTTP 即视为就绪 ----
const probeReady = (port) => new Promise((resolve) => {
  const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (r) => { r.resume(); resolve(true) })
  req.on("error", () => resolve(false))
  req.on("timeout", () => { req.destroy(); resolve(false) })
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitReady(port, deadline) {
  while (Date.now() < deadline) { if (await probeReady(port)) return true; await sleep(READY_PROBE_MS) }
  return false
}

// ---- 并发上限：起新容器前，若已达 WARM_CAP，按 LRU 停一个空闲(conns==0)容器 ----
async function enforceWarmCap(exceptName) {
  const running = []
  for (const u of users.values()) {
    if (u.name === exceptName) continue
    if (await isRunning(u.container)) running.push(u)
  }
  // 含即将启动的自己在内，超过上限则驱逐
  while (running.length + 1 > WARM_CAP) {
    const idle = running.filter((u) => u.conns === 0).sort((a, b) => a.lastActive - b.lastActive)
    if (!idle.length) { log(`[cap] 已达上限但无空闲容器可停，暂时超配`); break }
    const victim = idle[0]
    log(`[cap] 达到 WARM_CAP=${WARM_CAP}，停掉最久空闲的 ${victim.container}`)
    await dockerStop(victim.container)
    running.splice(running.indexOf(victim), 1)
  }
}

// ---- 确保某用户容器在跑且就绪（single-flight）----
function ensureUp(u) {
  if (u.starting) return u.starting
  u.starting = (async () => {
    const running = await isRunning(u.container)
    if (running === null) throw new Error(`容器 ${u.container} 不存在（先跑 user-add 或 docker compose up --no-start）`)
    if (running && await probeReady(u.port)) return
    if (!running) {
      await enforceWarmCap(u.name)
      log(`[wake] 启动 ${u.container} …`)
      const r = await dockerStart(u.container)
      if (r.code !== 0) throw new Error(`docker start ${u.container} 失败：${r.stderr}`)
    }
    if (!await waitReady(u.port, Date.now() + START_TIMEOUT_MS))
      throw new Error(`${u.container} 在 ${START_TIMEOUT_MS}ms 内未就绪`)
    log(`[wake] ${u.container} 就绪`)
  })().finally(() => { u.starting = null })
  return u.starting
}

// ---- 反向代理（流式，不缓冲）。fwdPath 已剥掉 /用户名 前缀，容器按根路径处理 ----
function proxy(u, fwdPath, req, res) {
  u.conns++; u.lastActive = Date.now()
  const done = () => { u.conns = Math.max(0, u.conns - 1); u.lastActive = Date.now() }
  res.on("close", done)

  const headers = { ...req.headers }
  headers["x-forwarded-for"] = req.socket.remoteAddress || ""
  headers["x-forwarded-proto"] = "https"
  headers["x-forwarded-prefix"] = u.base
  const up = http.request({ host: "127.0.0.1", port: u.port, method: req.method, path: fwdPath, headers }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers)
    upRes.pipe(res)   // 逐块透传：SSE / 长流式输出不攒包
  })
  up.on("error", (e) => {
    log(`[proxy] ${u.name} 上游错误：${e.message}`)
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
    res.end("上游容器暂不可用")
  })
  req.pipe(up)
  req.on("aborted", () => up.destroy())
}

// ---- HTTP 入口：路径首段 = 用户名 ----
const server = http.createServer(async (req, res) => {
  const seg = (/^\/([^/?#]+)/.exec(req.url) || [])[1] || ""
  const u = users.get(seg)
  if (!u) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end(`未知用户路径：/${seg}`) }
  // 裸 /alice（无尾斜杠）→ 301 到 /alice/，否则页面里的相对 URL 会解析到根而错位
  if (req.url === "/" + seg) { res.writeHead(301, { Location: "/" + seg + "/" }); return res.end() }
  const fwdPath = req.url.slice(seg.length + 1) || "/"   // 剥掉 "/用户名"，容器收到根路径
  try {
    await ensureUp(u)
    proxy(u, fwdPath, req, res)
  } catch (e) {
    log(`[wake] ${u.name} 失败：${e.message}`)
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "5" })
    res.end(`服务正在启动，请几秒后重试。\n(${e.message})`)
  }
})

// ---- 空闲巡检：停掉无在途连接且空闲超时的容器 ----
setInterval(async () => {
  const now = Date.now()
  for (const u of users.values()) {
    if (u.conns > 0 || u.starting) continue            // 有开着的连接（含 SSE 长流）或正在启动 → 绝不停
    if (now - u.lastActive < IDLE_MS) continue
    if (await isRunning(u.container)) {
      log(`[idle] ${u.container} 空闲 ${Math.round((now - u.lastActive) / 1000)}s，停机`)
      await dockerStop(u.container)
    }
  }
}, SWEEP_MS)

process.on("SIGHUP", () => { log("[reload] 收到 SIGHUP，热加载用户表"); loadUsers() })

loadUsers()
const [lhost, lport] = LISTEN.includes(":") ? LISTEN.split(":") : ["127.0.0.1", LISTEN]
server.listen(Number(lport), lhost, () =>
  log(`manager 就绪 http://${lhost}:${lport}  WARM_CAP=${WARM_CAP} IDLE=${Math.round(IDLE_MS / 1000)}s`))
