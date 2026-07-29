#!/usr/bin/env node
// sci-auth —— 服务器侧唯一的应用进程。只做三件事：
//
//   ① 认人：管理员分发账号 → 客户端账密登录 → 换一把有有效期的 access key
//   ② 放行：/llm/* 转发到上游模型，按档位限额、按响应 usage 计量入账
//   ③ 管人：/admin 运营后台（用户、档位、用量、审计）
//
//   Internet ─HTTPS─> Caddy ──> 127.0.0.1:8090（本进程）──> one-api / 上游模型
//
// 与它的前身 deploy/manager.mjs 的区别：不再有每用户容器、不再碰 docker、不再存用户产出。
// 用户的会话/文件/产物全在桌面客户端本机（见 docs/改造方案-服务器只做鉴权与网关-2026-07-28.md）。
//
// 依赖：只有 Node 内置模块。要求 Node ≥ 22（node:sqlite）。

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

import * as DB from "./lib/db.mjs"
import * as A from "./lib/auth.mjs"
import * as OneAPI from "./lib/oneapi.mjs"
import * as Upstream from "./lib/upstream.mjs"
import { llmForward, GATEWAY_PATH_PREFIX } from "./lib/gateway.mjs"
import { ADMIN_HTML } from "./lib/admin-ui.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---- Node 版本闸：node:sqlite 在 22 之前不存在，装错运行时要在启动时就响亮失败 ----
const NODE_MAJOR = Number(process.versions.node.split(".")[0])
if (NODE_MAJOR < 22) {
  console.error(`[fatal] 需要 Node ≥ 22（node:sqlite），当前 ${process.versions.node}。部署脚本会装 Node 24 LTS。`)
  process.exit(1)
}

// ==== 配置 ====================================================================
// 数值配置一律走 envNum：非法值【启动即失败】，不许悄悄变成 NaN。
//
// 由来（2026-07-28 首次真机部署踩到）：systemd 的 EnvironmentFile **不剥行尾注释**，
// `REFRESH_TTL_MS=2592000000  # 30 天` 会把整串（含 # 与中文）当成值 → Number() = NaN
// → Date.now()+NaN = NaN → 写库时才炸成 "NOT NULL constraint failed"，报错离病因十万八千里。
// 单价配错更阴：不会报错，只会让计费系统性地偏，而且偏得很安静。
export function envNum(name, def, { min = 0, allowZero = true } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return def
  const n = Number(String(raw).trim())
  if (!Number.isFinite(n) || n < min || (!allowZero && n === 0)) {
    console.error(`[fatal] 配置 ${name}=${JSON.stringify(raw)} 不是合法数值` +
      `（要求：有限数字、≥${min}${allowZero ? "" : " 且非 0"}）。` +
      `\n        常见原因：systemd 的 EnvironmentFile 不剥行尾注释，别写成 "${name}=123  # 说明"，` +
      `\n        注释请单独占一行。`)
    process.exit(1)
  }
  return n
}

export const CFG = {
  listen: process.env.LISTEN || "127.0.0.1:8090",
  dataDir: process.env.DATA_DIR || "/var/lib/sci-auth",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  accessTtlMs: envNum("ACCESS_TTL_MS", 24 * 60 * 60 * 1000, { min: 1000 }),             // 24h
  refreshTtlMs: envNum("REFRESH_TTL_MS", 30 * 24 * 60 * 60 * 1000, { min: 1000 }),      // 30d
  // 上游：默认 DeepSeek 官方；接 one-api 就指到它的 /v1
  upstreamUrl: (process.env.LLM_UPSTREAM_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
  upstreamKey: process.env.LLM_UPSTREAM_KEY || "",
  // 单价（USD / 百万 token），与旧架构 OC_COST_* 同口径
  priceIn: envNum("COST_INPUT", 0.27),
  priceOut: envNum("COST_OUTPUT", 1.10),
  priceCached: envNum("COST_CACHE_READ", 0.07),
  skillsDir: process.env.SKILLS_DIR || path.join(__dirname, "..", ".opencode", "skills"),
  // one-api 的【管理】API（后台看/切上游通道用）。注意这跟 LLM_UPSTREAM_KEY 是两回事：
  // 后者是调模型的令牌，这里是管理台令牌（one-api 的"系统访问令牌"）。两个都没配也不影响
  // 转发，只是后台的「上游通道」页会显示未接入。
  oneapiUrl: (process.env.ONEAPI_URL || "").replace(/\/+$/, ""),
  oneapiToken: process.env.ONEAPI_TOKEN || "",
}
export const oneapiCfg = () => ({ url: CFG.oneapiUrl, token: CFG.oneapiToken })

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ==== 库 ======================================================================
const DB_FILE = process.env.DB_FILE || path.join(CFG.dataDir, "sci.db")
export const db = DB.openDb(DB_FILE)

// access key 的签名密钥：优先 env；否则从库里读；再没有就生成并持久化。
// 必须持久：每次重启换密钥 = 全体客户端 key 立刻失效、全员被迫重新登录。
function keySecret() {
  if (process.env.KEY_SECRET) return process.env.KEY_SECRET
  const row = db.prepare("SELECT v FROM meta WHERE k='key_secret'").get()
  if (row) return row.v
  const s = crypto.randomBytes(32).toString("base64url")
  db.prepare("INSERT INTO meta(k,v) VALUES('key_secret',?)").run(s)
  log("[auth] 已生成并持久化 access key 签名密钥（首次启动）")
  return s
}
const KEY_SECRET = keySecret()

// ==== HTTP 小工具 =============================================================
const json = (res, code, obj) => {
  if (!res.headersSent) res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(obj))
}
/** 结构化错误：客户端据 code 给友好提示，而不是把裸文本甩给用户（改造方案 §3.2）。 */
const fail = (res, code, errCode, message, extra = {}) =>
  json(res, code, { ok: false, error: { code: errCode, message, ...extra } })

const readBody = async (req, limit = 1 << 20) => {
  const chunks = []; let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) { const e = new Error("body too large"); e.tooLarge = true; throw e }
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") } catch { return {} }
}
const parseCookies = (req) => Object.fromEntries(
  (req.headers.cookie || "").split(";").map((c) => {
    const i = c.indexOf("="); return i < 0 ? ["", ""] : [c.slice(0, i).trim(), c.slice(i + 1).trim()]
  }).filter((x) => x[0]))

// 取真实客户端 IP。X-Forwarded-For 客户端可伪造：只有对端是本机回环（= 确实是本机 Caddy
// 转进来的）才采信，且取 Caddy 追加的【最后一段】，伪造的前缀一律忽略。
const isLoopback = (a) => !a || a === "::1" || a === "::ffff:127.0.0.1" || String(a).startsWith("127.")
const clientIp = (req) => {
  const peer = req.socket.remoteAddress || "-"
  if (!isLoopback(peer)) return peer
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean)
  return xff.length ? xff[xff.length - 1] : peer
}

const audit = (ev, fields = {}) => {
  try { DB.addAudit(db, { event: ev, ...fields }) } catch (e) { log("[audit] 写失败", e.message) }
}

// 技能清单以仓库技能目录为唯一事实来源（新增技能不用重启）
const SKILL_LABELS = {
  "clinical-stats": "临床统计", "data-analysis": "数据分析", "data-integrity": "数据自查",
  "deep-research": "深度研究", "deidentify": "数据脱敏", "fulltext-retrieval": "全文获取",
  "grant-proposal": "标书撰写", "humanize-academic": "去AI味", "literature-review": "文献综述",
  "nature-figure": "出版级图表", "novelty-check": "新颖性核查", "ocr": "OCR识字",
  "peer-review": "同行评审", "ppt-master": "PPT制作", "reference-check": "查引用",
  "render-docx": "Word排版", "render-pdf-doc": "PDF排版", "research-scan": "领域扫描",
  "search-lit": "文献检索", "systematic-review": "系统综述", "topic-selection": "选题",
  "write-paper": "论文撰写", "zotero-library": "Zotero文库",
}
export function skillTable() {
  try {
    return fs.readdirSync(CFG.skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "env-setup" && fs.existsSync(path.join(CFG.skillsDir, e.name, "SKILL.md")))
      .map((e) => ({ id: e.name, label: SKILL_LABELS[e.name] || e.name }))
  } catch { return [] }
}

// ==== 签发 key ================================================================
function issueTokens(user, { withRefresh = true } = {}) {
  const ent = DB.resolveEntitlement(db, user)
  const scope = user.must_change_pw ? "pwchange" : "full"
  const access = A.signAccessKey(KEY_SECRET, {
    u: user.username, uid: user.id, ep: user.key_epoch, sc: scope,
    tier: ent.tier, model: ent.model, skills: ent.skills,
  }, CFG.accessTtlMs)
  // 【票据里【不】放允许模型清单】清单会随管理员加模型而变，放进票据就意味着"加了新模型
  // 得等用户重新登录才看得到"。清单走 /api/me 现取现下发（网关放行时也是现查库），
  // 于是后台加完模型，客户端刷新一次档案就有——打包版不用重装。
  const out = {
    access,
    expiresAt: Date.now() + CFG.accessTtlMs,
    scope,
    mustChangePassword: !!user.must_change_pw,
    profile: profileOf(user, ent),
  }
  if (withRefresh) {
    const rt = A.randToken(32)
    const exp = Date.now() + CFG.refreshTtlMs
    DB.saveRefresh(db, user.id, A.sha256(rt), user.key_epoch, exp)
    out.refresh = rt
    out.refreshExpiresAt = exp
  }
  return out
}

function profileOf(user, ent = DB.resolveEntitlement(db, user)) {
  return {
    username: user.username,
    displayName: user.display_name,
    hospital: user.hospital,
    position: user.position,
    tier: ent.tier,
    model: ent.model,                      // 默认模型
    models: DB.modelInfo(db, ent.models),  // 可选模型（含中文名/供应商/单价），客户端下拉就用它
    skills: ent.skills,                    // [] = 不限（全部技能）
    limits: { daily: ent.daily, monthly: ent.monthly },
    usage: { today: DB.todayCost(db, user.id), month: DB.monthCost(db, user.id) },
  }
}

/**
 * 校验 access key 并取回用户。这里做的是「会变的那部分」：用户还在不在、停没停用、
 * epoch 还对不对。epoch 一对不上就说明管理员改过档/停过用 → 立刻失效（不等下次登录）。
 */
export function authClient(req, { requireFullScope = true } = {}) {
  // \s* 而不是 \s+：HTTP 头值会被去掉尾部空白，光一个 "Bearer" 也该算「没带票据」而不是「票据非法」
  const tok = String(req.headers["authorization"] || "").replace(/^Bearer\s*/i, "").trim()
  if (!tok) return { ok: false, status: 401, code: "KEY_MISSING", message: "缺少 access key" }
  const v = A.verifyAccessKey(KEY_SECRET, tok)
  if (!v.ok) {
    return v.code === "KEY_EXPIRED"
      ? { ok: false, status: 401, code: "KEY_EXPIRED", message: "登录已过期，请重新登录" }
      : { ok: false, status: 401, code: "KEY_INVALID", message: "无效的凭证" }
  }
  const user = DB.getUserById(db, v.payload.uid)
  if (!user) return { ok: false, status: 401, code: "KEY_REVOKED", message: "账号不存在，请联系管理员" }
  // 【停用要先于 epoch 判】停用本身会 bumpEpoch，若先判 epoch 就永远只报"信息已变更、请重新登录"，
  // 用户照做又被登录接口以"已停用"挡回来 —— 白跑一趟。先判状态才能一次给出真正的原因。
  if (user.status !== "active")
    return { ok: false, status: 403, code: "ACCOUNT_SUSPENDED", message: "账号已停用，请联系管理员" }
  if (user.key_epoch !== v.payload.ep)
    return { ok: false, status: 401, code: "KEY_REVOKED", message: "账号信息已变更，请重新登录" }
  if (requireFullScope && v.payload.sc !== "full")
    return { ok: false, status: 403, code: "PASSWORD_CHANGE_REQUIRED", message: "首次登录需先修改口令" }
  return { ok: true, user, payload: v.payload }
}

/** 客户端每次带 X-Client-Version 上来就顺手记一下（需求 §3.5 版本可追溯）。 */
function noteClient(user, req) {
  const v = String(req.headers["x-client-version"] || "").slice(0, 40)
  const patch = { last_seen_at: Date.now() }
  if (v && v !== user.client_version) patch.client_version = v
  try { DB.updateUser(db, user.id, patch) } catch {}
}

// ==== 客户端 API ==============================================================
async function handleClientApi(req, res, pathname) {
  const ip = clientIp(req)

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const b = await readBody(req)
    const username = String(b.username || "").trim()
    const password = String(b.password || "")
    if (!username || !password) return fail(res, 400, "BAD_REQUEST", "请填写账号与口令")

    const lockKey = `${ip}|${username}`
    const left = A.loginLocked(lockKey)
    if (left > 0) {
      audit("login.locked", { actor: username, ip, detail: `剩余 ${Math.ceil(left / 1000)}s` })
      return fail(res, 429, "RATE_LIMITED", `尝试过于频繁，请 ${Math.ceil(left / 60000)} 分钟后再试`)
    }
    const user = DB.getUserByName(db, username)
    // 用户不存在与口令错误返回同一个错误码/文案：不给爆破者"这个账号存在"的信号
    if (!user || !A.verifyPassword(password, user.pass_hash, user.pass_salt)) {
      A.noteLoginFail(lockKey)
      audit("login.fail", { actor: username, ip })
      return fail(res, 401, "BAD_CREDENTIALS", "账号或口令不正确")
    }
    if (user.status !== "active") {
      audit("login.suspended", { actor: username, ip })
      return fail(res, 403, "ACCOUNT_SUSPENDED", "账号已停用，请联系管理员")
    }
    A.clearLoginFail(lockKey)
    DB.updateUser(db, user.id, { last_login_at: Date.now() })
    noteClient(user, req)
    audit("login.ok", { actor: username, ip })
    return json(res, 200, { ok: true, ...issueTokens(DB.getUserById(db, user.id)) })
  }

  if (req.method === "POST" && pathname === "/api/auth/refresh") {
    const b = await readBody(req)
    const rt = String(b.refresh || "")
    if (!rt) return fail(res, 400, "BAD_REQUEST", "缺少 refresh token")
    const row = DB.findRefresh(db, A.sha256(rt))
    if (!row || row.revoked || row.exp < Date.now())
      return fail(res, 401, "REFRESH_INVALID", "登录已失效，请重新登录")
    const user = DB.getUserById(db, row.user_id)
    if (!user) return fail(res, 401, "REFRESH_INVALID", "账号不存在，请联系管理员")
    if (user.status !== "active") return fail(res, 403, "ACCOUNT_SUSPENDED", "账号已停用，请联系管理员")
    // epoch 变了说明管理员动过这个号 —— 旧 refresh 一并作废（bumpEpoch 已置 revoked，这里是双保险）
    if (row.epoch !== user.key_epoch) return fail(res, 401, "REFRESH_INVALID", "账号信息已变更，请重新登录")
    DB.revokeRefresh(db, A.sha256(rt))   // 轮换：一把 refresh 只用一次
    noteClient(user, req)
    return json(res, 200, { ok: true, ...issueTokens(user) })
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const b = await readBody(req)
    if (b.refresh) DB.revokeRefresh(db, A.sha256(String(b.refresh)))
    return json(res, 200, { ok: true })
  }

  if (req.method === "POST" && pathname === "/api/auth/password") {
    // 首次强制改密也走这里，所以允许 pwchange scope 的票据进来
    const au = authClient(req, { requireFullScope: false })
    if (!au.ok) return fail(res, au.status, au.code, au.message)
    const b = await readBody(req)
    const oldPw = String(b.oldPassword || ""), newPw = String(b.newPassword || "")
    if (!A.verifyPassword(oldPw, au.user.pass_hash, au.user.pass_salt))
      return fail(res, 401, "BAD_CREDENTIALS", "原口令不正确")
    const bad = A.checkPasswordStrength(newPw)
    if (bad) return fail(res, 400, "WEAK_PASSWORD", bad)
    if (newPw === oldPw) return fail(res, 400, "WEAK_PASSWORD", "新口令不能与原口令相同")
    const { hash, salt } = A.hashPassword(newPw)
    DB.updateUser(db, au.user.id, { pass_hash: hash, pass_salt: salt, must_change_pw: 0 })
    // 改密后把旧票据全废掉，重新签一套：与旧架构「改密码 → 旧 cookie 立即失效」口径一致
    DB.bumpEpoch(db, au.user.id)
    audit("password.change", { actor: au.user.username, ip })
    return json(res, 200, { ok: true, ...issueTokens(DB.getUserById(db, au.user.id)) })
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const au = authClient(req)
    if (!au.ok) return fail(res, au.status, au.code, au.message)
    noteClient(au.user, req)
    return json(res, 200, { ok: true, profile: profileOf(au.user) })
  }

  return fail(res, 404, "NOT_FOUND", "没有这个接口")
}

// ==== 管理台 API ==============================================================
const adminAuthed = (req) => A.validSession(CFG.adminPassword, "admin", parseCookies(req).admin_auth)
const ADMIN_ENABLED = () => !!CFG.adminPassword

/**
 * 会话 cookie 要不要带 Secure。
 *
 * 生产（浏览器 → Caddy TLS → 本进程）永远带：Caddy 会给出 X-Forwarded-Proto: https。
 * 唯一不带的情形是【直连回环的明文 HTTP】—— 即运维在服务器上 curl 127.0.0.1:8090 调试、
 * 或走 SSH 端口转发。浏览器对 localhost 本来就豁免 Secure，但 curl / python cookiejar
 * 之类的客户端不豁免：带了 Secure 它们就不回传 cookie，表现是"登录返回 200 却始终未登录"，
 * 排查起来毫无线索。按同一条 localhost 例外处理，既不降低生产安全，也不留这个坑。
 */
function secureFlag(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
  if (proto === "https") return " Secure;"
  return isLoopback(req.socket.remoteAddress) ? "" : " Secure;"
}

// ---- 测试旁路：只跳过【图形验证码】一步，口令校验/限流/审计一样不少 ----
// 沿用 manager.mjs 时代的设计边界（改动前先读）：
//   · 不设 TEST_BYPASS_TOKEN = 判断恒 false，旁路不存在，线上默认关（部署脚本不写这个变量）；
//   · 只免验证码，不免口令 —— 令牌泄露也进不去；
//   · 恒时比对，杜绝逐字节试探；命中写审计，滥用可追溯。
// 为什么需要：无人值守的回归测试识别不了图形验证码，反复答错会撞 fail2ban 把整个出口 IP 连坐封禁。
const TEST_BYPASS_TOKEN = process.env.TEST_BYPASS_TOKEN || ""
function captchaBypassed(req) {
  if (!TEST_BYPASS_TOKEN) return false
  const got = String(req.headers["x-test-bypass"] || "")
  return got.length === TEST_BYPASS_TOKEN.length && A.safeEq(got, TEST_BYPASS_TOKEN)
}

function userRow(u) {
  const ent = DB.resolveEntitlement(db, u)
  return {
    id: u.id, username: u.username, displayName: u.display_name, surname: u.surname,
    hospital: u.hospital, position: u.position, phone: u.phone,
    tier: u.tier, status: u.status, mustChangePw: !!u.must_change_pw,
    clientVersion: u.client_version, note: u.note,
    createdAt: u.created_at, lastLoginAt: u.last_login_at, lastSeenAt: u.last_seen_at,
    limits: { daily: ent.daily, monthly: ent.monthly },
    overrides: { daily: u.daily_override, monthly: u.monthly_override, skills: u.skills_override },
    skills: ent.skills,
    usage: { today: DB.todayCost(db, u.id), month: DB.monthCost(db, u.id) },
  }
}

async function handleAdminApi(req, res, pathname) {
  const ip = clientIp(req)
  if (!ADMIN_ENABLED()) return json(res, 404, { ok: false, err: "管理台未启用（未设 ADMIN_PASSWORD）" })

  if (req.method === "POST" && pathname === "/admin/api/login") {
    const b = await readBody(req)
    const lockKey = `admin|${ip}`
    const left = A.loginLocked(lockKey)
    if (left > 0) return json(res, 429, { ok: false, err: `尝试过于频繁，请 ${Math.ceil(left / 60000)} 分钟后再试` })
    const bypass = captchaBypassed(req)
    if (bypass) audit("admin.login.test_bypass", { actor: "admin", ip })
    if (!bypass && !A.verifyCaptcha(b.captchaId, b.captcha)) {
      A.noteLoginFail(lockKey)
      audit("admin.login.captcha_fail", { actor: "admin", ip })
      return json(res, 401, { ok: false, err: "验证码不正确" })
    }
    if (!A.safeEq(String(b.password || ""), CFG.adminPassword)) {
      A.noteLoginFail(lockKey)
      audit("admin.login.fail", { actor: "admin", ip })
      return json(res, 401, { ok: false, err: "口令不正确" })
    }
    A.clearLoginFail(lockKey)
    audit("admin.login.ok", { actor: "admin", ip })
    res.setHeader("set-cookie", `admin_auth=${A.signSession(CFG.adminPassword, "admin")}; Path=/; HttpOnly; SameSite=Lax;${secureFlag(req)} Max-Age=${Math.floor(A.AUTH_TTL_MS / 1000)}`)
    return json(res, 200, { ok: true })
  }

  if (req.method === "POST" && pathname === "/admin/api/logout") {
    res.setHeader("set-cookie", `admin_auth=; Path=/; HttpOnly; SameSite=Lax;${secureFlag(req)} Max-Age=0`)
    return json(res, 200, { ok: true })
  }

  if (!adminAuthed(req)) return json(res, 401, { ok: false, err: "未登录" })

  // ---- 总览：用户列表（支持按姓名单/双字过滤，优先姓）+ 档位 + 看板 ----
  if (req.method === "GET" && pathname === "/admin/api/overview") {
    const url = new URL(req.url, "http://x")
    const q = url.searchParams.get("q") || ""
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200))
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0)
    const rows = DB.searchUsers(db, q, { limit, offset })
    const dayAgo = Date.now() - 24 * 3600 * 1000
    return json(res, 200, {
      ok: true,
      users: rows.map(userRow),
      total: DB.countUsers(db),
      matched: rows.length,
      tiers: DB.listTiers(db),
      skills: skillTable(),
      // 档位对话框要用它填「默认模型 / 允许模型」两个选择器，省一次往返
      catalog: DB.modelInfo(db, [...DB.catalogModels(db)]),
      board: {
        activeUsers: db.prepare("SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?").get(dayAgo).n,
        series: DB.usageTotalSeries(db, 30),
      },
    })
  }

  if (req.method === "POST" && pathname === "/admin/api/user-add") {
    const b = await readBody(req)
    const username = String(b.username || "").trim()
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(username))
      return json(res, 400, { ok: false, err: "登录名须小写字母开头，2-32 位（小写字母/数字/下划线/连字符）" })
    if (DB.getUserByName(db, username)) return json(res, 400, { ok: false, err: "登录名已存在" })
    const displayName = String(b.displayName || "").trim()
    if (!displayName) return json(res, 400, { ok: false, err: "请填写姓名（后台按姓名检索）" })
    if (b.tier && !DB.getTier(db, String(b.tier))) return json(res, 400, { ok: false, err: "档位不存在" })
    const pw = A.genInitialPassword()
    const { hash, salt } = A.hashPassword(pw)
    const u = DB.createUser(db, {
      username, display_name: displayName, surname: b.surname,
      hospital: b.hospital, position: b.position, phone: b.phone,
      pass_hash: hash, pass_salt: salt, tier: b.tier || "free", note: b.note,
    })
    audit("user.add", { actor: "admin", target: username, ip, detail: `tier=${u.tier}` })
    // 初始口令【只在这一次响应里返回】，库里只存哈希；管理员负责转交（需求 REQ-U-003）
    return json(res, 200, { ok: true, user: userRow(u), initialPassword: pw })
  }

  if (req.method === "POST" && pathname === "/admin/api/user-update") {
    const b = await readBody(req)
    const u = DB.getUserById(db, b.id)
    if (!u) return json(res, 404, { ok: false, err: "用户不存在" })
    const patch = {}
    for (const f of ["display_name", "surname", "hospital", "position", "phone", "note"]) {
      const camel = f.replace(/_(\w)/g, (_, c) => c.toUpperCase())
      if (b[camel] !== undefined) patch[f] = String(b[camel])
    }
    // 姓名改了但没显式给姓 → 重新切一次，别留着旧姓影响检索排序
    if (patch.display_name !== undefined && b.surname === undefined) patch.surname = DB.guessSurname(patch.display_name)
    if (b.tier !== undefined) {
      if (!DB.getTier(db, String(b.tier))) return json(res, 400, { ok: false, err: "档位不存在" })
      patch.tier = String(b.tier)
    }
    for (const [k, col] of [["dailyOverride", "daily_override"], ["monthlyOverride", "monthly_override"]]) {
      if (b[k] === undefined) continue
      patch[col] = b[k] === null || b[k] === "" ? null : Number(b[k])
      if (patch[col] !== null && !(Number.isFinite(patch[col]) && patch[col] >= 0))
        return json(res, 400, { ok: false, err: "额度覆盖须是 ≥0 的数字（0=不限，留空=随档位）" })
    }
    if (b.skillsOverride !== undefined)
      patch.skills_override = b.skillsOverride === null ? null : String(b.skillsOverride)
    DB.updateUser(db, u.id, patch)
    // 档位/额度/技能变了 → 立刻吊销已签发的 key，下一次请求就按新权限走（改造方案 §3.2）
    const sensitive = ["tier", "daily_override", "monthly_override", "skills_override"].some((k) => k in patch)
    if (sensitive) DB.bumpEpoch(db, u.id)
    audit("user.update", { actor: "admin", target: u.username, ip, detail: JSON.stringify(patch).slice(0, 300) })
    return json(res, 200, { ok: true, user: userRow(DB.getUserById(db, u.id)), keyRevoked: sensitive })
  }

  if (req.method === "POST" && pathname === "/admin/api/suspend") {
    const b = await readBody(req)
    const u = DB.getUserById(db, b.id)
    if (!u) return json(res, 404, { ok: false, err: "用户不存在" })
    const on = !!b.suspended
    DB.updateUser(db, u.id, { status: on ? "suspended" : "active" })
    DB.bumpEpoch(db, u.id)   // 停用要立刻生效，不能等 key 自然过期
    audit(on ? "user.suspend" : "user.resume", { actor: "admin", target: u.username, ip })
    return json(res, 200, { ok: true, user: userRow(DB.getUserById(db, u.id)) })
  }

  if (req.method === "POST" && pathname === "/admin/api/reset-password") {
    const b = await readBody(req)
    const u = DB.getUserById(db, b.id)
    if (!u) return json(res, 404, { ok: false, err: "用户不存在" })
    const pw = A.genInitialPassword()
    const { hash, salt } = A.hashPassword(pw)
    DB.updateUser(db, u.id, { pass_hash: hash, pass_salt: salt, must_change_pw: 1 })
    DB.bumpEpoch(db, u.id)
    audit("user.reset_password", { actor: "admin", target: u.username, ip })
    return json(res, 200, { ok: true, initialPassword: pw })
  }

  if (req.method === "POST" && pathname === "/admin/api/reset-key") {
    const b = await readBody(req)
    const u = DB.getUserById(db, b.id)
    if (!u) return json(res, 404, { ok: false, err: "用户不存在" })
    const ep = DB.bumpEpoch(db, u.id)
    audit("user.reset_key", { actor: "admin", target: u.username, ip, detail: `epoch=${ep}` })
    return json(res, 200, { ok: true, epoch: ep })
  }

  if (req.method === "POST" && pathname === "/admin/api/user-del") {
    const b = await readBody(req)
    const u = DB.getUserById(db, b.id)
    if (!u) return json(res, 404, { ok: false, err: "用户不存在" })
    if (String(b.confirm || "") !== u.username)
      return json(res, 400, { ok: false, err: "请输入登录名确认删除" })
    DB.deleteUser(db, u.id)
    audit("user.del", { actor: "admin", target: u.username, ip })
    return json(res, 200, { ok: true })
  }

  if (req.method === "GET" && pathname === "/admin/api/user-usage") {
    const url = new URL(req.url, "http://x")
    const u = DB.getUserById(db, url.searchParams.get("id"))
    if (!u) return json(res, 404, { ok: false, err: "用户不存在" })
    return json(res, 200, {
      ok: true, user: userRow(u),
      detail: DB.usageDetail(db, u.id, 100),
      series: DB.usageDailySeries(db, u.id, 30),
    })
  }

  if (req.method === "POST" && pathname === "/admin/api/tier") {
    const b = await readBody(req)
    const key = String(b.key || "").trim()
    if (!/^[a-z][a-z0-9-]{0,20}$/.test(key))
      return json(res, 400, { ok: false, err: "档位键须小写字母开头（仅小写字母/数字/连字符）" })
    if (b.remove) {
      const r = DB.deleteTier(db, key)
      if (!r.ok) return json(res, 400, { ok: false, err: r.err })
      audit("tier.del", { actor: "admin", target: key, ip })
      return json(res, 200, { ok: true, tiers: DB.listTiers(db) })
    }
    const before = DB.getTier(db, key)
    DB.upsertTier(db, {
      key, daily_usd: b.dailyUSD, monthly_usd: b.monthlyUSD,
      model: b.model, models: b.models, skills: b.skills, note: b.note, sort: b.sort,
    })
    const after = DB.getTier(db, key)
    // 改档位定义影响该档全体用户的额度/默认模型/技能 → 全部吊销 key，下次登录按新权限走。
    //
    // 【唯独"允许模型清单"不吊销】它不在 access key 的载荷里，网关每一单都现查库判放行，
    // 改了立刻生效。为它踢人下线纯属白踢：管理员每加一个可选模型就把该档全体用户
    // 强制登出（bumpEpoch 连 refresh 一起作废 = 要重新输口令），而"加个模型给大家用"
    // 本该是无感的。客户端下次拉档案（重启 / 账号面板点刷新）就能看到新模型。
    const revoking = !before || ["daily_usd", "monthly_usd", "model", "skills"].some((k) => before[k] !== after[k])
    const affected = revoking ? db.prepare("SELECT id FROM users WHERE tier=?").all(key) : []
    for (const r of affected) DB.bumpEpoch(db, r.id)
    audit("tier.set", { actor: "admin", target: key, ip, detail: `affected=${affected.length}${revoking ? "" : " (仅改可选模型，未吊销)"}` })
    return json(res, 200, { ok: true, tiers: DB.listTiers(db), affected: affected.length })
  }

  // ---- 模型供应商与模型目录（本进程自己的表，与 one-api 无关）----
  //
  // 这一组接口就是「管理台能加模型供应商」的落点：加完供应商与模型，往档位的允许清单里一勾，
  // 客户端（含打包版）刷新一次档案就能选到新模型 —— 不用重装、不用改客户端配置。
  if (req.method === "GET" && pathname === "/admin/api/providers") {
    const models = DB.listModels(db)
    const tiers = DB.listTiers(db)
    return json(res, 200, {
      ok: true,
      // api_key 只报"有没有"，绝不回显：后台页面被肩窥/截图不该泄露上游凭证
      providers: DB.listProviders(db).map((p) => ({
        key: p.key, name: p.name, baseUrl: p.base_url, hasKey: !!p.api_key,
        status: p.status, note: p.note, sort: p.sort, createdAt: p.created_at,
        models: models.filter((m) => m.provider === p.key).length,
      })),
      models: models.map((m) => ({
        id: m.id, model: m.model, provider: m.provider, providerName: m.provider_name || m.provider,
        providerStatus: m.provider_status || "missing", upstream: m.upstream, label: m.label,
        priceIn: m.price_in, priceOut: m.price_out, priceCached: m.price_cached,
        status: m.status, sort: m.sort, note: m.note,
        // 哪些档位把它列进了允许清单（含把它当默认模型的）——删之前要能看见影响面
        tiers: tiers.filter((t) => t.model === m.model ||
          String(t.models || "").split(",").map((s) => s.trim()).includes(m.model)).map((t) => t.key),
      })),
      // env 里的兜底上游：目录里查不到的模型名仍走它，后台要让运维看见这条路还在
      legacy: { url: CFG.upstreamUrl, hasKey: !!CFG.upstreamKey, priceIn: CFG.priceIn, priceOut: CFG.priceOut, priceCached: CFG.priceCached },
      tiers: tiers.map((t) => ({ key: t.key, model: t.model, models: t.models })),
    })
  }

  if (req.method === "POST" && pathname === "/admin/api/provider") {
    const b = await readBody(req)
    const key = String(b.key || "").trim()
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(key))
      return json(res, 400, { ok: false, err: "供应商键须小写字母开头，1-32 位（小写字母/数字/下划线/连字符）" })

    if (b.action === "probe" || b.action === "test") {
      // 探测用【表单里刚填的】地址/key；编辑时 key 留空则回退到库里存的那把（后台不回显 key）
      const cur = DB.getProvider(db, key)
      const baseUrl = String(b.baseURL || cur?.base_url || "")
      const apiKey = String(b.apiKey || "") || cur?.api_key || ""
      if (!apiKey) return json(res, 400, { ok: false, err: "请先填 API Key" })
      const r = b.action === "probe"
        ? await Upstream.listUpstreamModels(baseUrl, apiKey)
        : await Upstream.pingModel(baseUrl, apiKey, String(b.model || ""))
      return json(res, 200, r.ok ? { ok: true, ...r } : { ok: false, err: r.err })
    }

    if (b.remove) {
      if (!DB.getProvider(db, key)) return json(res, 404, { ok: false, err: "供应商不存在" })
      const r = DB.deleteProvider(db, key)
      audit("provider.del", { actor: "admin", target: key, ip, detail: `models=${r.removedModels}` })
      return json(res, 200, { ok: true, removedModels: r.removedModels })
    }

    const baseUrl = String(b.baseURL || "").trim()
    if (!/^https?:\/\//i.test(baseUrl)) return json(res, 400, { ok: false, err: "API 地址要以 http:// 或 https:// 开头" })
    const existed = !!DB.getProvider(db, key)
    if (!existed && !String(b.apiKey || "").trim()) return json(res, 400, { ok: false, err: "请填 API Key" })
    DB.upsertProvider(db, {
      key, name: String(b.name || key), base_url: baseUrl, api_key: b.apiKey,
      status: b.status === "disabled" ? "disabled" : "active", note: b.note, sort: b.sort,
    })
    audit(existed ? "provider.update" : "provider.add", { actor: "admin", target: key, ip, detail: baseUrl })
    return json(res, 200, { ok: true })
  }

  if (req.method === "POST" && pathname === "/admin/api/model") {
    const b = await readBody(req)
    if (b.remove) {
      const row = DB.getModelRow(db, b.id)
      if (!row) return json(res, 404, { ok: false, err: "模型不存在" })
      DB.deleteModel(db, b.id)
      audit("model.del", { actor: "admin", target: `${row.model}@${row.provider}`, ip })
      return json(res, 200, { ok: true })
    }
    // 批量：加供应商后从「拉取模型」里勾一批，一次落库
    const items = Array.isArray(b.items) ? b.items : [b]
    const saved = []
    for (const it of items) {
      const model = String(it.model || "").trim()
      const provider = String(it.provider || b.provider || "").trim()
      if (!model) return json(res, 400, { ok: false, err: "请填对外模型名" })
      if (!DB.getProvider(db, provider)) return json(res, 400, { ok: false, err: `供应商 ${provider || "(空)"} 不存在` })
      // 单价缺省用 env 的全局价：多数情况下第一家就是现在这家，填错了也不至于把账算成 0
      const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d }
      saved.push(DB.upsertModel(db, {
        id: it.id, model, provider, upstream: it.upstream, label: it.label,
        price_in: num(it.priceIn, CFG.priceIn), price_out: num(it.priceOut, CFG.priceOut),
        price_cached: num(it.priceCached, CFG.priceCached),
        status: it.status, sort: it.sort, note: it.note,
      }))
    }
    audit("model.set", { actor: "admin", target: saved.map((m) => `${m.model}@${m.provider}`).join(",").slice(0, 200), ip })
    return json(res, 200, { ok: true, saved: saved.length })
  }

  // ---- 上游通道（one-api）：看/切默认与备用 ----
  if (req.method === "GET" && pathname === "/admin/api/channels") {
    if (!OneAPI.enabled(oneapiCfg()))
      return json(res, 200, { ok: true, enabled: false, err: "未接入 one-api 管理台（/etc/sci-auth.env 未配 ONEAPI_URL / ONEAPI_TOKEN）" })
    const r = await OneAPI.listChannels(oneapiCfg())
    if (!r.ok) return json(res, 200, { ok: true, enabled: true, err: r.err, channels: [], byModel: {} })
    // 顺带告诉前端：各档位当前请求的是哪个模型名 —— 通道要能给某档兜底，
    // 前提是它挂了这个模型名，否则它对这个档位根本不构成备用
    return json(res, 200, {
      ok: true, enabled: true, ...r,
      tierModels: DB.listTiers(db).map((t) => ({ key: t.key, model: t.model })),
      priceNote: { input: CFG.priceIn, output: CFG.priceOut, cached: CFG.priceCached },
    })
  }
  if (req.method === "POST" && pathname === "/admin/api/channel") {
    if (!OneAPI.enabled(oneapiCfg())) return json(res, 400, { ok: false, err: "未接入 one-api 管理台" })
    const b = await readBody(req)
    let r
    if (b.action === "default") r = await OneAPI.makeDefault(oneapiCfg(), b.id, String(b.model || ""))
    else if (b.action === "serve") r = await OneAPI.serveModel(oneapiCfg(), { id: b.id, model: b.model, mapTo: b.mapTo, asBackup: b.asBackup !== false })
    else if (b.action === "test") r = await OneAPI.testChannel(oneapiCfg(), b.id)
    else r = await OneAPI.updateChannel(oneapiCfg(), { id: b.id, priority: b.priority, status: b.status, weight: b.weight })
    if (!r.ok) return json(res, 400, { ok: false, err: r.err || "操作失败" })
    audit("channel." + (b.action || "update"), { actor: "admin", target: String(b.id), ip, detail: JSON.stringify(b).slice(0, 200) })
    return json(res, 200, { ok: true, ...r })
  }

  if (req.method === "GET" && pathname === "/admin/api/audit") {
    return json(res, 200, { ok: true, rows: DB.listAudit(db, 300) })
  }

  return json(res, 404, { ok: false, err: "没有这个接口" })
}

// ==== 路由 ====================================================================
export const server = http.createServer(async (req, res) => {
  req.on("error", () => {}); res.on("error", () => {})
  let url
  try { url = new URL(req.url, "http://x") } catch { return json(res, 400, { ok: false }) }
  const p = url.pathname

  try {
    // LLM 转发必须最先路由：body 要原样管道给上游，绝不能先被别处读掉
    if (p.startsWith(GATEWAY_PATH_PREFIX)) return await llmForward({ req, res, pathname: p, ctx })

    if (p === "/healthz") return json(res, 200, { ok: true, service: "sci-auth", users: DB.countUsers(db), node: process.versions.node })

    if (p === "/captcha") {
      const c = A.newCaptcha()
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store", "x-captcha-id": c.id })
      return res.end(A.captchaSvg(c.code))
    }

    if (p === "/admin" || p === "/admin/") {
      if (!ADMIN_ENABLED()) return json(res, 404, { ok: false, err: "管理台未启用" })
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(ADMIN_HTML)
    }
    if (p.startsWith("/admin/api/")) return await handleAdminApi(req, res, p)
    if (p.startsWith("/api/")) return await handleClientApi(req, res, p)

    return json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "没有这个路径" } })
  } catch (e) {
    if (e && e.tooLarge) return fail(res, 413, "BODY_TOO_LARGE", "请求体过大")
    log("[error]", p, e && e.stack || e)
    if (!res.headersSent) return fail(res, 500, "INTERNAL", "服务器内部错误")
    try { res.destroy() } catch {}
  }
})

// 传给网关模块的上下文（避免循环 import）
const ctx = {
  db, CFG, log, audit, clientIp,
  authClient, json, fail,
  resolveEntitlement: (u) => DB.resolveEntitlement(db, u),
  modelRoutes: (m) => DB.modelRoutes(db, m),
  recordUsage: (uid, rec) => DB.recordUsage(db, uid, rec),
  todayCost: (uid) => DB.todayCost(db, uid),
  monthCost: (uid) => DB.monthCost(db, uid),
  noteClient,
}

// ==== 启动 ====================================================================
export function start() {
  const [h, port] = CFG.listen.includes(":") ? CFG.listen.split(":") : ["127.0.0.1", CFG.listen]
  return new Promise((resolve) => {
    server.listen(Number(port), h, () => {
      // 报【实际】绑定的端口而不是配置值：LISTEN=...:0 时配置里是 0，迁移脚本的影子演练
      // 正是靠这一行（或 PORT_FILE）知道该去打哪个口。
      const real = server.address().port
      log(`sci-auth 就绪 http://${h}:${real}　库=${DB_FILE}　管理台=${ADMIN_ENABLED() ? "开" : "关（未设 ADMIN_PASSWORD）"}`)
      if (process.env.PORT_FILE) { try { fs.writeFileSync(process.env.PORT_FILE, String(real)) } catch (e) { log("[warn] 写 PORT_FILE 失败", e.message) } }
      if (!CFG.upstreamKey) log("[warn] 未配 LLM_UPSTREAM_KEY —— /llm 转发会返回 503")
      resolve(server)
    })
  })
}

// 定期清理过期 refresh（一天一次足够）
const sweep = setInterval(() => { try { DB.purgeExpiredRefresh(db) } catch {} }, 24 * 3600 * 1000)
sweep.unref?.()

// 直接执行才起服务；被 import（测试）时只导出
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) start()
