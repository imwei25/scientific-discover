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
import crypto from "node:crypto"
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
const CAP_WAIT_MS = Number(process.env.CAP_WAIT_MS || 120 * 1000) // 满载排队等待上限（超时回繁忙）
const CAP_POLL_MS = 2000                                          // 满载时的排队轮询间隔

// ---- 管理台 /admin（宿主级：唯一能看全体用户的组件）----
// 未设 ADMIN_PASSWORD = 管理台关闭（/admin 一律 404）。设了才开，用它登录。走 Caddy HTTPS，Cookie 加 Secure。
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""
const ADMIN_ENABLED  = !!ADMIN_PASSWORD
const DEPLOY_DIR  = __dirname
const SCRIPTS_DIR = path.join(DEPLOY_DIR, "scripts")
const TIERS_FILE  = path.join(DEPLOY_DIR, "tiers.env")

// ---- LLM 网关(one-api)：manager 在宿主上，直接访问 one-api 的回环地址，代 /admin 管渠道/模型 ----
const ONEAPI_URL   = process.env.ONEAPI_URL || ""      // 如 http://127.0.0.1:3010
const ONEAPI_TOKEN = process.env.ONEAPI_TOKEN || ""    // one-api 的系统访问令牌
const GATEWAY_ENABLED = !!(ONEAPI_URL && ONEAPI_TOKEN)
// 调 one-api 管理 API（Bearer 令牌）。ONEAPI_URL 是明文回环 http，用 http 模块即可，无需 fetch。
function oaReq(method, apiPath, body) {
  return new Promise((resolve) => {
    let u; try { u = new URL(ONEAPI_URL + apiPath) } catch { return resolve({ status: 0, err: "bad url" }) }
    const data = body !== undefined ? JSON.stringify(body) : null
    const headers = { "Authorization": "Bearer " + ONEAPI_TOKEN, "New-Api-User": "1" }
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data) }
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (r) => {
      let b = ""; r.on("data", (c) => b += c); r.on("end", () => { try { resolve({ status: r.statusCode, json: JSON.parse(b || "{}") }) } catch { resolve({ status: r.statusCode, raw: b }) } })
    })
    req.on("error", (e) => resolve({ status: 0, err: e.message }))
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, err: "timeout" }) })
    if (data) req.write(data); req.end()
  })
}

// ---- 会话：无状态签名 cookie（HMAC，5天免登录；manager 重启也不掉线）----
const AUTH_TTL_MS = 5 * 24 * 60 * 60 * 1000
const b64u = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const hmac = (key, msg) => b64u(crypto.createHmac("sha256", key).update(msg).digest())
const signSession = (key, tag) => { const exp = Date.now() + AUTH_TTL_MS; return exp + "." + hmac(key, tag + "|" + exp) }
const validSession = (key, tag, val) => {
  if (!val) return false
  const i = val.indexOf("."); if (i < 0) return false
  const exp = Number(val.slice(0, i)), sig = val.slice(i + 1)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const good = hmac(key, tag + "|" + exp)
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))
}

// ---- 图形验证码（自建 SVG，零依赖零外部请求；答案存内存，3 分钟过期、一次性）----
const CAPTCHA_TTL_MS = 3 * 60 * 1000
const captchas = new Map()   // id -> { code, exp }
const CAP_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   // 去掉易混的 0O1IL
function newCaptcha() {
  const now = Date.now()
  for (const [k, v] of captchas) if (v.exp < now) captchas.delete(k)   // 顺手清过期
  let code = ""; for (let i = 0; i < 4; i++) code += CAP_CHARS[crypto.randomInt(CAP_CHARS.length)]
  const id = crypto.randomBytes(12).toString("hex")
  captchas.set(id, { code, exp: now + CAPTCHA_TTL_MS })
  return { id, code }
}
function verifyCaptcha(id, answer) {
  const c = captchas.get(id); if (!c) return false
  captchas.delete(id)                                   // 一次性：无论对错都作废，防重放
  return c.exp >= Date.now() && String(answer || "").toUpperCase() === c.code
}
// 手写 SVG：字符随机位置/旋转/颜色 + 噪点线，无需任何图形库
function captchaSvg(code) {
  const W = 130, H = 44, R = (a, b) => a + Math.floor(crypto.randomInt(Math.max(1, b - a + 1)))
  const cols = ["#2b3a55", "#3a5a40", "#6a3d5b", "#7a4b1e", "#334155"]
  let noise = ""
  for (let i = 0; i < 5; i++) noise += `<line x1="${R(0, W)}" y1="${R(0, H)}" x2="${R(0, W)}" y2="${R(0, H)}" stroke="${cols[R(0, 4)]}" stroke-width="1" opacity="0.35"/>`
  for (let i = 0; i < 18; i++) noise += `<circle cx="${R(0, W)}" cy="${R(0, H)}" r="1" fill="${cols[R(0, 4)]}" opacity="0.4"/>`
  let chars = ""
  for (let i = 0; i < code.length; i++) {
    const x = 16 + i * 28 + R(-3, 3), y = 30 + R(-4, 4), rot = R(-24, 24), fs = R(24, 30)
    chars += `<text x="${x}" y="${y}" font-family="Georgia,serif" font-size="${fs}" font-weight="700" fill="${cols[R(0, 4)]}" transform="rotate(${rot} ${x} ${y})">${code[i]}</text>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" rx="6" fill="#eef2f7"/>${noise}${chars}</svg>`
}
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || "").split(";").map((c) => { const i = c.indexOf("="); return i < 0 ? ["", ""] : [c.slice(0, i).trim(), c.slice(i + 1).trim()] }).filter((x) => x[0]))

// ---- 审计日志：登录成败 / 管理操作各写一行到 /var/log/sci-audit.log ----
const AUDIT_LOG = process.env.AUDIT_LOG || "/var/log/sci-audit.log"
const clientIp = (req) => ((req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "-"
function audit(event, fields) {
  const kv = Object.entries(fields || {}).map(([k, v]) => `${k}=${String(v).replace(/[\r\n|]/g, " ")}`).join(" ")
  try { fs.appendFileSync(AUDIT_LOG, `${new Date().toISOString()} | ${event} | ${kv}\n`) } catch { /* 记不上不影响主流程 */ }
}
// 停用/恢复用户：改写 users/<name>.env 的 SUSPENDED 行
function setSuspended(name, on) {
  const f = path.join(USERS_DIR, name + ".env")
  let lines; try { lines = fs.readFileSync(f, "utf8").split(/\r?\n/) } catch { return false }
  lines = lines.filter((l) => !/^SUSPENDED=/.test(l))
  while (lines.length && lines[lines.length - 1] === "") lines.pop()
  if (on) lines.push("SUSPENDED=1")
  fs.writeFileSync(f, lines.join("\n") + "\n")
  return true
}
const SUSPENDED_HTML = '<!doctype html><meta charset="utf-8"><title>账号已停用</title><div style="max-width:420px;margin:18vh auto;font:15px/1.7 system-ui,\'Microsoft YaHei\',sans-serif;color:#334;text-align:center"><div style="font-size:44px">🚫</div><h2 style="margin:.4em 0">账号已停用</h2><p style="color:#889">你的账号已被管理员暂时停用，数据已保留。请联系管理员恢复。</p></div>'

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
    const suspended = e.SUSPENDED === "1"
    // 保留已在跑用户的运行时状态（热加载不该清空计数/时间戳）
    const prev = users.get(name)
    next.set(name, prev
      ? Object.assign(prev, { port: Number(e.PORT), suspended })
      // lastActive 初值取「此刻」而非 0：取 0 意味着新加载的用户一上来就是「空闲了 56 年」，
      // 若其容器当时正在跑（如运维手动 docker start、或 manager 重启而容器还活着），
      // 下一轮 60s 巡检立刻判定超时把它停掉 —— 正在跑的活会被连锅端。
      : { name, port: Number(e.PORT), base: `/${name}`, container: `agent-${name}`, lastActive: Date.now(), conns: 0, starting: null, suspended })
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

// ---- 忙碌探测：容器里还有没有在跑的生成任务？----
// 为什么必须问：容器网关的设计是「关页面 = 只退订，生成继续跑」，用户点了「写论文」再关掉页面，
// 活是还在跑的。但 manager 只看得见 HTTP 连接，页面一关 SSE 就断、conns 归 0，光凭空闲时长会把
// 正跑着十几分钟流水线的容器停掉 —— 用户回来发现活没了。停机/腾位前都得先问这一句。
// 为什么走 docker exec 而不是直接 HTTP：容器网关对 127.0.0.1 的请求免鉴权，从容器【内部】打正好
// 命中该豁免，无需给 manager 发登录票据、也不必把 /api/busy 变成公开接口（容器彼此在同一 docker
// 网络里互通，而容器里跑的正是能执行任意代码的 agent，公开它等于让用户能互相探活动状态）。
// 判不准时返回 true（宁可多留一会儿，也不误杀正在跑的活）——除非容器压根没跑。
async function isBusy(u) {
  const r = await dockerExec(["exec", u.container, "curl", "-sf", "--max-time", "5",
    "http://127.0.0.1:3000/api/busy"])
  if (r.code !== 0) {
    // 容器没跑/curl 不在/网关没起 → 无所谓忙不忙，交由调用方按「不忙」处理（它自己会先判 isRunning）
    return false
  }
  try { return !!JSON.parse(r.stdout).busy } catch { log(`[busy] ${u.container} 探针回包异常：${r.stdout.slice(0, 80)}`); return true }
}

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

// ---- 并发上限：起新容器前确保有槽位。有空闲(conns==0)容器就 LRU 停一个腾位；
//      全忙则排队等待（轮询）直到有槽位，超 CAP_WAIT_MS 抛错 → 前端提示繁忙。绝不超配，内存是硬顶。----
async function makeRoom(exceptName) {
  const deadline = Date.now() + CAP_WAIT_MS
  let waited = false
  for (;;) {
    const running = []
    for (const u of users.values()) {
      if (u.name === exceptName) continue
      if (await isRunning(u.container)) running.push(u)
    }
    if (running.length + 1 <= WARM_CAP) return                       // 有空位 → 放行
    // 候选：无在途连接的容器，按空闲时长从久到近。但「没连接」不等于「没活干」——用户关了页面
    // 而生成还在跑的容器也长这样，驱逐它 = 杀掉别人跑到一半的论文。逐个探针确认真的闲着才动手。
    const idle = running.filter((u) => u.conns === 0).sort((a, b) => a.lastActive - b.lastActive)
    let evicted = false
    for (const cand of idle) {
      if (await isBusy(cand)) { cand.lastActive = Date.now(); continue }   // 有活在跑 → 换下一个候选
      log(`[cap] 达到 WARM_CAP=${WARM_CAP}，停掉最久空闲的 ${cand.container}`)
      await dockerStop(cand.container)
      evicted = true
      break
    }
    if (evicted) continue
    // 走到这儿 = 在跑的容器全都有活（连接着的，或关了页面但仍在生成的）→ 宁可排队，也不打断任何人
    if (Date.now() >= deadline) throw new Error(`并发已满（${WARM_CAP} 路全忙），排队超时，请稍后重试`)
    if (!waited) { log(`[cap] ${WARM_CAP} 路全忙且无空闲，${exceptName} 排队等待空闲槽位…`); waited = true }
    await sleep(CAP_POLL_MS)                                         // 全忙 → 等待，不超配
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
      await makeRoom(u.name)
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

// GET /pub/gateway/siblings?model=X：返回「含该模型的启用渠道」= 同一供应商，及其全部模型名（供用户在同供应商下切换）。
// 只回供应商名 + 模型名，不含 key/地址；未接入网关则 enabled:false。
async function handleSiblings(req, res) {
  const json = (obj) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)) }
  if (!GATEWAY_ENABLED) return json({ enabled: false, provider: "", models: [] })
  let model = ""; try { model = (new URL(req.url, "http://x").searchParams.get("model") || "").trim() } catch {}
  const r = await oaReq("GET", "/api/channel/?p=0&page_size=100")
  const chans = (r.json && r.json.data) || []
  const modelsOf = (c) => String(c.models || "").split(",").map((s) => s.trim()).filter(Boolean)
  let ch = (model && chans.find((c) => c.status === 1 && modelsOf(c).includes(model))) || chans.find((c) => c.status === 1)
  if (!ch) return json({ enabled: true, provider: "", models: model ? [model] : [] })
  return json({ enabled: true, provider: ch.name, models: modelsOf(ch) })
}

// GET /captcha：发一张 SVG 图形验证码，挑战 id 放进 cap_id cookie（登录 POST 自动带回核对）
function serveCaptcha(res) {
  const { id, code } = newCaptcha()
  res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store",
    "set-cookie": `cap_id=${id}; Path=/; Max-Age=180; HttpOnly; SameSite=Strict; Secure` })
  res.end(captchaSvg(code))
}
// 转发一个已被读出的请求体（登录场景：manager 先读 body 验验证码，再把原样 body 转给容器核对密码）
function proxyBuffered(u, fwdPath, req, res, body, onStatus) {
  u.conns++; u.lastActive = Date.now()
  res.on("close", () => { u.conns = Math.max(0, u.conns - 1); u.lastActive = Date.now() })
  const headers = { ...req.headers, "content-length": Buffer.byteLength(body) }
  headers["x-forwarded-proto"] = "https"
  headers["x-forwarded-prefix"] = u.base
  const up = http.request({ host: "127.0.0.1", port: u.port, method: req.method, path: fwdPath, headers }, (upRes) => {
    try { onStatus && onStatus(upRes.statusCode || 0) } catch {}
    res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res)
  })
  up.on("error", (e) => { log(`[proxy] ${u.name} 上游错误：${e.message}`); if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }); res.end("上游容器暂不可用") })
  up.end(body)
}
// 用户登录：先在 manager 校验图形验证码（错就不唤醒容器、直接回），过了再唤醒容器转发核对密码
async function handleUserLogin(u, fwdPath, req, res) {
  const chunks = []; for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  let captcha = ""; try { captcha = JSON.parse(body.toString() || "{}").captcha || "" } catch {}
  if (!verifyCaptcha(parseCookies(req).cap_id, captcha)) {
    audit("login.fail", { user: u.name, ip: clientIp(req), reason: "captcha" })
    res.writeHead(401, { "content-type": "application/json; charset=utf-8" })
    return res.end(JSON.stringify({ ok: false, err: "验证码错误", captcha: true }))
  }
  await ensureUp(u)
  proxyBuffered(u, fwdPath, req, res, body, (status) => audit(status === 200 ? "login.ok" : "login.fail", { user: u.name, ip: clientIp(req), reason: status === 200 ? "" : "password" }))
}

// ---- 通用登录页（服务于裸 /）：沿用原 web/login.html 的视觉（背景视频 + 玻璃登录框 + 主视觉文案），
// 只把提交逻辑改成"按用户名分发"：POST /<用户名>/api/login，成功跳 /<用户名>/。
// 不做中央认证：密码仍由各自容器校验，"该去哪个容器"= 用户名本身。★改设计时此处与 web/login.html 两份需同步。
const LOGIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · Niuma Research</title><meta name="theme-color" content="#010101">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://db.onlinewebfonts.com/c/2bf40ab72ea4897a3fd9b6e48b233a19?family=Garamond">
<style>
  :root { --sans: 'Geist', -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; --serif: 'Garamond', 'Times New Roman', serif; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: #010101; color: #fff; overflow: hidden; font-family: var(--sans); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  .stage { position: fixed; inset: 0; overflow: hidden; background: #010101; }
  .stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; z-index: 0; }
  .stage .veil { position: absolute; inset: 0; z-index: 1; background: radial-gradient(ellipse 80% 80% at 50% 50%, rgba(1,1,1,.08) 0%, rgba(1,1,1,.5) 100%); }
  .wrap { position: relative; z-index: 10; display: flex; flex-direction: column; min-height: 100vh; }
  nav { display: flex; align-items: center; justify-content: space-between; padding: 28px 40px; z-index: 20; }
  .brand { font-weight: 300; font-size: 12px; letter-spacing: .3em; text-transform: uppercase; color: #fff; white-space: nowrap; }
  .nav-links { display: flex; gap: 36px; align-items: center; }
  .nav-links a { font-weight: 300; font-size: 11px; letter-spacing: .2em; text-transform: uppercase; color: rgba(255,255,255,.68); text-decoration: none; transition: color .3s ease; }
  .nav-links a:hover { color: #fff; }
  .nav-right { display: flex; align-items: center; gap: 16px; }
  .try-btn { background: transparent; border: 1px solid rgba(255,255,255,.28); border-radius: 999px; color: rgba(255,255,255,.8); font-family: var(--sans); font-weight: 300; font-size: 11px; letter-spacing: .18em; text-transform: uppercase; padding: 7px 20px; cursor: pointer; white-space: nowrap; transition: background .22s ease, border-color .22s ease, color .22s ease; }
  .try-btn:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.5); color: #fff; }
  .hamburger { display: none; background: none; border: none; color: #fff; cursor: pointer; padding: 0; align-items: center; }
  .hamburger svg { width: 24px; height: 24px; stroke: currentColor; stroke-width: 1.6; fill: none; }
  .hero { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20px 20px 80px; gap: 24px; margin-top: -120px; }
  .hero h1 { font-family: var(--serif); font-size: clamp(36px, 7vw, 96px); font-weight: 400; color: #fff; line-height: 1.08; letter-spacing: -.01em; margin: 0 0 4px; }
  .hero h1 div { opacity: 0; transform: translateY(20px); animation: rise .9s cubic-bezier(.2,.7,.2,1) forwards; }
  .hero h1 div:nth-child(1) { animation-delay: .05s; }
  .hero h1 div:nth-child(2) { animation-delay: .18s; }
  .hero h1 div:nth-child(3) { animation-delay: .31s; }
  .hero p { font-weight: 300; font-size: clamp(13px, 1.8vw, 17px); color: rgba(255,255,255,.58); line-height: 1.75; max-width: 400px; margin: 0; opacity: 0; transform: translateY(12px); animation: rise .9s cubic-bezier(.2,.7,.2,1) .5s forwards; }
  @keyframes rise { to { opacity: 1; transform: none; } }
  form.login { position: fixed; top: 72%; right: 14%; transform: translateY(-50%); z-index: 50; display: flex; flex-direction: column; gap: 10px; align-items: flex-end; opacity: 0; animation: rise .9s cubic-bezier(.2,.7,.2,1) .7s forwards; }
  .pill { width: 220px; box-sizing: border-box; padding: 11px 20px; border-radius: 999px; background: rgba(4,7,10,.72); backdrop-filter: blur(16px) saturate(1.2); -webkit-backdrop-filter: blur(16px) saturate(1.2); border: 1px solid rgba(255,255,255,.1); box-shadow: 0 2px 16px rgba(0,0,0,.4); color: rgba(255,255,255,.88); font-family: var(--sans); font-size: 13px; font-weight: 300; letter-spacing: .03em; outline: none; display: block; transition: background .18s ease, border-color .18s ease; }
  .pill::placeholder { color: rgba(255,255,255,.22); }
  .pill:focus { background: rgba(4,7,10,.88); border-color: rgba(255,255,255,.22); }
  .pill.error { border-color: rgba(200,70,50,.5); }
  button.pill-btn { width: 220px; padding: 11px 20px; border-radius: 999px; background: rgba(4,7,10,.72); backdrop-filter: blur(16px) saturate(1.2); -webkit-backdrop-filter: blur(16px) saturate(1.2); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 2px 16px rgba(0,0,0,.4); color: rgba(255,255,255,.82); font-family: var(--sans); font-size: 11px; font-weight: 400; letter-spacing: .22em; text-transform: uppercase; cursor: pointer; display: block; transition: background .2s ease, border-color .2s ease, color .2s ease; }
  button.pill-btn:hover { background: rgba(4,7,10,.9); border-color: rgba(255,255,255,.26); color: rgba(255,255,255,.96); }
  button.pill-btn:active { transform: scale(.97); }
  button.pill-btn:disabled { opacity: .42; cursor: not-allowed; transform: none; }
  .err { min-height: 15px; font-size: 11px; color: rgba(220,75,55,.88); text-align: right; padding-right: 6px; opacity: 0; transition: opacity .16s; }
  .err.show { opacity: 1; }
  @media (max-width: 767px) {
    nav { padding: 22px 24px; }
    .nav-links, .try-btn { display: none; }
    .hamburger { display: flex; }
    .hero { margin-top: -60px; }
    form.login { position: fixed; top: auto; bottom: 40px; right: 0; left: 0; transform: none; align-items: center; }
  }
</style></head>
<body>
  <div class="stage">
    <video autoplay muted loop playsinline src="https://oss-crm-test-tellgen.oss-cn-shanghai.aliyuncs.com/videos/hf_20260619_191346_9d19d66e-86a4-47f7-8dc6-712c1788c3b2_1783489695679.mp4"></video>
    <div class="veil"></div>
  </div>
  <div class="wrap">
    <nav>
      <span class="brand">Niuma Research</span>
      <div class="nav-links"><a href="#">Research</a><a href="#">Database</a><a href="#">Skills</a><a href="#">About</a></div>
      <div class="nav-right">
        <button type="button" class="try-btn" id="try">Try it now</button>
        <button type="button" class="hamburger" aria-label="Toggle menu"><svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
      </div>
    </nav>
    <div class="hero">
      <h1><div>AI-POWERED</div><div>MEDICAL RESEARCH</div><div>REIMAGINED</div></h1>
      <p>250+ Research Skills · 50+ Medical Databases<br>Your all-in-one AI platform for medical science.</p>
    </div>
  </div>
  <form class="login" id="card" autocomplete="off">
    <input id="user" class="pill" type="text" placeholder="Username" autocomplete="username" autofocus>
    <input id="pw" class="pill" type="password" placeholder="Password" autocomplete="current-password">
    <div style="display:flex;gap:8px;width:220px;align-items:center">
      <input id="cap" class="pill" style="width:auto;flex:1;letter-spacing:.2em;text-transform:uppercase" type="text" placeholder="Code" autocomplete="off" maxlength="4">
      <img id="capimg" src="/captcha" alt="captcha" title="点击刷新" style="height:44px;width:auto;border-radius:12px;cursor:pointer;border:1px solid rgba(255,255,255,.14);flex:none">
    </div>
    <button type="submit" class="pill-btn" id="go">Sign In</button>
    <div class="err" id="err"></div>
  </form>
<script>
  var card=document.getElementById('card'),user=document.getElementById('user'),pw=document.getElementById('pw'),err=document.getElementById('err'),go=document.getElementById('go'),cap=document.getElementById('cap'),capimg=document.getElementById('capimg');
  document.getElementById('try').onclick=function(){user.focus()};
  function refreshCap(){capimg.src='/captcha?'+Date.now();cap.value=''}
  capimg.onclick=refreshCap;
  function fail(m){err.textContent=m;err.classList.add('show');user.classList.add('error');pw.classList.add('error');setTimeout(function(){user.classList.remove('error');pw.classList.remove('error')},1200);pw.select()}
  card.addEventListener('submit',async function(e){
    e.preventDefault();
    var username=user.value.trim(),password=pw.value.trim(),captcha=cap.value.trim();
    if(!username)return fail('请输入账号');
    if(!password)return fail('请输入密码');
    if(!captcha)return fail('请输入验证码');
    go.disabled=true;go.textContent='Signing in…';err.classList.remove('show');
    try{
      var r=await fetch('/'+encodeURIComponent(username)+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username,password:password,captcha:captcha})});
      if(r.ok){go.textContent='Welcome ✓';location.href='/'+encodeURIComponent(username)+'/';return}
      var j={};try{j=await r.json()}catch(_){}
      refreshCap();
      if(j&&j.captcha){fail('验证码错误')}else if(r.status===503){fail('服务器繁忙，请稍候重试')}else{fail('账号或密码错误')}
    }catch(_){refreshCap();fail('网络异常，请重试')}
    go.disabled=false;go.textContent='Sign In';
  });
</script>
</body></html>`

// ==== 管理台 /admin 的后端 ==========================================
// 读 tiers.env → [{key, daily, storage}]（与 render-compose.sh 同源解析）
function loadTiers() {
  const out = []
  try {
    for (const line of fs.readFileSync(TIERS_FILE, "utf8").split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue
      const p = line.trim().split(/\s+/)
      if (p.length >= 3 && p[0]) out.push({ key: p[0], daily: Number(p[1]) || 0, storage: Number(p[2]) || 0, model: p[3] || "" })
    }
  } catch { /* 无 tiers.env */ }
  return out
}
const userEnv = (name) => { try { return parseEnvFile(path.join(USERS_DIR, name + ".env")) } catch { return {} } }
// 解析某用户实际额度：显式覆盖 > 档位 > 0（与 render-compose.sh 一致）
function resolveLimits(name) {
  const e = userEnv(name)
  const t = loadTiers().find((x) => x.key === e.TIER) || null
  const pick = (explicit, tv) => (explicit !== undefined && explicit !== "" ? Number(explicit) : (t ? tv : 0))
  return { tier: e.TIER || "", daily: pick(e.DAILY_COST_LIMIT, t?.daily), storage: pick(e.STORAGE_LIMIT_MB, t?.storage) }
}
// docker 卷的宿主挂载点（缓存）；manager 以 root 跑，可直接读卷内文件，免去每次起 alpine
const _vmount = {}
async function mountpoint(vol) {
  if (_vmount[vol]) return _vmount[vol]
  const r = await dockerExec(["volume", "inspect", "-f", "{{.Mountpoint}}", vol])
  if (r.code === 0 && r.stdout) _vmount[vol] = r.stdout
  return _vmount[vol] || null
}
// 某用户今日成本（读 ocdata 卷 quota.json；server.mjs 按 UTC 日切）
async function todayCost(name) {
  const mp = await mountpoint(`${name}-ocdata`); if (!mp) return 0
  try {
    const q = JSON.parse(fs.readFileSync(path.join(mp, "quota.json"), "utf8"))
    return q && q.day === new Date().toISOString().slice(0, 10) ? Number(q.cost) || 0 : 0
  } catch { return 0 }
}
// 某用户存储用量 MB（uploads+outputs 卷），best-effort
async function storageUsedMB(name) {
  let mb = 0
  for (const v of ["uploads", "outputs"]) {
    const mp = await mountpoint(`${name}-${v}`); if (!mp) continue
    const out = await new Promise((res) => execFile("du", ["-sm", mp], { timeout: 15000 }, (e, o) => res(e ? "" : String(o))))
    mb += Number(out.split(/\s+/)[0] || 0)
  }
  return mb
}
// 跑 deploy/scripts/<script>（复用已验证的 user-add/del/tier/render 逻辑）
function runScript(script, args) {
  return new Promise((resolve) => {
    execFile("bash", [path.join(SCRIPTS_DIR, script), ...args], { cwd: DEPLOY_DIR, timeout: 90000 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }))
  })
}
const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); try { return JSON.parse(Buffer.concat(c).toString() || "{}") } catch { return {} } }
const adminAuthed = (req) => validSession(ADMIN_PASSWORD, "admin", parseCookies(req).admin_auth)   // 无状态签名会话
const safeEq = (a, b) => { const ab = Buffer.from(String(a)), bb = Buffer.from(String(b)); return ab.length === bb.length && crypto.timingSafeEqual(ab, bb) }

// 改档位定义：改写 tiers.env(增/改/删一个档) → 重渲染 → 重建「该档位下当前空闲」的容器（活跃的跳过并回报）
async function setTierDef(b) {
  const key = String(b.key || "").trim()
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(key)) return { ok: false, err: "档位键须小写字母开头（仅小写字母/数字/连字符）" }
  let lines = []
  try { lines = fs.readFileSync(TIERS_FILE, "utf8").split(/\r?\n/) } catch {}
  const kept = lines.filter((l) => { if (/^\s*#/.test(l)) return true; const p = l.trim().split(/\s+/); return p[0] !== key })
  if (!b.remove) {
    const model = String(b.model || "").trim().replace(/\s+/g, "") || "deepseek-v4-pro"   // 分级路由的模型名（第4列）
    kept.push(`${key}\t${Math.max(0, Number(b.dailyUSD) || 0)}\t${Math.max(0, Number(b.storageMB) || 0)}\t${model}`)
  }
  fs.writeFileSync(TIERS_FILE, kept.filter((l, i) => !(l === "" && i === kept.length - 1)).join("\n") + "\n")
  await runScript("render-compose.sh", [])
  const affected = []
  for (const [name, u] of users) {
    if ((userEnv(name).TIER || "") !== key) continue
    if (u.conns > 0) { affected.push({ name, skipped: true }); continue }   // 活跃会话不打断
    await dockerExec(["rm", "-f", u.container])
    await new Promise((res) => execFile("docker", ["compose", "up", "--no-start", u.container], { cwd: DEPLOY_DIR, timeout: 60000 }, () => res()))
    affected.push({ name, skipped: false })
  }
  return { ok: true, affected }
}

const ADMIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>用户管理台</title>
<style>
:root{--bg:#0f1216;--panel:#171b21;--p2:#1e242c;--line:#2a323c;--fg:#e7ecf2;--mut:#93a1b0;--acc:#4f8cff;--ok:#39b57a;--warn:#e6a23c;--bad:#e05a5a}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:16px;margin:0}.sp{flex:1}main{max-width:1000px;margin:0 auto;padding:22px 20px 60px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:22px}
h2{font-size:14px;margin:0 0 14px}.hint{color:var(--mut);font-weight:400;font-size:12px;margin-left:8px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--mut);font-weight:500;font-size:12px}td.name{font-weight:600}
select,input{background:var(--p2);border:1px solid var(--line);color:var(--fg);border-radius:7px;padding:5px 8px;font-size:13px}input.num{width:120px}
.btn{border:1px solid var(--line);background:var(--p2);color:var(--fg);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px}
.btn:hover{border-color:var(--acc)}.btn.primary{background:var(--acc);border-color:var(--acc);color:#fff}.btn.bad{border-color:var(--bad);color:#ff9b9b}
.bar{position:relative;height:7px;border-radius:5px;background:var(--p2);overflow:hidden;min-width:110px;margin-top:4px}.bar>i{position:absolute;inset:0 auto 0 0;background:var(--ok)}.bar.warn>i{background:var(--warn)}.bar.bad>i{background:var(--bad)}
.usage{white-space:nowrap;font-variant-numeric:tabular-nums}.mut{color:var(--mut)}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;background:var(--p2);border:1px solid var(--line);color:var(--mut)}
.pill.run{color:#7fe0ac;border-color:#2c5}.pill.act{color:#ffd27f;border-color:#a83}
.msg{font-size:13px;padding:8px 12px;border-radius:8px;margin-bottom:12px;display:none}.msg.ok{display:block;background:rgba(57,181,122,.12);color:#7fe0ac}.msg.err{display:block;background:rgba(224,90,90,.12);color:#ff9b9b}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}.card{background:var(--p2);border:1px solid var(--line);border-radius:10px;padding:12px}
.row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}label.lb{color:var(--mut);font-size:12px;width:60px}
#login{max-width:360px;margin:14vh auto;text-align:center}#login input{width:100%;margin:12px 0;padding:10px}code{background:var(--p2);padding:1px 5px;border-radius:5px}
</style></head><body>
<div id="app"></div>
<script>
const $=(h)=>{const t=document.createElement('template');t.innerHTML=h.trim();return t.content.firstElementChild}
const app=document.getElementById('app')
const fmt=(n)=>Number(n||0).toLocaleString()
const money=(n)=>'$'+Number(n||0).toFixed(n>=1?2:3)
async function api(p,opt){const r=await fetch('/admin/api/'+p,opt);if(r.status===401)throw {unauth:1};return r.json()}
function toast(m,ok){const e=document.querySelector('#msg');if(!e)return;e.textContent=m;e.className='msg '+(ok?'ok':'err');setTimeout(()=>e.className='msg',4000)}
let TIERS=[], MODELS=[]
function tierOpts(sel){return TIERS.map(t=>'<option value="'+t.key+'"'+(t.key===sel?' selected':'')+'>'+t.key+(t.daily?' ($'+t.daily+'/天)':' (不限)')+'</option>').join('')}
function modelOpts(sel){const o=MODELS.slice();if(sel&&o.indexOf(sel)<0)o.unshift(sel);return o.map(m=>'<option'+(m===sel?' selected':'')+'>'+m+'</option>').join('')}
async function renderGateway(box){let d;try{d=await api('gateway/channels')}catch(e){box.textContent='加载失败';return}
  if(!d.enabled){box.innerHTML='<div class="mut" style="font-size:13px">网关未接入（sci-manager 未配 ONEAPI_URL/ONEAPI_TOKEN）。配好后这里可直接加/看渠道。</div>';return}
  const rows=(d.channels||[]).map(c=>'<tr><td class="name">'+c.name+'</td><td class="mut" style="word-break:break-all">'+(c.base_url||'')+'</td><td>'+(c.models||'')+'</td><td>'+(c.status===1?'<span class="pill run">启用</span>':'<span class="pill">停</span>')+'</td></tr>').join('');
  box.innerHTML='<table><thead><tr><th>渠道</th><th>接口地址</th><th>模型名</th><th>状态</th></tr></thead><tbody>'+(rows||'<tr><td colspan="4" class="mut">暂无渠道</td></tr>')+'</tbody></table>'
    +'<div class="row" style="margin-top:12px;flex-wrap:wrap"><input id="gcn" placeholder="名称(如 OpenAI)" style="width:140px"><input id="gcu" placeholder="接口地址 https://api.openai.com/v1" style="flex:1;min-width:200px"><input id="gck" placeholder="API Key" style="width:160px"><input id="gcm" placeholder="模型名(逗号分隔)" style="width:170px"><button class="btn primary" id="gcadd">加渠道</button></div>'
    +'<div class="mut" style="font-size:12px;margin-top:6px">加完记得在某档位「模型」下拉里选它，才会有用户路由过去。</div>';
  box.querySelector('#gcadd').onclick=async()=>{const body={name:box.querySelector('#gcn').value.trim(),base_url:box.querySelector('#gcu').value.trim(),key:box.querySelector('#gck').value.trim(),models:box.querySelector('#gcm').value.trim()};if(!body.name||!body.base_url||!body.key||!body.models)return toast('请填全 名称/地址/Key/模型',0);const j=await api('gateway/channel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast(j.ok?('渠道 '+body.name+' 已添加'):(j.err||'失败'),j.ok);if(j.ok){MODELS=[];renderGateway(box)}}}
function bar(used,limit){if(!limit)return '<span class="usage">'+money(used)+' <span class="mut">/ 不限</span></span>';const pct=Math.min(100,Math.round(used/limit*100));const c=pct>=100?'bad':pct>=80?'warn':'';return '<div class="usage">'+money(used)+' <span class="mut">/ '+money(limit)+' ('+pct+'%)</span></div><div class="bar '+c+'"><i style="width:'+pct+'%"></i></div>'}
function sbar(usedMB,limitMB){if(!limitMB)return '<span class="usage">'+fmt(usedMB)+'MB <span class="mut">/ 不限</span></span>';const pct=Math.min(100,Math.round(usedMB/limitMB*100));const c=pct>=100?'bad':pct>=90?'warn':'';return '<div class="usage">'+fmt(usedMB)+' <span class="mut">/ '+fmt(limitMB)+'MB</span></div><div class="bar '+c+'"><i style="width:'+pct+'%"></i></div>'}

function renderLogin(err){app.innerHTML='';const box=$('<section id="login"><h2>用户管理台</h2><div class="msg '+(err?'err':'')+'" style="'+(err?'display:block':'')+'">'+(err||'')+'</div><input id="pw" type="password" placeholder="管理员密码" autofocus><div style="display:flex;gap:8px;margin:12px 0;align-items:center"><input id="cap" placeholder="验证码" maxlength="4" autocomplete="off" style="flex:1;text-transform:uppercase;letter-spacing:.2em"><img id="capimg" src="/captcha?'+Date.now()+'" title="点击刷新" style="height:40px;border-radius:7px;cursor:pointer;border:1px solid var(--line)"></div><button class="btn primary" id="go" style="width:100%">登录</button></section>')
  app.appendChild(box)
  box.querySelector('#capimg').onclick=(e)=>{e.target.src='/captcha?'+Date.now()}
  const go=async()=>{try{const r=await fetch('/admin/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value,captcha:document.getElementById('cap').value.trim()})});const j=await r.json();if(j.ok)load();else renderLogin(j.err||'登录失败')}catch(e){renderLogin('网络错误')}}
  box.querySelector('#go').onclick=go;box.querySelector('#pw').addEventListener('keydown',e=>{if(e.key==='Enter')go()});box.querySelector('#cap').addEventListener('keydown',e=>{if(e.key==='Enter')go()})}

async function load(){let d;try{d=await api('overview')}catch(e){return renderLogin('')}
  TIERS=d.tiers||[]
  try{const gm=await api('gateway/models');MODELS=(gm&&gm.models)||[]}catch(e){MODELS=[]}
  app.innerHTML=''
  app.appendChild($('<header><h1>用户管理台</h1><span class="hint">额度=USD/天（含缓存折扣），UTC 0点重置；同时在跑上限 '+d.warmCap+'</span><span class="sp"></span><button class="btn" id="reload">刷新</button><button class="btn" id="logout">退出</button></header>'))
  const main=$('<main><div class="msg" id="msg"></div></main>')
  // 用户表
  const us=$('<section><h2>用户<span class="hint">改档位即时重建容器生效；删除保留数据，勾选彻底删则先备份再删卷</span></h2><table><thead><tr><th>用户</th><th>档位</th><th>今日成本/额度</th><th>存储</th><th>状态</th><th></th></tr></thead><tbody id="ut"></tbody></table></section>')
  main.appendChild(us)
  const tb=us.querySelector('#ut')
  d.users.forEach(u=>{const stat=u.suspended?'<span class="pill" style="color:#ff9b9b;border-color:#a55">已停用</span>':(u.active?'<span class="pill act">活跃</span>':u.running?'<span class="pill run">运行</span>':'<span class="pill">停</span>');
    const tr=$('<tr><td class="name">'+u.name+'</td><td><select class="ts">'+tierOpts(u.tier)+'</select></td><td>'+bar(u.todayCost,u.daily)+'</td><td>'+sbar(u.storageUsedMB,u.storage)+'</td><td>'+stat+'</td><td style="white-space:nowrap"><button class="btn save">保存</button> <button class="btn susp">'+(u.suspended?'恢复':'停用')+'</button> <button class="btn bad del">删</button></td></tr>')
    tr.querySelector('.save').onclick=async()=>{const tier=tr.querySelector('.ts').value;const j=await api('tier',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:u.name,tier})});toast(j.ok?(u.name+' → '+tier+'（已重建生效）'):(j.out||'失败'),j.ok);if(j.ok)load()}
    tr.querySelector('.susp').onclick=async()=>{const on=!u.suspended;if(on&&!confirm('停用 '+u.name+'？将立即停其容器、踢下线，数据保留，恢复后照常。'))return;const j=await api('suspend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:u.name,suspend:on})});toast(j.ok?(u.name+(on?' 已停用':' 已恢复')):(j.err||'失败'),j.ok);if(j.ok)load()}
    tr.querySelector('.del').onclick=async()=>{const purge=confirm('删除用户 '+u.name+'。\\n\\n确定=保留数据卷（可复原）\\n取消后可再选彻底删。\\n\\n点“确定”仅移除容器与配置，保留数据。');if(!purge&&!confirm('改为【彻底删除】'+u.name+' 连同其所有数据卷？此操作先自动备份再删，不可逆。'))return;const hard=!purge;const j=await api('user-del',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:u.name,purge:hard})});toast(j.ok?('已删除 '+u.name+(hard?'（含数据）':'（留数据）')):(j.out||'失败'),j.ok);if(j.ok)load()}
    tb.appendChild(tr)})
  // 加用户
  const add=$('<section><h2>新增用户</h2><div class="row"><input id="nn" placeholder="用户名（小写字母开头）" style="width:220px"><select id="nt">'+tierOpts('free')+'</select><button class="btn primary" id="addbtn">创建</button></div><div class="hint" id="addout" style="margin-top:10px"></div></section>')
  main.appendChild(add)
  add.querySelector('#addbtn').onclick=async()=>{const name=add.querySelector('#nn').value.trim();const tier=add.querySelector('#nt').value;if(!name)return toast('填用户名',0);const j=await api('user-add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,tier})});if(j.ok){add.querySelector('#addout').innerHTML='✅ 已创建 <b>'+name+'</b>（'+tier+'）　密码：<code>'+(j.password||'见日志')+'</code>　请发给该用户并妥善保存';toast('已创建 '+name,1);setTimeout(load,1500)}else toast(j.out||'失败',0)}
  // 档位编辑
  const ts=$('<section><h2>档位与额度<span class="hint">改额度对该档所有用户生效：重建其空闲容器，活跃会话下次冷启动生效</span></h2><div class="grid" id="tg"></div><div class="row" style="margin-top:14px"><input id="tk" placeholder="新档位键(如 vip)" style="width:150px"><input id="td" class="num" type="number" step="0.01" min="0" placeholder="每日USD 0=不限"><input id="ts2" class="num" type="number" min="0" placeholder="存储MB 0=不限"><button class="btn primary" id="taddbtn">新增/更新档位</button></div></section>')
  main.appendChild(ts)
  const tg=ts.querySelector('#tg')
  TIERS.forEach(t=>{const mfield=MODELS.length?'<select class="tm" style="flex:1;width:auto">'+modelOpts(t.model)+'</select>':'<input class="tm" style="flex:1" value="'+(t.model||'')+'" placeholder="模型名">';
    const c=$('<div class="card"><div style="font-weight:600">'+t.key+'</div><div class="row"><label class="lb">每日USD</label><input class="num td" type="number" step="0.01" min="0" value="'+t.daily+'"></div><div class="row"><label class="lb">存储MB</label><input class="num ts" type="number" min="0" value="'+t.storage+'"></div><div class="row"><label class="lb">模型</label>'+mfield+'</div><div class="row"><span class="mut" style="flex:1;font-size:12px">0=不限；改模型需重建容器</span><button class="btn save">保存</button> <button class="btn bad del">删</button></div></div>')
    c.querySelector('.save').onclick=async()=>{const j=await api('tier-def',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:t.key,dailyUSD:c.querySelector('.td').value,storageMB:c.querySelector('.ts').value,model:c.querySelector('.tm').value})});toast(j.ok?('档位 '+t.key+' 已更新'+(j.affected&&j.affected.some(a=>a.skipped)?'（部分活跃用户下次冷启动生效）':'')):'失败',j.ok);if(j.ok)load()}
    c.querySelector('.del').onclick=async()=>{if(!confirm('删除档位 '+t.key+'？该档位下的用户将回落到不限额，请先给他们改到别的档。'))return;const j=await api('tier-def',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:t.key,remove:true})});toast(j.ok?('已删档位 '+t.key):'失败',j.ok);if(j.ok)load()}
    tg.appendChild(c)})
  ts.querySelector('#taddbtn').onclick=async()=>{const key=ts.querySelector('#tk').value.trim();if(!key)return toast('填档位键',0);const j=await api('tier-def',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,dailyUSD:ts.querySelector('#td').value,storageMB:ts.querySelector('#ts2').value})});toast(j.ok?('档位 '+key+' 已保存'):(j.err||'失败'),j.ok);if(j.ok)load()}
  // LLM 网关渠道
  const gw=$('<section><h2>LLM 网关渠道<span class="hint">加一家供应商即在此；权重·failover·用量日志等高级项去 one-api 台</span></h2><div id="gwbox">加载中…</div></section>')
  main.appendChild(gw); renderGateway(gw.querySelector('#gwbox'))
  // 审计日志
  const au=$('<section><h2>审计日志<span class="hint">最近100条：登录成败 / 管理操作（新→旧）</span></h2><div id="aud" style="max-height:260px;overflow:auto;font:12px/1.7 ui-monospace,Consolas,monospace;color:var(--mut);white-space:pre-wrap">加载中…</div></section>')
  main.appendChild(au)
  api('audit').then(a=>{var bj=function(l){var i=l.indexOf(' | ');if(i<0)return l;var d=new Date(l.slice(0,i));if(isNaN(d))return l;return new Date(d.getTime()+288e5).toISOString().slice(0,19).replace('T',' ')+l.slice(i)};au.querySelector('#aud').textContent=(a.lines&&a.lines.length)?a.lines.map(bj).join('\\n'):'（暂无记录）'}).catch(()=>{au.querySelector('#aud').textContent='加载失败'})
  app.appendChild(main)
  document.getElementById('reload').onclick=load
  document.getElementById('logout').onclick=async()=>{await fetch('/admin/api/logout',{method:'POST'});renderLogin('')}
}
load()
</script></body></html>`

async function handleAdmin(req, res, pathname) {
  const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)) }
  if (!ADMIN_ENABLED) return json(404, { ok: false, err: "管理台未启用（未设 ADMIN_PASSWORD）" })

  if (req.method === "GET" && (pathname === "/admin" || pathname === "/admin/")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(ADMIN_HTML)
  }
  if (req.method === "POST" && pathname === "/admin/api/login") {
    const b = await readBody(req)
    if (!verifyCaptcha(parseCookies(req).cap_id, b.captcha)) { await sleep(400); audit("admin.login.fail", { ip: clientIp(req), reason: "captcha" }); return json(401, { ok: false, err: "验证码错误", captcha: true }) }
    if (!safeEq(b.password || "", ADMIN_PASSWORD)) { await sleep(600); audit("admin.login.fail", { ip: clientIp(req), reason: "password" }); return json(401, { ok: false, err: "密码错误", captcha: true }) }
    audit("admin.login.ok", { ip: clientIp(req) })
    res.writeHead(200, { "content-type": "application/json", "set-cookie": `admin_auth=${signSession(ADMIN_PASSWORD, "admin")}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${AUTH_TTL_MS / 1000}` })
    return res.end(JSON.stringify({ ok: true }))
  }
  if (req.method === "POST" && pathname === "/admin/api/logout") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "admin_auth=; Path=/admin; Max-Age=0" }); return res.end("{}")
  }
  if (!adminAuthed(req)) return json(401, { ok: false, err: "unauthorized" })   // 以下均需登录

  if (req.method === "GET" && pathname === "/admin/api/overview") {
    const list = []
    for (const [name, u] of users) {
      const lim = resolveLimits(name)
      list.push({ name, tier: lim.tier, daily: lim.daily, storage: lim.storage,
        todayCost: await todayCost(name), storageUsedMB: await storageUsedMB(name),
        running: (await isRunning(u.container)) === true, active: u.conns > 0, suspended: !!u.suspended })
    }
    return json(200, { tiers: loadTiers(), users: list, warmCap: WARM_CAP })
  }
  if (req.method === "POST" && pathname === "/admin/api/tier") {
    const b = await readBody(req)
    const r = await runScript("user-tier.sh", [String(b.name || ""), String(b.tier || "")])
    loadUsers(); audit("admin.tier", { ip: clientIp(req), name: b.name, tier: b.tier, ok: r.code === 0 })
    return json(r.code === 0 ? 200 : 400, { ok: r.code === 0, out: (r.stdout + r.stderr).trim() })
  }
  if (req.method === "POST" && pathname === "/admin/api/user-add") {
    const b = await readBody(req)
    const r = await runScript("user-add.sh", [String(b.name || ""), String(b.tier || "free")])
    loadUsers(); audit("admin.user-add", { ip: clientIp(req), name: b.name, tier: b.tier || "free", ok: r.code === 0 })
    const pw = (r.stdout.match(/密码：(\S+)/) || [])[1] || ""
    return json(r.code === 0 ? 200 : 400, { ok: r.code === 0, password: pw, out: (r.stdout + r.stderr).trim() })
  }
  if (req.method === "POST" && pathname === "/admin/api/user-del") {
    const b = await readBody(req)
    const args = [String(b.name || "")]; if (b.purge) args.push("--purge")
    const r = await runScript("user-del.sh", args)
    loadUsers(); audit("admin.user-del", { ip: clientIp(req), name: b.name, purge: !!b.purge, ok: r.code === 0 })
    return json(r.code === 0 ? 200 : 400, { ok: r.code === 0, out: (r.stdout + r.stderr).trim() })
  }
  // 停用 / 恢复用户
  if (req.method === "POST" && pathname === "/admin/api/suspend") {
    const b = await readBody(req)
    const name = String(b.name || "").trim(), on = !!b.suspend
    if (!users.has(name)) return json(400, { ok: false, err: "无此用户" })
    const ok = setSuspended(name, on); loadUsers()
    if (on) { try { await dockerStop(`agent-${name}`) } catch {} }   // 停用即停其容器、踢下线
    audit("admin.suspend", { ip: clientIp(req), name, suspend: on })
    return json(ok ? 200 : 400, { ok })
  }
  if (req.method === "POST" && pathname === "/admin/api/tier-def") {
    const b = await readBody(req)
    const r = await setTierDef(b); audit("admin.tier-def", { ip: clientIp(req), key: b.key, remove: !!b.remove, ok: r.ok })
    return json(200, r)
  }
  // ---- LLM 网关(one-api)代理：让 /admin 直接管渠道与可用模型 ----
  if (req.method === "GET" && pathname === "/admin/api/gateway/channels") {
    if (!GATEWAY_ENABLED) return json(200, { enabled: false, channels: [] })
    const r = await oaReq("GET", "/api/channel/?p=0&page_size=100")
    const items = (r.json && r.json.data) || []
    return json(200, { enabled: true, channels: items.map((c) => ({ id: c.id, name: c.name, type: c.type, status: c.status, base_url: c.base_url, models: c.models, used_quota: c.used_quota })) })
  }
  if (req.method === "GET" && pathname === "/admin/api/gateway/models") {
    if (!GATEWAY_ENABLED) return json(200, { enabled: false, models: [] })
    const r = await oaReq("GET", "/api/channel/?p=0&page_size=100")
    const set = new Set()
    for (const c of (r.json && r.json.data) || []) for (const m of String(c.models || "").split(",")) { const s = m.trim(); if (s) set.add(s) }
    return json(200, { enabled: true, models: [...set].sort() })
  }
  if (req.method === "POST" && pathname === "/admin/api/gateway/channel") {
    if (!GATEWAY_ENABLED) return json(400, { ok: false, err: "网关未接入（未配 ONEAPI_URL/ONEAPI_TOKEN）" })
    const b = await readBody(req)
    const name = String(b.name || "").trim(), base = String(b.base_url || "").trim(), key = String(b.key || "").trim(), models = String(b.models || "").trim()
    if (!name || !base || !key || !models) return json(400, { ok: false, err: "请填 名称/接口地址/Key/模型名" })
    const r = await oaReq("POST", "/api/channel/", { name, type: Number(b.type) || 1, key, base_url: base, models, group: "default", groups: ["default"], model_mapping: "" })
    const ok = !!(r.json && r.json.success)
    audit("admin.gateway.channel-add", { ip: clientIp(req), name, base, ok })
    return json(ok ? 200 : 400, { ok, err: ok ? "" : ((r.json && r.json.message) || "添加失败") })
  }

  // 审计日志：最近 100 条（新→旧）
  if (req.method === "GET" && pathname === "/admin/api/audit") {
    let lines = []
    try { lines = fs.readFileSync(AUDIT_LOG, "utf8").trim().split("\n").filter(Boolean).slice(-100).reverse() } catch {}
    return json(200, { lines })
  }
  return json(404, { ok: false, err: "not found" })
}
// ==== /管理台后端 ===================================================

// ---- HTTP 入口：路径首段 = 用户名 ----
const server = http.createServer(async (req, res) => {
  const pathname = req.url.split(/[?#]/)[0] || "/"
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return handleAdmin(req, res, pathname)   // 管理台：不当用户名路由
  if (pathname === "/captcha") return serveCaptcha(res)                                                 // 图形验证码：manager 直接发
  if (pathname === "/pub/gateway/siblings") return handleSiblings(req, res)                              // 用户切模型：同供应商可选模型（只回名字，无 key）
  const seg = (/^\/([^/?#]+)/.exec(req.url) || [])[1] || ""
  if (!seg) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(LOGIN_HTML) }
  const u = users.get(seg)
  if (!u) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end(`未知用户路径：/${seg}（请访问 / 登录）`) }
  if (u.suspended) { res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(SUSPENDED_HTML) }   // 已停用：任何路径都挡在门外
  // 裸 /alice（无尾斜杠）→ 301 到 /alice/，否则页面里的相对 URL 会解析到根而错位
  if (req.url === "/" + seg) { res.writeHead(301, { Location: "/" + seg + "/" }); return res.end() }
  const fwdPath = req.url.slice(seg.length + 1) || "/"   // 剥掉 "/用户名"，容器收到根路径
  try {
    if (req.method === "POST" && fwdPath === "/api/login") return await handleUserLogin(u, fwdPath, req, res)   // 登录先过验证码
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
      // 没连接 ≠ 没活干：用户关了页面但生成仍在跑（容器网关设计如此）。停机前必须问一句。
      if (await isBusy(u)) {
        u.lastActive = Date.now()                      // 有活在跑 → 视为活跃，重新计时
        log(`[idle] ${u.container} 无连接但仍有生成任务在跑，暂不停机`)
        continue
      }
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
