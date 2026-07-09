import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { spawn, execSync } from "node:child_process"
import { setGlobalDispatcher, Agent } from "undici"
import { createOpencodeClient } from "@opencode-ai/sdk"

// opencode 的完整流水线（标书/论文/系统综述）单轮可跑十几分钟，而 session.prompt 是“等整轮结束才返回”的请求；
// undici 默认 5 分钟 headers/body 超时会让这类长轮假性抛错。关掉这两个超时（0=不限），连接超时保留。
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 10_000 }))

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const UPLOADS = path.join(ROOT, "uploads")
const OUTPUTS = path.join(ROOT, "outputs")
fs.mkdirSync(UPLOADS, { recursive: true })
fs.mkdirSync(OUTPUTS, { recursive: true })

const OC_URL = process.env.OC_URL || "http://127.0.0.1:4098"
const client = createOpencodeClient({ baseUrl: OC_URL })
const un = (r) => (r && r.data !== undefined ? r.data : r)
const [PID, MID] = (process.env.OC_MODEL || "deepseek/deepseek-v4-pro").split("/")
const MODEL = { providerID: PID, modelID: MID }
const PORT = Number(process.env.PORT || 3000)
// ---- 每个会话独占 uploads/<sid>/ 和 outputs/<sid>/（多用户隔离）----
const safeSid = (s) => (s || "").replace(/[^a-zA-Z0-9_-]/g, "")   // 防目录穿越
const wsUp = (sid) => path.join(UPLOADS, safeSid(sid))
const wsOut = (sid) => path.join(OUTPUTS, safeSid(sid))
const ensureWs = (sid) => { fs.mkdirSync(wsUp(sid), { recursive: true }); fs.mkdirSync(wsOut(sid), { recursive: true }) }
const relUp = (sid) => `uploads/${safeSid(sid)}`     // 相对仓库根、正斜杠，喂给 agent
const relOut = (sid) => `outputs/${safeSid(sid)}`
// 某目录里顶层文件的 name -> mtime 快照（跳过隐藏项和子目录）
const dirState = (dir) => {
  if (!fs.existsSync(dir)) return {}
  const m = {}
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(".")) continue
    const st = fs.statSync(path.join(dir, f))
    if (st.isFile()) m[f] = st.mtimeMs
  }
  return m
}
// 相对某个快照，哪些文件是本轮新建或被改动的（最新在前）
const changedSince = (dir, before) => {
  const now = dirState(dir)
  return Object.keys(now)
    .filter(name => !(name in before) || now[name] > before[name])
    .sort((a, b) => now[b] - now[a])
}
const send = (res, code, type, body) => { res.writeHead(code, { "Content-Type": type }); res.end(body) }

// ---- 局域网访问的简易单用户登录（demo）----
// 本机（localhost）访问免登录；从局域网 IP 访问才要求输入密码。登录成功发一个随机 token 到 Cookie。
const LAN_USER = process.env.LAN_USER || "tellgen"             // 单用户账号，可用环境变量覆盖
const LAN_PASSWORD = process.env.LAN_PASSWORD || "123"         // 单用户密码，可用环境变量覆盖
const AUTH_ENABLED = process.env.LAN_AUTH !== "0"             // LAN_AUTH=0 可整体关闭登录
const tokens = new Set()                                      // 内存里的有效 token（重启即失效，demo 足够）
const PUBLIC_PATHS = new Set(["/login", "/api/login"])        // 不需登录即可访问的路径
const isLocal = (req) => {
  const a = req.socket.remoteAddress || ""
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1" || a.startsWith("127.")
}
const cookieOf = (req, key) => {
  const raw = req.headers.cookie || ""
  for (const kv of raw.split(";")) { const [k, ...v] = kv.trim().split("="); if (k === key) return decodeURIComponent(v.join("=")) }
  return null
}
const authed = (req) => !AUTH_ENABLED || isLocal(req) || tokens.has(cookieOf(req, "lan_auth") || "")

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost")
  try {
    // 登录页：未登录的局域网访客看到它；已登录/本机则直接跳回主页
    if (req.method === "GET" && u.pathname === "/login") {
      if (authed(req)) { res.writeHead(302, { Location: "/" }); return res.end() }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      return res.end(fs.readFileSync(path.join(__dirname, "login.html")))
    }
    // 校验密码 → 发 token Cookie
    if (req.method === "POST" && u.pathname === "/api/login") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let user = "", pw = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); user = (b.username || "").trim(); pw = (b.password || "").trim() } catch {}
      if (user !== LAN_USER || pw !== LAN_PASSWORD) return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "账号或密码错误" }))
      const tok = crypto.randomBytes(24).toString("hex"); tokens.add(tok)
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` })
      return res.end(JSON.stringify({ ok: true }))
    }
    // 退出登录
    if (req.method === "POST" && u.pathname === "/api/logout") {
      tokens.delete(cookieOf(req, "lan_auth") || "")
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "lan_auth=; Path=/; HttpOnly; Max-Age=0" })
      return res.end(JSON.stringify({ ok: true }))
    }
    // 门禁：其余路径若未登录 → 页面跳登录页、接口回 401
    if (!PUBLIC_PATHS.has(u.pathname) && !authed(req)) {
      if (req.method === "GET" && (req.headers.accept || "").includes("text/html")) {
        res.writeHead(302, { Location: "/login" }); return res.end()
      }
      return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "unauthorized" }))
    }
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })   // 每次取最新页面，避免浏览器缓存旧版
      return res.end(fs.readFileSync(path.join(__dirname, "index.html")))
    }

    if (req.method === "POST" && u.pathname === "/api/upload") {
      let sid = u.searchParams.get("sid") || null
      if (!sid) sid = un(await client.session.create({ body: { title: "web" } })).id   // 上传先于对话则现建会话
      ensureWs(sid)
      const name = path.basename(u.searchParams.get("name") || "upload.bin")
      const chunks = []; for await (const c of req) chunks.push(c)
      const dest = path.join(wsUp(sid), name); fs.writeFileSync(dest, Buffer.concat(chunks))
      return send(res, 200, "application/json", JSON.stringify({ ok: true, sid, path: `${relUp(sid)}/${name}`, size: fs.statSync(dest).size }))
    }

    if (req.method === "GET" && u.pathname === "/api/files")
      return send(res, 200, "application/json", JSON.stringify([]))   // 页面初始不预载历史产物，只在对话后显示本轮新产物

    // 列出本会话 uploads/ 里已上传的文件（含大小），用于侧栏“上传空间”的常驻展示
    if (req.method === "GET" && u.pathname === "/api/uploads") {
      const sid = u.searchParams.get("sid") || ""
      const dir = sid ? wsUp(sid) : UPLOADS
      if (!fs.existsSync(dir)) return send(res, 200, "application/json", "[]")
      const list = fs.readdirSync(dir)
        .filter((f) => !f.startsWith("."))
        .map((f) => { const st = fs.statSync(path.join(dir, f)); return st.isFile() ? { name: f, size: st.size, mtime: st.mtimeMs } : null })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)   // 最新上传在前
      return send(res, 200, "application/json", JSON.stringify(list))
    }

    // 删除本会话某个已上传文件
    if (req.method === "POST" && u.pathname === "/api/upload/delete") {
      const sid = u.searchParams.get("sid") || ""
      const name = path.basename(u.searchParams.get("name") || "")
      const f = path.join(sid ? wsUp(sid) : UPLOADS, name)
      if (!name || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "application/json", JSON.stringify({ ok: false }))
      try { fs.unlinkSync(f) } catch (e) { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e) })) }
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    // 最近会话列表（排除子 agent 会话，按更新时间倒序取前 10）——支持“断点续问”
    if (req.method === "GET" && u.pathname === "/api/sessions") {
      const all = un(await client.session.list()) || []
      const list = all
        .filter((s) => !s.parentID)
        .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
        .slice(0, 10)
        .map((s) => ({ id: s.id, title: s.title || "(未命名)", updated: s.time?.updated || 0 }))
      return send(res, 200, "application/json", JSON.stringify(list))
    }

    // 某会话的历史消息（user/assistant 正文），用于断点续问时回显上下文
    if (req.method === "GET" && u.pathname === "/api/history") {
      const id = u.searchParams.get("id") || ""
      if (!id) return send(res, 400, "application/json", "[]")
      const msgs = un(await client.session.messages({ path: { id } })) || []
      const out = []
      for (const m of msgs) {
        const role = m.info?.role
        if (role !== "user" && role !== "assistant") continue
        let text = (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim()
        text = text.replace(/^【本会话专属目录[\s\S]*?】[\s\S]*?\n\n/, "")   // 剥掉注入的目录前言，只回显真正对话
        if (text) out.push({ role, text })
      }
      return send(res, 200, "application/json", JSON.stringify(out))
    }

    // 删除一个会话
    if (req.method === "POST" && u.pathname === "/api/session/delete") {
      const id = u.searchParams.get("id") || ""
      if (!id) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      try { await client.session.delete({ path: { id } }) } catch (e) { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e) })) }
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    // 编辑历史消息：回退到第 uindex 个用户消息（含）之前，opencode 会丢弃其后的消息；
    // 之后前端把编辑后的内容当新消息重发。uploads/ 与 outputs/ 均在 .gitignore 里，
    // opencode 基于 git 快照的回退不会动它们 —— 满足“文件不变”。
    if (req.method === "POST" && u.pathname === "/api/revert") {
      const sid = u.searchParams.get("sid") || ""
      const uindex = Number(u.searchParams.get("uindex"))
      if (!sid || !Number.isInteger(uindex) || uindex < 0) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      const msgs = un(await client.session.messages({ path: { id: sid } })) || []
      const target = msgs.filter((m) => m.info?.role === "user")[uindex]   // 按顺序取第 uindex 个用户消息
      if (!target?.info?.id) return send(res, 404, "application/json", JSON.stringify({ ok: false, err: "message not found" }))
      try { await client.session.revert({ path: { id: sid }, body: { messageID: target.info.id } }) }
      catch (e) { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e) })) }
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    if (req.method === "GET" && u.pathname === "/api/download") {
      const sid = u.searchParams.get("sid") || ""
      const name = path.basename(u.searchParams.get("name") || "")
      const up = u.searchParams.get("dir") === "up"   // dir=up 时取上传目录，否则取产出目录
      const f = path.join(sid ? (up ? wsUp(sid) : wsOut(sid)) : (up ? UPLOADS : OUTPUTS), name)   // 无 sid 回退共享目录（兼容）
      if (!name || !fs.existsSync(f)) return send(res, 404, "text/plain", "not found")
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"` })
      return fs.createReadStream(f).pipe(res)
    }

    // 内联查看（供聊天框里 <img> 预览 / 在新标签打开），带正确 MIME、不强制下载
    if (req.method === "GET" && u.pathname === "/api/raw") {
      const sid = u.searchParams.get("sid") || ""
      const name = path.basename(u.searchParams.get("name") || "")
      const up = u.searchParams.get("dir") === "up"
      const f = path.join(sid ? (up ? wsUp(sid) : wsOut(sid)) : (up ? UPLOADS : OUTPUTS), name)
      if (!name || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "text/plain", "not found")
      const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".pdf": "application/pdf" }
      res.writeHead(200, { "Content-Type": MIME[path.extname(name).toLowerCase()] || "application/octet-stream" })
      return fs.createReadStream(f).pipe(res)
    }

    if (req.method === "GET" && u.pathname === "/api/chat") {
      const q = u.searchParams.get("q") || ""
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      const sse = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)

      // Reuse the session the browser passes back so the conversation is multi-turn;
      // create one only on the first message (or if the old id is gone after a restart).
      let sid = u.searchParams.get("sid") || null
      if (!sid) sid = un(await client.session.create({ body: { title: (q || "web").slice(0, 40) } })).id   // 用首条提问当标题，便于会话列表识别
      ensureWs(sid)
      sse("session", { id: sid })
      // 给 agent 注入本会话专属目录，覆盖技能默认的 outputs/，实现多用户/多会话隔离
      const preamble = `【本会话专属目录，务必遵守】\n- 用户上传的数据文件在 \`${relUp(sid)}/\`（读数据从这里找）。\n- 所有产物（图表 PNG/PDF、CSV/Excel、md/docx 文档等）一律写到 \`${relOut(sid)}/\`。\n- 连临时脚本、中间文件也一律写在 \`${relOut(sid)}/\`（需要放一起可用 \`${relOut(sid)}/.scratch/\`）。\n- **严禁在仓库根写任何文件**（.py / .csv / .png / .md 等都不行）：仓库根是所有用户共享的，同名文件会互相覆盖、把不同会话的数据串在一起。运行脚本时也把工作目录/输出指到 \`${relOut(sid)}/\`。\n- 正文里嵌入图片用 \`![图注](${relOut(sid)}/xxx.png)\` 这个路径。\n\n`
      const sentText = preamble + q

      let done = false
      let aborted = false
      // 浏览器关掉 EventSource（点“终止”或离开）→ 真正掐断 opencode 生成，别继续烧 token
      req.on("close", () => {
        if (done) return
        aborted = true; done = true
        client.session.abort({ path: { id: sid } }).catch(() => {})
      })
      const events = await client.event.subscribe()
      ;(async () => {
        for await (const e of events.stream) {
          if (done) break
          const p = e?.properties?.part; if (!p) continue
          if (p.sessionID && p.sessionID !== sid) continue
          if (p.type === "text" && typeof p.text === "string" && p.text !== sentText) sse("text", p.text)   // cumulative — browser replaces（滤掉回显的用户输入，含注入的目录前言）
          else if (p.type === "reasoning" && typeof p.text === "string") sse("reasoning", { id: p.id, text: p.text })
          else if (p.type === "tool" && p.state?.status) sse("tool", {
            callID: p.callID, tool: p.tool, status: p.state.status,
            title: p.state.title || "",
            skill: p.tool === "skill" ? (p.state.input?.name || null) : null,   // 技能名（running/completed 才有）
          })
        }
      })().catch(() => {})

      const before = dirState(wsOut(sid))   // 记录本轮开始前本会话产物状态，用于算增量
      const ask = (id) => client.session.prompt({
        path: { id },
        body: { model: MODEL, parts: [{ type: "text", text: sentText }] },   // 带注入的目录前言
      })
      let result
      try {
        result = un(await ask(sid))
      } catch (err) {
        if (aborted) return   // 已被用户终止 / 连接断开：别再往已关闭的连接写
        // 关键修复：出错时【绝不】新建空会话并重放本条消息——那会丢光多轮上下文
        // （opencode 会话持久化在 db、重启也不丢，sid 一般仍有效；旧的"重试"是这次上下文丢失的元凶）。
        // 只如实报错，让前端提示用户；真正失效时用户点「新对话」重开。
        const msg = String(err?.message || err)
        const gone = /not found|no such session|does not exist|404/i.test(msg)
        try { sse("failed", { message: gone ? "该会话已失效，请点「新对话」重新开始。" : ("本轮出错：" + msg.slice(0, 200)) }) } catch {}
        done = true; try { res.end() } catch {}
        return
      }
      if (aborted) return
      const finalText = (result?.parts ?? []).filter(x => x.type === "text").map(x => x.text).join("\n")
      sse("final", { text: finalText })
      sse("files", changedSince(wsOut(sid), before))   // 只推本会话本轮新建/改动的产物
      sse("done", {})
      done = true; res.end()
      return
    }

    send(res, 404, "text/plain", "not found")
  } catch (err) {
    try { send(res, 500, "text/plain", String(err?.stack || err)) } catch {}
  }
})
// ---- opencode 生命周期：网关启动时刷新一个干净的 opencode，让它重扫 .opencode/skills/ ----
// opencode 只在“启动那一刻”扫描 skill 目录并缓存，新增/改名的技能不会被运行中的实例识别，
// 必须重启才能生效。默认仅当 OC 在本机时自动接管；OC 指向远端（如 docker-compose 独立服务）时自动跳过。
// 覆盖开关：MANAGE_OC=0 强制关闭；MANAGE_OC=1 强制开启（即使 OC 是远端）。
const ocHealthy = () => new Promise((resolve) => {
  const req = http.get(OC_URL + "/app", (r) => { r.resume(); resolve(true) })   // 任意 HTTP 应答即视为活着
  req.on("error", () => resolve(false))
  req.setTimeout(2500, () => { req.destroy(); resolve(false) })
})
const killPort = (port) => {
  try {
    if (process.platform === "win32")
      execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" })
    else
      execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: "ignore" })
  } catch { /* 端口本就空闲 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function ensureOpencode() {
  const u = new URL(OC_URL)
  const ocLocal = ["127.0.0.1", "localhost", "::1"].includes(u.hostname)
  if (process.env.MANAGE_OC === "0" || (!ocLocal && process.env.MANAGE_OC !== "1")) {
    console.log(`[oc] 不接管 opencode（OC=${OC_URL}），直接连它`)
    return
  }
  const port = Number(u.port || 80)
  console.log(`[oc] 重启本机 opencode :${port}（让它重扫 .opencode/skills/）...`)
  killPort(port)
  await sleep(800)
  const out = fs.openSync(path.join(ROOT, "serve.out"), "a")
  const err = fs.openSync(path.join(ROOT, "serve.err"), "a")
  const child = spawn("opencode", ["serve", "--port", String(port)], {
    cwd: ROOT, detached: true, stdio: ["ignore", out, err], shell: process.platform === "win32",
  })
  child.on("error", (e) => console.warn(`[oc] 启动 opencode 失败：${e.message}（PATH 里有 opencode 吗？）`))
  child.unref()
  for (let i = 0; i < 60; i++) {
    if (await ocHealthy()) { console.log(`[oc] 就绪：${OC_URL}（工作目录=${ROOT}）`); return }
    await sleep(500)
  }
  console.warn(`[oc] 30s 内未就绪，仍继续启动网关（排查见 serve.err）`)
}

const lanIPs = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address)

await ensureOpencode()
// 绑 0.0.0.0：本机与局域网都能访问
server.listen(PORT, "0.0.0.0", () => {
  console.log(`gateway on http://localhost:${PORT}  (opencode=${OC_URL}, model=${MODEL.providerID}/${MODEL.modelID})`)
  for (const ip of lanIPs()) console.log(`  局域网访问：http://${ip}:${PORT}`)
  console.log(AUTH_ENABLED
    ? `  局域网登录：账号 ${LAN_USER} / 密码 ${LAN_PASSWORD}（本机 localhost 免登录；改账号密码用环境变量 LAN_USER/LAN_PASSWORD，关登录用 LAN_AUTH=0）`
    : `  登录已关闭（LAN_AUTH=0）`)
})
