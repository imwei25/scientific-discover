import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { spawn, execSync, execFile } from "node:child_process"
import { promisify } from "node:util"
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
let MODEL = { providerID: PID, modelID: MID }
const PORT = Number(process.env.PORT || 3000)

// ---- 自定义大模型（OpenAI 兼容）：前端可切换后台 opencode 用的模型 ----
const MODEL_CFG_PATH = path.join(__dirname, "model-config.json")   // 持久化所选自定义模型（含 key，已 gitignore）
const OC_CONFIG_PATH = path.join(ROOT, "opencode.json")            // opencode 项目配置：注册自定义 provider
const CUSTOM_PROVIDER_ID = "custom"
const loadModelCfg = () => { try { return JSON.parse(fs.readFileSync(MODEL_CFG_PATH, "utf8")) } catch { return null } }
const saveModelCfg = (c) => { try { fs.writeFileSync(MODEL_CFG_PATH, JSON.stringify(c, null, 2)) } catch {} }
const customProviderCfg = ({ baseURL, apiKey, modelID }) => ({
  npm: "@ai-sdk/openai-compatible", name: "Custom (OpenAI 兼容)",
  options: { baseURL, apiKey },
  models: { [modelID]: { name: modelID, tool_call: true, attachment: true } },   // 开工具调用，技能才能跑
})
// opencode 的 `question` 工具会弹交互式提问卡片；本部署（web 网关）没有应答它的 UI，
// 模型一旦调用就整轮 error/卡死（实测卡在“确认方向选择”那步）。各技能与 AGENTS.md §六 已要求
// “一律用编号文本让用户回数字选、别弹卡片”，但模型会无视提示词照调——故在配置层全局禁用，从根上杜绝。
const enforceOcTools = (oc) => { oc.tools = { ...(oc.tools || {}), question: false }; return oc }
// 把自定义 provider 合并进 ROOT/opencode.json（保留其它配置），opencode 启动时读取它
const writeOcProvider = (cfg) => {
  let oc = {}
  try { oc = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf8")) } catch {}
  oc.provider = oc.provider || {}
  oc.provider[CUSTOM_PROVIDER_ID] = customProviderCfg(cfg)
  enforceOcTools(oc)
  fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(oc, null, 2))
}
const removeOcProvider = () => {
  try {
    const oc = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf8"))
    if (oc.provider) { delete oc.provider[CUSTOM_PROVIDER_ID]; if (!Object.keys(oc.provider).length) delete oc.provider }
    enforceOcTools(oc)
    fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(oc, null, 2))
  } catch {}
}
// 启动时无条件确保 opencode.json 已禁用 question 工具（无论用不用自定义模型；opencode.json 已 gitignore）
try {
  let oc = {}
  try { oc = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf8")) } catch {}
  enforceOcTools(oc)
  fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(oc, null, 2))
} catch {}
// 启动时恢复上次所选的自定义模型（写好 opencode.json，随后 ensureOpencode 启动的 opencode 会读到）
{
  const saved = loadModelCfg()
  if (saved?.baseURL && saved?.apiKey && saved?.modelID) {
    writeOcProvider(saved)
    MODEL = { providerID: CUSTOM_PROVIDER_ID, modelID: saved.modelID }
  } else if (process.env.OC_GATEWAY_URL && process.env.OC_GATEWAY_KEY) {
    // 未自设模型但配了 LLM 网关(one-api) → 默认把请求走网关(OpenAI 兼容)：baseURL 指网关，模型用 OC_MODEL 的模型名。
    // 网关内做多渠道调度/failover；分级路由靠各容器注入不同的 OC_MODEL（tiers.env 的 MODEL 列）。
    writeOcProvider({ baseURL: process.env.OC_GATEWAY_URL, apiKey: process.env.OC_GATEWAY_KEY, modelID: MID })
    MODEL = { providerID: CUSTOM_PROVIDER_ID, modelID: MID }
  }
}
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
// 路径路由前缀：多用户单域名部署时每容器设 BASE_PATH=/用户名（如 /alice）。前面的 manager 会剥掉该前缀再转进来，
// 所以容器内部仍按根路径处理；这里只在"发给浏览器"的东西上补回前缀——跳转 Location 与 Cookie 的 Path。
// 尤其 Cookie 的 Path=/用户名/ 是隔离关键：保证 alice 的登录 token 只发往 /alice/，不会泄露给别的用户容器。
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/+$/, "")   // 归一化，去掉结尾斜杠；根部署留空

// ---- 每日成本额度（USD）----
// 用 opencode 的 session.cost（已含 DeepSeek 缓存折扣）累计每轮增量；跨日自动清零；持久化在 ocdata 卷（重启不丢）。
// DAILY_COST_LIMIT=0 或空 = 不限额。达上限即拦截新对话（本轮已开始的照常跑完）。
const DAILY_COST_LIMIT = Number(process.env.DAILY_COST_LIMIT || 0)
const QUOTA_FILE = path.join(os.homedir(), ".local", "share", "opencode", "quota.json")
const todayKey = () => new Date().toISOString().slice(0, 10)   // UTC 日期
const loadQuota = () => { try { const q = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8")); if (q && q.day === todayKey()) return q } catch {} return { day: todayKey(), cost: 0 } }
const saveQuota = (q) => { try { fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true }); fs.writeFileSync(QUOTA_FILE, JSON.stringify(q)) } catch {} }
const addCost = (delta) => { if (!(delta > 0)) return; const q = loadQuota(); q.cost += delta; saveQuota(q) }
const quotaUsed = () => loadQuota().cost
const quotaOver = () => DAILY_COST_LIMIT > 0 && quotaUsed() >= DAILY_COST_LIMIT

// ---- 每用户存储上限（uploads + outputs 之和）----
// STORAGE_LIMIT_MB=0 或空 = 不限。达上限拦截新上传；前端到 90% 提示。删除会话会清掉其目录（见 /api/session/delete）。
const STORAGE_LIMIT_MB = Number(process.env.STORAGE_LIMIT_MB || 0)
const dirSize = (dir) => {
  let total = 0
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { total += fs.statSync(p).size } catch {} } }
  }
  walk(dir); return total
}
const storageUsed = () => dirSize(UPLOADS) + dirSize(OUTPUTS)      // 字节
const storageLimitBytes = () => STORAGE_LIMIT_MB * 1024 * 1024
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
// ---- 无状态签名登录 cookie（不再靠内存 tokens Set）----
// 容器按需停机/冷启动会清空内存，随机 token 一停就失效、无法"5 天免登录"。改用 HMAC 签名：
// cookie = <过期时间ms>.<HMAC(LAN_PASSWORD, "lan|过期时间")>，容器只验签+验没过期，无需存储，重启后老 cookie 仍有效。
// 用 LAN_PASSWORD 作签名密钥：每容器稳定、且改密码即让旧会话失效（合理）。
const AUTH_TTL_MS = 5 * 24 * 60 * 60 * 1000                    // 5 天免登录
// 自助改密码：新密码存 ocdata 卷的 override 文件（随容器持久、随备份走）；用 base=旧env密码的hash 绑定——
// 管理员在 env 改密并重建容器后 base 不再匹配，override 自动失效、以新 env 密码为准（管理员始终能覆盖）。
const PW_OVERRIDE = path.join(os.homedir(), ".local", "share", "opencode", "auth-override.json")
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex")
const effectivePassword = () => {
  try { const o = JSON.parse(fs.readFileSync(PW_OVERRIDE, "utf8")); if (o && o.base === sha(LAN_PASSWORD) && typeof o.password === "string" && o.password) return o.password } catch {}
  return LAN_PASSWORD
}
const b64u = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
// 签名密钥用「当前有效密码」：改密码后旧 cookie 立即失效（合理）
const signAuth = (exp) => b64u(crypto.createHmac("sha256", "lan-auth|" + effectivePassword()).update("lan|" + exp).digest())
const makeAuthCookie = () => { const exp = Date.now() + AUTH_TTL_MS; return exp + "." + signAuth(exp) }
const validAuth = (val) => {
  if (!val) return false
  const i = val.indexOf("."); if (i < 0) return false
  const exp = Number(val.slice(0, i)), sig = val.slice(i + 1)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const good = signAuth(exp)
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))
}
const authed = (req) => !AUTH_ENABLED || isLocal(req) || validAuth(cookieOf(req, "lan_auth"))

// ---- 后台生成任务：一轮生成 = 一个挂在 sid 上的 job，SSE 连接只是"订阅者" ----
// 切会话/关页面 → 只是退订，生成继续跑；回来用 /api/chat/attach 先重放快照再续直播。
// 真正终止走 POST /api/chat/abort（前端"终止"按钮）。job 完成即从表里删除，历史由 opencode 持久化。
// ---- 文档预览转换：docx→HTML（.venv 的 mammoth）、pptx/ppt/odp/doc/odt→PDF（LibreOffice）----
const PYEXE = process.platform === "win32" ? path.join(ROOT, ".venv/Scripts/python.exe") : path.join(ROOT, ".venv/bin/python")
const MAMMOTH_PY = "import sys,mammoth\nsrc,out=sys.argv[1],sys.argv[2]\nf=open(src,'rb');h=mammoth.convert_to_html(f).value;f.close()\nopen(out,'w',encoding='utf-8').write(h)"
let _soffice   // 惰性探测并缓存（LibreOffice 可能在网关启动后才装好）
const soffice = () => {
  if (_soffice !== undefined) return _soffice
  const cands = process.env.SOFFICE ? [process.env.SOFFICE] : (process.platform === "win32"
    ? ["C:/Program Files/LibreOffice/program/soffice.com", "C:/Program Files/LibreOffice/program/soffice.exe", "C:/Program Files (x86)/LibreOffice/program/soffice.com"]
    : ["/usr/bin/soffice", "/usr/bin/libreoffice", "/opt/libreoffice/program/soffice"])
  _soffice = cands.find((c) => { try { return fs.existsSync(c) } catch { return false } }) || null
  if (!_soffice) { try { _soffice = execSync(process.platform === "win32" ? "where soffice" : "command -v soffice", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\r?\n/)[0] || null } catch { _soffice = null } }
  return _soffice
}
const execFileAsync = promisify(execFile)
const sofficeArgs = (src, outDir) => {   // 每次用独立 UserInstallation profile，避免多用户并发时 profile 锁冲突
  const prof = "file:///" + path.join(os.tmpdir(), "lo-" + crypto.randomBytes(6).toString("hex")).replace(/\\/g, "/")
  return ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, src, "-env:UserInstallation=" + prof]
}

// 生成/复用文档预览缓存到 <dir>/.preview/；docx→HTML、pptx/ppt/odp/doc/odt→PDF。
// 异步（不阻塞网关主线程），按源文件 mtime 缓存。命中缓存直接返回，未命中才转换。
// 返回 { out, ctype } 供内联响应；不支持的类型返回 null；转换失败 throw 带 .code 的错误。
// /api/preview（点开即看）与产物落地后的后台预热共用本函数，确保两边缓存路径/新鲜度判定完全一致。
async function ensurePreviewCache(dir, name) {
  const src = path.join(dir, name)
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) { const e = new Error("not found"); e.code = "no-src"; throw e }
  const ext = path.extname(name).toLowerCase()
  const cacheDir = path.join(dir, ".preview"); fs.mkdirSync(cacheDir, { recursive: true })
  const srcMtime = fs.statSync(src).mtimeMs
  const fresh = (out) => fs.existsSync(out) && fs.statSync(out).mtimeMs >= srcMtime

  if (ext === ".docx") {
    const out = path.join(cacheDir, name + ".html")
    if (!fresh(out)) {
      try { await execFileAsync(PYEXE, ["-X", "utf8", "-c", MAMMOTH_PY, src, out], { timeout: 60_000 }) }
      catch (err) { const e = new Error(String(err).slice(0, 200)); e.code = "docx-fail"; throw e }
    }
    return { out, ctype: "text/html; charset=utf-8" }
  }
  if ([".pptx", ".ppt", ".odp", ".doc", ".odt"].includes(ext)) {
    const out = path.join(cacheDir, name.replace(/\.[^.]+$/, "") + ".pdf")
    if (!fresh(out)) {
      if (!soffice()) { const e = new Error("no LibreOffice"); e.code = "no-soffice"; throw e }
      try { await execFileAsync(soffice(), sofficeArgs(src, cacheDir), { timeout: 90_000 }) }
      catch (err) { const e = new Error(String(err).slice(0, 200)); e.code = "office-fail"; throw e }
      if (!fs.existsSync(out)) { const e = new Error("no pdf produced"); e.code = "no-pdf"; throw e }
    }
    return { out, ctype: "application/pdf" }
  }
  return null   // 该类型不支持文档转换预览（md/pdf/csv/txt/html 等在前端直接渲染，不走这里）
}

// 产物落地后台预热：把本轮新产出的 office/docx 文档提前转好缓存，用户点预览即秒开。
// 串行执行（一次只跑一个 LibreOffice），best-effort，失败静默——点开时 /api/preview 会照常再试并如实报错。
let _warmQueue = Promise.resolve()
function warmPreviews(dir, names) {
  const CONV = /\.(pptx?|odp|odt|doc|docx)$/i
  for (const name of (names || [])) {
    if (!CONV.test(name)) continue
    _warmQueue = _warmQueue.then(() => ensurePreviewCache(dir, path.basename(name)).catch(() => {}))
  }
}

const jobs = new Map()   // sid -> 进行中的 job
const titledSessions = new Set()   // 已确认过标题的会话（每会话只查/改一次），见 /api/chat 的自动补名
// 会话标题统一取"首条提问"：上传先于对话建的会话是占位标题 "web"，收到首条消息时改名。
// 只对占位标题改名，避免"断点续问"旧会话时把原标题冲掉。
async function ensureSessionTitle(sid, q) {
  if (!q || titledSessions.has(sid)) return
  titledSessions.add(sid)   // 无论成败都只尝试一次，别每条消息都打 API
  try {
    const s = un(await client.session.get({ path: { id: sid } }))
    const t = (s?.title || "").trim()
    if (t === "" || t === "web") await client.session.update({ path: { id: sid }, body: { title: q.slice(0, 40) } })
  } catch { /* 改名失败不影响对话 */ }
}
// 自愈残留的“半回退”：编辑历史消息是两段式（/api/revert 暂存回退点 → 下一条 prompt 提交）。
// 若那次重发没走完（僵尸轮/报错/被吞），暂存的回退就永远提交不了，会话被钉在带 revert 标记的
// 半回退态：opencode 之后只返回不一致的回退视图，导致再次编辑必然失败（悬空 messageID）。
// 判据：有 revert 标记 且 该会话没有正在跑的 job → 一定是残留（成功的一次编辑会把标记清成 null），
// 用 unrevert 清掉。只在“打开会话 / 开始新一次编辑”时调用，绝不碰正在提交的正常编辑流程。
async function clearStaleRevert(sid) {
  if (!sid || jobs.get(sid)?.running) return   // 正在生成 → 可能是合法的进行中状态，别动
  try {
    const s = un(await client.session.get({ path: { id: sid } }))
    if (s?.revert) { await client.session.unrevert({ path: { id: sid } }); return true }
  } catch { /* 自愈失败不阻断主流程 */ }
  return false
}
const sseWrite = (res, ev, data) => { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`) } catch {} }
function startJob(sid, sentText) {
  const job = {
    sid, running: true, finished: false, subs: new Set(),
    // 增量快照：text 是累积全文、reasoning 按 id、tool 按 callID 各存最新一条，attach 时按序重放即可还原界面
    text: "", reasoning: new Map(), tools: new Map(), skills: new Map(),
  }
  jobs.set(sid, job)
  const broadcast = (ev, data) => {
    if (ev === "text") job.text = data
    else if (ev === "reasoning") job.reasoning.set(data.id, data)
    else if (ev === "tool") { if (data.tool === "skill") { if (data.skill) job.skills.set(data.skill, data) } else if (data.callID) job.tools.set(data.callID, data) }
    for (const r of job.subs) sseWrite(r, ev, data)
  }
  const finish = () => {
    if (job.finished) return
    job.finished = true; job.running = false; jobs.delete(sid)
    for (const r of job.subs) { try { r.end() } catch {} }
    job.subs.clear()
  }
  job.abort = async () => {
    if (job.finished) return
    job.aborting = true          // 让 prompt 的报错分支知道这是用户终止，别再广播 failed
    broadcast("aborted", {})     // 先告知订阅者（保证前端能收到"已终止"），再实际掐断
    try { await client.session.abort({ path: { id: sid } }) } catch {}
    finish()
  }
  ;(async () => {
    const events = await client.event.subscribe()
    const qStart = quotaUsed()            // 本轮开始时今日已用成本（跨日不变），用于中途封顶判断
    const runCost = new Map()             // 本轮各 assistant 消息的 cost（按 messageID 取最新），实时累计
    ;(async () => {
      for await (const e of events.stream) {
        if (job.finished) break
        // 中途额度封顶：一旦「今日已用 + 本轮实时成本」达上限，立即中止本轮，避免单轮跑到底大幅超支
        if (DAILY_COST_LIMIT > 0 && !job.quotaHit && e?.type === "message.updated") {
          const info = e.properties?.info
          if (info?.sessionID === sid && info.role === "assistant") {
            runCost.set(info.id, info.cost || 0)
            let rc = 0; for (const v of runCost.values()) rc += v
            if (qStart + rc >= DAILY_COST_LIMIT) { job.quotaHit = true; try { await client.session.abort({ path: { id: sid } }) } catch {} }
          }
          continue
        }
        const p = e?.properties?.part; if (!p) continue
        if (p.sessionID && p.sessionID !== sid) continue
        if (p.type === "text" && typeof p.text === "string" && p.text !== sentText) broadcast("text", p.text)   // cumulative — browser replaces（滤掉回显的用户输入，含注入的目录前言）
        else if (p.type === "reasoning" && typeof p.text === "string") broadcast("reasoning", { id: p.id, text: p.text })
        else if (p.type === "tool" && p.state?.status) broadcast("tool", {
          callID: p.callID, tool: p.tool, status: p.state.status,
          title: p.state.title || "",
          skill: p.tool === "skill" ? (p.state.input?.name || null) : null,   // 技能名（running/completed 才有）
        })
      }
    })().catch(() => {})
    const before = dirState(wsOut(sid))   // 记录本轮开始前本会话产物状态，用于算增量
    let cost0 = 0; try { cost0 = un(await client.session.get({ path: { id: sid } }))?.cost || 0 } catch {}   // 本轮前累计成本，用于算增量
    let result, promptErr = null
    try {
      result = un(await client.session.prompt({ path: { id: sid }, body: { model: MODEL, parts: [{ type: "text", text: sentText }] } }))
    } catch (err) { promptErr = err }
    // 无论正常结束 / 被额度中止 / 被用户终止，都先把本轮实际成本记进今日额度——否则中止的轮不计费，用户可无限重试绕过额度
    try { const c1 = un(await client.session.get({ path: { id: sid } }))?.cost || 0; addCost(c1 - cost0) } catch {}
    if (job.aborting) return finish()                       // 用户显式终止：job.abort 已广播 aborted
    if (job.quotaHit) { broadcast("failed", { message: `本轮已达今日额度上限（$${DAILY_COST_LIMIT.toFixed(2)}），已自动中止；明日 0 点(UTC)恢复。` }); return finish() }
    if (promptErr) {
      if (job.finished) return finish()
      // 出错时【绝不】新建空会话重放消息——会丢光多轮上下文；如实报错，真失效时用户点「新对话」。
      const msg = String(promptErr?.message || promptErr)
      const gone = /not found|no such session|does not exist|404/i.test(msg)
      broadcast("failed", { message: gone ? "该会话已失效，请点「新对话」重新开始。" : ("本轮出错：" + msg.slice(0, 200)) })
      return finish()
    }
    if (job.finished) return finish()
    const finalText = (result?.parts ?? []).filter(x => x.type === "text").map(x => x.text).join("\n")
    broadcast("final", { text: finalText })
    const changed = changedSince(wsOut(sid), before)
    broadcast("files", changed)   // 只推本会话本轮新建/改动的产物
    warmPreviews(wsOut(sid), changed)   // 后台把新产出的 office/docx 预转缓存，用户点预览即秒开
    broadcast("done", {})
    finish()
  })().catch(() => { try { broadcast("failed", { message: "本轮出错（网关内部异常）" }) } catch {} finish() })
  return job
}
// 给一个 SSE 连接订阅 job：先重放快照（技能/工具/思考/已生成文本），再接后续直播；断开只退订
function attachJob(job, req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
  sseWrite(res, "session", { id: job.sid })
  for (const d of job.skills.values()) sseWrite(res, "tool", d)
  for (const d of job.tools.values()) sseWrite(res, "tool", d)
  for (const d of job.reasoning.values()) sseWrite(res, "reasoning", d)
  if (job.text) sseWrite(res, "text", job.text)
  job.subs.add(res)
  req.on("close", () => job.subs.delete(res))
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost")
  try {
    // 登录页：未登录的局域网访客看到它；已登录/本机则直接跳回主页
    if (req.method === "GET" && u.pathname === "/login") {
      if (authed(req)) { res.writeHead(302, { Location: BASE_PATH + "/" }); return res.end() }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      return res.end(fs.readFileSync(path.join(__dirname, "login.html")))
    }
    // 校验密码 → 发 token Cookie
    if (req.method === "POST" && u.pathname === "/api/login") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let user = "", pw = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); user = (b.username || "").trim(); pw = (b.password || "").trim() } catch {}
      if (user !== LAN_USER || pw !== effectivePassword()) return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "账号或密码错误" }))
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=${makeAuthCookie()}; Path=${BASE_PATH}/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_TTL_MS / 1000}` })
      return res.end(JSON.stringify({ ok: true }))
    }
    // 退出登录：签名 cookie 无服务端状态，清掉浏览器 cookie 即可（本人登出足够）
    if (req.method === "POST" && u.pathname === "/api/logout") {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=; Path=${BASE_PATH}/; HttpOnly; Max-Age=0` })
      return res.end(JSON.stringify({ ok: true }))
    }
    // 自助改密码（须已登录）：校验当前密码 → 写 override → 清 cookie 逼重登（旧 cookie 已随密钥变更失效）
    if (req.method === "POST" && u.pathname === "/api/password") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let cur = "", nw = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); cur = String(b.current || ""); nw = String(b.new || "") } catch {}
      if (cur !== effectivePassword()) return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "当前密码不正确" }))
      if (nw.length < 6) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "新密码至少 6 位" }))
      try { fs.mkdirSync(path.dirname(PW_OVERRIDE), { recursive: true }); fs.writeFileSync(PW_OVERRIDE, JSON.stringify({ base: sha(LAN_PASSWORD), password: nw })) }
      catch { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: "保存失败" })) }
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=; Path=${BASE_PATH}/; HttpOnly; Max-Age=0` })
      return res.end(JSON.stringify({ ok: true }))
    }
    // 门禁：其余路径若未登录 → 页面跳登录页、接口回 401
    if (!PUBLIC_PATHS.has(u.pathname) && !authed(req)) {
      if (req.method === "GET" && (req.headers.accept || "").includes("text/html")) {
        res.writeHead(302, { Location: BASE_PATH + "/login" }); return res.end()
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
      const buf = Buffer.concat(chunks)
      const lim = storageLimitBytes()
      if (lim > 0 && storageUsed() + buf.length > lim)
        return send(res, 413, "application/json", JSON.stringify({ ok: false, err: `存储空间不足：已用 ${(storageUsed() / 1048576).toFixed(0)}MB / 上限 ${STORAGE_LIMIT_MB}MB。请删除旧会话或文件后再传。` }))
      const dest = path.join(wsUp(sid), name); fs.writeFileSync(dest, buf)
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
        .map((s) => ({ id: s.id, title: s.title || "(未命名)", updated: s.time?.updated || 0, running: !!jobs.get(s.id)?.running }))
      return send(res, 200, "application/json", JSON.stringify(list))
    }

    // 某会话的历史消息（user/assistant 正文），用于断点续问时回显上下文
    if (req.method === "GET" && u.pathname === "/api/history") {
      const id = u.searchParams.get("id") || ""
      if (!id) return send(res, 400, "application/json", "[]")
      await clearStaleRevert(id)   // 打开会话即自愈：清掉上次编辑遗留的半回退标记，让历史与后续编辑基于完整消息列表
      const msgs = un(await client.session.messages({ path: { id } })) || []
      const out = []
      for (const m of msgs) {
        const role = m.info?.role
        if (role !== "user" && role !== "assistant") continue
        let text = (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim()
        text = text.replace(/^【本会话专属目录[\s\S]*?】[\s\S]*?\n\n/, "")   // 剥掉注入的目录前言，只回显真正对话
        if (text) out.push({ role, text })
      }
      // 这一轮还在生成中：末尾未完成的助手输出交给续流（/api/chat/attach）直播，从历史里剔除避免重复
      if (jobs.get(id)?.running) {
        let lastUser = -1
        out.forEach((m, i) => { if (m.role === "user") lastUser = i })
        return send(res, 200, "application/json", JSON.stringify(out.filter((m, i) => i <= lastUser || m.role === "user")))
      }
      return send(res, 200, "application/json", JSON.stringify(out))
    }

    // 删除一个会话
    if (req.method === "POST" && u.pathname === "/api/session/delete") {
      const id = u.searchParams.get("id") || ""
      if (!id) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      try { await jobs.get(id)?.abort() } catch {}   // 会话还在生成中 → 先终止再删
      try { await client.session.delete({ path: { id } }) } catch (e) { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e) })) }
      try { fs.rmSync(wsUp(id), { recursive: true, force: true }); fs.rmSync(wsOut(id), { recursive: true, force: true }) } catch {}   // 删会话即释放其 uploads/outputs 占用的空间
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    // 编辑历史消息：回退到第 uindex 个用户消息（含）之前，opencode 会丢弃其后的消息；
    // 之后前端把编辑后的内容当新消息重发。uploads/ 与 outputs/ 均在 .gitignore 里，
    // opencode 基于 git 快照的回退不会动它们 —— 满足“文件不变”。
    if (req.method === "POST" && u.pathname === "/api/revert") {
      const sid = u.searchParams.get("sid") || ""
      const uindex = Number(u.searchParams.get("uindex"))
      if (!sid || !Number.isInteger(uindex) || uindex < 0) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      await clearStaleRevert(sid)   // 先清掉上一次没提交的残留回退，确保 uindex→messageID 对着完整消息列表算，而非回退视图
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
        ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".pdf": "application/pdf",
        ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
        ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8" }
      const ext = path.extname(name).toLowerCase()
      const head = { "Content-Type": MIME[ext] || "application/octet-stream" }
      // 产物 HTML/SVG 可能含脚本：无论 iframe 内嵌还是直开新标签，都沙箱化、不接触本站源（cookie/localStorage）
      if (ext === ".html" || ext === ".htm" || ext === ".svg") head["Content-Security-Policy"] = "sandbox allow-scripts"
      res.writeHead(200, head)
      return fs.createReadStream(f).pipe(res)
    }

    // 文档预览转换：docx→HTML、pptx/ppt/odp/doc/odt→PDF；缓存到 <产物目录>/.preview/（与后台预热共用 ensurePreviewCache）
    if (req.method === "GET" && u.pathname === "/api/preview") {
      const sid = u.searchParams.get("sid") || ""
      const name = path.basename(u.searchParams.get("name") || "")
      const dir = sid ? wsOut(sid) : OUTPUTS
      let r
      try { r = await ensurePreviewCache(dir, name) }
      catch (e) {
        if (e.code === "no-src") return send(res, 404, "text/plain", "not found")
        if (e.code === "docx-fail") return send(res, 500, "text/html; charset=utf-8", `<p style="color:#b91c1c">DOCX 预览转换失败：${e.message}</p>`)
        if (e.code === "no-soffice") return send(res, 501, "text/plain", "服务器未安装 LibreOffice，无法预览此类型（装好后即可）")
        if (e.code === "no-pdf") return send(res, 500, "text/plain", "转换未产出 PDF")
        return send(res, 500, "text/plain", "转换失败：" + e.message)
      }
      if (!r) return send(res, 415, "text/plain", "该类型不支持预览")
      res.writeHead(200, { "Content-Type": r.ctype })
      return fs.createReadStream(r.out).pipe(res)
    }

    if (req.method === "GET" && u.pathname === "/api/quota") {   // 前端显示今日额度用量
      return send(res, 200, "application/json", JSON.stringify({ used: quotaUsed(), limit: DAILY_COST_LIMIT }))
    }
    if (req.method === "GET" && u.pathname === "/api/storage") {   // 前端显示存储用量（uploads+outputs）
      return send(res, 200, "application/json", JSON.stringify({ used: storageUsed(), limit: storageLimitBytes() }))
    }
    if (req.method === "GET" && u.pathname === "/api/chat") {
      const q = u.searchParams.get("q") || ""
      // Reuse the session the browser passes back so the conversation is multi-turn;
      // create one only on the first message (or if the old id is gone after a restart).
      let sid = u.searchParams.get("sid") || null
      if (!sid) { sid = un(await client.session.create({ body: { title: (q || "web").slice(0, 40) } })).id; if (q) titledSessions.add(sid) }   // 先打字建的会话：首条提问即标题
      ensureWs(sid)
      const running = jobs.get(sid)
      if (running?.running) {   // 该会话已有进行中的一轮（断线重连/双开页面）→ 直接续流，绝不重复发起
        attachJob(running, req, res)
        if (q) sseWrite(res, "notice", { message: "上一轮仍在进行中，本条消息未发送；请等本轮结束后重发。" })
        return
      }
      await ensureSessionTitle(sid, q)   // 上传先于对话建的占位标题 "web" → 首条提问改名（只对占位标题生效，不动续问的旧会话）
      // 给 agent 注入本会话专属目录，覆盖技能默认的 outputs/，实现多用户/多会话隔离
      const preamble = `【本会话专属目录，务必遵守】\n- 用户上传的数据文件在 \`${relUp(sid)}/\`（读数据从这里找）。\n- 所有产物（图表 PNG/PDF、CSV/Excel、md/docx 文档等）一律写到 \`${relOut(sid)}/\`。\n- 连临时脚本、中间文件也一律写在 \`${relOut(sid)}/\`（需要放一起可用 \`${relOut(sid)}/.scratch/\`）。\n- **严禁在仓库根写任何文件**（.py / .csv / .png / .md 等都不行）：仓库根是所有用户共享的，同名文件会互相覆盖、把不同会话的数据串在一起。运行脚本时也把工作目录/输出指到 \`${relOut(sid)}/\`。\n- 正文里嵌入图片用 \`![图注](${relOut(sid)}/xxx.png)\` 这个路径。\n\n`
      if (quotaOver()) {   // 今日额度已用尽 → 不发起新对话，回一条 failed 让前端提示
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
        sseWrite(res, "session", { id: sid })
        sseWrite(res, "failed", { message: `今日额度已用尽（已用 $${quotaUsed().toFixed(3)} / 上限 $${DAILY_COST_LIMIT.toFixed(2)}），明天恢复。` })
        return res.end()
      }
      return attachJob(startJob(sid, preamble + q), req, res)
    }

    // 重新订阅某会话进行中的一轮（切回会话/重开页面时续流）；没有进行中的轮次则回 idle
    if (req.method === "GET" && u.pathname === "/api/chat/attach") {
      const sid = u.searchParams.get("sid") || ""
      const job = jobs.get(sid)
      if (!job || !job.running) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
        sseWrite(res, "idle", {})   // 前端收到后改走历史回显（含刚完成的最终答案）
        return res.end()
      }
      return attachJob(job, req, res)
    }

    // 显式终止某会话进行中的一轮（前端"终止"按钮；断开连接不再意味着终止）
    if (req.method === "POST" && u.pathname === "/api/chat/abort") {
      const job = jobs.get(u.searchParams.get("sid") || "")
      if (job) await job.abort()
      return send(res, 200, "application/json", JSON.stringify({ ok: true, aborted: !!job }))
    }

    // 某会话是否有进行中的一轮（切会话/重开页面时决定要不要续流）
    if (req.method === "GET" && u.pathname === "/api/job") {
      return send(res, 200, "application/json", JSON.stringify({ running: !!jobs.get(u.searchParams.get("sid") || "")?.running }))
    }

    // 列出本会话 outputs/ 里的产物文件（重开页面/切会话时回显"产出"侧栏，产物随会话持久）
    if (req.method === "GET" && u.pathname === "/api/outputs") {
      const sid = u.searchParams.get("sid") || ""
      const dir = sid ? wsOut(sid) : OUTPUTS
      if (!fs.existsSync(dir)) return send(res, 200, "application/json", "[]")
      const list = fs.readdirSync(dir)
        .filter((f) => !f.startsWith("."))
        .map((f) => { const st = fs.statSync(path.join(dir, f)); return st.isFile() ? { name: f, size: st.size, mtime: st.mtimeMs } : null })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
      return send(res, 200, "application/json", JSON.stringify(list))
    }

    // 当前后台模型配置（apiKey 不回传，只报是否已设）
    if (req.method === "GET" && u.pathname === "/api/model") {
      const c = loadModelCfg()
      return send(res, 200, "application/json", JSON.stringify({
        providerID: MODEL.providerID, modelID: MODEL.modelID,
        isCustom: MODEL.providerID === CUSTOM_PROVIDER_ID,
        baseURL: c?.baseURL || "", hasKey: !!(c && c.apiKey),
        default: `${PID}/${MID}`, managed: OC_MANAGED,
      }))
    }
    // 测试一个 OpenAI 格式的 API（URL + key + 模型）是否可用
    if (req.method === "POST" && u.pathname === "/api/model/test") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let baseURL = "", apiKey = "", modelID = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); baseURL = (b.baseURL || "").trim(); apiKey = (b.apiKey || "").trim(); modelID = (b.modelID || "").trim() } catch {}
      if (!baseURL || !apiKey || !modelID) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "请填写 API URL、API Key、模型 ID" }))
      const url = baseURL.replace(/\/+$/, "") + "/chat/completions"
      const t0 = Date.now()
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 20000)
      try {
        const r = await fetch(url, {
          method: "POST", signal: ac.signal,
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify({ model: modelID, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
        })
        clearTimeout(timer)
        const ms = Date.now() - t0
        const body = await r.text()
        if (!r.ok) {
          let em = body.slice(0, 300); try { const j = JSON.parse(body); em = j.error?.message || j.message || em } catch {}
          return send(res, 200, "application/json", JSON.stringify({ ok: false, status: r.status, ms, err: em }))
        }
        let reply = ""; try { const j = JSON.parse(body); reply = j.choices?.[0]?.message?.content || "" } catch {}
        return send(res, 200, "application/json", JSON.stringify({ ok: true, status: r.status, ms, reply: String(reply).slice(0, 80) }))
      } catch (e) {
        clearTimeout(timer)
        return send(res, 200, "application/json", JSON.stringify({ ok: false, err: e?.name === "AbortError" ? "请求超时（20s 内无响应）" : String(e?.message || e) }))
      }
    }
    // 切换后台模型：注册自定义 provider → 重启 opencode → 更新当前模型
    if (req.method === "POST" && u.pathname === "/api/model") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let baseURL = "", apiKey = "", modelID = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); baseURL = (b.baseURL || "").trim(); apiKey = (b.apiKey || "").trim(); modelID = (b.modelID || "").trim() } catch {}
      if (!baseURL || !apiKey || !modelID) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "请填写 API URL、API Key、模型 ID" }))
      writeOcProvider({ baseURL, apiKey, modelID })
      saveModelCfg({ baseURL, apiKey, modelID })
      MODEL = { providerID: CUSTOM_PROVIDER_ID, modelID }
      let restarted = false
      try { restarted = await restartOpencode() } catch {}
      if (!restarted) { try { await client.config.update({ body: { provider: { [CUSTOM_PROVIDER_ID]: customProviderCfg({ baseURL, apiKey, modelID }) } } }) } catch {} }
      return send(res, 200, "application/json", JSON.stringify({ ok: true, restarted, providerID: CUSTOM_PROVIDER_ID, modelID }))
    }
    // 恢复默认模型（清掉自定义 provider）
    if (req.method === "POST" && u.pathname === "/api/model/reset") {
      try { fs.unlinkSync(MODEL_CFG_PATH) } catch {}
      removeOcProvider()
      MODEL = { providerID: PID, modelID: MID }
      let restarted = false; try { restarted = await restartOpencode() } catch {}
      return send(res, 200, "application/json", JSON.stringify({ ok: true, restarted, providerID: PID, modelID: MID }))
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
const OC_U = new URL(OC_URL)
const OC_LOCAL = ["127.0.0.1", "localhost", "::1"].includes(OC_U.hostname)
const OC_MANAGED = process.env.MANAGE_OC === "1" || (OC_LOCAL && process.env.MANAGE_OC !== "0")
const OC_PORT = Number(OC_U.port || 80)
function spawnOc() {
  const out = fs.openSync(path.join(ROOT, "serve.out"), "a")
  const err = fs.openSync(path.join(ROOT, "serve.err"), "a")
  const child = spawn("opencode", ["serve", "--port", String(OC_PORT)], {
    cwd: ROOT, detached: true, stdio: ["ignore", out, err], shell: process.platform === "win32",
  })
  child.on("error", (e) => console.warn(`[oc] 启动 opencode 失败：${e.message}（PATH 里有 opencode 吗？）`))
  child.unref()
}
async function waitOcHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) { if (await ocHealthy()) return true; await sleep(500) }
  return false
}
// 切换模型后重启 opencode，让它重新读取 opencode.json 里的自定义 provider（仅接管本机 OC 时可用）
async function restartOpencode() {
  if (!OC_MANAGED) return false
  killPort(OC_PORT); await sleep(800); spawnOc()
  return waitOcHealthy()
}
async function ensureOpencode() {
  if (!OC_MANAGED) {
    console.log(`[oc] 不接管 opencode（OC=${OC_URL}），直接连它`)
    return
  }
  console.log(`[oc] 重启本机 opencode :${OC_PORT}（让它重扫 .opencode/skills/）...`)
  if (await restartOpencode()) console.log(`[oc] 就绪：${OC_URL}（工作目录=${ROOT}）`)
  else console.warn(`[oc] 30s 内未就绪，仍继续启动网关（排查见 serve.err）`)
}

const lanIPs = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address)

await ensureOpencode()
// 若上一次的网关还占着本端口，先杀掉它再起，避免 EADDRINUSE（重启即用，不必手动清端口）
killPort(PORT)
await sleep(500)
// 兜底：端口仍被别的进程占用时给一句人话提示，而不是抛未捕获的 'error' 事件
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.error(`[gateway] 端口 ${PORT} 仍被占用，无法启动。请手动结束占用进程后重试。`); process.exit(1) }
  else { console.error(`[gateway] 监听出错：${e.message}`); process.exit(1) }
})
// 绑 0.0.0.0：本机与局域网都能访问
server.listen(PORT, "0.0.0.0", () => {
  console.log(`gateway on http://localhost:${PORT}  (opencode=${OC_URL}, model=${MODEL.providerID}/${MODEL.modelID})`)
  for (const ip of lanIPs()) console.log(`  局域网访问：http://${ip}:${PORT}`)
  console.log(AUTH_ENABLED
    ? `  局域网登录：账号 ${LAN_USER} / 密码 ${LAN_PASSWORD}（本机 localhost 免登录；改账号密码用环境变量 LAN_USER/LAN_PASSWORD，关登录用 LAN_AUTH=0）`
    : `  登录已关闭（LAN_AUTH=0）`)
})
