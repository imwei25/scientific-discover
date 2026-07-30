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
import { createQueue, sanitizeLimits, LIMIT_DEFAULTS } from "./lib/queue.mjs"
import { ADMIN_HTML } from "./lib/admin-ui.mjs"
import * as SkillPacks from "./lib/skillpacks.mjs"
import * as SkillSrc from "./lib/skillsrc.mjs"
// 版本比较的实现挪进了 lib/skillpacks.mjs（skillsrc 也要用，从这里 import 会循环）；
// 这里 re-export 保持既有引用（测试拿的是 app.mod.cmpVersion）不变。
import { cmpVersion } from "./lib/skillpacks.mjs"
export { cmpVersion }

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
  // "从仓库发布"的同步源（见 lib/skillsrc.mjs）；不配 = 只有"本地检出"通道
  skillRepoUrl: process.env.SKILL_REPO_URL || "",
  skillRepoRef: process.env.SKILL_REPO_REF || "main",
  // 不随技能包分发的技能（preserved，客户端自留平移）；默认 85MB 的 vendored ppt-master
  packExclude: String(process.env.SKILL_PACK_EXCLUDE ?? "ppt-master"),
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

// ==== 并发闸 ==================================================================
// 【库是权威，env 只给初值】上限要能在后台改并**立刻生效**（上游换套餐、白天人多晚上人少
// 都会要改），改 env 得重启进程，而重启会把所有在飞的长任务连根拔掉。所以启动时：库里有
// 记录就用库里的，没有就拿 env（再没有就用 queue.mjs 的默认值：全站不限，与老部署一致）。
const ENV_LIMITS = {
  maxConcurrent: envNum("LLM_MAX_CONCURRENCY", LIMIT_DEFAULTS.maxConcurrent),
  perUser: envNum("LLM_MAX_CONCURRENCY_PER_USER", LIMIT_DEFAULTS.perUser),
  maxQueue: envNum("LLM_QUEUE_MAX", LIMIT_DEFAULTS.maxQueue),
  maxWaitMs: envNum("LLM_QUEUE_WAIT_MS", LIMIT_DEFAULTS.maxWaitMs),
}
export const queue = createQueue({ limits: sanitizeLimits(DB.getLimits(db, ENV_LIMITS)), log })

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
/** 二进制上传（技能包 zip）。与 readBody 分开：那边是 JSON 语义，这边原样收字节。 */
const readRawBody = async (req, limit = 128 * 1024 * 1024) => {
  const chunks = []; let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) { const e = new Error("body too large"); e.tooLarge = true; throw e }
    chunks.push(c)
  }
  return Buffer.concat(chunks)
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

/** 这个客户端版本是否低于公告里要求的最低版本（认不出版本号就不催）。 */
function needsUpgrade(notice, clientVersion) {
  if (!notice || !notice.minClientVersion) return false
  const c = cmpVersion(clientVersion, notice.minClientVersion)
  return c !== null && c < 0
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
    // 公告随档案一并下发：登录后第一屏就能看到，不用等客户端另外去问一次
    notice: DB.publicNotice(db),
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

/** 客户端每次带 X-Client-Version / X-Skills-Version 上来就顺手记一下（需求 §3.5 版本可追溯）。 */
function noteClient(user, req) {
  const v = String(req.headers["x-client-version"] || "").slice(0, 40)
  const sv = String(req.headers["x-skills-version"] || "").slice(0, 40)
  const patch = { last_seen_at: Date.now() }
  if (v && v !== user.client_version) patch.client_version = v
  if (sv && sv !== user.skills_version) patch.skills_version = sv
  try { DB.updateUser(db, user.id, patch) } catch {}
}

// ==== 技能包（在线分发整套技能，见 lib/skillpacks.mjs 头注）======================
const PACKS_DIR = () => path.join(CFG.dataDir, "skill-packs")
const packFile = (version) => path.join(PACKS_DIR(), `${version}.zip`)   // version 已过 VERSION_RE，拼不出路径逃逸

/** 当前对客户端生效的最新版（active 里版本号最大的；文本排序对版本号不可靠，用 cmpVersion） */
function latestSkillPack() {
  let best = null
  for (const p of DB.listSkillPacks(db)) {
    if (p.status !== "active") continue
    if (!best || cmpVersion(p.version, best.version) > 0) best = p
  }
  return best
}

/** 这次更新与该用户有没有关系：技能白名单与 changedSkills 无交集就不打扰 */
function packRelevant(pack, ent) {
  const changed = String(pack.changed_skills || "").split(",").map((s) => s.trim()).filter(Boolean)
  if (!changed.length || !ent.skills.length) return true
  return changed.some((s) => ent.skills.includes(s))
}

/** 不随包分发的技能（写进 preserved，客户端自留平移） */
const packExcludeSet = () =>
  new Set(CFG.packExclude.split(",").map((s) => s.trim()).filter(Boolean))

/**
 * 落盘 + 入库 + 留存依赖清单。手动上传与"从仓库发布"共用（校验都在 parsePack，这里只管发）。
 * 先落盘再写库：反过来会留下"客户端能看到、却永远下不到"的版本。
 */
function publishParsedPack(buf, parsed, { commitSha = "", ip, via, forced = false }) {
  fs.mkdirSync(PACKS_DIR(), { recursive: true })
  const sha = crypto.createHash("sha256").update(buf).digest("hex")
  const tmp = packFile(parsed.pack.version) + ".tmp"
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, packFile(parsed.pack.version))
  const ins = DB.addSkillPack(db, {
    version: parsed.pack.version, sha256: sha, size: buf.length,
    changelog: parsed.pack.changelog, changed_skills: parsed.pack.changedSkills.join(","),
    skills: parsed.skills.join(","), commit_sha: commitSha,
  })
  if (!ins.ok) { try { fs.unlinkSync(packFile(parsed.pack.version)) } catch {}; return ins }
  // 依赖清单留存："从仓库发布"没有打包机 .venv 可查，lint 靠最近一次整包里嵌的清单
  if (parsed.pack.venvPackages.length) DB.setMeta(db, "venv_packages", parsed.pack.venvPackages)
  audit("skillpack.publish", { actor: "admin", ip, target: parsed.pack.version,
    detail: `via=${via} size=${buf.length} skills=${parsed.skills.length}${commitSha ? ` commit=${commitSha.slice(0, 10)}` : ""}${forced ? " (强制发布，lint 有告警)" : ""}` })
  return { ok: true, sha }
}

// ==== 客户端 API ==============================================================
async function handleClientApi(req, res, pathname) {
  const ip = clientIp(req)

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const b = await readBody(req)
    const username = String(b.username || "").trim()
    const password = String(b.password || "")
    if (!username || !password) return fail(res, 400, "BAD_REQUEST", "请填写账号与口令")
    // 登录名有格式约束（≤32 位），比这长的一定是垃圾。挡在这里的意义是别让它流进
    // 限流表的 key 与审计的 actor —— 那两处都是匿名可写的，见 auth.mjs 的 FAILS_MAX
    // 与 db.mjs 的 addAudit 截断。
    if (username.length > 64) return fail(res, 400, "BAD_REQUEST", "账号或口令不正确")

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

  /**
   * 公告。客户端每几分钟问一次这里，而不是靠刷新整份档案。
   *
   * 【为什么要单独一个口】档案（/api/me）只在登录、access key 续期（TTL 24h、提前 10 分钟续）
   * 或用户手点"刷新"时才会重取 —— 一条"今晚 10 点维护"的公告要等到明天才到用户眼前，
   * 那这功能就白做了。这个口只读一行 meta，可以放心高频轮询。
   *
   * requireFullScope:false —— 还没改初始口令的人也该看到维护通知，他们同样会受影响。
   */
  if (req.method === "GET" && pathname === "/api/notice") {
    const au = authClient(req, { requireFullScope: false })
    if (!au.ok) return fail(res, au.status, au.code, au.message)
    const notice = DB.publicNotice(db)
    const cv = String(req.headers["x-client-version"] || "")
    return json(res, 200, { ok: true, notice, needUpgrade: needsUpgrade(notice, cv), clientVersion: cv })
  }

  /**
   * 排队状态。客户端在"请求已发出、响应头还没回来"的那段时间里问这里，好把
   * 「正在排队，前面还有 N 个」告诉用户，而不是干转圈几分钟。
   *
   * 【为什么不做成"排队时先回一个通知"】/llm 那条是标准 OpenAI 协议，先塞一段自定义内容
   * 就把协议弄脏了（opencode / 各家 SDK 都会当成畸形响应）。分开一个只读内存的小口最干净：
   * 不碰库、不碰上游，可以放心每两秒问一次。
   *
   * requireFullScope:false —— 还没改初始口令的人不会发起模型调用，但让它能通对齐 /api/notice
   * 的口径，少一处"为什么这个口 403 了"的排查。
   */
  if (req.method === "GET" && pathname === "/api/queue") {
    const au = authClient(req, { requireFullScope: false })
    if (!au.ok) return fail(res, au.status, au.code, au.message)
    const q = queue.snapshot(au.user.id)
    // perUser 报【对这个人实际生效的那个】：档位设了就是档位的值。客户端拿它做提示文案，
    // 报全局默认值会让"我这档明明能开 3 路"的用户看到 1，纯属误导。
    const ent = DB.resolveEntitlement(db, au.user)
    if (ent.maxConc > 0) q.perUser = ent.maxConc
    return json(res, 200, { ok: true, queue: q })
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const au = authClient(req)
    if (!au.ok) return fail(res, au.status, au.code, au.message)
    noteClient(au.user, req)
    return json(res, 200, { ok: true, profile: profileOf(au.user) })
  }

  /**
   * 技能包：最新版元数据。客户端低频轮询（本机自己限流），比对本机已装版本后决定要不要
   * 提示 —— 更新【不强制】，提不提示由 relevant 与客户端的"忽略此版"共同决定。
   */
  if (req.method === "GET" && pathname === "/api/skills/latest") {
    const au = authClient(req)
    if (!au.ok) return fail(res, au.status, au.code, au.message)
    noteClient(au.user, req)   // 顺手记 X-Skills-Version：后台要看"谁还停在旧版技能"
    const p = latestSkillPack()
    if (!p) return json(res, 200, { ok: true, latest: null })
    const ent = DB.resolveEntitlement(db, au.user)
    return json(res, 200, {
      ok: true,
      latest: {
        version: p.version, sha256: p.sha256, size: p.size,
        changelog: p.changelog,
        changedSkills: String(p.changed_skills || "").split(",").map((s) => s.trim()).filter(Boolean),
        skills: String(p.skills || "").split(",").map((s) => s.trim()).filter(Boolean),
        publishedAt: p.created_at,
        relevant: packRelevant(p, ent),
      },
    })
  }

  /** 技能包：下载指定版本的 zip（只发 active 的——disabled 即"已撤下"）。 */
  if (req.method === "GET" && pathname === "/api/skills/pack") {
    const au = authClient(req)
    if (!au.ok) return fail(res, au.status, au.code, au.message)
    const url = new URL(req.url, "http://x")
    const version = String(url.searchParams.get("version") || "").trim()
    if (!SkillPacks.VERSION_RE.test(version)) return fail(res, 400, "BAD_REQUEST", "版本号格式不对")
    const p = DB.getSkillPack(db, version)
    if (!p || p.status !== "active") return fail(res, 404, "NOT_FOUND", "没有这个技能包版本（可能已被撤下）")
    let stat
    try { stat = fs.statSync(packFile(version)) } catch {
      log(`[skillpack] 元数据在库里、文件却不在盘上：${packFile(version)} —— 迁移/备份漏了 DATA_DIR/skill-packs？`)
      return fail(res, 500, "INTERNAL", "服务器上的包文件缺失，请联系管理员")
    }
    audit("skillpack.download", { actor: au.user.username, ip, target: version })
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": stat.size,
      "x-pack-sha256": p.sha256,
      "cache-control": "no-store",
    })
    const stream = fs.createReadStream(packFile(version))
    stream.on("error", () => { try { res.destroy() } catch {} })
    return stream.pipe(res)
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

/**
 * 同源校验 —— CSRF 的第二道闸。
 *
 * 会话 cookie 已是 HttpOnly + SameSite=Lax，跨【站】的 POST 本来就带不上它。但"站"是按
 * 可注册域算的：现在挂 duckdns.org（在公共后缀列表里）所以子域之间算跨站，一旦换成自有
 * 域名部署，任意子域下的页面就都算同站，Lax 立刻失效 —— 那时这道闸才是唯一挡着的东西。
 *
 * 【为什么"两个头都没有"要放行】浏览器发写请求必带 Sec-Fetch-Site 或 Origin 之一；
 * 都没有的只可能是 curl / ops 脚本 / 测试，那是运维自己。拒了它们等于把运维路径全砍掉，
 * 却挡不住任何真实攻击（攻击面全在浏览器里）。
 */
function sameOrigin(req) {
  const sfs = String(req.headers["sec-fetch-site"] || "").trim()
  if (sfs) return sfs === "same-origin" || sfs === "none"
  const origin = String(req.headers["origin"] || "").trim()
  if (!origin) return true
  try { return new URL(origin).host === String(req.headers["host"] || "") } catch { return false }
}

/**
 * 用户列表的筛选器。全都在【全集】上算，不是只筛当前这页 —— "谁本月要触顶"正是管理员
 * 打开后台最想先看到的一类问题，只筛当前 200 条会漏掉恰好排在后面的人。
 */
const USER_FILTERS = {
  suspended: (u) => u.status !== "active",
  pwchange: (u) => !!u.mustChangePw,
  overday: (u) => u.limits.daily > 0 && u.usage.today >= u.limits.daily,
  overmonth: (u) => u.limits.monthly > 0 && u.usage.month >= u.limits.monthly,
  nearmonth: (u) => u.limits.monthly > 0 && u.usage.month >= u.limits.monthly * 0.8,
  idle: (u) => !u.lastSeenAt || u.lastSeenAt < Date.now() - 30 * 86400 * 1000,
}

/** 该用户的技能授权形态：follow=跟随档位 / any=覆盖为全部放行 / pick=自己一份白名单 */
export const skillModeOf = (u) =>
  u.overrides.skills == null ? "follow" : (String(u.overrides.skills) ? "pick" : "any")

/**
 * 多条件筛选（Excel 那种"每列一个筛子"）。前端把条件拼成 JSON 放在 ?f= 里：
 *   {tiers:[],status:[],skillMode:[],usage:[],hasSkill:[],hospital:"",idle:false}
 * 【列之间 AND、同列多选 OR】——与 Excel 的筛选直觉一致；空数组/空串 = 这一列不筛。
 * 老的单键 filter=overmonth 继续有效（运维脚本与书签里还在用），两者可以叠加。
 *
 * 【坏 JSON 当没传】管理员手改地址栏、或前端版本不一致时，宁可返回未筛选的全量，
 * 也不要 500 —— 后台列表是排查问题的入口，它不能因为一个参数写错就整页打不开。
 */
export function buildUserPredicate({ filter = "", f = "" } = {}) {
  const preds = []
  if (USER_FILTERS[filter]) preds.push(USER_FILTERS[filter])
  let spec = null
  try { spec = f ? JSON.parse(f) : null } catch { spec = null }
  if (spec && typeof spec === "object") {
    const arr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : [])
    const tiers = arr(spec.tiers)
    if (tiers.length) preds.push((u) => tiers.includes(u.tier))
    const status = arr(spec.status)                     // active | suspended | pwchange
    if (status.length) preds.push((u) => status.some((s) => (s === "pwchange" ? !!u.mustChangePw : u.status === s)))
    const modes = arr(spec.skillMode)                   // follow | any | pick
    if (modes.length) preds.push((u) => modes.includes(skillModeOf(u)))
    const usage = arr(spec.usage)                       // overday | overmonth | nearmonth
    if (usage.length) preds.push((u) => usage.some((k) => USER_FILTERS[k] && USER_FILTERS[k](u)))
    if (spec.idle) preds.push(USER_FILTERS.idle)
    const hos = String(spec.hospital || "").trim()
    if (hos) preds.push((u) => String(u.hospital || "").includes(hos))
    // 「能用这些技能的人」：u.skills 是生效后的白名单，空数组 = 不限（等于全都能用）。
    // 多选时取 AND —— 运维意图通常是"把能写标书【且】能查引用的人挑出来再统一调整"。
    const has = arr(spec.hasSkill)
    if (has.length) preds.push((u) => has.every((s) => !u.skills.length || u.skills.includes(s)))
  }
  return preds.length ? (u) => preds.every((p) => p(u)) : null
}
// 批量操作一次最多改多少人。上限存在的意义是"手滑保护"：全选 800 人再点一下按钮，
// 与其静默改掉全部，不如让它报错、让管理员明确缩小范围。
const MAX_BULK = 500

function userRow(u) {
  const ent = DB.resolveEntitlement(db, u)
  return {
    id: u.id, username: u.username, displayName: u.display_name, surname: u.surname,
    hospital: u.hospital, position: u.position, phone: u.phone,
    tier: u.tier, status: u.status, mustChangePw: !!u.must_change_pw,
    clientVersion: u.client_version, skillsVersion: u.skills_version, note: u.note,
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
  if (req.method === "POST" && !sameOrigin(req)) {
    audit("admin.csrf_block", { actor: "admin", ip, detail: String(req.headers["origin"] || req.headers["sec-fetch-site"] || "").slice(0, 120) })
    return json(res, 403, { ok: false, err: "请求来源不对（跨站请求已拒绝）" })
  }

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
    const filter = String(url.searchParams.get("filter") || "")
    const pred = buildUserPredicate({ filter, f: url.searchParams.get("f") || "" })
    // 【matched 必须是真实命中数】以前直接取 rows.length，被 limit 截断过 ——
    // 账号数超过一页时后台写着"命中 200 / 640"，而管理员正是靠这个数字判断要不要再缩关键词。
    // matchedIds 是给"选中全部命中的人"用的：批量操作要按 id 明确点名（可审计、不受翻页影响），
    // 不做成"按条件批量"——那样一旦条件与管理员以为的不一致，改的就是一批他没看见的人。
    let rows, matched, matchedIds
    if (pred) {
      const all = DB.searchUsers(db, q, { limit: 100000, offset: 0 }).map(userRow).filter(pred)
      matched = all.length
      rows = all.slice(offset, offset + limit)
      matchedIds = all.slice(0, MAX_BULK).map((u) => u.id)
    } else {
      rows = DB.searchUsers(db, q, { limit, offset }).map(userRow)
      matched = DB.countSearchUsers(db, q)
      matchedIds = DB.searchUsers(db, q, { limit: MAX_BULK, offset: 0 }).map((u) => u.id)
    }
    const dayAgo = Date.now() - 24 * 3600 * 1000
    return json(res, 200, {
      ok: true,
      users: rows,
      total: DB.countUsers(db),
      matched, offset, limit, filter,
      matchedIds, maxBulk: MAX_BULK,
      tiers: DB.listTiers(db),
      // 【档位人数要服务端 GROUP BY 出】前端拿"当前这页的用户"去数，一旦有搜索词或翻了页，
      // 每档显示的人数就是错的 —— 管理员据此判断"这个档还有没有人、能不能删"。
      tierCounts: DB.tierCounts(db),
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
    // 【姓留空 = 没提供，不是"清空姓"】后台那个框的 placeholder 明写着"留空则按姓名自动识别"，
    // 而前端总是无条件发 surname:'' —— 照字面存进去就是空姓，此后 searchUsers 的 rank 0/1
    // 对这个人永不命中（输他的姓搜不到他排前面），而管理员完全看不出发生了什么。
    // 与 createUser 的口径对齐：空串一律当作未提供。
    const surnameGiven = b.surname !== undefined && String(b.surname).trim() !== ""
    if (!surnameGiven) delete patch.surname
    if (patch.display_name !== undefined && !surnameGiven) patch.surname = DB.guessSurname(patch.display_name)
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
    // 档位/技能变了 → 立刻吊销已签发的 key，下一次请求就按新权限走（改造方案 §3.2）。
    //
    // 【额度覆盖【不】吊销】额度根本不在票据里：authClient 只用 payload 的 uid/ep/sc，
    // 网关每一单都现查库拿 resolveEntitlement，改完下一次请求就生效。为它 bumpEpoch 纯属
    // 白踢人 —— 给正在跑一小时综述的医生临时加 5 美元，会把他这一轮登录态打断、要求重输
    // 口令，而这次吊销没有任何执行层面的必要（"档位的可选模型清单"早就按同一条理由豁免了）。
    const sensitive = ["tier", "skills_override"].some((k) => k in patch)
    if (sensitive) DB.bumpEpoch(db, u.id)
    audit("user.update", { actor: "admin", target: u.username, ip, detail: JSON.stringify(patch).slice(0, 300) })
    return json(res, 200, { ok: true, user: userRow(DB.getUserById(db, u.id)), keyRevoked: sensitive })
  }

  // ---- 批量调整（勾一批人 → 一次改档位 / 技能授权 / 停用恢复）----
  //
  // 【为什么按 id 点名而不是"按当前筛选条件批量改"】筛选条件在前端，改的人在后端 ——
  // 两边对条件的理解差一点，动的就是一批管理员没看见的账号，而这类操作没有撤销。
  // 明确的 id 列表既能审计（逐人一条 user.update），也不会被翻页/并发新账号影响。
  //
  // 语义与单人编辑严格一致，避免"批量的口径和单改不一样"这种最难查的不一致：
  //   skillsOverride: null=跟随档位 / ""=全部放行（覆盖档位）/ "a,b"=白名单
  //   改档位或技能 → 吊销这些人已签发的 key（下次请求即按新权限走）；只改状态同样吊销。
  if (req.method === "POST" && pathname === "/admin/api/users-bulk") {
    const b = await readBody(req)
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : []
    if (!ids.length) return json(res, 400, { ok: false, err: "没有选中任何账号" })
    if (ids.length > MAX_BULK) return json(res, 400, { ok: false, err: `一次最多批量 ${MAX_BULK} 个账号（当前 ${ids.length} 个），请缩小筛选范围` })
    const patch = {}
    if (b.tier !== undefined) {
      if (!DB.getTier(db, String(b.tier))) return json(res, 400, { ok: false, err: "档位不存在" })
      patch.tier = String(b.tier)
    }
    if (b.skillsOverride !== undefined)
      patch.skills_override = b.skillsOverride === null ? null : String(b.skillsOverride)
    if (b.suspended !== undefined) patch.status = b.suspended ? "suspended" : "active"
    if (!Object.keys(patch).length) return json(res, 400, { ok: false, err: "没有要改的项（档位 / 技能授权 / 状态至少给一项）" })
    // 这三项全都要吊销 key：档位与技能在票据里，状态决定还能不能用 —— 都不能等 key 自然过期
    const changed = [], missing = []
    for (const id of ids) {
      const u = DB.getUserById(db, id)
      if (!u) { missing.push(id); continue }
      DB.updateUser(db, u.id, patch)
      DB.bumpEpoch(db, u.id)
      changed.push(u.username)
      // 逐人留一条：按 target 查某个账号的历史时，批量改的那一次也必须在场
      audit("user.update", { actor: "admin", target: u.username, ip, detail: "bulk " + JSON.stringify(patch).slice(0, 240) })
    }
    audit("user.bulk_update", { actor: "admin", target: `${changed.length} 个账号`, ip,
      detail: JSON.stringify(patch).slice(0, 200) + " | " + changed.slice(0, 40).join(",") + (changed.length > 40 ? " …" : "") })
    return json(res, 200, {
      ok: true, changed: changed.length, usernames: changed, missing,
      keyRevoked: changed.length,   // 与单人编辑同口径：前端据此提示"需重新登录"
    })
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
    // 【额度必须校验】upsertTier 里是 `Number(x) || 0`，负数与「abc」「1,000」这类误输入
    // 会静默变成 0，而 0 在额度闸里的含义是【不限】—— 一次手滑就让整档用户变成无限额度，
    // 且后台看上去一切正常。用户级 override 早就校验了（见上），两条路径口径必须一致。
    for (const [k, label] of [["dailyUSD", "日额度"], ["monthlyUSD", "月额度"]]) {
      if (b[k] === undefined || b[k] === null || b[k] === "") continue
      const n = Number(b[k])
      if (!Number.isFinite(n) || n < 0)
        return json(res, 400, { ok: false, err: `${label}须是 ≥0 的数字（0 = 不限）` })
    }
    // 【默认模型不能空】pickModel 在 ent.model 为空时会回落成"客户端点名的那个"，
    // 于是该档用户可以在请求体里随便写模型名，绕过允许清单、按 env 全局价计费。
    // 后台是唯一能建出这种档位的地方（新增对话框默认就是空），所以闸设在这里。
    if (!String(b.model || "").trim())
      return json(res, 400, { ok: false, err: "请填默认模型——留空会让该档用户可以自选任意模型名，绕过允许清单" })
    if (b.maxConc !== undefined && b.maxConc !== null && b.maxConc !== "") {
      const n = Number(b.maxConc)
      if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n)
        return json(res, 400, { ok: false, err: "单用户并发须是 ≥0 的整数（0 = 跟随全局）" })
    }
    const before = DB.getTier(db, key)
    DB.upsertTier(db, {
      key, daily_usd: b.dailyUSD, monthly_usd: b.monthlyUSD,
      model: b.model, models: b.models, skills: b.skills, note: b.note, sort: b.sort,
      max_conc: b.maxConc,
    })
    const after = DB.getTier(db, key)
    // 改档位定义影响该档全体用户的额度/默认模型/技能 → 全部吊销 key，下次登录按新权限走。
    //
    // 【唯独"允许模型清单"不吊销】它不在 access key 的载荷里，网关每一单都现查库判放行，
    // 改了立刻生效。为它踢人下线纯属白踢：管理员每加一个可选模型就把该档全体用户
    // 强制登出（bumpEpoch 连 refresh 一起作废 = 要重新输口令），而"加个模型给大家用"
    // 本该是无感的。客户端下次拉档案（重启 / 账号面板点刷新）就能看到新模型。
    // 【并发上限同理不吊销】它也不在票据里，网关每一单现查现用，改完下一个请求就按新值排队。
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
      const dropped = Object.entries(r.droppedFromTiers || {}).map(([t, ms]) => `${t}:${ms.join("/")}`).join(" ")
      audit("provider.del", { actor: "admin", target: key, ip, detail: `models=${r.removedModels}${dropped ? " 档位清单已摘 " + dropped : ""}` })
      return json(res, 200, { ok: true, removedModels: r.removedModels, droppedFromTiers: r.droppedFromTiers })
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
      const r = DB.deleteModel(db, b.id)
      const dropped = Object.entries(r.droppedFromTiers || {}).map(([t, ms]) => `${t}:${ms.join("/")}`).join(" ")
      audit("model.del", { actor: "admin", target: `${row.model}@${row.provider}`, ip, detail: dropped ? "档位清单已摘 " + dropped : "" })
      return json(res, 200, { ok: true, droppedFromTiers: r.droppedFromTiers })
    }
    // 批量：加供应商后从「拉取模型」里勾一批，一次落库。
    // 【批量必须是 insertOnly】批量项只带模型名，价格/中文名/上游真实名一律缺省；若走
    // DO UPDATE，再点一次「+ 模型」勾中已接入的那个，就会把管理员手工填好的真实单价洗成
    // env 全局价 —— 账静默偏，正是本架构要治的病根。
    const bulk = b.bulk === true || Array.isArray(b.items)
    const items = Array.isArray(b.items) ? b.items : [b]
    const saved = [], skipped = []
    for (const it of items) {
      const model = String(it.model || "").trim()
      const provider = String(it.provider || b.provider || "").trim()
      if (!model) return json(res, 400, { ok: false, err: "请填对外模型名" })
      if (!DB.getProvider(db, provider)) return json(res, 400, { ok: false, err: `供应商 ${provider || "(空)"} 不存在` })
      // 单价缺省用 env 的全局价：多数情况下第一家就是现在这家，填错了也不至于把账算成 0
      const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d }
      const r = DB.upsertModel(db, {
        id: it.id, model, provider, upstream: it.upstream, label: it.label,
        price_in: num(it.priceIn, CFG.priceIn), price_out: num(it.priceOut, CFG.priceOut),
        price_cached: num(it.priceCached, CFG.priceCached),
        status: it.status, sort: it.sort, note: it.note,
      }, { insertOnly: bulk && !it.id })
      if (r && r.err) return json(res, 400, { ok: false, err: r.err })
      if (r && r.skipped) skipped.push(`${model}@${provider}`)
      else saved.push(r)
    }
    audit("model.set", { actor: "admin", target: saved.map((m) => `${m.model}@${m.provider}`).join(",").slice(0, 200), ip,
      detail: skipped.length ? `已接入过、保持原样：${skipped.join(",").slice(0, 200)}` : "" })
    return json(res, 200, { ok: true, saved: saved.length, skipped: skipped.length, skippedNames: skipped })
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

  // ---- 技能包 ----
  // 管理员上传 make-skill-pack.mjs 出的整套技能 zip → 校验（布局/BOM/依赖 lint）→ 发布。
  // 客户端轮询 /api/skills/latest 看到新版本后提示更新（不强制）；服务端回退 = 把新版置 disabled。
  if (req.method === "GET" && pathname === "/admin/api/skill-packs") {
    const latest = latestSkillPack()
    // 版本分布：判断"催不催大家更新"得先知道现在都停在哪版（'' = 客户端还没汇报过/老客户端）
    const versions = db.prepare(`SELECT skills_version AS v, COUNT(*) AS n FROM users
                                 GROUP BY skills_version ORDER BY n DESC`).all()
    return json(res, 200, {
      ok: true,
      packs: DB.listSkillPacks(db).map((p) => ({
        version: p.version, sha256: p.sha256, size: p.size, changelog: p.changelog,
        changedSkills: String(p.changed_skills || "").split(",").filter(Boolean),
        skills: String(p.skills || "").split(",").filter(Boolean),
        status: p.status, createdAt: p.created_at,
        fileOk: fs.existsSync(packFile(p.version)),
      })),
      current: latest ? latest.version : "",
      versions,
    })
  }

  if (req.method === "POST" && pathname === "/admin/api/skill-pack-upload") {
    const url = new URL(req.url, "http://x")
    const force = url.searchParams.get("force") === "1"
    const buf = await readRawBody(req)
    if (!buf.length) return json(res, 400, { ok: false, err: "请求体是空的——请选择要上传的技能包 zip" })
    const r = SkillPacks.parsePack(buf)
    if (!r.ok) return json(res, 400, { ok: false, err: r.err })
    if (DB.getSkillPack(db, r.pack.version))
      return json(res, 400, { ok: false, err: `版本 ${r.pack.version} 已发布过——同一版本号不许重发，请升版本号重新出包` })
    // 依赖 lint 拦发布：技能 import 了客户端 .venv 里没有的库 → 在线更新发出去客户端必炸。
    // 这是信号不是判决（识别不了动态 import / 冷门别名），管理员核实后可 force。
    if (r.lint.issues.length && !force) {
      return json(res, 400, {
        ok: false, needForce: true, lint: r.lint.issues, warnings: r.warnings,
        err: `依赖检查未通过：${r.lint.issues.length} 处 import 了客户端可能没有的库。` +
          `若确认这些库客户端已有（或属误报），可强制发布；若确实是新依赖，此更新走不了在线分发，需要重新打包客户端。`,
      })
    }
    const pub = publishParsedPack(buf, r, { ip, via: "upload", forced: force })
    if (!pub.ok) return json(res, 400, { ok: false, err: pub.err })
    return json(res, 200, { ok: true, version: r.pack.version, sha256: pub.sha, size: buf.length,
      skills: r.skills, warnings: r.warnings, lint: r.lint.issues, forced: force })
  }

  // ---- 从仓库发布（推荐通道；见 lib/skillsrc.mjs 头注）----
  // check：同步专用检出（或读本地检出）→ 预览"待发布的 commit / 变更技能 / 下个版本号"；
  // publish：带着 check 看到的 sha 来出包发布，源被人推动过就 409 打回重看。
  if (req.method === "GET" && pathname === "/admin/api/skill-src") {
    const cfg = SkillSrc.srcConfig(CFG)
    const latest = latestSkillPack()
    return json(res, 200, {
      ok: true,
      remote: { configured: !!cfg.url, url: SkillSrc.maskUrl(cfg.url), ref: cfg.ref,
        cloneReady: fs.existsSync(path.join(cfg.cloneDir, ".git")) },
      localRoot: cfg.localRoot,
      exclude: [...packExcludeSet()],
      lastPublished: latest ? { version: latest.version, commitSha: latest.commit_sha || "" } : null,
      venvLint: (DB.getMeta(db, "venv_packages", []) || []).length > 0,
    })
  }
  if (req.method === "POST" && pathname === "/admin/api/skill-src") {
    const b = await readBody(req)
    const source = b.source === "local" ? "local" : "remote"
    const latest = latestSkillPack()
    const lastSha = (latest && latest.commit_sha) || ""
    let src
    try { src = await SkillSrc.resolveSource(CFG, source) } catch (e) { return json(res, 400, { ok: false, err: e.message }) }
    const skillsDir = path.join(src.root, ".opencode", "skills")
    let diff = { changedSkills: [], agentsChanged: false, commits: [], known: false }
    if (src.sha) { try { diff = await SkillSrc.diffSince(src.root, lastSha) } catch (e) { log("[skill-src] diff 失败", e.message) } }
    const diffWarnings = []
    if (!src.sha) diffWarnings.push("该检出不是 git 仓库：算不出与上次发布的差异，将提示所有用户")
    else if (lastSha && !diff.known) diffWarnings.push("上次发布的 commit 在此仓查不到（首次从仓库发布或换过仓）：无法算差异，将提示所有用户")
    const version = SkillSrc.nextVersion(latest && latest.version, (v) => !!DB.getSkillPack(db, v))

    if (b.action === "check") {
      let c
      try { c = SkillPacks.collectSkillEntries(skillsDir, { exclude: packExcludeSet() }) }
      catch (e) { return json(res, 400, { ok: false, err: `源树读不了：${e.message}` }) }
      return json(res, 200, {
        ok: true, source, sha: src.sha, shortSha: src.sha.slice(0, 10),
        upToDate: !!(src.sha && lastSha && src.sha === lastSha),
        changedSkills: diff.changedSkills, agentsChanged: diff.agentsChanged, commits: diff.commits,
        nextVersion: version, skills: c.packed.length, preserved: c.preserved,
        sizeBytes: c.totalBytes, warnings: [...c.warnings, ...diffWarnings],
        venvLint: (DB.getMeta(db, "venv_packages", []) || []).length > 0,
      })
    }
    if (b.action !== "publish") return json(res, 400, { ok: false, err: "action 要是 check / publish" })

    if (src.sha && String(b.sha || "") !== src.sha)
      return json(res, 409, { ok: false, staleSha: true,
        err: `源已更新（现在是 ${src.sha.slice(0, 10)}，你预览的是 ${String(b.sha || "").slice(0, 10) || "?"}）——请重新「检查更新」看过差异再发布` })
    // changelog：管理员在预览时可改；默认拿 commit 说明拼一条
    const changelog = String(b.changelog || "").trim().slice(0, 2000) ||
      (diff.commits.length ? diff.commits.map((s) => s.replace(/^\S+\s/, "")).slice(0, 10).join("；").slice(0, 500)
        : `同步自${source === "remote" ? "仓库" : "本地检出"} ${src.sha ? src.sha.slice(0, 10) : "（非 git 检出）"}`)
    let built
    try {
      built = SkillPacks.buildPack({
        skillsDir, rootDir: src.root, version, changelog,
        changedSkills: diff.changedSkills, exclude: packExcludeSet(),
        venvPackages: DB.getMeta(db, "venv_packages", []) || [],
      })
    } catch (e) { return json(res, 500, { ok: false, err: `出包失败：${e.message}` }) }
    const parsed = SkillPacks.parsePack(built.buf)
    if (!parsed.ok) return json(res, 500, { ok: false, err: `出的包没过发布校验（属于 bug，请报告）：${parsed.err}` })
    if (parsed.lint.issues.length && !b.force) {
      return json(res, 400, {
        ok: false, needForce: true, lint: parsed.lint.issues, warnings: [...built.warnings, ...parsed.warnings],
        err: `依赖检查未通过：${parsed.lint.issues.length} 处 import 了客户端可能没有的库。` +
          `若确认这些库客户端已有（或属误报），可强制发布；若确实是新依赖，此更新走不了在线分发，需要重新打包客户端。`,
      })
    }
    const pub = publishParsedPack(built.buf, parsed, { commitSha: src.sha, ip, via: `sync:${source}`, forced: !!b.force })
    if (!pub.ok) return json(res, 400, { ok: false, err: pub.err })
    return json(res, 200, {
      ok: true, version, sha256: pub.sha, size: built.buf.length, commitSha: src.sha,
      skills: parsed.skills, changedSkills: diff.changedSkills,
      warnings: [...built.warnings, ...parsed.warnings], forced: !!b.force,
    })
  }

  if (req.method === "POST" && pathname === "/admin/api/skill-pack") {
    const b = await readBody(req)
    const version = String(b.version || "").trim()
    const p = DB.getSkillPack(db, version)
    if (!p) return json(res, 404, { ok: false, err: "没有这个版本" })
    if (b.action === "delete") {
      DB.deleteSkillPack(db, version)
      try { fs.unlinkSync(packFile(version)) } catch {}
      audit("skillpack.delete", { actor: "admin", ip, target: version })
      return json(res, 200, { ok: true })
    }
    const st = b.action === "enable" ? "active" : b.action === "disable" ? "disabled" : null
    if (!st) return json(res, 400, { ok: false, err: "action 要是 enable / disable / delete 之一" })
    DB.setSkillPackStatus(db, version, st)
    audit("skillpack." + b.action, { actor: "admin", ip, target: version })
    return json(res, 200, { ok: true, current: (latestSkillPack() || {}).version || "" })
  }

  // ---- 公告 ----
  // 站长通知全员此前只能一个个发微信。这里维护的一条公告随 /api/me 与 /api/notice 下发。
  if (req.method === "GET" && pathname === "/admin/api/notice") {
    // 版本分布顺带给出来：要不要卡最低版本，得先知道现在大家都在用什么版本
    const versions = db.prepare(`SELECT client_version AS v, COUNT(*) AS n FROM users
                                 WHERE client_version <> '' GROUP BY client_version ORDER BY n DESC`).all()
    return json(res, 200, { ok: true, notice: DB.getNotice(db), versions, levels: DB.NOTICE_LEVELS })
  }
  if (req.method === "POST" && pathname === "/admin/api/notice") {
    const b = await readBody(req)
    if (b.minClientVersion && !/^\d+(\.\d+)*$/.test(String(b.minClientVersion).trim()))
      return json(res, 400, { ok: false, err: "最低客户端版本要写成点分数字，如 1.2.0（留空 = 不检查）" })
    // 下载地址只允许 http(s)：这串会被客户端渲染成一个链接，别让它变成 javascript: 之类的东西
    if (b.downloadUrl && !/^https?:\/\//i.test(String(b.downloadUrl).trim()))
      return json(res, 400, { ok: false, err: "下载地址要以 http:// 或 https:// 开头（留空 = 不给链接）" })
    if (b.enabled && !String(b.text || "").trim() && !String(b.minClientVersion || "").trim())
      return json(res, 400, { ok: false, err: "公告内容与最低版本至少填一个，否则发出去用户什么也看不到" })
    const n = DB.setNotice(db, b)
    audit("notice.set", { actor: "admin", ip, target: n.enabled ? "on" : "off",
      detail: `id=${n.id} level=${n.level} min=${n.minClientVersion || "-"} ${n.text.slice(0, 120)}` })
    return json(res, 200, { ok: true, notice: n })
  }

  // ---- 并发与排队 ----
  // 上游按并发/RPM 限速，人一多就是一片 429（客户端只表现为"这轮没输出"）。这里配的是
  // 「同时最多放几个请求打上游」，超出的在网关排队等位，客户端会显示"前面还有几个"。
  if (req.method === "GET" && pathname === "/admin/api/limits") {
    const st = queue.stats()
    // 队里在跑的是谁：只回名字，够运营判断"是不是某个人把位子占满了"
    const names = st.byUser.map((r) => {
      const u = DB.getUserById(db, r.userId)
      return { userId: r.userId, running: r.running, username: u?.username || "(已删除)", displayName: u?.display_name || "" }
    })
    return json(res, 200, { ok: true, limits: st.limits, defaults: LIMIT_DEFAULTS, stats: { ...st, byUser: names }, tiers: DB.listTiers(db) })
  }
  if (req.method === "POST" && pathname === "/admin/api/limits") {
    const b = await readBody(req)
    for (const [k, label] of [["maxConcurrent", "全站并发"], ["perUser", "单用户并发"],
      ["maxQueue", "排队上限"], ["maxWaitMs", "最长等待(ms)"]]) {
      if (b[k] === undefined || b[k] === null || b[k] === "") continue
      const n = Number(b[k])
      // 【必须自己校验】sanitizeLimits 对非法值是"忽略、保留原值"，静默得让管理员以为改成功了
      if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n)
        return json(res, 400, { ok: false, err: `${label}须是 ≥0 的整数（0 = 不限）` })
    }
    const next = queue.setLimits(b)
    DB.setLimits(db, next)   // 库是权威：重启后仍按这个值跑
    audit("limits.set", { actor: "admin", ip, detail: JSON.stringify(next) })
    return json(res, 200, { ok: true, limits: next })
  }

  // ---- 对账：按模型 / 供应商 / 用户 / 技能聚合，外加 CSV 导出 ----
  //
  // 为什么必须有：usage_log 一直记着 model 与 provider 两列，却没有任何一处按它们聚合，
  // 要回答"这个月这家该收我多少""哪个模型最烧钱"只能 SSH 进去手写 SQL。而单价配错造成的
  // 计费偏差【不会报错、只会静默偏】，逐项对账是唯一能发现它的手段。
  if (req.method === "GET" && (pathname === "/admin/api/usage-summary" || pathname === "/admin/api/usage-export")) {
    const url = new URL(req.url, "http://x")
    const to = (url.searchParams.get("to") || DB.dayOf()).slice(0, 10)
    const from = (url.searchParams.get("from") || DB.dayOf(Date.now() - 29 * 86400 * 1000)).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return json(res, 400, { ok: false, err: "日期要写成 YYYY-MM-DD" })

    if (pathname === "/admin/api/usage-summary") {
      return json(res, 200, {
        ok: true, from, to,
        byModel: DB.usageByModel(db, from, to),
        byProvider: DB.usageByProvider(db, from, to),
        byUser: DB.usageByUser(db, from, to),
        bySkill: DB.usageBySkill(db, from, to),
        series: DB.usageTotalSeries(db, 90).filter((r) => r.day >= from && r.day <= to),
        // 对账要能核单价：把目录里每个模型每家的现价一并给出
        prices: DB.listModels(db).map((m) => ({ model: m.model, provider: m.provider,
          priceIn: m.price_in, priceOut: m.price_out, priceCached: m.price_cached })),
        legacyPrice: { priceIn: CFG.priceIn, priceOut: CFG.priceOut, priceCached: CFG.priceCached },
      })
    }

    const by = String(url.searchParams.get("by") || "detail")
    const cell = (v) => {
      const s = String(v == null ? "" : v)
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const sheet = (head, rows) => head.join(",") + "\r\n" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"
    let csv, name
    if (by === "model") {
      csv = sheet(["模型", "调用数", "花费USD", "输入tokens", "输出tokens", "缓存tokens"],
        DB.usageByModel(db, from, to).map((r) => [r.model || "(空)", r.calls, r.cost, r.tin, r.tout, r.tcached]))
      name = "usage-by-model"
    } else if (by === "provider") {
      csv = sheet(["供应商", "调用数", "花费USD", "输入tokens", "输出tokens", "缓存tokens"],
        DB.usageByProvider(db, from, to).map((r) => [r.provider || "env兜底上游", r.calls, r.cost, r.tin, r.tout, r.tcached]))
      name = "usage-by-provider"
    } else if (by === "user") {
      csv = sheet(["登录名", "姓名", "档位", "调用数", "花费USD", "输入tokens", "输出tokens", "缓存tokens"],
        DB.usageByUser(db, from, to).map((r) => [r.username || "(已删除)", r.display_name || "", r.tier || "", r.calls, r.cost, r.tin, r.tout, r.tcached]))
      name = "usage-by-user"
    } else {
      csv = sheet(["时间(北京)", "日期(UTC)", "登录名", "姓名", "模型", "供应商", "技能", "输入tokens", "输出tokens", "缓存tokens", "花费USD"],
        DB.usageRange(db, from, to).map((r) => [
          new Date(r.ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
          r.day, r.username || "(已删除)", r.display_name || "", r.model, r.provider || "env", r.skill,
          r.prompt_tokens, r.completion_tokens, r.cached_tokens, r.cost_usd]))
      name = "usage-detail"
    }
    audit("usage.export", { actor: "admin", ip, detail: `${by} ${from}~${to}` })
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}-${from}_${to}.csv"`,
      "cache-control": "no-store",
    })
    // 【必须带 BOM】不带的话 Excel 按本地代码页解，中文列名与姓名全是乱码 —— 而这份表
    // 十有八九就是拿去 Excel 里对账的。
    return res.end("﻿" + csv)
  }

  if (req.method === "GET" && pathname === "/admin/api/audit") {
    const url = new URL(req.url, "http://x")
    const r = DB.listAudit(db, {
      limit: Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 200)),
      offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
      event: url.searchParams.get("event") || "",
      actor: url.searchParams.get("actor") || "",
    })
    return json(res, 200, { ok: true, rows: r.rows, total: r.total, events: DB.auditEvents(db) })
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
  queue,
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
      // 默认模型为空的档位 = 该档用户可以在请求体里随便点模型名（网关会照用），
      // 绕过允许清单、按 env 全局价计费。后台已经拦住了新建这种档位，老库里的要看得见。
      const blank = DB.listTiers(db).filter((t) => !String(t.model || "").trim()).map((t) => t.key)
      if (blank.length) log(`[warn] 这些档位没有默认模型：${blank.join(", ")} —— 该档用户可自选任意模型名并按 env 全局价计费，请到后台补上`)
      resolve(server)
    })
  })
}

// 定期清理过期 refresh 与太老的审计（一天一次足够）。
// 审计表只写不删，login.ok / llm.quota_block 这类高频事件会让它无限涨；半年前的行对运维
// 已无价值，留着只会把库撑大、把审计页拖慢。
const AUDIT_KEEP_DAYS = envNum("AUDIT_KEEP_DAYS", 180, { min: 7 })
const sweep = setInterval(() => {
  try { DB.purgeExpiredRefresh(db) } catch {}
  try { const n = DB.purgeAudit(db, AUDIT_KEEP_DAYS); if (n) log(`[sweep] 清理 ${n} 条超过 ${AUDIT_KEEP_DAYS} 天的审计`) } catch {}
}, 24 * 3600 * 1000)
sweep.unref?.()

// 直接执行才起服务；被 import（测试）时只导出
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) start()
