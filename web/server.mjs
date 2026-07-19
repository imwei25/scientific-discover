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
// provider/model：只按【第一个】斜杠切——模型名本身可能含斜杠（如 deepseek-ai/DeepSeek-V4-Flash），不能整体 split
const _OCM = process.env.OC_MODEL || "deepseek/deepseek-v4-pro"
const _sl = _OCM.indexOf("/")
const PID = _sl >= 0 ? _OCM.slice(0, _sl) : _OCM
const MID = _sl >= 0 ? _OCM.slice(_sl + 1) : _OCM
let MODEL = { providerID: PID, modelID: MID }
const PORT = Number(process.env.PORT || 3000)

// ---- 自定义大模型（OpenAI 兼容）：前端可切换后台 opencode 用的模型 ----
const MODEL_CFG_PATH = path.join(__dirname, "model-config.json")   // 持久化所选自定义模型（含 key，已 gitignore）
const OC_CONFIG_PATH = path.join(ROOT, "opencode.json")            // opencode 项目配置：注册自定义 provider
const CUSTOM_PROVIDER_ID = "custom"
const loadModelCfg = () => { try { return JSON.parse(fs.readFileSync(MODEL_CFG_PATH, "utf8")) } catch { return null } }
const saveModelCfg = (c) => { try { fs.writeFileSync(MODEL_CFG_PATH, JSON.stringify(c, null, 2)) } catch {} }
// 给自定义/网关模型注入定价（USD / 每百万 token），否则 opencode 不知道价格 → session.cost 恒为 0 →
// 每日成本额度与中途封顶全部失效。价格由 OC_COST_* 环境变量给（deploy/.env 集中配），缺省按 DeepSeek 常见价。
const _modelCost = () => {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d }
  return { input: n(process.env.OC_COST_INPUT, 0.27), output: n(process.env.OC_COST_OUTPUT, 1.10), cache_read: n(process.env.OC_COST_CACHE_READ, 0.07), cache_write: n(process.env.OC_COST_CACHE_WRITE, 0) }
}
const customProviderCfg = ({ baseURL, apiKey, modelID }) => ({
  npm: "@ai-sdk/openai-compatible", name: "Custom (OpenAI 兼容)",
  options: { baseURL, apiKey },
  models: { [modelID]: { name: modelID, tool_call: true, attachment: true, cost: _modelCost() } },   // 开工具调用 + 注入定价（用于算成本额度）
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
// ---- 每个会话独占一套工作区目录（多用户 / 多会话隔离）----
//
// 关键机制：建会话时就把 opencode 的 session.directory 指到该会话的产物目录，
// 于是 agent 的所有工具（bash / write / read）都以【会话产物目录】为工作目录，
// 产物天然落在正确的地方，不再依赖 agent 记得传 --outdir 或环境变量。
// （已在服务器实测：directory 会改变工具 cwd；projectID 仍是 global，技能与 AGENTS.md 照常加载。）
//
// 但 directory 【只能在 session.create 时指定、之后不可改】（PATCH 只允许 title/metadata/...），
// 而目录名又想跟会话走 —— 鸡生蛋。解法：网关自己先生成一个工作区 id(ws_xxx) 当目录名，
// 用它建会话；之后要用时直接问 opencode 要 session.directory（它已持久化在 ocdata 卷里），
// 网关不必再维护一张自己的映射表。
const safeSid = (s) => (s || "").replace(/[^a-zA-Z0-9_-]/g, "")   // 防目录穿越
const newWsId = () => "ws_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex")
const dirCache = new Map()   // sid -> 绝对产物目录（进程内缓存，冷启动后按需回填）

// 会话的绝对产物目录。老会话（本次改造之前建的）的 directory 是仓库根，
// 回落到旧约定 outputs/<sid>，保证既有数据仍能被列出/下载。
async function sessionOut(sid) {
  const s = safeSid(sid)
  if (!s) return OUTPUTS
  if (dirCache.has(s)) return dirCache.get(s)
  let dir = path.join(OUTPUTS, s)                       // 回落：老会话
  try {
    const info = un(await client.session.get({ path: { id: sid } }))
    const d = info?.directory
    if (d && path.resolve(d) !== path.resolve(ROOT)) dir = path.resolve(d)
  } catch { /* opencode 不可用时用回落值，不阻断文件接口 */ }
  dirCache.set(s, dir)
  return dir
}
const relFromRoot = (abs) => path.relative(ROOT, abs).replace(/\\/g, "/")   // 仅用于回给前端展示，统一正斜杠
// uploads 与 outputs 同名配对：outputs/<ws> ←→ uploads/<ws>（老会话则同为 <sid>）
const sessionUp = async (sid) => path.join(UPLOADS, path.basename(await sessionOut(sid)))
const ensureWsAt = (outDir, upDir) => { fs.mkdirSync(outDir, { recursive: true }); fs.mkdirSync(upDir, { recursive: true }) }
async function ensureWs(sid) {
  const o = await sessionOut(sid), u = await sessionUp(sid)
  ensureWsAt(o, u); return { out: o, up: u }
}
// 新建会话：先定目录名，再用它建 opencode 会话（directory 只有这一次机会能设）
async function createSession(title) {
  const ws = newWsId()
  const outDir = path.join(OUTPUTS, ws), upDir = path.join(UPLOADS, ws)
  ensureWsAt(outDir, upDir)
  const s = un(await client.session.create({ body: { title }, query: { directory: outDir } }))
  dirCache.set(safeSid(s.id), outDir)
  return s.id
}
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
// 在【请求体还没读完】就提前回包时必须用它：HTTP/1.1 默认 keep-alive，若不声明关闭连接，
// 未读完的 body 会滞留在这条连接上，把它彻底堵死——同一条连接上的下一个请求永远不返回
// （实测：同一 keepAlive Agent 上先发超限请求拿到 413，紧接着的请求 >15s 无响应）。
// 典型场景：上传/发消息的体积超限，我们不想把几 MB 收完才拒绝。
const sendClose = (res, code, type, body) => { res.writeHead(code, { "Content-Type": type, "Connection": "close" }); res.end(body) }

// ---- 局域网访问的简易单用户登录（demo）----
// 本机（localhost）访问免登录；从局域网 IP 访问才要求输入密码。登录成功发一个随机 token 到 Cookie。
const LAN_USER = process.env.LAN_USER || "tellgen"             // 单用户账号，可用环境变量覆盖
const LAN_PASSWORD = process.env.LAN_PASSWORD || "123"         // 单用户密码，可用环境变量覆盖
const AUTH_ENABLED = process.env.LAN_AUTH !== "0"             // LAN_AUTH=0 可整体关闭登录
// 路径路由前缀：多用户单域名部署时每容器设 BASE_PATH=/用户名（如 /alice）。前面的 manager 会剥掉该前缀再转进来，
// 所以容器内部仍按根路径处理；这里只在"发给浏览器"的东西上补回前缀——跳转 Location 与 Cookie 的 Path。
// 尤其 Cookie 的 Path=/用户名/ 是隔离关键：保证 alice 的登录 token 只发往 /alice/，不会泄露给别的用户容器。
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/+$/, "")   // 归一化，去掉结尾斜杠；根部署留空
// 未登录时把浏览器送去哪个登录页：
// - 多用户部署（设了 BASE_PATH，前面有 manager 按 /用户名/ 反代并剥前缀）→ 必须送到 manager 根 "/" 的
//   验证码登录门户。容器自带的 login.html 没有验证码输入框，而 manager 对 POST /<用户名>/api/login
//   强制校验图形验证码（verifyCaptcha 不过直接 401「验证码错误」，压根不转进容器）→ 在容器登录页永远登不进来。
//   "/" 在 manager 那层（不带用户名前缀），故此处【不能】加 BASE_PATH。
// - 单机/局域网部署（BASE_PATH 为空、前面没有 manager）→ 没有验证码这回事，照旧用容器自带的 /login。
const LOGIN_URL = BASE_PATH ? "/" : "/login"

// HTTP 响应头只能承载 latin1：中文文件名直接塞进 Content-Disposition 会 ERR_INVALID_CHAR → 下载必 500。
// 按 RFC 5987 同时给两份：ASCII 兜底名（老客户端读它；剔掉引号、反斜杠、控制字符与非 ASCII 字节）
// 与 filename*=UTF-8''<百分号编码>（现代浏览器优先读它，中文名原样还原）。
const contentDisposition = (name) => {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").trim() || "download"
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

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
// 正在跑的各轮实时成本（sid -> 本轮已花）。轮内成本要到收尾才 addCost 进持久额度，
// 若判断额度时不算上它们，两轮并发会各自以为额度还够、最坏花到上限的约 2 倍；
// 算上后合计一到顶各轮就中止，超支收敛到「一条消息」的粒度。
const runningCost = new Map()
const runningTotal = () => { let t = 0; for (const v of runningCost.values()) t += v; return t }
const quotaUsedLive = () => quotaUsed() + runningTotal()   // 今日已入账 + 各在跑轮的实时成本
const quotaOver = () => DAILY_COST_LIMIT > 0 && quotaUsedLive() >= DAILY_COST_LIMIT

// ---- /api/model/test 的 SSRF 护栏 ----
// 这个接口让【已登录用户】指定任意 URL、由容器去请求，等于一个内网探测原语（容器网络里能打到
// one-api 网关、宿主服务、兄弟容器）。默认只放行公网地址；确有自建局域网/本机模型网关的部署，
// 可设 ALLOW_PRIVATE_MODEL_URL=1 放开（那时请自行确保容器网络里没有不该被探测的东西）。
const ALLOW_PRIVATE_MODEL_URL = process.env.ALLOW_PRIVATE_MODEL_URL === "1"
const isPrivateHost = (host) => {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true
  if (h === "0.0.0.0" || h === "metadata.google.internal") return true
  // 任何以 :: 开头的 IPv6 一律拒：涵盖 ::1(回环)、::(未指定)、::ffff:x(IPv4-mapped，会真连到内嵌的 v4 地址)、
  // ::<v4>(IPv4-compatible)。注意 new URL 会把 [::ffff:127.0.0.1] 归一成十六进制的 ::ffff:7f00:1，
  // 只比对点分写法必然漏（实测确认过）。正经公网模型端点不会写成这种形式，整类拒掉最稳。
  if (h.startsWith("::")) return true
  const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m4) {
    const a = Number(m4[1]), b = Number(m4[2])
    if (a === 127 || a === 10 || a === 0) return true                 // 回环 / 私网A / 本网
    if (a === 192 && b === 168) return true                            // 私网C
    if (a === 172 && b >= 16 && b <= 31) return true                   // 私网B（docker 网桥常在此段）
    if (a === 169 && b === 254) return true                            // link-local（含 AWS/GCP 元数据 169.254.169.254）
    if (a === 100 && b >= 64 && b <= 127) return true                  // CGNAT（阿里云元数据 100.100.100.200 在此段）
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true    // IPv6 ULA / link-local
  return false
}

// ---- 每用户存储上限（uploads + outputs 之和）----
// STORAGE_LIMIT_MB=0 或空 = 不限。达上限拦截新上传；前端到 90% 提示。删除会话会清掉其目录（见 /api/session/delete）。
const STORAGE_LIMIT_MB = Number(process.env.STORAGE_LIMIT_MB || 0)
const dirSize = (dir) => {
  let total = 0
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      // .preview 是服务端自己生成的预览缓存（docx→html、pptx→pdf），用户在界面上既看不见也删不掉，
      // 却按目录递归被算进配额 —— 等于拿用户看不见的缓存去挤他的额度。它是派生数据，不计入。
      if (e.isDirectory()) { if (e.name !== ".preview") walk(p) }
      else if (!e.name.endsWith(".part")) { try { total += fs.statSync(p).size } catch {} }   // .part 是在传中的临时文件，另由 inflightUploadBytes 计
    }   // .part 是上传中的临时文件，用 inflightUploadBytes 单独计，别在此重复计
  }
  walk(dir); return total
}
const storageUsed = () => dirSize(UPLOADS) + dirSize(OUTPUTS)      // 字节（不含在写的 .part）
const storageLimitBytes = () => STORAGE_LIMIT_MB * 1024 * 1024
// 所有正在写、尚未改名就位的上传字节合计。并发上传各自只盯自己的 size 会互相看不见 →
// 剩 150MB 时两个 100MB 同传都以为够、双双落盘超限。用这个全局量让并发上传彼此可见（与 runningCost 同构）。
let inflightUploadBytes = 0
// 不需登录即可访问的路径。/api/health 必须在这里：它的用途就是给 manager / compose healthcheck /
// monitor 这些【没有登录票据】的探针用；放在门禁后面只会拿到 302 到登录页，等于这个端点白做。
// 它只回两个布尔（网关活着 / opencode 就绪），不含任何敏感信息。
const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/health"])
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
// 解释器优先级：SCI_PYTHON 显式覆盖 > 项目根 .venv（镜像里由 Dockerfile 创建，也是各技能的统一约定）
//                > PATH 上的 python3（依赖包在系统 python 里也是齐的）。
// 【惰性探测 + 缓存】而非模块加载时一次性求值：.venv 可能是网关起来【之后】才建好的（env-setup 场景），
// 若在加载时就定死，进程整个生命周期都会用系统 python3、再也切不回去。与下面的 soffice() 同构。
let _pyexe
const PYEXE = () => {
  if (_pyexe !== undefined) return _pyexe
  if (process.env.SCI_PYTHON) { _pyexe = process.env.SCI_PYTHON; return _pyexe }
  const inVenv = process.platform === "win32" ? path.join(ROOT, ".venv/Scripts/python.exe") : path.join(ROOT, ".venv/bin/python")
  try { _pyexe = fs.existsSync(inVenv) ? inVenv : null } catch { _pyexe = null }
  if (!_pyexe) _pyexe = process.platform === "win32" ? "python" : "python3"
  return _pyexe
}
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
// 每次用独立 UserInstallation profile，避免多用户并发时 profile 锁冲突。
// 返回 profile 目录供调用方【用完删掉】：LibreOffice 每次会在里面铺一整套配置树（数 MB），
// 不删就随每次预览/预热在容器可写层里越积越多（超时被 kill 的那次同样会留下）。
const sofficeJob = (src, outDir) => {
  const dir = path.join(os.tmpdir(), "lo-" + crypto.randomBytes(6).toString("hex"))
  return { dir, args: ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, src, "-env:UserInstallation=file:///" + dir.replace(/\\/g, "/")] }
}
// ★ 全局串行闸：同一时刻只允许【一个】LibreOffice 在跑。
// 单个 soffice headless 转 pptx 峰值 300–600MB，而容器 mem_limit 只有 1400–1750m；
// 一旦并发起两个就可能触发 OOM-kill —— 被杀的是【整个容器】（opencode + 网关一起没），
// 而不只是这次预览失败。而后台预热虽有 _warmQueue 串行，/api/preview 却是直接调用、
// 不进那个队列：用户点预览时预热正好在跑、或两个标签页同时点，就凑齐了两个进程。
// 故把闸做在最底层，无论谁调用都得排队。
let _sofficeGate = Promise.resolve()
const withSoffice = (fn) => {
  const run = _sofficeGate.then(fn, fn)   // 前一个无论成败都放行下一个
  _sofficeGate = run.then(() => {}, () => {})
  return run
}

// .preview 已不计入用户配额（它是派生缓存，用户看不见也删不掉），那就必须自己有上限，
// 否则「配额没满、卷先写爆」：活跃会话里每个新文件名都会生成一份缓存 PDF（数 MB），只在删会话时才整目录清。
// 每次写完缓存后按 mtime 做一次 LRU 裁剪，超出上限就从最旧的开始删。
const PREVIEW_CACHE_MAX = Number(process.env.PREVIEW_CACHE_MAX_MB || 200) * 1024 * 1024
function prunePreviewCache(cacheDir) {
  try {
    const items = fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => { const p = path.join(cacheDir, e.name); const st = fs.statSync(p); return { p, size: st.size, mtime: st.mtimeMs } })
    let total = items.reduce((s, x) => s + x.size, 0)
    if (total <= PREVIEW_CACHE_MAX) return
    for (const it of items.sort((a, b) => a.mtime - b.mtime)) {   // 最旧的先删
      if (total <= PREVIEW_CACHE_MAX) break
      try { fs.unlinkSync(it.p); total -= it.size } catch {}
    }
  } catch { /* 裁剪失败不影响预览本身 */ }
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
      try { await execFileAsync(PYEXE(), ["-X", "utf8", "-c", MAMMOTH_PY, src, out], { timeout: 60_000 }) }
      catch (err) { const e = new Error(String(err).slice(0, 200)); e.code = "docx-fail"; throw e }
    }
    prunePreviewCache(cacheDir)
    return { out, ctype: "text/html; charset=utf-8" }
  }
  if ([".pptx", ".ppt", ".odp", ".doc", ".odt"].includes(ext)) {
    const out = path.join(cacheDir, name.replace(/\.[^.]+$/, "") + ".pdf")
    if (!fresh(out)) {
      if (!soffice()) { const e = new Error("no LibreOffice"); e.code = "no-soffice"; throw e }
      const job = sofficeJob(src, cacheDir)
      try { await withSoffice(() => execFileAsync(soffice(), job.args, { timeout: 90_000 })) }   // 排队，绝不并发起两个 LO
      catch (err) { const e = new Error(String(err).slice(0, 200)); e.code = "office-fail"; throw e }
      finally { try { fs.rmSync(job.dir, { recursive: true, force: true }) } catch {} }   // 成功/失败/超时都要清掉临时 profile
      if (!fs.existsSync(out)) { const e = new Error("no pdf produced"); e.code = "no-pdf"; throw e }
    }
    prunePreviewCache(cacheDir)
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
  // 事件流的取消句柄：每轮都会 client.event.subscribe() 新开一条到 opencode 的长连接，
  // 若不主动取消，for-await 只有等"下一个任意事件到达"才会看到 job.finished 而 break ——
  // 末轮的订阅可能整夜不释放。SDK 的 subscribe(options) 会把 options.signal 一路透传到
  // createSseClient → fetch(url,{signal})，abort 后重试循环顶部的 `if (signal.aborted) break` 会终止它。
  const evAbort = new AbortController()
  const broadcast = (ev, data) => {
    if (ev === "text") job.text = data
    else if (ev === "reasoning") job.reasoning.set(data.id, data)
    else if (ev === "tool") { if (data.tool === "skill") { if (data.skill) job.skills.set(data.skill, data) } else if (data.callID) job.tools.set(data.callID, data) }
    for (const r of job.subs) sseWrite(r, ev, data)
  }
  const finish = () => {
    if (job.finished) return
    job.finished = true; job.running = false; jobs.delete(sid); runningCost.delete(sid)   // 本轮成本已由 addCost 入账，撤掉实时占位
    try { evAbort.abort() } catch {}   // 立刻掐掉本轮的 opencode 事件流，别留着空转到下一个事件
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
    const events = await client.event.subscribe({ signal: evAbort.signal })   // finish() 里 abort，避免订阅泄漏
    const runCost = new Map()             // 本轮各 assistant 消息的 cost（按 messageID 取最新），实时累计
    ;(async () => {
      for await (const e of events.stream) {
        if (job.finished) break
        // 中途额度封顶：一旦「今日已入账 + 所有在跑轮的实时成本」达上限，立即中止本轮，避免单轮跑到底大幅超支。
        // 用全局 runningCost（而非本轮开始时的快照）：并发的几轮互相看得见对方已花的钱，合计到顶各轮都会中止。
        if (DAILY_COST_LIMIT > 0 && !job.quotaHit && e?.type === "message.updated") {
          const info = e.properties?.info
          if (info?.sessionID === sid && info.role === "assistant") {
            runCost.set(info.id, info.cost || 0)
            let rc = 0; for (const v of runCost.values()) rc += v
            runningCost.set(sid, rc)
            if (quotaUsedLive() >= DAILY_COST_LIMIT) { job.quotaHit = true; try { await client.session.abort({ path: { id: sid } }) } catch {} }
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
    const outDir = await sessionOut(sid)                 // 本会话的绝对产物目录（= agent 的工作目录）
    const before = dirState(outDir)   // 记录本轮开始前本会话产物状态，用于算增量
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
    const changed = changedSince(outDir, before)
    broadcast("files", changed)   // 只推本会话本轮新建/改动的产物
    warmPreviews(outDir, changed)   // 后台把新产出的 office/docx 预转缓存，用户点预览即秒开
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
      // 多用户部署（BASE_PATH 非空 = 前面有 manager）：容器自带的登录页是条死路——
      // manager 的 POST /<user>/api/login 强制校验图形验证码，而本容器的 login.html 根本不发验证码，
      // 从这里提交必然「验证码错误」。故送去 manager 的验证码门户（LOGIN_URL 已按 BASE_PATH 取好）。
      // 单机/局域网部署（BASE_PATH 为空、无 manager）仍用本地 login.html。
      if (BASE_PATH) { res.writeHead(302, { Location: LOGIN_URL, "Cache-Control": "no-store" }); return res.end() }
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
    // 门禁：其余路径若未登录 → 页面跳登录页、接口回 401
    if (!PUBLIC_PATHS.has(u.pathname) && !authed(req)) {
      if (req.method === "GET" && (req.headers.accept || "").includes("text/html")) {
        // 多用户部署直接送到站点根的统一登录页（带验证码），少一跳、也避开容器 login.html 那条死路
        res.writeHead(302, { Location: LOGIN_URL, "Cache-Control": "no-store" }); return res.end()
      }
      return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "unauthorized" }))
    }
    // ↓↓↓ 以下路由都已过门禁：未登录的请求走不到这里 ↓↓↓

    // 忙碌探针：宿主的 manager 在「空闲停机 / 满员腾位」前问一句「这容器还有活在跑吗」。
    // 本网关的设计是「关页面 = 只退订，生成继续跑」（见 /api/chat/attach），但 manager 只看得见
    // HTTP 连接：页面一关 SSE 就断、conns 归 0，它便会把正在跑十几分钟的流水线连容器一起停掉。
    // 故这里把「有无在跑的 job」暴露给它。manager 用 docker exec 从容器【内部】打 127.0.0.1 来问，
    // 命中 isLocal 免鉴权 —— 不必把本接口放进 PUBLIC_PATHS：容器彼此在同一 docker 网络里互通，
    // 而每个容器里跑的正是能执行任意代码的 agent，公开它等于让 alice 能探到 bob 在不在干活。
    if (req.method === "GET" && u.pathname === "/api/busy") {
      const running = [...jobs.values()].filter((j) => j.running).length
      return send(res, 200, "application/json", JSON.stringify({ busy: running > 0, running }))
    }

    // 自助改密码（须已登录 —— 必须留在门禁【之后】）：校验当前密码 → 写 override → 用新密码重签 cookie。
    // 放门禁前等于开了个密码预言机：未登录者能凭「当前密码不正确 / 新密码至少 6 位」两种回包无限盲猜密码，
    // 且绕开 manager 的图形验证码、限流与审计日志。
    if (req.method === "POST" && u.pathname === "/api/password") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let cur = "", nw = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); cur = String(b.current || ""); nw = String(b.new || "") } catch {}
      if (cur !== effectivePassword()) return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "当前密码不正确" }))
      if (nw.length < 6) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "新密码至少 6 位" }))
      try { fs.mkdirSync(path.dirname(PW_OVERRIDE), { recursive: true }); fs.writeFileSync(PW_OVERRIDE, JSON.stringify({ base: sha(LAN_PASSWORD), password: nw })) }
      catch { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: "保存失败" })) }
      // 签名密钥就是「当前有效密码」，改密后旧 cookie 立即失效 → 必须当场用新密码重签一张下发，
      // 否则改密成功的用户下一次请求就被自己踢回登录页。override 已落盘，effectivePassword() 此刻返回新密码。
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=${makeAuthCookie()}; Path=${BASE_PATH}/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_TTL_MS / 1000}` })
      return res.end(JSON.stringify({ ok: true }))
    }
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })   // 每次取最新页面，避免浏览器缓存旧版
      return res.end(fs.readFileSync(path.join(__dirname, "index.html")))
    }

    if (req.method === "POST" && u.pathname === "/api/upload") {
      let sid = u.searchParams.get("sid") || null
      if (!sid) sid = await createSession("web")   // 上传先于对话则现建会话（createSession 会把 directory 定到会话产物目录）
      const ws = await ensureWs(sid)
      const name = path.basename(u.searchParams.get("name") || "upload.bin")
      // 流式落盘（不整包缓冲进内存，大文件不再有 ~2×文件大小的内存尖峰）：
      // ① 有 Content-Length 就先预检存储余量（浏览器上传都带），拦在收数据之前；
      // ② 边写临时隐藏文件边累计大小（兜底 chunked 上传），超限即中止并删除；③ 成功才改名就位。
      // 余量始终算上 inflightUploadBytes（其它在传的上传），并发上传彼此可见、不会合谋超限。
      const lim = storageLimitBytes()
      const overMsg = () => JSON.stringify({ ok: false, err: `存储空间不足：已用 ${(storageUsed() / 1048576).toFixed(0)}MB / 上限 ${STORAGE_LIMIT_MB}MB。请删除旧会话或文件后再传。` })
      const wouldExceed = (extra) => lim > 0 && storageUsed() + inflightUploadBytes + extra > lim
      const declared = Number(req.headers["content-length"])
      const hasLen = Number.isFinite(declared) && declared >= 0
      // 有 Content-Length（浏览器上传都有）：读 body 前就判，超限直接回干净 413（不会在半程掐断连接让浏览器报“Failed to fetch”）；
      // 通过则【预占】declared 到 inflightUploadBytes——并发的下一个上传立刻看得见这份占用，也在读 body 前被干净拦下。
      if (hasLen && wouldExceed(declared)) return sendClose(res, 413, "application/json", overMsg())   // 不收正文就拒 → 必须关连接，否则残留 body 堵死这条 keep-alive
      let reserved = 0
      if (hasLen) { reserved = declared; inflightUploadBytes += reserved }
      const release = () => { inflightUploadBytes -= (hasLen ? reserved : size) }   // 成功改名(计入真实 storageUsed)或失败删除后，把占用撤出
      const dest = path.join(ws.up, name)
      const tmp = path.join(ws.up, "." + crypto.randomBytes(6).toString("hex") + ".part")   // 隐藏 .part：文件列表/产物快照/存储计量都会跳过
      let size = 0, stopped = false   // stopped：chunked 超限掐断后，别再让 data 监听器给 inflight 加字节（否则 release 后仍累加→永久泄漏）
      try {
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(tmp)
          // 无 Content-Length 的 chunked 上传：没法预占，只能边写边把字节计入全局并逐块判超限（超了半程掐断）。
          req.on("data", (c) => {
            if (stopped) return
            size += c.length
            if (!hasLen) { inflightUploadBytes += c.length; if (wouldExceed(0)) { stopped = true; const e = new Error("over"); e.code = "over"; req.unpipe(ws); ws.destroy(e) } }
          })
          req.on("close", () => { if (!req.complete) { const e = new Error("客户端中断上传"); e.code = "aborted"; reject(e) } })
          req.on("error", reject)
          ws.on("error", reject)
          ws.on("finish", resolve)
          req.pipe(ws)
        })
      } catch (e) {
        release(); try { fs.unlinkSync(tmp) } catch {}
        // 这两条都发生在【半程掐断】：客户端可能还在上传，body 必然没读完 → 一律关连接
        if (e.code === "over") return sendClose(res, 413, "application/json", overMsg())
        return sendClose(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e?.message || e).slice(0, 200) }))
      }
      fs.renameSync(tmp, dest); release()
      return send(res, 200, "application/json", JSON.stringify({ ok: true, sid, path: `${relFromRoot(dest)}`, size: fs.statSync(dest).size }))
    }

    if (req.method === "GET" && u.pathname === "/api/files")
      return send(res, 200, "application/json", JSON.stringify([]))   // 页面初始不预载历史产物，只在对话后显示本轮新产物

    // 列出本会话 uploads/ 里已上传的文件（含大小），用于侧栏“上传空间”的常驻展示
    if (req.method === "GET" && u.pathname === "/api/uploads") {
      const sid = u.searchParams.get("sid") || ""
      const dir = sid ? await sessionUp(sid) : UPLOADS
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
      const f = path.join(sid ? await sessionUp(sid) : UPLOADS, name)
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
      try { fs.rmSync(await sessionUp(id), { recursive: true, force: true }); fs.rmSync(await sessionOut(id), { recursive: true, force: true }); dirCache.delete(safeSid(id)) } catch {}   // 删会话即释放其 uploads/outputs 占用的空间
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    // 编辑历史消息：回退到第 uindex 个用户消息（含）之前，opencode 会丢弃其后的消息；
    // 之后前端把编辑后的内容当新消息重发。uploads/ 与 outputs/ 均在 .gitignore 里，
    // opencode 基于 git 快照的回退不会动它们 —— 满足“文件不变”。
    if (req.method === "POST" && u.pathname === "/api/revert") {
      const sid = u.searchParams.get("sid") || ""
      const uindex = Number(u.searchParams.get("uindex"))
      if (!sid || !Number.isInteger(uindex) || uindex < 0) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      // 该会话正在生成 → 拒绝回退：此刻 opencode 正往消息列表写，revert 会把状态搅乱、本轮收尾行为未定义。
      // （前端 activeES 一般已拦，但双开/attach 失败时前端拦不住，这里兜底。）
      if (jobs.get(sid)?.running) return send(res, 409, "application/json", JSON.stringify({ ok: false, err: "本轮生成进行中，无法编辑，请等结束后再试" }))
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
      const f = path.join(sid ? (up ? await sessionUp(sid) : await sessionOut(sid)) : (up ? UPLOADS : OUTPUTS), name)   // 无 sid 回退共享目录（兼容）
      if (!name || !fs.existsSync(f)) return send(res, 404, "text/plain", "not found")
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": contentDisposition(name) })
      return fs.createReadStream(f).pipe(res)
    }

    // 内联查看（供聊天框里 <img> 预览 / 在新标签打开），带正确 MIME、不强制下载
    if (req.method === "GET" && u.pathname === "/api/raw") {
      const sid = u.searchParams.get("sid") || ""
      const name = path.basename(u.searchParams.get("name") || "")
      const up = u.searchParams.get("dir") === "up"
      const f = path.join(sid ? (up ? await sessionUp(sid) : await sessionOut(sid)) : (up ? UPLOADS : OUTPUTS), name)
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
      const dir = sid ? await sessionOut(sid) : OUTPUTS
      let r
      try { r = await ensurePreviewCache(dir, name) }
      catch (e) {
        if (e.code === "no-src") return send(res, 404, "text/plain", "not found")
        // 转义再插进 HTML：e.message 里含被转换文件的路径/文件名，而文件名是 agent 产出的、可含尖括号。
        // 影响仅限用户自己（一人一容器），但顺手堵掉，别留个会往 HTML 里塞未转义内容的口子。
        if (e.code === "docx-fail") return send(res, 500, "text/html; charset=utf-8", `<p style="color:#b91c1c">DOCX 预览转换失败：${String(e.message).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
        if (e.code === "no-soffice") return send(res, 501, "text/plain", "服务器未安装 LibreOffice，无法预览此类型（装好后即可）")
        if (e.code === "no-pdf") return send(res, 500, "text/plain", "转换未产出 PDF")
        return send(res, 500, "text/plain", "转换失败：" + e.message)
      }
      if (!r) return send(res, 415, "text/plain", "该类型不支持预览")
      // docx 转出来的 HTML 是 mammoth 直出的：它保留原文档里的超链接，且【不过滤 javascript: 协议】。
      // 这条路径以前因为 mammoth 没装、docx 预览 100% 失败而从没真正跑过，装上后才第一次生效 → 补上沙箱。
      // 与 /api/raw 对 html/svg 的处理保持一致：不允许脚本、不接触本站源。
      const head = { "Content-Type": r.ctype }
      if (String(r.ctype).startsWith("text/html")) head["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"
      res.writeHead(200, head)
      return fs.createReadStream(r.out).pipe(res)
    }

    // 健康检查：网关活着不等于能用——opencode 起不来时网关照样监听端口、
    // 前端也照常渲染，用户要等发出第一条消息才发现整站是坏的（manager 只探端口，也会误判为健康）。
    // 暴露真实依赖状态，供 manager/monitor 与前端横幅使用。
    if (req.method === "GET" && u.pathname === "/api/health") {
      const ocOk = await ocHealthy()
      // 只回布尔，不带模型名——这是个公开端点（见 PUBLIC_PATHS 的说明），没必要对外透露用的哪个模型
      return send(res, ocOk ? 200 : 503, "application/json", JSON.stringify({ gateway: true, opencode: ocOk }))
    }
    if (req.method === "GET" && u.pathname === "/api/quota") {   // 前端显示今日额度用量（含在跑轮的实时成本）
      return send(res, 200, "application/json", JSON.stringify({ used: quotaUsedLive(), limit: DAILY_COST_LIMIT }))
    }
    if (req.method === "GET" && u.pathname === "/api/storage") {   // 前端显示存储用量（uploads+outputs）
      return send(res, 200, "application/json", JSON.stringify({ used: storageUsed(), limit: storageLimitBytes() }))
    }
    // 发起一轮生成。【POST，正文在 body】——原先是 GET /api/chat?q=...，两个毛病：
    //   ① GET 带副作用（发消息 + 扣额度），而 cookie 是 SameSite=Lax：跨站顶层 GET 导航会带上凭据，
    //      诱导点一个链接就能替用户跑一轮长生成、烧掉当天额度（浏览器/代理的链接预取也可能误触发）。
    //   ② 长正文塞进 URL 会撞 Node 默认 16KB 请求头上限 → 431/断连，而前端的 SSE onerror 会把它
    //      当成网络抖动去重连，消息就【静默丢失】了（粘贴一段稿件即可复现）。
    // 起轮成功后，前端再用 GET /api/chat/attach?sid= 订阅直播（EventSource 只能发 GET，故拆成两步）。
    if (req.method === "POST" && u.pathname === "/api/chat/start") {
      const chunks = []; let total = 0
      for await (const c of req) {
        total += c.length
        if (total > 4_000_000) return sendClose(res, 413, "application/json", JSON.stringify({ ok: false, sent: false, err: "消息过长（超过 4MB）" }))   // 从 for-await 里提前 return → body 未读完，必须关连接
        chunks.push(c)
      }
      let q = "", sid = null
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); q = String(b.q ?? ""); sid = b.sid ? String(b.sid) : null } catch {}
      if (!q.trim()) return send(res, 400, "application/json", JSON.stringify({ ok: false, sent: false, err: "消息为空" }))
      // 新会话要先向 opencode 建会话；它没起来时这里会抛，此前会被外层 catch 变成一个带堆栈的 500，
      // 用户只看到"发送失败"，根本不知道是后台模型服务没起来。这里单独兜住并给人话。
      if (!sid) {
        try { sid = await createSession(q.slice(0, 40)); titledSessions.add(sid) }
        catch {
          const ocOk = await ocHealthy()
          return send(res, 503, "application/json", JSON.stringify({ ok: false, sent: false,
            err: ocOk ? "无法创建会话，请稍后重试" : "后台模型服务（opencode）尚未就绪，请稍等几十秒后重试；若持续如此请联系管理员" }))
        }
      }
      const ws = await ensureWs(sid)
      // ensureSessionTitle 里有 await（打 opencode 网络）——必须放在“检查 running → startJob”这段【全同步】区之前。
      // 否则同 sid 的两个并发请求会在这个 await 处双双让出、都看到没有 running job、各自 startJob，
      // 后者 jobs.set 覆盖前者 → 两轮 prompt 并发打同一会话、先收尾的把另一轮从表里删成无法 attach/abort 的孤儿。
      await ensureSessionTitle(sid, q)
      if (jobs.get(sid)?.running)   // 该会话已有进行中的一轮（双开页面/连点）→ 不重复发起，让前端去续流
        return send(res, 200, "application/json", JSON.stringify({ ok: true, sid, sent: false, running: true, notice: "上一轮仍在进行中，本条消息未发送；请等本轮结束后重发。" }))
      if (quotaOver())
        return send(res, 200, "application/json", JSON.stringify({ ok: false, sid, sent: false, err: `今日额度已用尽（已用 $${quotaUsedLive().toFixed(3)} / 上限 $${DAILY_COST_LIMIT.toFixed(2)}），明天恢复。` }))
      // 给 agent 注入本会话专属目录，覆盖技能默认的 outputs/，实现多用户/多会话隔离
      // 注意：本会话的工作目录（cwd）已在建会话时通过 opencode 的 session.directory 定在【会话产物目录】，
      // 所以 agent 的所有工具默认就在正确的地方读写，preamble 只需说清"当前目录就是产物目录"与几个绝对路径。
      const preamble = `【本会话工作区，务必遵守】\n- **你的当前工作目录就是本会话的产物目录**（\`${ws.out}\`）。所有产物（图表 PNG/PDF、CSV/Excel、md/docx 等）**直接写到当前目录即可**，用相对文件名如 \`fig1.png\`、\`manuscript.md\`，不要再自己拼 \`outputs/xxx\` 前缀。\n- 临时脚本、中间文件同样写当前目录（要归拢可用 \`./.scratch/\`）。\n- 用户上传的数据文件在 \`${ws.up}/\`（读数据从这里找，用这个绝对路径）。\n- 跑本套件的脚本用 \`\${REPO_ROOT:-/app}\` 前缀定位仓库，例如 \`\${REPO_ROOT:-/app}/.venv/bin/python \${REPO_ROOT:-/app}/.opencode/skills/<技能>/xxx.py\`——因为当前目录不是仓库根，写 \`.venv/...\` 这种相对路径会找不到。\n- 正文里嵌入图片直接用文件名：\`![图注](fig1.png)\`（图和稿件都在当前目录，渲染也从当前目录跑）。\n- **不要把产物写到仓库根或 \`\${REPO_ROOT:-/app}\` 下**：那是所有会话共享的，会互相覆盖，也不会出现在界面的"产出"侧栏。\n\n`
      startJob(sid, preamble + q)   // 同步建 job（jobs.set 在函数首行）→ 返回后前端 attach 必能接上
      return send(res, 200, "application/json", JSON.stringify({ ok: true, sid, sent: true }))
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
      const dir = sid ? await sessionOut(sid) : OUTPUTS
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
        gateway: !!(process.env.OC_GATEWAY_URL && process.env.OC_GATEWAY_KEY),   // 是否接入网关（前端据此显示模型切换器）
      }))
    }
    // 测试一个 OpenAI 格式的 API（URL + key + 模型）是否可用
    if (req.method === "POST" && u.pathname === "/api/model/test") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let baseURL = "", apiKey = "", modelID = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); baseURL = (b.baseURL || "").trim(); apiKey = (b.apiKey || "").trim(); modelID = (b.modelID || "").trim() } catch {}
      if (!baseURL || !apiKey || !modelID) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "请填写 API URL、API Key、模型 ID" }))
      // SSRF 护栏：只允许 http/https 的公网地址（见 isPrivateHost 上方注释）
      try {
        const pu = new URL(baseURL)
        if (!/^https?:$/.test(pu.protocol)) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "只支持 http/https 地址" }))
        if (!ALLOW_PRIVATE_MODEL_URL && isPrivateHost(pu.hostname))
          return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "出于安全考虑，不允许指向内网 / 本机 / 云元数据地址；请填公网可访问的 API 地址" }))
      } catch { return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "API URL 格式不正确" })) }
      const url = baseURL.replace(/\/+$/, "") + "/chat/completions"
      const t0 = Date.now()
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 20000)
      try {
        const r = await fetch(url, {
          method: "POST", signal: ac.signal,
          // 不跟随跳转：上面的私网校验只作用于首跳，若自动跟随，攻击者用一个公网地址 302 到
          // http://127.0.0.1:3010 就能绕过整道护栏（响应体虽已不回显，status/耗时仍是可达性信号）。
          // 正经的 OpenAI 兼容端点不会把 POST /chat/completions 重定向走。
          redirect: "manual",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify({ model: modelID, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
        })
        clearTimeout(timer)
        const ms = Date.now() - t0
        if (r.status >= 300 && r.status < 400)
          return send(res, 200, "application/json", JSON.stringify({ ok: false, status: r.status, ms, err: "该地址发生了重定向，出于安全考虑不予跟随；请直接填最终的 API 地址" }))
        const body = await r.text()
        if (!r.ok) {
          // 【不回显上游响应体】：本接口可被指向任意 URL，原样回显 body 等于把探测结果送给调用方。
          // 只给状态码 + 按状态类别的固定说明——够用户排查自己的配置，又不泄露上游内容。
          const hint = (r.status === 401 || r.status === 403) ? "密钥无效或无权限"
            : r.status === 404 ? "地址或模型不存在（检查 API URL 是否需以 /v1 结尾、模型 ID 是否正确）"
            : r.status === 429 ? "上游限流，稍后再试"
            : r.status >= 500 ? "上游服务异常" : "上游返回错误"
          return send(res, 200, "application/json", JSON.stringify({ ok: false, status: r.status, ms, err: `${hint}（HTTP ${r.status}）` }))
        }
        // 成功分支只回模型回复的前 80 字：需要上游返回标准 OpenAI 结构才有值，普通内网服务命不中。
        let reply = ""; try { const j = JSON.parse(body); reply = j.choices?.[0]?.message?.content || "" } catch {}
        return send(res, 200, "application/json", JSON.stringify({ ok: true, status: r.status, ms, reply: String(reply).slice(0, 80) }))
      } catch (e) {
        clearTimeout(timer)
        // 同理不回显底层错误串：ECONNREFUSED / EHOSTUNREACH / ENOTFOUND 的区别本身就是端口扫描的信号，统一成一句话。
        return send(res, 200, "application/json", JSON.stringify({ ok: false, err: e?.name === "AbortError" ? "请求超时（20s 内无响应）" : "无法连接到该地址（检查 API URL 是否正确、是否可公网访问）" }))
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
    // 用户切换网关下的模型：沿用网关的 baseURL/key，只换模型名（持久化 + 重启 opencode 生效）
    if (req.method === "POST" && u.pathname === "/api/model/pick") {
      const baseURL = process.env.OC_GATEWAY_URL, apiKey = process.env.OC_GATEWAY_KEY
      if (!baseURL || !apiKey) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "未接入网关，无法切换模型" }))
      const chunks = []; for await (const c of req) chunks.push(c)
      let modelID = ""; try { modelID = (JSON.parse(Buffer.concat(chunks).toString() || "{}").model || "").trim() } catch {}
      if (!modelID) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "缺 model" }))
      writeOcProvider({ baseURL, apiKey, modelID })
      saveModelCfg({ baseURL, apiKey, modelID })
      MODEL = { providerID: CUSTOM_PROVIDER_ID, modelID }
      let restarted = false; try { restarted = await restartOpencode() } catch {}
      if (!restarted) { try { await client.config.update({ body: { provider: { [CUSTOM_PROVIDER_ID]: customProviderCfg({ baseURL, apiKey, modelID }) } } }) } catch {} }
      return send(res, 200, "application/json", JSON.stringify({ ok: true, restarted, modelID }))
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
