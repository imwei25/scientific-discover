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
// 固化两条无论如何都要成立的 opencode 策略。所有写 opencode.json 的路径 + 启动时都会过这里。
//
// 【为什么这里【不】用 permission.edit/read 去保护 /app/.opencode、AGENTS.md、网关代码等】
// 实测（2026-07-23，服务器隔离容器 + 钉死的 opencode 1.17.14，逐配置复跑）：opencode 的
// permission.edit/read 的路径规则【只作用于会话工作目录(cwd)以内】的文件；cwd 之【外】的文件
// 完全由 external_directory 一个开关决定，路径规则对它们一律不生效。而本部署把每个会话的 cwd
// 指到 /app/outputs/<会话id>/，要保护的 /app/.opencode、/app/AGENTS.md、/app/web、/app/opencode.json
// 全在 cwd 之外 → 归 external_directory 管；而它又【必须】是 allow（否则「上传文件→分析」100% 挂死，
// 见下）。结论：靠 opencode 配置保护这些文件在本部署形态下【根本做不到】，写了也是惰性失效的安全
// 表演。真正enforceable的写保护要靠容器层【只读绑定挂载】（内核级、连 root+bash 都写不动），见
// deploy 侧（render-compose.sh 的 :ro 卷 / 或只读根文件系统）。故此处不再写任何 edit/read 规则。
const enforceOcTools = (oc) => {
  oc.tools = { ...(oc.tools || {}), question: false }
  // ★ external_directory 必须 allow，否则「上传文件→让 agent 分析」这条最常用的路径 100% 卡死。
  // 起因是会话工作目录改造：cwd 从 /app 变成了 /app/outputs/<会话id>/，于是用户上传所在的
  // /app/uploads/<会话id>/ 对 opencode 而言成了【外部目录】，默认策略是 ask →
  // 无头网关里没有任何人能应答这个授权询问 → read 工具永久停在 running。
  // 实测后果（一次上传即触发，且不可自救）：
  //   ① 该轮永不结束，前端一直转圈；② /api/chat/abort 返回 aborted:false，终止按钮救不回来；
  //   ③ 该会话被永久锁死（再发消息只得到"上一轮仍在进行中"）；④ busy 恒真 → manager 永不回收该容器，
  //   白占内存与 WARM_CAP 槽位，且 /api/model/pick 恒 409，用户连换模型自救都做不到。
  //   只有 docker restart 能解，而普通用户没这个能力。
  // 为什么给 allow 而不是按目录细分：容器是单用户的，agent 本来就有 shell、与网关同 uid，
  // 它能 cat 的东西不因这个开关而增减 —— 这不是安全边界，只是交互式场景下的确认提示，
  // 在无头服务里唯一的效果就是把请求挂死。跨用户隔离靠的是「一人一容器」，不是它。
  oc.permission = { ...(oc.permission || {}), external_directory: "allow" }
  return oc
}
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
  let resolved = false                                  // 是否真从 opencode 问到了 directory
  try {
    const info = un(await client.session.get({ path: { id: sid } }))
    const d = info?.directory
    if (d && path.resolve(d) !== path.resolve(ROOT)) { dir = path.resolve(d); resolved = true }
  } catch { /* opencode 不可用时用回落值，不阻断文件接口 */ }
  // 【只缓存问到的结果】失败回落不能进缓存，否则一次失败就把错目录钉死【整个进程生命周期】：
  // 容器冷启动时 opencode 要几十秒才就绪，这期间若前端先打到 /api/outputs，session.get 会抛 →
  // 缓存 outputs/<sid>（错的）→ 此后产出侧栏永远空、下载预览全 404，而 agent 实际把文件写进
  // outputs/ws_xxx → 用户看到"跑完了但一个产物都没有"，只有重启网关才能恢复。
  if (resolved) dirCache.set(s, dir)
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
// 递归【一层】：键是相对 dir 的路径，顶层文件仍是裸文件名（"a.png"），子目录里的是 "pdfs/a.pdf"。
// 为什么要递归：好几个技能天然产出子目录（fulltext-retrieval 的 pdfs/、data-integrity 的 audit/、
// systematic-review 的 counts/）。此前只列顶层 → 这些产物在界面"产出"侧栏里【一个都看不到】，
// agent 报告"已下载 4 篇文献"而用户什么也拿不到（生产上真实发生过）。
// 为什么只一层：够覆盖已知的技能产出结构，同时把列表规模与前端展示复杂度控制住；
// 更深的层级仍读得到（下载接口按包含性校验，不限深度），只是不主动列出来。
const DIRSTATE_DEPTH = 1
const dirState = (dir, depth = DIRSTATE_DEPTH, prefix = "") => {
  if (!fs.existsSync(dir)) return {}
  const m = {}
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return m }
  for (const e of ents) {
    if (e.name.startsWith(".")) continue          // .preview 等派生缓存不进列表
    const p = path.join(dir, e.name)
    const rel = prefix ? prefix + "/" + e.name : e.name
    let st; try { st = fs.statSync(p) } catch { continue }
    if (st.isFile()) m[rel] = st.mtimeMs
    else if (st.isDirectory() && depth > 0) Object.assign(m, dirState(p, depth - 1, rel))
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
// 把用户传来的 name 解析成 dir 内的绝对路径；越界一律返回 null（调用方回 404）。
// ★ 为什么不能再用 path.basename：支持子目录后 name 必须允许带分隔符，而 basename 会把
//   "pdfs/a.pdf" 砍成 "a.pdf"（功能直接坏掉）。basename 之所以安全，恰恰是因为它把分隔符全扔了；
//   一旦要保留分隔符，这条一行防线就失效，必须换成"解析后检查是否仍在 dir 之内"。
// 三重检查缺一不可：
//   ① path.resolve 后做前缀包含 → 挡住 ../、绝对路径、以及 %2e%2e 解码后的形态；
//   ② 前缀比较必须带 path.sep → 否则 /data/outputs-evil 会被 /data/outputs 的前缀误判为"在内"；
//   ③ realpath 后再查一次 → 挡住 dir 内部指向外面的符号链接（agent 有 shell，能造软链）。
// 注意：写入路径（/api/upload）【不使用】本函数，仍用 basename —— 那里的 name 完全由用户控制，
// 允许分隔符等于把写入点从"会话目录内一个文件"放大成"任意相对路径"，不值得为它冒险。
const safeUnder = (dir, name) => {
  if (!name || typeof name !== "string") return null
  if (name.includes("\0")) return null
  const base = path.resolve(dir)
  const p = path.resolve(base, name)
  if (p !== base && !p.startsWith(base + path.sep)) return null
  try {
    const realBase = fs.realpathSync(base)
    const real = fs.realpathSync(p)
    if (real !== realBase && !real.startsWith(realBase + path.sep)) return null
  } catch { /* 文件不存在时 realpath 会抛 —— 交给调用方的 existsSync 去 404 */ }
  return p
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

// ---- 功能模块（封装的技能入口 + 每用户授权）----
// 每个"模块"= 一种会话形态：chat 是不设限的自由对话（走 AGENTS.md 的完整路由）；
// 其余模块把会话锁定到【单个技能】——注入模块专用前言，且网关在事件流里强制校验：
// agent 一旦调用模块外的技能（或试图用 task 子代理绕道），本轮立即中止（见 startJob 的模块闸）。
// 会话在创建那一刻绑定模块，绑定持久化在 ocdata 卷（module-map.json），之后不可改——
// 换功能 = 新开会话。老会话（本功能上线前建的）一律按 chat 处理。
const MODULE_DEFS = {
  chat:     { name: "自由对话",       skill: null,               desc: "不限功能的科研助手：综述、论文、统计、作图、检索……完整流水线都在这里" },
  grant:    { name: "标书撰写",       skill: "grant-proposal",   desc: "基金标书专用：按资助渠道模板起草申请书正文" },
  refcheck: { name: "文献真实性检查", skill: "reference-check",  desc: "查假引用：核对参考文献是否真实存在、DOI/题录是否一致" },
  humanize: { name: "去AI味写作",     skill: "humanize-academic", desc: "学术文本去 AI 味改写：保留事实与引用，只改表达" },
}
// 每用户授权（ALLOWED_MODULES=chat,grant,...，由 deploy 的 users/<名>.env 注入）。
// 空/未设 = 全部模块（单机部署与老容器的兼容默认）。非空但没有一个合法 id = 配置错误 →
// fail-closed 回落到仅 chat 并响亮告警（别把乱码静默当"全开"）。
const ALLOWED_MODULES = (() => {
  const raw = String(process.env.ALLOWED_MODULES || "").trim()
  if (!raw) return Object.keys(MODULE_DEFS)
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => MODULE_DEFS[s])
  if (!ids.length) { console.warn(`[modules] ALLOWED_MODULES 配置非法：${JSON.stringify(raw)} → 回落到仅 chat，请修正 users/<名>.env 的 MODULES`); return ["chat"] }
  return ids
})()
// ---- 每用户技能白名单（比模块更细的授权粒度）----
// ALLOWED_SKILLS=（逗号分隔，deploy 的 users/<名>.env 经 SKILLS= 注入）；空/未设 = 全部技能。
// 生效范围：自由对话(chat)会话——注入"未开通技能"前言 + 事件流强制（调未开通技能即中止本轮，
// 与模块闸同一机制）；受限模块的绑定技能被收权时，该模块整体不可用（/api/modules 置 false、start 拒绝）。
// env-setup 恒许可（基础设施：各技能都依赖它建的 .venv，禁它只会让一切技能坏得莫名其妙）。
// 已知逃逸面（与模块闸一致的取舍）：chat 会话不禁 task 子代理（禁了会破坏正常流水线），子会话里的
// 技能调用不经本闸；且 agent 有 shell，理论上可绕过 skill 工具直接跑技能脚本——本闸是产品分权，不是对抗边界。
const SKILL_IDS = (() => {   // 以技能目录为唯一事实来源（含 SKILL.md 的子目录才算技能）
  try {
    return fs.readdirSync(path.join(ROOT, ".opencode", "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, ".opencode", "skills", e.name, "SKILL.md")))
      .map((e) => e.name)
  } catch { return [] }
})()
const ALLOWED_SKILLS_SET = (() => {   // null = 不设限（全部技能）
  const raw = String(process.env.ALLOWED_SKILLS || "").trim()
  if (!raw) return null
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean)
  const valid = ids.filter((s) => SKILL_IDS.includes(s))
  const dropped = ids.filter((s) => !SKILL_IDS.includes(s))
  if (dropped.length) console.warn(`[skills] ALLOWED_SKILLS 含未知技能（已忽略）：${dropped.join(",")}`)
  // 非空但全非法 = 配置错误：fail-closed 成"一个都不许"（响亮告警），而不是静默放开全部
  if (!valid.length) console.warn(`[skills] ALLOWED_SKILLS 无一合法：${JSON.stringify(raw)} → 按全部禁用处理，请修正 users/<名>.env 的 SKILLS`)
  return new Set([...valid, "env-setup"])
})()
const skillAllowed = (name) => !ALLOWED_SKILLS_SET || ALLOWED_SKILLS_SET.has(name)
// chat 会话的技能限制前言（受限模块会话不用它——那边本就锁死单技能）。挑短的一边列，控制前言长度；
// 单行无空行（stripPreamble 按第一个空行剥离，见 modulePreamble 同款约束）。
const skillsPreamble = () => {
  if (!ALLOWED_SKILLS_SET) return ""
  const allowed = [...ALLOWED_SKILLS_SET].filter((s) => s !== "env-setup")
  const banned = SKILL_IDS.filter((s) => s !== "env-setup" && !ALLOWED_SKILLS_SET.has(s))
  if (!banned.length) return ""
  const line = banned.length <= allowed.length
    ? `以下技能对本账号【未开通】，禁止调用：${banned.join("、")}。`
    : `本账号【只开通】了以下技能：${allowed.join("、")}（外加 env-setup），其余技能一律禁止调用。`
  return `\n- **【技能授权，最高优先级】**${line}规划流水线时直接跳过未开通的技能并明确告知用户"某步骤因未开通某技能而省略"；不要试图调用（会被网关强制中止本轮），也不要徒手模仿该技能的产出。`
}

// 会话 → 模块 绑定表（持久化在 ocdata 卷，容器重建不丢；与 quota.json 同目录）
const MODULE_MAP_FILE = path.join(os.homedir(), ".local", "share", "opencode", "module-map.json")
let _modMap = null
const moduleMap = () => {
  if (_modMap) return _modMap
  try { _modMap = JSON.parse(fs.readFileSync(MODULE_MAP_FILE, "utf8")) || {} } catch { _modMap = {} }
  return _modMap
}
const saveModuleMap = () => { try { fs.mkdirSync(path.dirname(MODULE_MAP_FILE), { recursive: true }); fs.writeFileSync(MODULE_MAP_FILE, JSON.stringify(_modMap || {})) } catch (e) { console.warn(`[modules] 绑定表写入失败：${e.message}`) } }
const sessionModule = (sid) => moduleMap()[safeSid(sid)] || "chat"   // 未登记的老会话一律按 chat
const bindSessionModule = (sid, modId) => { moduleMap()[safeSid(sid)] = modId; saveModuleMap() }
const unbindSessionModule = (sid) => { if (moduleMap()[safeSid(sid)]) { delete moduleMap()[safeSid(sid)]; saveModuleMap() } }
// 受限模块的会话前言：与工作区前言同一个块注入（中间不能有空行——stripPreamble 按"第一个空行"剥离）
const modulePreamble = (modId) => {
  const m = MODULE_DEFS[modId]
  if (!m || !m.skill) return ""
  return `\n- **【模块限制，最高优先级，覆盖 AGENTS.md 的一切路由规则】本会话是「${m.name}」专用模块**：你【只允许】调用一个技能——\`${m.skill}\`，禁止调用任何其它技能，也禁止用 task/子代理间接调用其它技能。\n- 不做任何流水线编排（不选题、不检索、不统计、不排版……），缺信息就直接向用户要。\n- 用户的需求超出「${m.name}」范围时，明确告知“本模块只负责${m.name}，其它需求请到「自由对话」模块”，不要自己徒手代替其它技能去做。\n- 网关会强制校验技能调用：一旦调用 \`${m.skill}\` 之外的技能，本轮会被立即中止。`
}

// HTTP 响应头只能承载 latin1：中文文件名直接塞进 Content-Disposition 会 ERR_INVALID_CHAR → 下载必 500。
// 按 RFC 5987 同时给两份：ASCII 兜底名（老客户端读它；剔掉引号、反斜杠、控制字符与非 ASCII 字节）
// 与 filename*=UTF-8''<百分号编码>（现代浏览器优先读它，中文名原样还原）。
const contentDisposition = (name) => {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").trim() || "download"
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

// ---- 每日成本额度（USD）----
// 用 opencode 的 session.cost（已含 DeepSeek 缓存折扣）累计每轮增量；跨日自动清零。
// 持久化分两种形态：多用户部署记到【宿主账本】（见下方 REMOTE_QUOTA，防容器内 agent 篡改），
// 单机/本地部署记到 ocdata 卷的 quota.json（重启不丢，与旧行为一致）。
// DAILY_COST_LIMIT=0 或空 = 不限额。达上限即拦截新对话；进行中的轮到限也会被中途掐断（见 startJob 的 updateRunning）。
// 被 abort / 被掐断的那一步 opencode 记 cost=0，由估算兜底补账（见下方"轮内实时成本估算"），否则可无限重试绕过额度。
// 额度解析（fail-closed，与 manager.mjs parseLimit 同款策略）：空/未设/合法 0 → 0（=故意不限额，行为不变）；
// 合法正数 → 该上限；非空但非有限 ≥0 数字（NaN/负数/Infinity，如乱码 env）→ 判为【配置错误】。
// 此前 Number("abc")=NaN、`x>0` 恒 false → 门形同虚设可无限烧钱（要治的 fail-open）。兜底：返回极小正数哨兵
// QUOTA_BAD + 响亮日志，所有既有 `>0 &&` 判断无需改动即近似 fail-closed；哨兵是有限正数 → toFixed 不崩、
// 前端 `if(!limit)` 判真 → 显示 ~$0.00 而绝不回退成"不限"。代价：触底前首个请求可能漏过。
const QUOTA_BAD = 1e-9
const parseLimit = (raw) => {
  if (raw === undefined || raw === null || raw === "") return 0
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return n
  console.warn(`[quota] 额度配置非法 ${JSON.stringify(raw)} → fail-closed（按已超限处理），请修正容器 env`)
  return QUOTA_BAD
}
const DAILY_COST_LIMIT = parseLimit(process.env.DAILY_COST_LIMIT)
const QUOTA_FILE = path.join(os.homedir(), ".local", "share", "opencode", "quota.json")
const todayKey = () => new Date().toISOString().slice(0, 10)   // UTC 日期
const loadQuota = () => { try { const q = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8")); if (q && q.day === todayKey()) return q } catch {} return { day: todayKey(), cost: 0 } }
const saveQuota = (q) => { try { fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true }); fs.writeFileSync(QUOTA_FILE, JSON.stringify(q)) } catch {} }
// ---- 权威账本放宿主（防篡改）----
// 容器里跑的是能执行任意命令的 agent（与网关同 uid、同容器），QUOTA_FILE 对它就是一个可写文件——
// "把 quota.json 里今天的数清零"一句话就能绕过每日额度。配了 QUOTA_API_URL（多用户部署由
// render-compose.sh 注入，指向宿主 manager 的记账端点）时：权威账本在宿主文件系统上，本进程
// 只在内存记账 + 异步上报增量；QUOTA_FILE 降级为镜像缓存，仅在「启动后尚未从宿主播种到读数」
// 的窗口期作回退。上报凭据 QUOTA_TOKEN 虽然 agent 同样读得到（env 对它不设防），但宿主端
// 只接受【正增量】——拿它伪造只能给自己多记账，减不了、清不了。
// 未配 QUOTA_API_URL（单机 / 本地 / 老容器）完全保持原来的本地文件行为。
const QUOTA_API = (process.env.QUOTA_API_URL || "").replace(/\/+$/, "")
const QUOTA_TOKEN = process.env.QUOTA_TOKEN || ""
const QUOTA_USER = (process.env.BASE_PATH || "").replace(/^\//, "").split("/")[0]
const REMOTE_QUOTA = !!(QUOTA_API && QUOTA_TOKEN && QUOTA_USER)
const rq = { day: todayKey(), cost: 0, pending: 0, seeded: false, flushing: false }
// 跨日：已入账部分清零；尚未上报出去的增量（pending）是真实花费，顺延计入新的一天
const rqRoll = () => { if (rq.day !== todayKey()) { rq.day = todayKey(); rq.cost = rq.pending } }
const rqFetch = (p, opt) => fetch(QUOTA_API + p, { ...opt, headers: { "x-quota-token": QUOTA_TOKEN, ...(opt?.headers || {}) }, signal: AbortSignal.timeout(5000) })
// 把累计未上报的增量推给宿主账本。失败不丢：pending 保留，10s 定时器兜底重试；
// 唯独 400（宿主明确拒收，如金额不合法）放弃该笔并响亮记日志，否则会无限重试卡死队列。
async function rqFlush() {
  if (rq.flushing || !(rq.pending > 0)) return
  rq.flushing = true
  const amt = rq.pending
  try {
    const r = await rqFetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: QUOTA_USER, add: amt }) })
    if (r.ok) rq.pending = Math.max(0, rq.pending - amt)
    else if (r.status === 400) { rq.pending = Math.max(0, rq.pending - amt); console.warn(`[quota] 宿主拒收上报 $${amt.toFixed(4)}（HTTP 400），该笔放弃：${await r.text().catch(() => "")}`) }
  } catch { /* 宿主暂不可达：pending 留待定时器重试 */ } finally { rq.flushing = false }
}
// 向宿主要权威读数：启动播种 + 周期校准（宿主端管理员手工调账也会被吸收进来）。
// 叠加 pending 是因为宿主读数不含尚未上报的部分；flush 在途的短暂窗口可能小幅高估，方向安全（宁多算不少算）。
async function rqSync() {
  try {
    const r = await rqFetch(`/today?user=${encodeURIComponent(QUOTA_USER)}`)
    if (!r.ok) return
    const j = await r.json()
    rqRoll()
    rq.cost = (j && j.day === todayKey() ? Number(j.cost) || 0 : 0) + rq.pending
    rq.seeded = true
    saveQuota({ day: rq.day, cost: rq.cost })   // 镜像到本地缓存：下次启动若宿主不可达，作回退读数
  } catch { /* 播种定时器会再试；期间 quotaUsed 用本地缓存回退 */ }
}
if (REMOTE_QUOTA) {
  rqSync()
  setInterval(() => { if (!rq.seeded) rqSync() }, 15_000).unref()          // 没播种成功就一直试
  setInterval(() => { rqSync() }, 5 * 60_000).unref()                      // 周期校准
  setInterval(() => { if (rq.pending > 0) rqFlush() }, 10_000).unref()     // 上报兜底重试
}
const addCost = (delta) => {
  if (!(delta > 0)) return
  if (!REMOTE_QUOTA) { const q = loadQuota(); q.cost += delta; saveQuota(q); return }
  rqRoll(); rq.cost += delta; rq.pending += delta
  saveQuota({ day: rq.day, cost: rq.cost })   // 本地镜像仅作回退缓存，权威在宿主
  rqFlush()
}
const quotaUsed = () => {
  if (!REMOTE_QUOTA) return loadQuota().cost
  rqRoll()
  // 播种前用本地镜像回退，取较大者：镜像里可能有上次进程已入账、宿主也已收到的花费——宁多算不少算
  return rq.seeded ? rq.cost : Math.max(rq.cost, loadQuota().cost)
}
// 正在跑的各轮实时成本（sid -> 本轮已花）。轮内成本要到收尾才 addCost 进持久额度，
// 若判断额度时不算上它们，两轮并发会各自以为额度还够、最坏花到上限的约 2 倍；
// 算上后合计一到顶各轮就中止，超支收敛到「一条消息」的粒度。
const runningCost = new Map()
const runningTotal = () => { let t = 0; for (const v of runningCost.values()) t += v; return t }
const quotaUsedLive = () => quotaUsed() + runningTotal()   // 今日已入账 + 各在跑轮的实时成本
const quotaOver = () => DAILY_COST_LIMIT > 0 && quotaUsedLive() >= DAILY_COST_LIMIT

// ---- 轮内实时成本估算（供中途封顶 + abort 结算兜底）----
// 实测（2026-07-20，抓 /global/event 原始流 + one-api 账）：opencode 一条 assistant 消息 = 一个
// LLM step，只在 step 完成时才记 cost/tokens；流式过程中恒 0，被 abort 的消息【永远】是 0——
// 而上游连 abort 后都会把该请求跑完并全额扣费（实测 abort 后 51.6s、2063 completion tokens 照记）。
// 故：完成的消息用真实 cost（session.cost 增量天然包含，含被 abort 轮里已完成的步），
// cost=0 的消息按「流出内容估算的输出 + 上一步实测的输入侧成本」补账。估算取向：宁可高估。
// token 估算按字符类别（DeepSeek 系：中文 ≈0.6 token/字、英文 ≈0.3 token/字符，这里各上浮些）。
const EST_IN_TOKENS = Number(process.env.OC_EST_INPUT_TOKENS || 15000)   // 新会话首步的输入侧估计；实测本部署系统上下文首步 input+cache ≈ 14.9k tokens
const estDeltaTokens = (s) => {
  let t = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    t += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) ? 0.7 : 0.35
  }
  return t
}
// sid -> 该会话最近一个完成 step 的真实输入侧成本（USD）。同会话下一步的输入 ≈ 上一步 + 少量增量，
// 拿它当"被 abort 的那一步"的输入侧估计，比只算流出文本准一个数量级（实测输入占一步成本的 ~95%）。
const sessInCost = new Map()
const estInCost = (sid) => sessInCost.get(sid) ?? (EST_IN_TOKENS * _modelCost().input) / 1e6

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
const STORAGE_LIMIT_MB = parseLimit(process.env.STORAGE_LIMIT_MB)
// 统一的文件下发：createReadStream 的 'error' 【必须】挂监听器。进程里没有 uncaughtException 兜底
// （刻意不加：那会把真正的 bug 掩盖成"还能跑"），一个没人接的 'error' 就是整容器退出、opencode 一起没。
// 触发它不需要攻击，日常就够：TOCTOU（existsSync 通过后文件被 prunePreviewCache / 删会话并发删掉 → ENOENT）、
// 磁盘 IO 错误、以及曾经的 EISDIR。响应头此时多半已发出，只能断流，但至少不该拖垮整个容器。
// 自定义模型 baseURL 的 SSRF 校验。返回 null=放行，否则返回要下发的 JSON 错误串。
// 【必须两个入口都用】：此前护栏只装在 /api/model/test 上，而真正生效的是 POST /api/model ——
// 用户完全可以跳过"测试"直接保存，baseURL 未经任何校验就写进 opencode 配置并重启，
// 此后每轮对话都去打那个地址，上游报错还会经 promptErr 回显进聊天框（截 200 字），
// 等于一个比 test 更好用的内网探测通道，而 test 那边刚特意把响应体和 errno 都隐掉了。
const modelUrlReject = (baseURL) => {
  try {
    const pu = new URL(baseURL)
    if (!/^https?:$/.test(pu.protocol)) return JSON.stringify({ ok: false, err: "只支持 http/https 地址" })
    if (!ALLOW_PRIVATE_MODEL_URL && isPrivateHost(pu.hostname))
      return JSON.stringify({ ok: false, err: "出于安全考虑，不允许指向内网 / 本机 / 云元数据地址；请填公网可访问的 API 地址" })
    return null
  } catch { return JSON.stringify({ ok: false, err: "API URL 格式不正确" }) }
}
const pipeFile = (f, res) => {
  const rs = fs.createReadStream(f)
  rs.on("error", (e) => {
    console.warn(`[download] 读取失败 ${f}: ${e?.code || e?.message || e}`)
    if (!res.headersSent) { try { return send(res, 404, "text/plain", "not found") } catch {} }
    try { res.destroy() } catch {}
  })
  return rs.pipe(res)
}
const dirSize = (dir) => {
  let total = 0
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      // .preview 是服务端自己生成的预览缓存（docx→html、pptx→pdf），用户在界面上既看不见也删不掉，
      // 却按目录递归被算进配额 —— 等于拿用户看不见的缓存去挤他的额度。它是派生数据，不计入。
      if (e.isDirectory()) { if (e.name !== ".preview") walk(p) }
      // 只跳过【网关自己生成】的临时名（"." + 12位hex + ".part"，见 /api/upload 的 tmp）。
      // 原来是无条件跳过一切 .part —— 而落盘名完全由 ?name= 决定，用户传 ?name=x.part 就能让文件
      // 正常落盘、正常出现在列表里，却在存储计量里恒为 0 → STORAGE_LIMIT_MB 形同虚设，卷可被写满。
      else if (!/^\.[0-9a-f]{12}\.part$/.test(e.name)) { try { total += fs.statSync(p).size } catch {} }   // 在传中的临时文件另由 inflightUploadBytes 计
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
// outDir 用【每次唯一】的临时子目录，而不是共享的 cacheDir：
// soffice 的输出名由【源文件基名】决定（a.pptx → a.pdf），直接写进 cacheDir 的话，
// "report.pptx" 与 "audit/report.pptx" 会争同一个 .preview/report.pdf。
// 而串行闸只包住 execFileAsync，改名发生在闸【释放之后】，且 /api/preview 是直接调用、
// 不进 _warmQueue —— 于是存在这样的交错：A 转完退出→闸放行→B 启动并开始写同一个中间文件
// →A 才执行改名，把 B 写了一半的 PDF 认领成自己的缓存（用户看到损坏文件），
// 随后 B 找不到自己的产物 → 报 "no pdf produced"。
// 把中间产物隔离到唯一目录后，这条竞态从根上消失，与闸的释放时机无关。
// 放在 cacheDir 之下（而非 os.tmpdir()）是为了保证与 out 同一文件系统，rename 才是原子的、
// 也不会踩 EXDEV。prunePreviewCache 只统计 isFile()，这个临时目录不会被它当成缓存。
const sofficeJob = (src, cacheDir) => {
  const profile = path.join(os.tmpdir(), "lo-" + crypto.randomBytes(6).toString("hex"))
  const outDir = path.join(cacheDir, ".conv-" + crypto.randomBytes(6).toString("hex"))
  fs.mkdirSync(outDir, { recursive: true })
  return { dir: profile, outDir, args: ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, src, "-env:UserInstallation=file:///" + profile.replace(/\\/g, "/")] }
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
// keep：本次刚生成、马上就要读的那个文件，必须排除在裁剪之外。
// 否则当单个产物本身就大于 PREVIEW_CACHE_MAX（一个大 pptx 转出的 PDF 达到这个量级并不罕见）时，
// 循环会一路删到把刚写好的 out 也删掉，而 ensurePreviewCache 照常 return { out } →
// 紧接着的 createReadStream 拿到 ENOENT。用户点预览，看到的是"刚生成就消失"的诡异失败。
function prunePreviewCache(cacheDir, keep) {
  try {
    const keepReal = keep ? path.resolve(keep) : null
    const items = fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => { const p = path.join(cacheDir, e.name); const st = fs.statSync(p); return { p, size: st.size, mtime: st.mtimeMs } })
      .filter((x) => !keepReal || path.resolve(x.p) !== keepReal)
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
  // 与下载/内联同一条防线：name 现在可含子目录（pdfs/a.docx），必须做包含性校验而非拼接了事。
  const src = safeUnder(dir, name)
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) { const e = new Error("not found"); e.code = "no-src"; throw e }
  const ext = path.extname(name).toLowerCase()
  const cacheDir = path.join(dir, ".preview"); fs.mkdirSync(cacheDir, { recursive: true })
  // 缓存文件名不能直接拼 name："pdfs/a.docx" 会变成 .preview/pdfs/a.docx.html，
  // 而上面只 mkdir 了 .preview 本身 → 写入必然 ENOENT。
  // 也不能简单把分隔符替换成 "__"：那是【不可逆映射】—— 顶层文件 "pdfs__a.docx" 与子目录文件
  // "pdfs/a.docx" 会压成同一个缓存名，而 fresh() 只比 mtime，于是先转好的那个会被判成后一个的
  // "新鲜缓存" → 预览 B 时看到的是 A 的内容，且没有任何提示。改为带路径哈希，保证一一对应。
  // 哈希取【规范化后的相对路径】而非原始 name：否则 "pdfs/a.docx"、"./pdfs/a.docx"、"pdfs//a.docx"
  // 指向同一个文件却生成三份内容相同的缓存，白转三次、占三份空间。
  const relKey = path.relative(path.resolve(dir), src).split(path.sep).join("/")
  const flat = crypto.createHash("sha1").update(relKey).digest("hex").slice(0, 12) + "__" + path.basename(src)
  const srcMtime = fs.statSync(src).mtimeMs
  const fresh = (out) => fs.existsSync(out) && fs.statSync(out).mtimeMs >= srcMtime

  if (ext === ".docx") {
    const out = path.join(cacheDir, flat + ".html")
    if (!fresh(out)) {
      try { await execFileAsync(PYEXE(), ["-X", "utf8", "-c", MAMMOTH_PY, src, out], { timeout: 60_000 }) }
      catch (err) { const e = new Error(String(err).slice(0, 200)); e.code = "docx-fail"; throw e }
    }
    prunePreviewCache(cacheDir, out)
    return { out, ctype: "text/html; charset=utf-8" }
  }
  if ([".pptx", ".ppt", ".odp", ".doc", ".odt"].includes(ext)) {
    const out = path.join(cacheDir, flat.replace(/\.[^.]+$/, "") + ".pdf")
    if (!fresh(out)) {
      if (!soffice()) { const e = new Error("no LibreOffice"); e.code = "no-soffice"; throw e }
      const job = sofficeJob(src, cacheDir)
      // killSignal: SIGKILL —— 默认超时发的是 SIGTERM，而 soffice headless 在解析大 pptx 时
      // 未必立刻响应。串行闸是在 promise settle 那一刻放行下一个的：若第一个只是"超时被 SIGTERM
      // 但还没死"，第二个就会启动，两个 300–600MB 的进程同时存在于 1400m 的容器里 ——
      // 正是这道闸要防的整容器 OOM-kill。SIGKILL 保证 settle 时进程真的没了。
      try { await withSoffice(() => execFileAsync(soffice(), job.args, { timeout: 90_000, killSignal: "SIGKILL" })) }   // 排队，绝不并发起两个 LO
      catch (err) { const e = new Error(String(err).slice(0, 200)); e.code = "office-fail"; throw e }
      finally { try { fs.rmSync(job.dir, { recursive: true, force: true }) } catch {} }   // 成功/失败/超时都要清掉临时 profile
      // soffice 按【源文件基名】决定输出名（a.pptx → a.pdf），而我们的缓存名是带哈希的，
      // 两者必然不同，所以要从这次专属的中间目录里把它搬到 out。
      // 中间目录唯一 → 不同请求各写各的，与串行闸的释放时机无关（见 sofficeJob 的说明）。
      try {
        const produced = path.join(job.outDir, path.basename(src).replace(/\.[^.]+$/, "") + ".pdf")
        if (fs.existsSync(produced)) fs.renameSync(produced, out)
      } finally { try { fs.rmSync(job.outDir, { recursive: true, force: true }) } catch {} }
      if (!fs.existsSync(out)) { const e = new Error("no pdf produced"); e.code = "no-pdf"; throw e }
    }
    prunePreviewCache(cacheDir, out)
    return { out, ctype: "application/pdf" }
  }
  return null   // 该类型不支持文档转换预览（md/pdf/csv/txt/html 等在前端直接渲染，不走这里）
}

// 产物落地后台预热：把本轮新产出的 office/docx 文档提前转好缓存，用户点预览即秒开。
// 串行执行（一次只跑一个 LibreOffice），best-effort，失败静默——点开时 /api/preview 会照常再试并如实报错。
let _warmQueue = Promise.resolve()
const WARM_MAX = 20   // 一轮最多预热多少个：一次产出几百个 doc 时别把 LibreOffice 队列堵死几十分钟
function warmPreviews(dir, names) {
  const CONV = /\.(pptx?|odp|odt|doc|docx)$/i
  let n = 0
  for (const name of (names || [])) {
    if (!CONV.test(name)) continue
    // 不再 basename：changedSince 现在给的是 "audit/report.docx" 这种相对路径，
    // 砍掉目录后会去顶层找 → no-src → 被 .catch 静默吞掉 → 子目录里的文档【永远不预热】
    // （用户点开时才现转，首次要等几十秒）；顶层若有同名文件还会重复预热错的那个。
    if (++n > WARM_MAX) break
    _warmQueue = _warmQueue.then(() => ensurePreviewCache(dir, name).catch(() => {}))
  }
}

// ---- 注入给 agent 的"工作区前言"：写入与剥离必须共用同一个标记 ----
// 【为什么要共用常量】原来这两处各写各的字面量：注入端是 `【本会话工作区，务必遵守】`，
// 而 /api/history 的剥离正则却还在找旧文案 `【本会话专属目录`（我改注入端时漏改了剥离端）。
// 后果：实时流式输出正常（不走剥离），但用户【重开或切回会话】时，整段内部指令会被当成
// 他自己发的话显示出来，还带着 /app/outputs/ws_xxx 这种容器绝对路径。因为只在"回看"时才犯，
// 一直没被发现。改成从同一个常量派生，杜绝再次漂移。
const PREAMBLE_MARK = "【本会话工作区，务必遵守】"
const PREAMBLE_MARK_LEGACY = "【本会话专属目录"   // 老会话里存的是旧文案，回看时同样要剥掉
const _reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const PREAMBLE_RE = new RegExp("^(?:" + _reEsc(PREAMBLE_MARK) + "|" + _reEsc(PREAMBLE_MARK_LEGACY) + ")[\\s\\S]*?\\n\\n")
const stripPreamble = (t) => t.replace(PREAMBLE_RE, "")

const jobs = new Map()   // sid -> 进行中的 job
// 在跑的轮数。三处要用同一个判据：/api/busy（manager 停机/腾位前探它）、以及切模型的两条路径
// （/api/model、/api/model/pick）——它们会 restartOpencode()，把所有在跑的轮连根拔掉。
const runningRounds = () => [...jobs.values()].filter((j) => j.running).length

// ---- /api/password 的失败限流（模块级：状态必须跨请求存活）----
// 这是【已登录】才够得着的接口，攻击面是"cookie 被偷/会话被借用"下的密码盲猜：拿到 cookie 的人
// 本就能读会话，但不知道当前密码就改不走账号——而该接口会如实回答"当前密码不正确"，
// 等于一个不限速的密码预言机。manager 那层的图形验证码/限流/审计管不到这里（请求打的是容器自己的
// 3000 端口，不经 manager）。容器是单用户的，所以全局一个计数器就够，无需按 IP 分桶。
const PW_MAX_FAILS = 5, PW_LOCK_MS = 15 * 60 * 1000
const pwGuard = { fails: 0, lockedUntil: 0 }
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
//
// 但这个判据本身分不出「真残留」和「刚暂存、正等用户敲完编辑重发」——后者同样是有标记且无 job。
// 修前实况：revert 之后、重发之前，任何一次 /api/history 读取都会把回退撤销（典型：双开标签页，
// 另一页切回该会话触发 resumeSession 拉历史），编辑就静默退化成【追加】。所以用内存表登记
// 「待提交回退」：网关是单进程、合法 revert 只出自 /api/revert 一处，登记内存态就够。
// 新鲜期内（TTL 30 分钟，够用户改完一段长文）history 读取不自愈；提交（下一条 prompt 起轮，
// opencode 收到新消息会自己清标记）或再次 /api/revert 都会摘掉登记；过期/网关重启 → 表空 →
// 退回「一律按残留自愈」的旧行为，正好兜住点了编辑又弃走的会话。
const pendingReverts = new Map()   // sid -> 暂存时刻 (ms)
const REVERT_PENDING_TTL = 30 * 60_000
const revertPendingFresh = (sid) => {
  const t = pendingReverts.get(sid)
  return !!t && Date.now() - t < REVERT_PENDING_TTL
}
async function clearStaleRevert(sid) {
  if (!sid || jobs.get(sid)?.running) return   // 正在生成 → 可能是合法的进行中状态，别动
  if (revertPendingFresh(sid)) return          // 新鲜的待提交回退 ≠ 残留，别撤
  pendingReverts.delete(sid)   // 过期条目顺手摘掉，走下面的残留自愈
  try {
    const s = un(await client.session.get({ path: { id: sid } }))
    // await 之后必须【重查】登记表：session.get 让出期间，另一请求的 /api/revert 可能恰好
    // 完成暂存并登记（双开标签页毫秒窗口）。只查入口那一次的话，这里拿着 revert 标记就 unrevert，
    // 把刚暂存的回退撤了——本函数要防的 bug 从窄窗口原样漏回来（复审抓出的 TOCTOU）。
    if (revertPendingFresh(sid)) return
    if (s?.revert) { await client.session.unrevert({ path: { id: sid } }); return true }
  } catch { /* 自愈失败不阻断主流程 */ }
  return false
}
const sseWrite = (res, ev, data) => { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`) } catch {} }
function startJob(sid, sentText, modId) {
  // 新一轮 prompt 就是回退的提交动作（opencode 收到新消息会把 revert 标记清成 null），
  // 待提交登记到此结束；之后再出现的 revert 标记就真是残留了，交还给 clearStaleRevert 自愈。
  pendingReverts.delete(sid)
  // 模块闸的判据：受限模块只允许这一个技能名；null = 非受限模块（chat / 未传 modId 的兼容路径）
  const onlySkill = MODULE_DEFS[modId]?.skill || null
  // 本轮实际生效的技能白名单：受限模块锁单技能（+env-setup 基础设施）；chat 用账号级白名单；null=不限
  const skillGate = onlySkill ? new Set([onlySkill, "env-setup"]) : ALLOWED_SKILLS_SET
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
    // 【必须订阅 /global/event 而非 /event】实测（裸 curl 对照抓包）：本部署把每个会话建在
    // outputs/<ws>/ 子目录，不带 directory 参数的 /event 只收得到 server.* 心跳，一条消息事件都没有
    // ——原先这个循环从未收到过任何 message.*，中途封顶、流式转发全是死代码（前端只在轮末收到 final）。
    // /global/event 才是全量总线；它的每条事件外面包一层 {directory, project, payload}，用时拆开。
    const events = await client.global.event({ signal: evAbort.signal })   // finish() 里 abort，避免订阅泄漏
    const jobT0 = Date.now()   // 开轮时刻（网关与 opencode 同容器同钟）：滤掉上一轮消息的迟到收尾事件
    const PRICE = _modelCost()
    // 本轮各 assistant 消息（= 各 LLM step）的计费状态：real 是 opencode 给的真实 cost（step 完成才有，
    // 已含在 session.cost 里）；estTok 是按流式增量累计的输出 token 估算（real 缺位时的替身）。
    const perMsg = new Map()
    const partMeta = new Map()   // partID -> { type, messageID, text }：text/reasoning 的增量重组，供直播与估算
    job.perMsg = perMsg          // 容器停机时 gracefulExit 的结算要用（见文件末尾）
    const msgEst = (m) => (m.real > 0 ? m.real : m.estTok > 0 ? estInCost(sid) + (m.estTok * PRICE.output) / 1e6 : 0)
    job.estExtra = () => { let x = 0; for (const m of perMsg.values()) if (!(m.real > 0) && m.estTok > 0) x += estInCost(sid) + (m.estTok * PRICE.output) / 1e6; return x }
    // 中途额度封顶：一旦「今日已入账 + 所有在跑轮的实时成本」达上限，立即中止本轮，避免单轮跑到底大幅超支。
    // 实时成本 = 已完成步的真实 cost + 进行中那一步的估算——后者让"单条长文本生成"也能被中途掐断
    // （原实现只看 message.updated 的 info.cost，而它在 step 完成前恒为 0，长生成全程封不住）。
    // 用全局 runningCost（而非本轮开始时的快照）：并发的几轮互相看得见对方已花的钱，合计到顶各轮都会中止。
    let lastCapCheck = 0
    const updateRunning = () => {
      let rc = 0; for (const m of perMsg.values()) rc += msgEst(m)
      runningCost.set(sid, rc)
      // 封顶判断节流 250ms：quotaUsedLive 每次都同步读盘（loadQuota），不能跟着每条 delta 跑；
      // 封顶精度本来就是"一条消息"粒度，250ms 不损失什么。runningCost 的内存更新不节流。
      const now = Date.now()
      if (DAILY_COST_LIMIT > 0 && !job.quotaHit && now - lastCapCheck > 250) {
        lastCapCheck = now
        if (quotaUsedLive() >= DAILY_COST_LIMIT) {
          job.quotaHit = true
          client.session.abort({ path: { id: sid } }).catch(() => {})
        }
      }
    }
    // 直播是"整段替换"语义：逐 delta 全量推送会 O(n²) 字节，节流到 ~4 次/秒；快照/收尾时强推。
    const dirtyParts = new Set()
    let lastEmit = 0
    const emitLive = (force) => {
      const now = Date.now()
      if (!force && now - lastEmit < 250) return
      lastEmit = now
      let textChanged = false
      for (const pid of dirtyParts) {
        const meta = partMeta.get(pid)
        if (!meta) continue
        if (meta.type === "text") textChanged = true
        else if (meta.type === "reasoning") broadcast("reasoning", { id: pid, text: meta.text })
      }
      dirtyParts.clear()
      if (textChanged) broadcast("text", [...partMeta.values()].filter((x) => x.type === "text").map((x) => x.text).join("\n"))
    }
    ;(async () => {
      for await (const w of events.stream) {
        if (job.finished) break
        const e = w?.payload ?? w
        if (e?.type === "message.updated") {
          const info = e.properties?.info
          if (info?.sessionID === sid && info.role === "assistant") {
            // 只收编【本轮】新建的消息：上一轮被 abort 的消息可能在本轮订阅建立后补发收尾事件
            // （cost=0 + 全文快照），照单全收会让它在本轮再被估算补账一次（上一轮结算已补过）。
            // 按创建时间过滤；缺 created 字段则放行（宁可失误于收编，也别把正常消息挡在外面——
            // 挡错了 = 估算/封顶/直播对该消息全体失效，回到修复前的死状态）。
            if (!perMsg.has(info.id) && info.time?.created && info.time.created < jobT0) continue
            const m = perMsg.get(info.id) || { real: 0, estTok: 0 }
            m.real = Math.max(m.real, info.cost || 0)   // 后到的无 cost 事件别把已知真实成本打回 0（那会让封顶退回估算值）
            perMsg.set(info.id, m)
            updateRunning()
          }
          continue
        }
        if (e?.type === "message.part.delta") {   // 流式增量：{sessionID, messageID, partID, field:"text", delta:"块"}
          const d = e.properties
          if (d?.sessionID !== sid || d.field !== "text" || typeof d.delta !== "string") continue
          const meta = partMeta.get(d.partID)
          const m = meta && perMsg.get(meta.messageID)
          if (!m) continue   // 只认本轮 assistant 消息的内容（其 message.updated 先于 parts 到达，实测）
          meta.text += d.delta
          m.estTok += estDeltaTokens(d.delta)
          dirtyParts.add(d.partID)
          emitLive(false)
          updateRunning()
          continue
        }
        const p = e?.properties?.part; if (!p) continue
        if (p.sessionID && p.sessionID !== sid) continue
        if (p.type === "step-finish") {
          // 本步完成，真实 tokens 已知 → 记下输入侧真实成本，作本会话后续步（含被 abort 步）的输入估计
          const t = p.tokens
          if (t && perMsg.has(p.messageID)) {
            if (sessInCost.size > 500) sessInCost.clear()   // 有界：会话数远到不了这，纯防御
            sessInCost.set(sid, ((t.input || 0) * PRICE.input + (t.cache?.read || 0) * PRICE.cache_read + (t.cache?.write || 0) * PRICE.cache_write) / 1e6)
          }
          emitLive(true)
        } else if ((p.type === "text" || p.type === "reasoning") && perMsg.has(p.messageID)) {
          // 快照事件（part 创建时 len=0、part 结束/abort 时全文）。用户消息的回显 part 进不来：
          // 它的 messageID 是 user 消息，不在 perMsg 里 —— 这同时替代了旧的 `p.text !== sentText` 滤重。
          const meta = partMeta.get(p.id) || { type: p.type, messageID: p.messageID, text: "" }
          partMeta.set(p.id, meta)
          if (typeof p.text === "string" && p.text.length > meta.text.length) {
            perMsg.get(p.messageID).estTok += estDeltaTokens(p.text.slice(meta.text.length))   // 快照比累计长 = 漏了 delta，差额补进估算
            meta.text = p.text
            dirtyParts.add(p.id)
          }
          emitLive(true)
          updateRunning()
        } else if (p.type === "tool" && p.state?.status) {
          // ---- 模块/技能闸（强制层，不靠提示词自觉）----
          // 技能调用只放行白名单内的：受限模块 = 绑定的那一个技能；chat = 账号级技能白名单。
          // 受限模块还禁 task 子代理绕道（子代理的技能调用发生在子会话里，本循环按 sessionID 过滤
          // 看不见，所以整个 task 工具都得禁；tools:{task:false} 已在 prompt 参数里禁掉，这里是双保险。
          // chat 不禁 task——禁了会破坏正常流水线，子会话逃逸是已接受的取舍，见 ALLOWED_SKILLS 注释）。
          // 违规立即 abort 本轮，prompt 返回后统一广播报错（见下方 moduleHit 分支）。
          if (skillGate && !job.moduleHit) {
            const bad = (p.tool === "skill" && p.state.input?.name && !skillGate.has(p.state.input.name)) ? p.state.input.name
              : (onlySkill && p.tool === "task" ? "task(子代理)" : null)
            if (bad) {
              job.moduleHit = bad
              console.warn(`[modules] 会话 ${sid}（模块 ${modId}）调用了越权技能/工具：${bad}，中止本轮`)
              client.session.abort({ path: { id: sid } }).catch(() => {})
            }
          }
          broadcast("tool", {
            callID: p.callID, tool: p.tool, status: p.state.status,
            title: p.state.title || "",
            skill: p.tool === "skill" ? (p.state.input?.name || null) : null,   // 技能名（running/completed 才有）
          })
        }
      }
    })().catch((e) => {
      // 事件流是估算/封顶/直播的共同前提，异常死亡绝不能静默——上次这条链路无声死掉（/event 订阅
      // 收不到任何事件）就是零观测才拖了这么久。主动取消（finish 里 evAbort.abort）不算异常。
      if (!job.finished) console.warn(`[events] 本轮事件流异常中断（sid=${sid}），封顶与直播退化、abort 估算只含已收到的部分：${e?.message || e}`)
    })
    const outDir = await sessionOut(sid)                 // 本会话的绝对产物目录（= agent 的工作目录）
    const before = dirState(outDir)   // 记录本轮开始前本会话产物状态，用于算增量
    let cost0 = 0; try { cost0 = un(await client.session.get({ path: { id: sid } }))?.cost || 0 } catch {}   // 本轮前累计成本，用于算增量
    job.cost0 = cost0   // 挂到 job 上：容器停机时 gracefulExit 要用它把本轮已花的钱结算掉（见文件末尾）
    let result, promptErr = null
    try {
      // 受限模块：从工具层面禁掉 task 子代理（子会话里的技能调用逃逸出上面的模块闸，索性不让开子代理）
      result = un(await client.session.prompt({ path: { id: sid }, body: { model: MODEL, parts: [{ type: "text", text: sentText }], ...(onlySkill ? { tools: { task: false } } : {}) } }))
    } catch (err) { promptErr = err }
    // 无论正常结束 / 被额度中止 / 被用户终止，都把本轮成本记进今日额度——否则中止的轮不计费，用户可无限重试绕过额度。
    // 真实增量（session.cost 只含完成步）+ 估算兜底（cost=0 的消息 = 被 abort 的那一步，opencode 对它记
    // cost=0/tokens=0，而上游实测已全额扣费）。估算前先问 opencode 该消息的权威状态：若它其实正常完成了
    // （只是我们没赶上它的 cost 事件），成本已在真实增量里，绝不能再叠加估算——宁可漏这一条也不重复计费。
    const settleEstimate = async () => {
      let extra = 0
      for (const [mid, m] of perMsg) {
        if (m.real > 0 || !(m.estTok > 0)) continue
        try {
          const info = un(await client.session.message({ path: { id: sid, messageID: mid } }))?.info
          if (info && ((info.cost || 0) > 0 || (!info.error && info.time?.completed))) continue
        } catch { continue }   // 权威状态都查不到时放弃这条估算：宁可少算，不冒双重计费的险
        extra += estInCost(sid) + (m.estTok * PRICE.output) / 1e6
      }
      return extra
    }
    if (!job.settled) {   // 容器停机时 gracefulExit 可能已替本轮结算过（它随后 abort 会让上面的 prompt 立刻返回、走到这里）——别结第二次
      job.settled = true
      try {
        const c1 = un(await client.session.get({ path: { id: sid } }))?.cost || 0
        addCost(c1 - cost0 + (await settleEstimate()))
      } catch {
        // session.get 都失败时真实增量拿不到了，至少把内存里的估算记上（比整轮漏账好；settled 已占坑，不会双记）
        try { addCost(job.estExtra?.() || 0) } catch {}
      }
    }
    if (job.aborting) return finish()                       // 用户显式终止：job.abort 已广播 aborted
    if (job.moduleHit) { broadcast("failed", { message: onlySkill
      ? `模块限制：本会话是「${MODULE_DEFS[modId]?.name || modId}」专用模块，只能使用「${onlySkill}」技能；检测到调用「${job.moduleHit}」，本轮已中止。此类需求请到「自由对话」模块新开会话。`
      : `技能未开通：你的账号未开通「${job.moduleHit}」技能，本轮已中止。如需使用请联系管理员开通。` }); return finish() }
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
      // 与 /api/password 共用同一把锁。此前只给改密加了限流，而这里【完全没有】——
      // 而 pwGuard 的理由是"能打到容器 3000 端口的人可以盲猜密码"，那个前提对本接口同样成立，
      // 且这里猜中直接拿到合法 cookie，比改密更直接。只给改密限流等于锁了后门开着前门。
      // 共用一把锁也让两条路径的失败次数合并计数，攻击者无法靠换接口重置计数。
      if (Date.now() < pwGuard.lockedUntil) {
        const mins = Math.ceil((pwGuard.lockedUntil - Date.now()) / 60000)
        return send(res, 429, "application/json", JSON.stringify({ ok: false, err: `尝试次数过多，请 ${mins} 分钟后再试` }))
      }
      if (user !== LAN_USER || pw !== effectivePassword()) {
        pwGuard.fails++
        if (pwGuard.fails >= PW_MAX_FAILS) { pwGuard.lockedUntil = Date.now() + PW_LOCK_MS; pwGuard.fails = 0 }
        await new Promise((r) => setTimeout(r, 600))
        return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "账号或密码错误" }))
      }
      pwGuard.fails = 0
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=${makeAuthCookie()}; Path=${BASE_PATH}/; HttpOnly; Secure; SameSite=Lax; Max-Age=${AUTH_TTL_MS / 1000}` })
      return res.end(JSON.stringify({ ok: true }))
    }
    // 退出登录：签名 cookie 无服务端状态，清掉浏览器 cookie 即可（本人登出足够）
    if (req.method === "POST" && u.pathname === "/api/logout") {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=; Path=${BASE_PATH}/; HttpOnly; Secure; Max-Age=0` })
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
      const running = runningRounds()
      return send(res, 200, "application/json", JSON.stringify({ busy: running > 0, running }))
    }

    // 自助改密码（须已登录 —— 必须留在门禁【之后】）：校验当前密码 → 写 override → 用新密码重签 cookie。
    // 放门禁前等于开了个密码预言机：未登录者能凭「当前密码不正确 / 新密码至少 6 位」两种回包无限盲猜密码，
    // 且绕开 manager 的图形验证码、限流与审计日志。
    if (req.method === "POST" && u.pathname === "/api/password") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let cur = "", nw = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); cur = String(b.current || ""); nw = String(b.new || "") } catch {}
      if (Date.now() < pwGuard.lockedUntil) {
        const mins = Math.ceil((pwGuard.lockedUntil - Date.now()) / 60000)
        return send(res, 429, "application/json", JSON.stringify({ ok: false, err: `尝试次数过多，请 ${mins} 分钟后再试` }))
      }
      if (cur !== effectivePassword()) {
        pwGuard.fails++
        if (pwGuard.fails >= PW_MAX_FAILS) { pwGuard.lockedUntil = Date.now() + PW_LOCK_MS; pwGuard.fails = 0 }
        await new Promise((r) => setTimeout(r, 600))   // 恒定延时：既压猜测速率，也不因"错得快/慢"泄露信息
        return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "当前密码不正确" }))
      }
      pwGuard.fails = 0   // 猜对即清零，避免正常用户偶尔手滑被累计到锁定
      if (nw.length < 6) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "新密码至少 6 位" }))
      try { fs.mkdirSync(path.dirname(PW_OVERRIDE), { recursive: true }); fs.writeFileSync(PW_OVERRIDE, JSON.stringify({ base: sha(LAN_PASSWORD), password: nw })) }
      catch { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: "保存失败" })) }
      // 签名密钥就是「当前有效密码」，改密后旧 cookie 立即失效 → 必须当场用新密码重签一张下发，
      // 否则改密成功的用户下一次请求就被自己踢回登录页。override 已落盘，effectivePassword() 此刻返回新密码。
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=${makeAuthCookie()}; Path=${BASE_PATH}/; HttpOnly; Secure; SameSite=Lax; Max-Age=${AUTH_TTL_MS / 1000}` })
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
      // storageUsed() 是【同步递归遍历】uploads+outputs 两棵树。chunked 上传（无 Content-Length，
      // fetch 带 ReadableStream body 就是这种）原本每收一个 chunk 就调一次 wouldExceed →
      // 传 100MB 约 1500+ 次全盘遍历，一个有几千产物的卷单次就是几十毫秒 → 事件循环被反复钉死，
      // 同容器的 SSE 直播卡顿、/api/busy 探测超时（manager 会据此误判该容器空闲而回收它）。
      // 故给一个 1 秒 TTL 的缓存：判超限只需要"够不够准"，不需要每字节都精确。
      let _suCache = 0, _suAt = 0
      const storageUsedCached = () => { const t = Date.now(); if (t - _suAt > 1000) { _suCache = storageUsed(); _suAt = t } return _suCache }
      const wouldExceed = (extra) => lim > 0 && storageUsedCached() + inflightUploadBytes + extra > lim
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
      // renameSync 必须包起来：它抛了（dest 已存在同名【目录】→ EISDIR/EPERM、EACCES、跨设备等）
      // 而 release() 在其后 → 本次预占的字节永久留在 inflightUploadBytes 里。累积几次后 wouldExceed()
      // 恒真，该容器【此后所有上传】都回"存储空间不足"，而 /api/storage 显示的用量却完全正常
      // （它读 storageUsed()，不含 inflight）→ 用户和运维都无从判断，只有重启进程能清。
      try { fs.renameSync(tmp, dest) }
      catch (e) {
        release(); try { fs.unlinkSync(tmp) } catch {}
        return send(res, 500, "application/json", JSON.stringify({ ok: false, err: `保存失败：${String(e?.message || e).slice(0, 200)}` }))
      }
      release()
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
        .map((s) => { const mod = sessionModule(s.id); return { id: s.id, title: s.title || "(未命名)", updated: s.time?.updated || 0, running: !!jobs.get(s.id)?.running, module: mod, moduleName: MODULE_DEFS[mod]?.name || mod } })
      return send(res, 200, "application/json", JSON.stringify(list))
    }

    // 某会话的历史消息（user/assistant 正文），用于断点续问时回显上下文
    if (req.method === "GET" && u.pathname === "/api/history") {
      // 兼容 sid：本接口用 id=，而 /api/outputs、/api/job、/api/download 全用 sid= ——
      // 这种不一致本身就是踩坑源，两个都收下，别让调用方因为传错参数名而拿到"空会话"。
      const id = u.searchParams.get("id") || u.searchParams.get("sid") || ""
      // 错误体【不能】是 []：那是一个能被 r.json() 正常解析的合法空结果，调用方不看状态码就会
      // 把"读取失败"渲染成"这个会话是空的"，用户以为对话丢了。回一个明显不是结果的对象。
      if (!id) return send(res, 400, "application/json", JSON.stringify({ err: "缺少会话 id" }))
      await clearStaleRevert(id)   // 打开会话即自愈：清掉上次编辑遗留的半回退标记，让历史与后续编辑基于完整消息列表
      const msgs = un(await client.session.messages({ path: { id } })) || []
      const out = []
      for (const m of msgs) {
        const role = m.info?.role
        if (role !== "user" && role !== "assistant") continue
        let text = (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim()
        text = stripPreamble(text)   // 剥掉注入的工作区前言，只回显真正对话
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
      // 【顺序要紧】必须在 session.delete 之【前】把目录解析出来：sessionOut/sessionUp 在 dirCache 未命中时
      // 要回头问 opencode 要 session.directory，而会话一旦删掉，session.get 必然 404 → 静默回落到
      // outputs/<sid>，而真实目录是 outputs/ws_xxx → rmSync 对着一个不存在的路径 force 空转，
      // 返回 ok:true 但一个字节都没删。容器按需停起是本架构常态，网关重启后 dirCache 就是空的，
      // 即"删会话释放空间"这唯一的回收手段在最常见的情形下完全失效，最终把用户卡在存储上限上。
      const delOut = await sessionOut(id), delUp = await sessionUp(id)
      try { await client.session.delete({ path: { id } }) } catch (e) { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e) })) }
      try { fs.rmSync(delUp, { recursive: true, force: true }); fs.rmSync(delOut, { recursive: true, force: true }); dirCache.delete(safeSid(id)) } catch {}   // 删会话即释放其 uploads/outputs 占用的空间
      pendingReverts.delete(id)   // 已删会话的待提交登记没人再消费，别驻留到进程重启
      unbindSessionModule(id)     // 模块绑定同样随会话删除，别在持久表里越积越多
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
      pendingReverts.delete(sid)   // 重新发起编辑 → 上一次未提交的暂存作废，让下面的自愈把它撤干净再重算
      await clearStaleRevert(sid)   // 先清掉上一次没提交的残留回退，确保 uindex→messageID 对着完整消息列表算，而非回退视图
      const msgs = un(await client.session.messages({ path: { id: sid } })) || []
      const target = msgs.filter((m) => m.info?.role === "user")[uindex]   // 按顺序取第 uindex 个用户消息
      if (!target?.info?.id) return send(res, 404, "application/json", JSON.stringify({ ok: false, err: "message not found" }))
      // 【先登记后 revert】：若反过来（revert 落地后才登记），并发 history 的 clearStaleRevert
      // 在它自己的 session.get 返回后重查登记表时可能还查不到（revert 已在 opencode 落地、
      // 这里的 set 还没执行），照样把新回退撤掉。先登记则重查必命中，窗口闭合；revert 失败再摘掉。
      pendingReverts.set(sid, Date.now())
      try { await client.session.revert({ path: { id: sid }, body: { messageID: target.info.id } }) }
      catch (e) { pendingReverts.delete(sid); return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e) })) }
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    if (req.method === "GET" && u.pathname === "/api/download") {
      const sid = u.searchParams.get("sid") || ""
      const name = u.searchParams.get("name") || ""   // 可含一层子目录（如 pdfs/a.pdf），由 safeUnder 做包含性校验
      const up = u.searchParams.get("dir") === "up"   // dir=up 时取上传目录，否则取产出目录
      const root = sid ? (up ? await sessionUp(sid) : await sessionOut(sid)) : (up ? UPLOADS : OUTPUTS)   // 无 sid 回退共享目录（兼容）
      const f = safeUnder(root, name)
      // isFile 不能省：只判 existsSync 时，?name=.preview（服务端自己在每个产物目录里建的预览缓存目录，
      // 必然存在）会让 createReadStream 异步抛 EISDIR，而进程没有 uncaughtException 兜底 → 整个容器崩、
      // opencode 一起没。任意已登录用户一个 URL 即可打崩。/api/raw 本来就有这个判断，这里漏了。
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "text/plain", "not found")
      // 下载文件名只取最后一段：带上 "pdfs/" 前缀的话，浏览器保存时会把斜杠当非法字符或造出怪名字
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": contentDisposition(path.basename(name)) })
      return pipeFile(f, res)
    }

    // 内联查看（供聊天框里 <img> 预览 / 在新标签打开），带正确 MIME、不强制下载
    if (req.method === "GET" && u.pathname === "/api/raw") {
      const sid = u.searchParams.get("sid") || ""
      const name = u.searchParams.get("name") || ""   // 可含一层子目录，交给 safeUnder 校验
      const up = u.searchParams.get("dir") === "up"
      const root = sid ? (up ? await sessionUp(sid) : await sessionOut(sid)) : (up ? UPLOADS : OUTPUTS)
      const f = safeUnder(root, name)
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "text/plain", "not found")
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
      return pipeFile(f, res)
    }

    // 文档预览转换：docx→HTML、pptx/ppt/odp/doc/odt→PDF；缓存到 <产物目录>/.preview/（与后台预热共用 ensurePreviewCache）
    if (req.method === "GET" && u.pathname === "/api/preview") {
      const sid = u.searchParams.get("sid") || ""
      // 不能再 basename：侧栏现在会给出 "audit/report.docx" 这种名字，砍掉目录后
      //  ① 子目录文档预览一律 404；
      //  ② 更糟——顶层若也有同名的 report.docx，就会【静默预览另一份文件】，而预览面板标题
      //     显示的仍是 audit/report.docx，用户完全看不出被掉包了。
      // 包含性校验交给 ensurePreviewCache 内部的 safeUnder（此前因为这里先 basename 过，
      // 那道 safeUnder 一直是空转的死代码）。
      const name = u.searchParams.get("name") || ""
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
      return pipeFile(r.out, res)
    }

    // 健康检查：网关活着不等于能用——opencode 起不来时网关照样监听端口、
    // 前端也照常渲染，用户要等发出第一条消息才发现整站是坏的（manager 只探端口，也会误判为健康）。
    // 暴露真实依赖状态，供 manager/monitor 与前端横幅使用。
    if (req.method === "GET" && u.pathname === "/api/health") {
      const ocOk = await ocHealthy()
      // 只回布尔，不带模型名——这是个公开端点（见 PUBLIC_PATHS 的说明），没必要对外透露用的哪个模型
      return send(res, ocOk ? 200 : 503, "application/json", JSON.stringify({ gateway: true, opencode: ocOk }))
    }
    // 功能模块清单：全部模块 + 本账号是否开通（前端据此渲染模块选择卡；未开通的置灰）
    if (req.method === "GET" && u.pathname === "/api/modules") {
      // 模块可用 = 模块本身获授权 且 其绑定技能未被技能白名单收权（chat 无绑定技能，只看模块授权）
      const list = Object.entries(MODULE_DEFS).map(([id, m]) => ({ id, name: m.name, desc: m.desc, skill: m.skill, allowed: ALLOWED_MODULES.includes(id) && (!m.skill || skillAllowed(m.skill)) }))
      return send(res, 200, "application/json", JSON.stringify({ modules: list }))
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
      let q = "", sid = null, reqMod = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); q = String(b.q ?? ""); sid = b.sid ? String(b.sid) : null; reqMod = String(b.module || "") } catch {}
      if (!q.trim()) return send(res, 400, "application/json", JSON.stringify({ ok: false, sent: false, err: "消息为空" }))
      // ---- 模块裁定 ----
      // 续会话：绑定在创建时已定死，忽略前端传值（防伪造请求把受限会话"升级"成 chat）。
      // 新会话：用请求的模块（缺省 chat），必须是已知且授权的模块。
      // 授权在这里查而不是只在创建时查：管理员收权后容器会被重建（env 变更即重建），
      // 老会话若绑着已收权的模块，续聊也要挡住。
      let modId = sid ? sessionModule(sid) : (reqMod || "chat")
      if (!MODULE_DEFS[modId]) return send(res, 400, "application/json", JSON.stringify({ ok: false, sent: false, err: `未知模块：${modId}` }))
      if (!ALLOWED_MODULES.includes(modId) || (MODULE_DEFS[modId].skill && !skillAllowed(MODULE_DEFS[modId].skill)))
        return send(res, 403, "application/json", JSON.stringify({ ok: false, sent: false, err: `你的账号未开通「${MODULE_DEFS[modId].name}」模块${sid ? "（本会话绑定于该模块）" : ""}，请联系管理员开通。` }))
      // 新会话要先向 opencode 建会话；它没起来时这里会抛，此前会被外层 catch 变成一个带堆栈的 500，
      // 用户只看到"发送失败"，根本不知道是后台模型服务没起来。这里单独兜住并给人话。
      if (!sid) {
        try { sid = await createSession(q.slice(0, 40)); titledSessions.add(sid); if (modId !== "chat") bindSessionModule(sid, modId) }
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
      const preamble = `${PREAMBLE_MARK}\n- **你的当前工作目录就是本会话的产物目录**（\`${ws.out}\`）。所有产物（图表 PNG/PDF、CSV/Excel、md/docx 等）**直接写到当前目录即可**，用相对文件名如 \`fig1.png\`、\`manuscript.md\`，不要再自己拼 \`outputs/xxx\` 前缀。\n- 临时脚本、中间文件同样写当前目录（要归拢可用 \`./.scratch/\`）。\n- 用户上传的数据文件在 \`${ws.up}/\`（读数据从这里找，用这个绝对路径）。\n- 跑本套件的脚本用 \`\${REPO_ROOT:-/app}\` 前缀定位仓库，例如 \`\${REPO_ROOT:-/app}/.venv/bin/python \${REPO_ROOT:-/app}/.opencode/skills/<技能>/xxx.py\`——因为当前目录不是仓库根，写 \`.venv/...\` 这种相对路径会找不到。\n- 正文里嵌入图片直接用文件名：\`![图注](fig1.png)\`（图和稿件都在当前目录，渲染也从当前目录跑）。\n- **不要把产物写到仓库根或 \`\${REPO_ROOT:-/app}\` 下**：那是所有会话共享的，会互相覆盖，也不会出现在界面的"产出"侧栏。${modId === "chat" ? skillsPreamble() : modulePreamble(modId)}\n\n`
      startJob(sid, preamble + q, modId)   // 同步建 job（jobs.set 在函数首行）→ 返回后前端 attach 必能接上
      return send(res, 200, "application/json", JSON.stringify({ ok: true, sid, sent: true, module: modId }))
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
      // 【必须与 dirState 同样递归一层】这条接口是 resumeSession 回显侧栏的唯一来源。
      // 只改 dirState 而漏了这里的话：本轮 SSE 推的 files 事件能列出 pdfs/a.pdf，
      // 但用户一刷新页面 / 切走再切回，子目录里的产物又全部消失 —— 症状与改动前一模一样，
      // 等于这次改造只在"当前这一轮"有效。（上面的 /api/uploads 不需要改：写入接口只收
      // basename，上传目录里天然不会出现子目录。）
      const list = Object.entries(dirState(dir))
        .map(([rel, mtime]) => { try { return { name: rel, size: fs.statSync(path.join(dir, rel)).size, mtime } } catch { return null } })
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
      { const bad = modelUrlReject(baseURL); if (bad) return send(res, 400, "application/json", bad) }
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
      let baseURL = "", apiKey = "", modelID = "", force = false
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); baseURL = (b.baseURL || "").trim(); apiKey = (b.apiKey || "").trim(); modelID = (b.modelID || "").trim(); force = !!b.force } catch {}
      if (!baseURL || !apiKey || !modelID) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "请填写 API URL、API Key、模型 ID" }))
      // SSRF 护栏：与 /api/model/test 用同一条判据。这条才是真正写配置并生效的路径。
      { const bad = modelUrlReject(baseURL); if (bad) return send(res, 400, "application/json", bad) }
      // 切模型要 restartOpencode()，会把所有在跑的轮连根拔掉：用户跑了半小时的综述，切个模型就没了，
      // 且此前没有任何提示。改为先挡住并如实说明，前端确认后带 force:true 重发才真切。
      { const busy = runningRounds(); if (busy > 0 && !force) return send(res, 409, "application/json", JSON.stringify({ ok: false, busy, needForce: true, err: `有 ${busy} 轮正在生成中，切换模型需重启后台，会中断它们` })) }
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
      let modelID = "", force = false
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); modelID = (b.model || "").trim(); force = !!b.force } catch {}
      if (!modelID) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "缺 model" }))
      // 同 /api/model：这条路径也 restartOpencode()，同样会中断在跑的轮
      { const busy = runningRounds(); if (busy > 0 && !force) return send(res, 409, "application/json", JSON.stringify({ ok: false, busy, needForce: true, err: `有 ${busy} 轮正在生成中，切换模型需重启后台，会中断它们` })) }
      writeOcProvider({ baseURL, apiKey, modelID })
      saveModelCfg({ baseURL, apiKey, modelID })
      MODEL = { providerID: CUSTOM_PROVIDER_ID, modelID }
      let restarted = false; try { restarted = await restartOpencode() } catch {}
      if (!restarted) { try { await client.config.update({ body: { provider: { [CUSTOM_PROVIDER_ID]: customProviderCfg({ baseURL, apiKey, modelID }) } } }) } catch {} }
      return send(res, 200, "application/json", JSON.stringify({ ok: true, restarted, modelID }))
    }
    // 恢复默认模型（清掉自定义 provider）
    if (req.method === "POST" && u.pathname === "/api/model/reset") {
      // 这条同样 restartOpencode()，与 /api/model、/api/model/pick 是同一个危害：
      // 在跑的轮被无声拔掉，且因为走不到 addCost 那步，本轮成本【完全不计费】。前两处加了拦截，这里漏了。
      let rforce = false
      try { const chunks = []; for await (const c of req) chunks.push(c); rforce = !!JSON.parse(Buffer.concat(chunks).toString() || "{}").force } catch {}
      { const busy = runningRounds(); if (busy > 0 && !rforce) return send(res, 409, "application/json", JSON.stringify({ ok: false, busy, needForce: true, err: `有 ${busy} 轮正在生成中，恢复默认模型需重启后台，会中断它们` })) }
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
    // 【不打印明文密码】这行会落进宿主的 docker JSON 日志文件，长期留存在磁盘上，
    // 任何抓容器日志的东西（日志采集、排障时的 docker logs、备份）都会带上它。
    // 多用户部署下每个容器的密码就是该用户的登录凭据，没必要为了启动提示把它写到盘上。
    // 只打掩码：位数信息足够运维确认"密码确实注入了"，又不泄露内容。
    ? `  局域网登录：账号 ${LAN_USER} / 密码 ${LAN_PASSWORD ? "*".repeat(Math.min(LAN_PASSWORD.length, 12)) + `（${LAN_PASSWORD.length} 位，见 users/<用户>.env）` : "(未设置)"}（本机 localhost 免登录；改账号密码用环境变量 LAN_USER/LAN_PASSWORD，关登录用 LAN_AUTH=0）`
    : `  登录已关闭（LAN_AUTH=0）`)
})

// ---- 优雅退出 ----
// entrypoint.sh 是 `exec node server.mjs`，所以 node 就是容器的 PID 1。PID 1 在没有注册处理器时，
// 内核【不】执行信号的默认动作 —— SIGTERM 被直接忽略，于是 `docker stop` 每次都白等满 10 秒宽限期
// 再 SIGKILL（实测退出码 137 就是这么来的）。manager 按需停容器/腾位很频繁，每次都多花 10 秒。
// 注册处理器后：立刻停止接受新连接 → 让在跑的轮自己收尾（有上限，不无限等）→ 主动收掉 opencode 子进程。
let shuttingDown = false
// console.log 在 stdout 是管道时（docker logs 正是管道）是【异步】写，紧跟 process.exit() 会把
// 没冲刷完的行直接丢掉——那样这条路径将完全不可观测。退出路径的日志改用同步写。
const exitLog = (s) => { try { fs.writeSync(1, s + "\n") } catch {} }
async function gracefulExit(sig) {
  if (shuttingDown) return
  shuttingDown = true
  exitLog(`[exit] 收到 ${sig}，开始优雅退出（在跑的轮：${runningRounds()}）`)
  try { server.close() } catch {}   // 停止接受新连接；已建立的连接自然收尾
  // 【顺序要紧：先结算、再 abort】
  // 上一版这里写的是 `await job.abort()`，注释说"abort 会走 finish() → addCost"——那条链路
  // 【代码里根本不存在】：finish() 只清状态（job.running=false; jobs.delete），addCost 唯一的
  // 调用点在主 IIFE 里、必须等 session.prompt 返回之后才到得了。于是那版改动的实际效果是：
  // abort → jobs 清空 → runningRounds() 归零 → 下面的排空循环【第一次判断就退出】、6 秒窗口
  // 变成死代码 → process.exit 立刻执行 → 那个还停在 prompt 上的 IIFE 被杀 → 成本永远入不了账。
  // 比不改还差：改之前，能在 6 秒内自然结束的轮次好歹会自己走到 addCost。
  // 现在显式结算：查一次当前累计成本，减去开轮前的 job.cost0，直接 addCost。
  const settleDeadline = Date.now() + 4000
  for (const job of [...jobs.values()]) {
    // 【settled 占坑必须在本 job 的一切 await 之前】与主循环的结算分支（同样是同步 check-and-set）互斥。
    // 否则两个方向都能双记：①主循环结算后、finish() 前（中间隔着 changedSince 的目录遍历）收到 SIGTERM，
    // 这里见 running=true 又结一遍；②这里在 await session.get 时轮子自然跑完，主循环见 settled 未设自己结，
    // 随后这边 await 返回再结。cost0 还没来得及读到的轮（刚起步几毫秒）直接跳过：按 c1-0 结会把
    // 该会话【历史全部成本】当成本轮重记一遍，宁可放过这几毫秒。
    if (!job.running || job.settled || job.cost0 === undefined) continue
    job.settled = true
    try {
      // 给每次查询单独设超时：opencode 若已卡死，这里不能一直等 —— docker 的宽限期只有 10 秒，
      // 拖过去就是 SIGKILL，下面的 killPort 也执行不到，反而留下孤儿 opencode 进程。
      const left = Math.max(500, settleDeadline - Date.now())
      const info = await Promise.race([
        client.session.get({ path: { id: job.sid } }).then(un),
        new Promise((_, rej) => setTimeout(() => rej(new Error("settle timeout")), left)),
      ])
      const c1 = info?.cost || 0
      // 真实增量之外，把"正在流式、还没被真实计费"的那一步按估算补上（job.estExtra 只算 real=0 的消息）。
      // 停机路径没时间逐条问权威状态，竞态窗口里可能极小幅高估——比整步漏账好。
      let est = 0; try { est = job.estExtra?.() || 0 } catch {}
      const delta = c1 - (job.cost0 || 0) + est
      if (delta > 0) { addCost(delta); exitLog(`[exit] 已结算 ${job.sid} 本轮成本 $${delta.toFixed(4)}（含估算 $${est.toFixed(4)}）`) }
    } catch (e) {
      job.settled = false   // 结算失败要还坑：主循环若还活着（比如只是 settle timeout），让它还有机会自己结，别把整轮变漏账
      exitLog(`[exit] 结算 ${job.sid} 失败（本轮可能不计费）：${e?.message || e}`)
    }
    try { await Promise.race([job.abort(), sleep(1500)]) } catch {}   // abort 也别无限等
  }
  // 给收尾留一点时间，但设硬上限——宽限期本身只有 10 秒，超时就没意义了
  const deadline = Date.now() + 3000
  while (runningRounds() > 0 && Date.now() < deadline) await sleep(200)
  if (runningRounds() > 0) exitLog(`[exit] 仍有 ${runningRounds()} 轮未收尾，不再等待`)
  // 宿主账本模式：上面 addCost 只把增量放进 pending（上报是异步的），停机前必须冲刷一次，
  // 否则「manager 空闲回收容器」这条最常见的停机路径每次都会丢掉最后一轮的上报。限时别拖过宽限期。
  if (REMOTE_QUOTA && rq.pending > 0) {
    // 用小循环而非单次调用：结算路径的 addCost 可能已触发一次在途 flush（rqFlush 对并发调用直接返回），
    // 这里要等的是「pending 清零」这个结果，不是某一次调用返回。
    const fDeadline = Date.now() + 2000
    while (rq.pending > 0 && Date.now() < fDeadline) { try { await rqFlush() } catch {}; if (rq.pending > 0) await sleep(150) }
    if (rq.pending > 0) exitLog(`[exit] 仍有 $${rq.pending.toFixed(4)} 未上报到宿主账本（宿主不可达？），该笔将丢失`)
  }
  // opencode 是 detached+unref 的子进程，不主动收会变成孤儿（容器销毁时才被清掉）。
  // 复用 restartOpencode 用的同一把刀：killPort(OC_PORT)（本进程没有留着 child 句柄可用）
  if (OC_MANAGED) { try { killPort(OC_PORT) } catch {} }
  exitLog("[exit] 完成")
  process.exit(0)
}
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { gracefulExit(s) })
