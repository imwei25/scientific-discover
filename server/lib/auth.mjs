// 鉴权原语：口令哈希、access key 签发/校验、图形验证码、管理台会话。
//
// 验证码与签名会话是从 deploy/manager.mjs 原样搬来的（生产跑了几个月、和 fail2ban 的
// caddy-login jail 配合过），别顺手"简化"：
//   · 验证码一次性（无论对错都作废）—— 防重放；
//   · 签名会话是无状态 HMAC —— 进程重启不掉线，改密码后旧票据自动全废（密钥就是当前口令）。

import crypto from "node:crypto"

// ---- base64url / HMAC ----
export const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
export const b64uDecode = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64")
export const hmac = (key, msg) => b64u(crypto.createHmac("sha256", key).update(msg).digest())
export const safeEq = (a, b) => {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b))
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}
export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex")
export const randToken = (n = 32) => crypto.randomBytes(n).toString("base64url")

// ---- 口令：scrypt（Node 内置，无外部依赖）----
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }
export function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const h = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return { hash: h.toString("hex"), salt }
}
export function verifyPassword(pw, hash, salt) {
  if (!hash || !salt) return false
  try { return safeEq(hashPassword(pw, salt).hash, hash) } catch { return false }
}

/** 生成初始口令：12 位，含大小写+数字+符号（需求 REQ-U-003 的强随机口径）。 */
export function genInitialPassword() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#$%^&*-_=+"]
  const all = sets.join("")
  const pick = (s) => s[crypto.randomInt(s.length)]
  const chars = sets.map(pick)                                  // 四类各保底一个
  while (chars.length < 12) chars.push(pick(all))
  for (let i = chars.length - 1; i > 0; i--) {                   // Fisher-Yates，别让前四位固定类别
    const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join("")
}

/** 口令复杂度（需求 REQ-U-004：长度≥8，含大小写、数字、特殊字符）。 */
export function checkPasswordStrength(pw) {
  const s = String(pw || "")
  if (s.length < 8) return "口令至少 8 位"
  if (!/[a-z]/.test(s)) return "口令需含小写字母"
  if (!/[A-Z]/.test(s)) return "口令需含大写字母"
  if (!/[0-9]/.test(s)) return "口令需含数字"
  if (!/[^A-Za-z0-9]/.test(s)) return "口令需含特殊字符"
  return null
}

// ==== access key ==============================================================
// 形如 v1.<payload-b64u>.<sig>。自签而非上 JWT 库：载荷字段自己定、零依赖、校验逻辑一眼看完。
//
// 关键设计（改造方案 §3.2）：载荷里带 epoch，服务端每次请求比对 users.key_epoch。
// 管理员改档/停用/调额时 epoch++ → 已签发的 key 立刻失效，不必等下次登录。

export const KEY_PREFIX = "v1"

export function signAccessKey(secret, payload, ttlMs) {
  const body = { ...payload, iat: Date.now(), exp: Date.now() + ttlMs }
  const p = b64u(JSON.stringify(body))
  return `${KEY_PREFIX}.${p}.${hmac(secret, p)}`
}

/**
 * 只做「格式 + 签名 + 未过期」三件事，返回 {ok,payload} 或 {ok:false,code}。
 * 用户是否存在 / 是否停用 / epoch 是否还对，由调用方查库判断——那些是会变的状态，不该塞进票据。
 */
export function verifyAccessKey(secret, token) {
  const t = String(token || "")
  const parts = t.split(".")
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return { ok: false, code: "KEY_INVALID" }
  const [, p, sig] = parts
  const want = hmac(secret, p)
  if (!safeEq(want, sig)) return { ok: false, code: "KEY_INVALID" }
  let payload
  try { payload = JSON.parse(b64uDecode(p).toString("utf8")) } catch { return { ok: false, code: "KEY_INVALID" } }
  if (!payload || typeof payload !== "object") return { ok: false, code: "KEY_INVALID" }
  if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return { ok: false, code: "KEY_EXPIRED" }
  return { ok: true, payload }
}

// ==== 管理台会话（无状态签名 cookie）==========================================
export const AUTH_TTL_MS = 5 * 24 * 60 * 60 * 1000
export const signSession = (key, tag) => {
  const exp = Date.now() + AUTH_TTL_MS
  return exp + "." + hmac(key, tag + "|" + exp)
}
export const validSession = (key, tag, val) => {
  if (!val || !key) return false
  const i = String(val).indexOf(".")
  if (i < 0) return false
  const exp = Number(val.slice(0, i)), sig = val.slice(i + 1)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  return safeEq(hmac(key, tag + "|" + exp), sig)
}

// ==== 图形验证码（自建 SVG，零依赖、不打外部服务）=============================
const CAPTCHA_TTL_MS = 3 * 60 * 1000
const CAP_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 去掉易混的 0O1IL
const captchas = new Map() // id -> {code, exp}

export function newCaptcha() {
  const now = Date.now()
  for (const [k, v] of captchas) if (v.exp < now) captchas.delete(k) // 顺手清过期
  let code = ""
  for (let i = 0; i < 4; i++) code += CAP_CHARS[crypto.randomInt(CAP_CHARS.length)]
  const id = crypto.randomBytes(12).toString("hex")
  captchas.set(id, { code, exp: now + CAPTCHA_TTL_MS })
  return { id, code }
}
export function verifyCaptcha(id, answer) {
  const c = captchas.get(id)
  if (!c) return false
  captchas.delete(id) // 一次性：无论对错都作废，防重放
  return c.exp >= Date.now() && String(answer || "").toUpperCase() === c.code
}
export const _captchaSize = () => captchas.size // 仅测试用

export function captchaSvg(code) {
  const W = 130, H = 44
  const R = (a, b) => a + crypto.randomInt(Math.max(1, b - a + 1))
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

// ==== 登录失败限流（内存，进程级）=============================================
// fail2ban 盯的是 Caddy 日志里的 401，这一层是应用内的第一道闸：同一 (IP,账号) 连续失败
// 到阈值就锁一段时间，避免把爆破流量全推给 fail2ban 去连坐整个出口 IP。
const fails = new Map() // key -> {n, until}
export const LOGIN_MAX_FAILS = 8
export const LOGIN_LOCK_MS = 10 * 60 * 1000

export function loginLocked(key, now = Date.now()) {
  const f = fails.get(key)
  if (!f) return 0
  if (f.until && f.until > now) return f.until - now
  if (f.until && f.until <= now) fails.delete(key)
  return 0
}
export function noteLoginFail(key, now = Date.now()) {
  const f = fails.get(key) || { n: 0, until: 0 }
  f.n++
  if (f.n >= LOGIN_MAX_FAILS) { f.until = now + LOGIN_LOCK_MS; f.n = 0 }
  fails.set(key, f)
  return f
}
export const clearLoginFail = (key) => fails.delete(key)
export const _resetLoginFails = () => fails.clear() // 仅测试用
