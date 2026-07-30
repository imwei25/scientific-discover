// 云端账号：桌面版用它登录 sci-auth、拿 access key、到期自动续期。
//
// 【为什么 key 不直接写进 opencode 的 provider 配置】
// access key 默认 24 小时过期，每次续期都是一把新 key。若把 key 写进 opencode.json，
// 每次续期就得重写配置 + 重启 opencode —— 而重启会把正在跑的轮连根拔掉（综述/标书
// 单轮可以跑十几分钟）。所以改成：opencode 恒指向【本机网关】的 /cloud/v1，
// 由网关在转发时贴上当前 access key。key 怎么轮换，opencode 都不用知道。
//
// 【状态文件里有什么】refresh token（长期凭证）。它等价于口令，所以：
//   · 落盘时 0600（Windows 上 chmod 基本无效，接受——见需求 §3.7 的口径：
//     防滥用靠有效期+额度+可踢，不指望对本机管理员保密）
//   · 打包脚本必须把它列进清理闸，别让开发机的登录态进安装器
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 【每次调用现读环境变量，别在模块加载时定死】生产里 env 在启动时就固定了，行为一样；
// 但自动化测试要给每个实例一个独立的状态目录，模块级捕获会让所有实例共用第一个测试的文件，
// 于是上一个用例的登录态漏进下一个用例 —— 排查起来完全看不出所以然。
const statePath = () => process.env.CLOUD_STATE_PATH || path.join(__dirname, "cloud-state.json")
const cfgPath = () => process.env.CLOUD_CFG_PATH || path.join(__dirname, "..", "cloud.json")
export { statePath as CLOUD_STATE_PATH }

/** 提前这么久就续期，别掐着点：网络慢一点就过期了 */
const RENEW_AHEAD_MS = 10 * 60 * 1000
/** 调 sci-auth 的超时。登录/续期都是小请求，慢过这个多半是网络断了 */
const API_TIMEOUT_MS = 20_000

// ---- 云端地址：cloud.json 的 gatewayUrl（或 SCI_CLOUD_URL 覆盖）----
// 兼容历史写法：以前这里填的是 OpenAI 兼容端点（.../llm 或 .../llm/v1），
// 现在要的是站点根。两种都收，统一归一化成站点根。
// 去掉 UTF-8 BOM 再解析。Windows 上 PowerShell 的 Out-File -Encoding utf8、以及记事本另存，
// 默认都会写 BOM，而 JSON.parse 见了 BOM 直接抛 —— 表现是"配置文件明明在、内容也对，
// 程序却当成没配"。打包脚本已改成不写 BOM，这里再兜一层：用户手改这个文件是常态。
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

export function cloudBase() {
  let raw = process.env.SCI_CLOUD_URL || ""
  if (!raw) {
    try { raw = JSON.parse(stripBom(fs.readFileSync(cfgPath(), "utf8"))).gatewayUrl || "" } catch {}
  }
  raw = String(raw).trim().replace(/\/+$/, "")
  if (!raw) return ""
  return raw.replace(/\/llm(\/v1)?$/, "").replace(/\/v1$/, "")
}

// ---- 状态读写 ----
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return null } }
export const loadState = () => {
  const s = readJson(statePath())
  return s && s.refresh ? s : null
}
export function saveState(s) {
  const p = statePath()
  const tmp = p + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)          // 原子替换：读方永远看到完整 JSON
  try { fs.chmodSync(p, 0o600) } catch {}
  return s
}
export function clearState() { try { fs.unlinkSync(statePath()) } catch {} }

// ---- 调 sci-auth ----
async function api(pathname, { method = "GET", body, token, headers: extraHeaders } = {}) {
  const base = cloudBase()
  if (!base) return { ok: false, status: 0, error: { code: "NO_CLOUD_URL", message: "未配置云端地址（cloud.json 的 gatewayUrl）" } }
  const headers = { "x-client-version": process.env.APP_VERSION || "dev", ...(extraHeaders || {}) }
  if (body !== undefined) headers["content-type"] = "application/json"
  if (token) headers["authorization"] = "Bearer " + token
  let r
  try {
    r = await fetch(base + pathname, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch (e) {
    // 网络错误与"云端说不行"必须区分开：前者不该清掉本地登录态
    return { ok: false, status: 0, error: { code: "NETWORK", message: e?.name === "TimeoutError" ? "连接云端超时" : "连不上云端服务" } }
  }
  let j = null
  try { j = await r.json() } catch {}
  if (r.ok && j) return { ok: true, status: r.status, data: j }
  return { ok: false, status: r.status, error: (j && j.error) || { code: "HTTP_" + r.status, message: "云端返回异常" } }
}

const stateFrom = (username, d) => ({
  username,
  access: d.access,
  accessExp: d.expiresAt,
  refresh: d.refresh,
  refreshExp: d.refreshExpiresAt,
  scope: d.scope || "full",
  mustChangePassword: !!d.mustChangePassword,
  profile: d.profile || null,
  updatedAt: Date.now(),
})

export async function login(username, password) {
  const r = await api("/api/auth/login", { method: "POST", body: { username, password } })
  if (!r.ok) return r
  return { ok: true, state: saveState(stateFrom(username, r.data)) }
}

export async function changePassword(oldPassword, newPassword) {
  const s = loadState()
  if (!s) return { ok: false, error: { code: "NOT_LOGGED_IN", message: "尚未登录" } }
  const r = await api("/api/auth/password", { method: "POST", token: s.access, body: { oldPassword, newPassword } })
  if (!r.ok) return r
  return { ok: true, state: saveState(stateFrom(s.username, r.data)) }
}

export async function logout() {
  const s = loadState()
  if (s?.refresh) await api("/api/auth/logout", { method: "POST", body: { refresh: s.refresh } })
  clearState()
  return { ok: true }
}

// ---- 续期：single-flight ----
// 并发的模型调用会同时发现 key 过期。refresh token 是【一次性轮换】的，
// 若每个请求各续各的，第二个就会拿着已作废的 refresh 去换，直接把登录态弄丢。
let renewing = null
export function _resetRenewing() { renewing = null }   // 仅测试用

export async function renew() {
  if (renewing) return renewing
  renewing = (async () => {
    const s = loadState()
    if (!s?.refresh) return { ok: false, error: { code: "NOT_LOGGED_IN", message: "尚未登录" } }
    const r = await api("/api/auth/refresh", { method: "POST", body: { refresh: s.refresh } })
    if (r.ok) return { ok: true, state: saveState(stateFrom(s.username, r.data)) }
    // 【只有云端明确否掉才清登录态】网络不通时清掉 = 断网一次就被登出，
    // 而这台机可能正跑着活。所以 status 0（网络层失败）一律保留状态、原样上报。
    if (r.status === 401 || r.status === 403) clearState()
    return r
  })().finally(() => { renewing = null })
  return renewing
}

/**
 * 取一把当前可用的 access key（临近到期就先续）。
 * 返回 {ok:true, token, state} 或 {ok:false, error}
 */
export async function currentAccess({ force = false } = {}) {
  const s = loadState()
  if (!s) return { ok: false, error: { code: "NOT_LOGGED_IN", message: "尚未登录云端账号" } }
  const near = !s.accessExp || s.accessExp - Date.now() < RENEW_AHEAD_MS
  if (force || near) {
    const r = await renew()
    if (!r.ok) return r
    return { ok: true, token: r.state.access, state: r.state }
  }
  return { ok: true, token: s.access, state: s }
}

/** 拉一次云端档案（档位/额度/用量），顺便把本地缓存刷新 */
export async function fetchProfile() {
  const a = await currentAccess()
  if (!a.ok) return a
  const r = await api("/api/me", { token: a.token })
  if (!r.ok) return r
  const s = loadState()
  if (s) saveState({ ...s, profile: r.data.profile, updatedAt: Date.now() })
  return { ok: true, profile: r.data.profile }
}

/**
 * 拉一次平台公告（站长在后台发布的横幅 / 最低客户端版本）。
 *
 * 【为什么不复用 fetchProfile】档案只在登录、access key 续期（TTL 24h、提前 10 分钟续）
 * 或用户手点"刷新"时才重取 —— 一条"今晚 10 点维护"的公告要等到明天才到用户眼前。
 * 这个口只读服务端一行 meta，可以放心几分钟问一次。
 *
 * 也【刻意不写进 cloud-state.json】：公告是纯展示信息，落盘只会带来"本地缓存与服务端
 * 不一致"的一类新问题（比如站长撤了公告、本地还留着）。要不要记"用户点掉过"由前端的
 * localStorage 按公告 id 记，那才是真正需要持久的东西。
 */
export async function fetchNotice() {
  const a = await currentAccess()
  if (!a.ok) return a
  const r = await api("/api/notice", { token: a.token })
  if (!r.ok) return r
  return { ok: true, notice: r.data.notice || null, needUpgrade: !!r.data.needUpgrade, clientVersion: r.data.clientVersion || "" }
}

/**
 * 问一次"我在云端排第几"。
 *
 * 【为什么需要它】云端的并发闸满了以后，请求会在服务端排队等位 —— HTTP 上什么都看不到
 * （响应头还没回），本地网关只能干等，用户看到的就是一个不动的转圈。这个口只读服务端内存里
 * 的一个计数，可以放心每两秒问一次，好把"正在排队，前面还有 N 个"如实告诉用户。
 *
 * 【刻意不重试、不抛错】它是纯附加信息：问不到就当"不知道"，绝不能影响正在飞的那一单。
 */
export async function fetchQueue() {
  const a = await currentAccess()
  if (!a.ok) return a
  const r = await api("/api/queue", { token: a.token })
  if (!r.ok) return r
  return { ok: true, queue: r.data.queue || null }
}

/**
 * 技能包：问一次"服务器上最新发布的是哪版"。低频（server.mjs 侧半小时一次），
 * 顺便把本机已装版本用 X-Skills-Version 报上去 —— 后台的"技能版本分布"就是靠它。
 */
export async function fetchSkillLatest(installedVersion) {
  const a = await currentAccess()
  if (!a.ok) return a
  const r = await api("/api/skills/latest", { token: a.token, headers: { "x-skills-version": installedVersion || "" } })
  if (!r.ok) return r
  return { ok: true, latest: r.data.latest || null }
}

/** 技能包：下载指定版本的 zip。二进制走不了 api()（那边固定 r.json()），单独写。 */
export async function downloadSkillPack(version) {
  const a = await currentAccess()
  if (!a.ok) return a
  const base = cloudBase()
  if (!base) return { ok: false, error: { code: "NO_CLOUD_URL", message: "未配置云端地址" } }
  try {
    const r = await fetch(base + "/api/skills/pack?version=" + encodeURIComponent(version), {
      headers: { authorization: "Bearer " + a.token, "x-client-version": process.env.APP_VERSION || "dev" },
      // 包是几 MB～几十 MB 的 zip，弱网下 20s 不够；给到 5 分钟，再慢就该报错让用户重试了
      signal: AbortSignal.timeout(5 * 60_000),
    })
    if (!r.ok) {
      let j = null; try { j = await r.json() } catch {}
      return { ok: false, status: r.status, error: (j && j.error) || { code: "HTTP_" + r.status, message: "下载失败（HTTP " + r.status + "）" } }
    }
    const buf = Buffer.from(await r.arrayBuffer())
    return { ok: true, buf, sha256: String(r.headers.get("x-pack-sha256") || "") }
  } catch (e) {
    return { ok: false, status: 0, error: { code: "NETWORK", message: e?.name === "TimeoutError" ? "下载超时" : "连不上云端服务" } }
  }
}

/** 给界面用的状态摘要（不含任何凭证） */
export function status() {
  const s = loadState()
  const base = cloudBase()
  if (!s) return { configured: !!base, loggedIn: false, cloudUrl: base }
  return {
    configured: !!base, loggedIn: true, cloudUrl: base,
    username: s.username,
    mustChangePassword: !!s.mustChangePassword,
    accessExp: s.accessExp, refreshExp: s.refreshExp,
    profile: s.profile || null,
  }
}
