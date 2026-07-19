// ---- 用户分级 + 每日 token 额度 + 用量计量（多用户网关）----
// 本部署是「每用户一个容器」，容器靠 USER_NAME 认得自己是谁；分级制度集中在一份共享文件里：
//   STATE_DIR/users.json  —— 档位定义(tiers) + 用户→档位映射(users)，所有容器只读它（管理员容器可写）。
//   STATE_DIR/usage/<name>.json —— 各容器写自己的每日用量 { "YYYY-MM-DD": tokens }。
// users.json 每次用到都现读一遍（文件小、访问频率低），改完即时生效——天然满足「热加载、免重启」。
// 额度单位＝当日消耗的 token 合计（input+output+reasoning）；dailyTokens=0 表示不限。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 容器里 STATE_DIR=/app/state（共享卷）；本地开发缺省落 web/.state（已 gitignore）
export const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, ".state")
const USERS_PATH = path.join(STATE_DIR, "users.json")
const USERS_EXAMPLE = path.join(STATE_DIR, "users.example.json")   // 首次启动无 users.json 时，优先按它落种子
const USAGE_DIR = path.join(STATE_DIR, "usage")
// 本容器代表哪个用户；本地开发缺省 "local"。IS_ADMIN=1 的容器才提供 /admin 管理台。
export const USER_NAME = process.env.USER_NAME || "local"
export const IS_ADMIN = process.env.IS_ADMIN === "1"

const KEEP_DAYS = 90          // 用量历史最多留 90 天（导出/审计用），更早的写入时顺手裁掉
// 缺省分级制度（首次运行且 users.json 不存在时落盘为种子，之后以文件为准）
const DEFAULT_USERS = {
  tiers: {
    free: { label: "普通", dailyTokens: 500000 },     // 50 万/天
    plus: { label: "高级", dailyTokens: 2000000 },    // 200 万/天
    admin: { label: "管理员", dailyTokens: 0 },       // 不限
  },
  defaultTier: "free",   // 未在 users 里登记的用户默认档位
  users: {},             // { "alice": { "tier": "plus" }, ... }
}

const ensureDirs = () => { try { fs.mkdirSync(USAGE_DIR, { recursive: true }) } catch {} }
const safe = (s) => String(s || "").replace(/[^a-zA-Z0-9_.-]/g, "_") || "_"

// 现读 users.json；不存在则用缺省种子写一份再返回。缺字段自动补齐，坏文件退回缺省（不抛）。
function loadUsers() {
  ensureDirs()
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(USERS_PATH, "utf8")) } catch {}
  if (!raw || typeof raw !== "object") {
    // 无 users.json：优先按同目录的 users.example.json 落种子（含预设的 alice=管理员等），否则用内置缺省
    try { const ex = JSON.parse(fs.readFileSync(USERS_EXAMPLE, "utf8")); if (ex && ex.tiers) raw = ex } catch {}
    const seed = raw || DEFAULT_USERS
    try { fs.writeFileSync(USERS_PATH, JSON.stringify(seed, null, 2)) } catch {}
    raw = seed
  }
  return {
    tiers: raw.tiers && typeof raw.tiers === "object" ? raw.tiers : { ...DEFAULT_USERS.tiers },
    defaultTier: raw.defaultTier || DEFAULT_USERS.defaultTier,
    users: raw.users && typeof raw.users === "object" ? raw.users : {},
  }
}
function saveUsers(u) { ensureDirs(); fs.writeFileSync(USERS_PATH, JSON.stringify(u, null, 2)) }

// 北京时间(UTC+8)的当日键，用于「每天 0 点重置」——不依赖系统时区库，直接偏移 8 小时取日期部分
export const todayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

const usagePath = (name) => path.join(USAGE_DIR, safe(name) + ".json")
function readUsage(name) {
  try { const o = JSON.parse(fs.readFileSync(usagePath(name), "utf8")); return o && typeof o === "object" ? o : {} } catch { return {} }
}
function writeUsage(name, obj) {
  ensureDirs()
  // 裁掉过老的日期键，避免文件无限增长
  const keys = Object.keys(obj).sort()
  while (keys.length > KEEP_DAYS) delete obj[keys.shift()]
  try { fs.writeFileSync(usagePath(name), JSON.stringify(obj)) } catch {}
}

// 某用户的档位键（登记表里没有 → 缺省档；档位已被删 → 也退回缺省档）
export function tierOf(name, u = loadUsers()) {
  const t = u.users?.[name]?.tier || u.defaultTier
  return u.tiers[t] ? t : u.defaultTier
}
// 某用户当日已用 token
export const usedToday = (name) => readUsage(name)[todayKey()] || 0

// 某用户的额度快照：{ name, tier, label, limit, used, remaining, unlimited }
export function quotaOf(name, u = loadUsers()) {
  const tier = tierOf(name, u)
  const limit = Number(u.tiers[tier]?.dailyTokens || 0)
  const unlimited = !(limit > 0)
  const used = usedToday(name)
  return { name, tier, label: u.tiers[tier]?.label || tier, limit, used, remaining: unlimited ? null : Math.max(0, limit - used), unlimited }
}
// 是否还能发起新的一轮（额度是否用尽）
export function canRun(name) {
  const q = quotaOf(name)
  return { allowed: q.unlimited || q.used < q.limit, ...q }
}
// 记一笔用量（本轮实际消耗的 token）到当日
export function addUsage(name, tokens) {
  if (!(tokens > 0)) return
  const o = readUsage(name)
  const k = todayKey()
  o[k] = (o[k] || 0) + Math.round(tokens)
  writeUsage(name, o)
}

// ---- 管理台用 ----
// 列出所有用户（users.json 里登记的 + 有用量文件但未登记的，取并集）及各自额度快照
export function listAll() {
  const u = loadUsers()
  const names = new Set(Object.keys(u.users || {}))
  try { for (const f of fs.readdirSync(USAGE_DIR)) if (f.endsWith(".json")) names.add(f.slice(0, -5)) } catch {}
  names.add(USER_NAME)
  return {
    tiers: u.tiers, defaultTier: u.defaultTier,
    users: [...names].sort().map((n) => quotaOf(n, u)),
  }
}
// 设/改某用户的档位（tier 必须已存在）；成功返回 true
export function setUserTier(name, tier) {
  name = String(name || "").trim(); if (!name) return { ok: false, err: "缺用户名" }
  const u = loadUsers()
  if (!u.tiers[tier]) return { ok: false, err: "档位不存在：" + tier }
  u.users[name] = { ...(u.users[name] || {}), tier }
  saveUsers(u)
  return { ok: true }
}
// 移除某用户的登记（之后按缺省档处理）；不动其用量历史
export function removeUser(name) {
  const u = loadUsers()
  if (u.users[name]) { delete u.users[name]; saveUsers(u) }
  return { ok: true }
}
// 新增/修改一个档位的名称与每日额度（dailyTokens=0 表示不限）
export function setTier(key, { label, dailyTokens }) {
  key = String(key || "").trim(); if (!key) return { ok: false, err: "缺档位键" }
  const u = loadUsers()
  u.tiers[key] = { label: String(label || key), dailyTokens: Math.max(0, Number(dailyTokens) || 0) }
  saveUsers(u)
  return { ok: true }
}
