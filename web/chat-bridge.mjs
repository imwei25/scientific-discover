// 聊天接入桥（chat-bridge）：把打包版的会话接到企业微信 / 微信。
//
// 架构（详见 desktop/方案设计-聊天工具接入产品化.md）：
//   企微/微信 ←WebSocket/长轮询← cc-connect（托管子进程）→ spawn oc-wrap.mjs → 内置 opencode
// cc-connect 负责平台协议（MIT，二进制预置在 runtime\cc-connect\，开发机回退 npm 全局），
// 我们负责：生成它的 config.toml、托管生命周期、会话绑定/换绑、把发文件说明书注入会话目录。
//
// 【多平台并存】企微、微信【各自独立绑定一个会话】——cc-connect 一个进程管多个 project，
// 每个 project 一套 platform + 各自 work_dir，按平台路由（官方明确支持）。所以 state 里
// wecom / weixin 各有自己的 boundSid/boundDir/凭证/白名单，config.toml 生成多个 [[projects]]。
//
// 【绑定的语义】绑定会话 = 微信端的对话在该会话的目录里干活（文件互通、产物进该目录）；
// cc-connect 每次对话在这个目录起【新的 opencode 会话】，绑定会话本身只是"目录锚点"。
// 网关侧据此认领同目录会话（挂图标、归文件夹，见 server.mjs /api/sessions）。
//
// 【换绑】停桥 → 收回旧目录注入的 AGENTS.md 块（另一平台还绑着同目录就别收）+ 注入新目录 →
// project 名带平台+会话 id（sci-<platform>-<sid8>）重启，cc-connect 会话状态按 project 落盘，
// 换名后旧状态不复用（否则它会 resume 一个 directory 钉在旧目录的会话，消息落错地方）。

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { spawn, execFileSync, execFile } from "node:child_process"
import * as WF from "./workflows.mjs"

const BLOCK_START = "<!-- sci-chat-bridge:start 由「聊天接入」自动注入，解绑时自动移除，请勿手工编辑 -->"
const BLOCK_END = "<!-- sci-chat-bridge:end -->"
const PLATFORMS = ["wecom", "weixin"]

let CTX = null            // { root, webDir, sessionOut, getModel, getCloudEnv, log }
let proc = null           // cc-connect 子进程
let restartCount = 0      // 崩溃退避计数（成功存活 60s 后清零）
let lastExit = null       // { code, at } 最近一次异常退出
let startingAt = 0

const dir = () => path.join(CTX.root, "chat-bridge")
const statePath = () => path.join(dir(), "state.json")
const configPath = () => path.join(dir(), "config.toml")
const logPath = () => path.join(dir(), "bridge.log")

// ---- 状态文件（含 bot 凭证，纳入卸载清理；与 cloud-state.json 同待遇）----
// 每平台独立一套绑定：boundSid/boundDir（各自锚点会话）、凭证、白名单。
// 白名单【按平台分开】：两边成员 id 体系不同（企微 woXXXX vs 微信 xxx@im.wechat）。
const defState = () => ({
  enabled: false,
  progress: true,                       // 长任务进度提示（oc-wrap 里实现）
  thinking: false,                      // 「输出思考」：把 reasoning 聚合成一条推给聊天（默认关，工具过程仍不外发）
  uploadFirst: false,                   // 「先上传后提问」：只发文件不触发会话，先暂存、提问时并入（默认关）
  model: "",                            // 聊天接入专用模型（modelID，空=跟随界面/网关当前模型）
  wecom: { bot_id: "", bot_secret: "", allow_from: "", boundSid: "", boundDir: "" },
  weixin: { token: "", account_id: "", base_url: "", allow_from: "", boundSid: "", boundDir: "" },
})
export function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8").replace(/^\uFEFF/, ""))
    const s = {
      ...defState(), ...raw,
      wecom: { ...defState().wecom, ...(raw.wecom || {}) },
      weixin: { ...defState().weixin, ...(raw.weixin || {}) },
    }
    // 迁移旧单平台格式：顶层 platform + boundSid/boundDir → 归到对应平台名下。
    if (raw.platform && (raw.boundSid || raw.boundDir)) {
      const p = raw.platform === "weixin" ? "weixin" : "wecom"
      if (!s[p].boundSid) s[p].boundSid = raw.boundSid || ""
      if (!s[p].boundDir) s[p].boundDir = raw.boundDir || ""
    }
    // 更早的顶层 allowFrom（企微时代）
    if (raw.allowFrom && !s.wecom.allow_from) s.wecom.allow_from = String(raw.allowFrom)
    for (const k of ["platform", "boundSid", "boundDir", "allowFrom"]) delete s[k]
    return s
  } catch { return defState() }
}
function saveState(s) {
  fs.mkdirSync(dir(), { recursive: true })
  const tmp = statePath() + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, statePath())
}
// 平台凭证是否齐（能连）
function platReady(s, p) {
  return p === "weixin" ? !!s.weixin.token : !!(s.wecom.bot_id && s.wecom.bot_secret)
}
// 平台是否可上线（凭证齐 + 绑了会话）
function platActive(s, p) {
  return platReady(s, p) && !!s[p].boundSid && !!s[p].boundDir
}
const activePlats = (s) => PLATFORMS.filter((p) => platActive(s, p))
// 另一平台是否也绑了这个目录（收回 AGENTS.md 前要问，别误删对方还在用的注入）
function otherPlatUsesDir(s, platform, d) {
  if (!d) return false
  const R = (x) => { try { return path.resolve(x).toLowerCase() } catch { return "" } }
  return PLATFORMS.some((p) => p !== platform && s[p].boundDir && R(s[p].boundDir) === R(d))
}

// ---- 路径工具 ----
const stripLP = (p) => String(p || "").replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "")
// cc-connect 把 cmd 按【空格】拆分（实测），所以 cmd 里的每段路径都不能含空格。
// 短路径（8.3）优先；拿不到就在无空格处建 junction 兜底。（导出仅为单测。）
export function spaceFree(p) {
  p = stripLP(p)
  if (!p.includes(" ")) return p
  try {
    const out = execFileSync("cmd.exe", ["/c", `for %A in ("${p}") do @echo %~sA`], { windowsHide: true }).toString().trim()
    if (out && !out.includes(" ") && fs.existsSync(out)) return out
  } catch {}
  // 【junction 名必须用整路径 sha1】前缀哈希会让同前缀目录（node 与包装器都在 c:\users\<u>\）
  // 撞进同一 junction，包装器路径指错（真机踩过：Cannot find module ...\j_xxx\oc-wrap.mjs）。
  const st = fs.statSync(p)
  const targetDir = st.isDirectory() ? p : path.dirname(p)
  const juncRoot = path.join(process.env.ProgramData || "C:\\ProgramData", "niuma-chat-bridge")
  fs.mkdirSync(juncRoot, { recursive: true })
  const name = "j_" + crypto.createHash("sha1").update(targetDir.toLowerCase()).digest("hex").slice(0, 16)
  const junc = path.join(juncRoot, name)
  try {
    if (fs.existsSync(junc) && path.resolve(fs.readlinkSync(junc)).toLowerCase() !== path.resolve(targetDir).toLowerCase()) fs.rmSync(junc)
  } catch {}
  if (!fs.existsSync(junc)) fs.symlinkSync(targetDir, junc, "junction")
  return st.isDirectory() ? junc : path.join(junc, path.basename(p))
}

// ---- 二进制定位 ----
export function ccBin() {
  const cands = [
    process.env.SCI_CC_BIN,
    path.join(CTX.root, "..", "runtime", "cc-connect", "cc-connect.exe"),
    path.join(process.env.LOCALAPPDATA || "", "nvm", "v22.14.0", "node_modules", "cc-connect", "bin", "cc-connect.exe"),
    "C:\\nvm4w\\nodejs\\node_modules\\cc-connect\\bin\\cc-connect.exe",
  ].filter(Boolean)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch {} }
  return ""
}
function ocBin() { return stripLP(process.env.OC_BIN || "") }
export function supported() {
  return process.platform === "win32" && !!ccBin() && !!ocBin() && fs.existsSync(ocBin())
}

// ---- AGENTS.md 注入 / 收回（标记块，不碰用户自己的内容）----
function template() {
  const t = path.join(CTX.webDir, "chat-bridge", "agents-template.md")
  return fs.readFileSync(t, "utf8")
}
export function injectAgents(dirAbs) {
  fs.mkdirSync(dirAbs, { recursive: true })
  const f = path.join(dirAbs, "AGENTS.md")
  retractAgents(dirAbs)   // 幂等：已有我们的块先删掉再注入
  const block = `\n\n${BLOCK_START}\n${template().trim()}\n${BLOCK_END}\n`
  const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""
  fs.writeFileSync(f, cur + block)
}
export function retractAgents(dirAbs) {
  try {
    const f = path.join(dirAbs, "AGENTS.md")
    if (!fs.existsSync(f)) return
    const cur = fs.readFileSync(f, "utf8")
    const re = new RegExp(`\\n*${BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g")
    const next = cur.replace(re, "\n").replace(/^\n+/, "")
    if (next.trim() === "") fs.rmSync(f)
    else if (next !== cur) fs.writeFileSync(f, next)
  } catch (e) { CTX.log?.("chat-bridge: 收回 AGENTS.md 失败（不阻塞换绑）: " + e.message) }
}

// ---- config.toml 生成（多平台各一个 project）----
const tq = (s) => `'${String(s)}'`
const sid8 = (sid) => String(sid || "unbound").replace(/[^a-zA-Z0-9]/g, "").slice(-8)
export const projectName = (platform, sid) => `sci-${platform}-${sid8(sid)}`
function commonEnv(s) {
  const cc = ccBin()
  const env = {
    OPENCODE_CONFIG: stripLP(path.join(CTX.root, "opencode.json")),
    XDG_CONFIG_HOME: stripLP(path.join(CTX.root, ".ocglobal")),
    PATH: [path.dirname(cc), stripLP(process.env.PATH || "")].join(";"),
    SCI_WRAP_OC: ocBin(),
    SCI_WRAP_CC: cc,
    SCI_WRAP_PROGRESS: s.progress ? "1" : "0",
    SCI_WRAP_THINKING: s.thinking ? "1" : "0",
    SCI_WRAP_UPLOAD_FIRST: s.uploadFirst ? "1" : "0",
    SCI_WRAP_LOG: path.join(dir(), "wrap.log"),
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
  }
  for (const k of ["REPO_ROOT", "SCI_PYTHON", "SKILL_DIR", "MPLBACKEND", "MATPLOTLIBRC",
    "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_DISABLE_PIP_VERSION_CHECK",
    "SCI_IMAGE_URL", "SCI_IMAGE_TOKEN", "SCI_OCR_URL", "SCI_OCR_TOKEN"])
    if (process.env[k]) env[k] = stripLP(process.env[k])
  // 生图/OCR 的平台代理变量（SCI_IMAGE_URL/TOKEN、SCI_OCR_URL/TOKEN）：桌面版这四个值是
  // server.mjs 按本机端口 + 每进程随机令牌算出来的，只注入过 opencode serve 那个子进程，
  // 主进程 process.env 里【没有】—— 上面那条透传只在容器版（render-compose 注入）才有值。
  // 桌面版走 init 传进来的 getCloudEnv 取实时值，并覆盖透传（登录态以它为准）。
  Object.assign(env, CTX.getCloudEnv?.() || {})
  return env
}
function renderProject(s, platform) {
  const b = s[platform]
  const nodeExe = spaceFree(process.execPath)
  const wrap = spaceFree(path.join(CTX.webDir, "chat-bridge", "oc-wrap.mjs"))
  const gm = CTX.getModel()
  const modelStr = gm.providerID + "/" + (s.model || gm.modelID)
  const env = commonEnv(s)
  const platOpts = platform === "weixin"
    ? [
      `token = ${tq(b.token)}`,
      ...(b.account_id ? [`account_id = ${tq(b.account_id)}`] : []),
      ...(b.base_url ? [`base_url = ${tq(b.base_url)}`] : []),
      ...(b.allow_from.trim() ? [`allow_from = ${tq(b.allow_from.trim())}`] : []),
    ]
    : [
      `mode = "websocket"`,
      `bot_id = ${tq(b.bot_id)}`,
      `bot_secret = ${tq(b.bot_secret)}`,
    ]
  return [
    "[[projects]]",
    `name = ${tq(projectName(platform, b.boundSid))}`,
    ...(b.allow_from.trim() ? [`allow_from = ${tq(b.allow_from.trim())}`] : []),
    "",
    "[projects.agent]",
    `type = "opencode"`,
    "",
    "[projects.agent.options]",
    `cmd = ${tq(nodeExe + " " + wrap)}`,
    `work_dir = ${tq(b.boundDir)}`,
    `model = ${tq(modelStr)}`,
    `mode = "default"`,
    "",
    "[projects.agent.options.env]",
    ...Object.entries(env).map(([k, v]) => `${k} = ${tq(v)}`),
    "",
    "[[projects.platforms]]",
    `type = ${tq(platform)}`,
    "",
    "[projects.platforms.options]",
    ...platOpts,
    "",
  ].join("\n")
}
export function renderConfig(s) {
  const head = [
    "# 本文件由打包版「聊天接入」自动生成，每次启动/换绑都会重写 —— 手工修改会被覆盖。",
    `language = "zh"`,
    "",
  ].join("\n")
  return head + activePlats(s).map((p) => renderProject(s, p)).join("\n")
}

// ---- 生命周期 ----
export function running() { return !!(proc && proc.exitCode === null) }
// getCloudEnv 输出的快照（起桥写 config.toml 那一刻）。env 是烘进 config 的，之后
// 登录态再变，跑着的桥不会自己知道 —— syncCloudEnv 拿当前值与快照比对来决定要不要重启。
let bakedCloudSig = ""
const cloudSig = () => JSON.stringify(CTX?.getCloudEnv?.() || {})
export async function stop() {
  if (!running()) { proc = null; return }
  const p = proc; proc = null
  try { p.kill() } catch {}
  await new Promise((r) => { const t = setTimeout(() => r(), 1500); p.once("exit", () => { clearTimeout(t); r() }) })
  if (p.exitCode === null) try { execFileSync("taskkill", ["/F", "/T", "/PID", String(p.pid)], { windowsHide: true }) } catch {}
}
export function start() {
  const s = loadState()
  if (!s.enabled || !supported()) return { ok: false, err: !s.enabled ? "未开启" : "缺 cc-connect 或 opencode 二进制" }
  if (running()) return { ok: true, already: true }
  const active = activePlats(s)
  if (!active.length) return { ok: false, err: "没有已配置且绑定会话的平台" }
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(configPath(), renderConfig(s))
  bakedCloudSig = cloudSig()
  const out = fs.openSync(logPath(), "a")
  startingAt = Date.now()
  proc = spawn(ccBin(), ["--config", configPath(), "--force"], {
    cwd: dir(), stdio: ["ignore", out, out], windowsHide: true,
  })
  proc.once("exit", (code) => {
    fs.closeSync(out)
    lastExit = { code, at: Date.now() }
    if (proc === null) return
    proc = null
    const lived = Date.now() - startingAt
    if (lived > 60_000) restartCount = 0
    if (loadState().enabled && restartCount < 3) {
      restartCount++
      CTX.log?.(`chat-bridge: cc-connect 退出(code=${code})，${restartCount}/3 次退避重启`)
      setTimeout(() => { try { start() } catch {} }, restartCount * 5000)
    } else if (loadState().enabled) {
      CTX.log?.("chat-bridge: cc-connect 连续崩溃，已停止自动重启（界面可手动重启）")
    }
  })
  return { ok: true }
}

// 云端登录态翻转（首次登录 / 改密完成 / 登出）后由 server.mjs 调用：变了才重启桥、
// 让 config.toml 重写出新的生图/OCR 代理变量。【只在真的变了才动】—— 解锁（同号重登）
// 每天都会发生，而 stop() 是 taskkill /T，会把微信端正在跑的任务连根拔掉，不能白折腾。
export async function syncCloudEnv() {
  if (!running() || cloudSig() === bakedCloudSig) return
  CTX.log?.("chat-bridge: 云端登录态变化，重启桥以刷新生图/OCR 代理变量")
  await stop()
  const r = start()
  if (!r.ok) CTX.log?.("chat-bridge: 重启未成功：" + r.err)
}

// ---- 微信个人号扫码（腾讯官方 ilink 机器人网关）----
let setupProc = null
let setupInfo = { state: "idle", err: "" }   // idle | running | done | failed
const qrPath = () => path.join(dir(), "weixin-qr.png")
const setupCfgPath = () => path.join(dir(), "weixin-setup.toml")

export async function weixinSetupStart() {
  if (!supported()) return { ok: false, err: "缺 cc-connect 组件" }
  if (setupProc && setupProc.exitCode === null) return { ok: true, already: true }
  fs.mkdirSync(dir(), { recursive: true })
  for (const f of [qrPath(), setupCfgPath()]) { try { fs.rmSync(f) } catch {} }
  await stop()   // 扫码期间停桥：ilink 单会话，旧 token 长轮询会跟新登录打架
  fs.writeFileSync(setupCfgPath(), [
    "[[projects]]", `name = 'setup'`,
    "[projects.agent]", `type = "opencode"`,
    "[[projects.platforms]]", `type = "weixin"`,
    "[projects.platforms.options]", `token = ""`, "",
  ].join("\n"))
  const out = fs.openSync(path.join(dir(), "setup.log"), "w")
  setupInfo = { state: "running", err: "" }
  setupProc = spawn(ccBin(), ["weixin", "setup", "--config", setupCfgPath(), "--project", "setup",
    "--qr-image", qrPath(), "--timeout", "300"], { cwd: dir(), stdio: ["ignore", out, out], windowsHide: true })
  setupProc.once("exit", (code) => {
    try { fs.closeSync(out) } catch {}
    setupProc = null
    try {
      const t = fs.existsSync(setupCfgPath()) ? fs.readFileSync(setupCfgPath(), "utf8") : ""
      const pick = (k) => t.match(new RegExp(`^\\s*${k}\\s*=\\s*['"]([^'"]*)['"]`, "m"))?.[1] || ""
      const token = pick("token")
      if (code === 0 && token) {
        const s = loadState()
        s.weixin = { ...s.weixin, token, account_id: pick("account_id"), base_url: pick("base_url") }
        const af = pick("allow_from")
        if (af) s.weixin.allow_from = af
        saveState(s)
        setupInfo = { state: "done", err: "" }
        if (s.enabled) start()
      } else {
        let tail = ""; try { tail = fs.readFileSync(path.join(dir(), "setup.log"), "utf8").trim().split(/\r?\n/).slice(-3).join(" | ") } catch {}
        setupInfo = { state: "failed", err: "扫码未完成（超时/取消）" + (tail ? "：" + tail.slice(0, 200) : "") }
        const s = loadState()
        if (s.enabled && activePlats(s).length) start()   // 扫码没成→把还绑着的平台拉回来
      }
    } catch (e) { setupInfo = { state: "failed", err: e.message } }
    for (const f of [setupCfgPath(), qrPath()]) { try { fs.rmSync(f) } catch {} }
  })
  return { ok: true }
}
export function weixinSetup() { return { ...setupInfo, qrReady: fs.existsSync(qrPath()) } }
export function qrFile() { return fs.existsSync(qrPath()) ? qrPath() : "" }
export async function weixinReset() {
  await stop()
  const s = loadState()
  const d = s.weixin.boundDir
  s.weixin = { token: "", account_id: "", base_url: "", allow_from: "", boundSid: "", boundDir: "" }
  if (d && !otherPlatUsesDir(s, "weixin", d)) retractAgents(d)
  saveState(s)
  if (s.enabled && activePlats(s).length) start()
  return { ok: true }
}

// ---- 绑定 / 换绑 / 解绑（按平台）----
export async function bind(platform, sid) {
  if (!PLATFORMS.includes(platform)) return { ok: false, err: "未知平台" }
  const dirAbs = stripLP(await CTX.sessionOut(sid))
  if (!dirAbs) return { ok: false, err: "找不到该会话的产物目录" }
  try { fs.mkdirSync(dirAbs, { recursive: true }) } catch { return { ok: false, err: "会话产物目录无法创建：" + dirAbs } }
  const s = loadState()
  await stop()
  const oldDir = s[platform].boundDir
  s[platform].boundSid = sid; s[platform].boundDir = dirAbs
  // 先更新再判断：换绑后旧目录若没别的平台用了，才收回注入
  if (oldDir && path.resolve(oldDir).toLowerCase() !== path.resolve(dirAbs).toLowerCase() && !otherPlatUsesDir(s, platform, oldDir))
    retractAgents(oldDir)
  injectAgents(dirAbs)
  saveState(s)
  restartCount = 0
  const r = s.enabled && platReady(s, platform) ? start() : { ok: true, idle: true }
  return { ...r, platform, boundSid: sid, boundDir: dirAbs }
}
export async function unbind(platform) {
  if (!PLATFORMS.includes(platform)) return { ok: false, err: "未知平台" }
  const s = loadState()
  await stop()
  const d = s[platform].boundDir
  s[platform].boundSid = ""; s[platform].boundDir = ""
  if (d && !otherPlatUsesDir(s, platform, d)) retractAgents(d)
  saveState(s)
  restartCount = 0
  if (s.enabled && activePlats(s).length) start()   // 还有别的平台绑着 → 重启只带它
  return { ok: true }
}
export async function setConfig(patch) {
  const s = loadState()
  if (patch.wecom) s.wecom = {
    ...s.wecom,
    bot_id: String(patch.wecom.bot_id ?? s.wecom.bot_id).trim(),
    bot_secret: String(patch.wecom.bot_secret ?? s.wecom.bot_secret).trim(),
    ...(patch.wecom.allow_from !== undefined ? { allow_from: String(patch.wecom.allow_from).trim() } : {}),
  }
  if (patch.weixin && patch.weixin.allow_from !== undefined) s.weixin.allow_from = String(patch.weixin.allow_from).trim()
  if (patch.progress !== undefined) s.progress = !!patch.progress
  if (patch.thinking !== undefined) s.thinking = !!patch.thinking
  if (patch.uploadFirst !== undefined) s.uploadFirst = !!patch.uploadFirst
  if (patch.model !== undefined) s.model = String(patch.model).trim()
  if (patch.enabled !== undefined) s.enabled = !!patch.enabled
  saveState(s)
  const wasRunning = running()
  await stop()
  restartCount = 0
  const r = s.enabled && activePlats(s).length ? start() : { ok: true, idle: true }
  return { ok: true, restarted: wasRunning, ...(r.ok === false ? { warn: r.err } : {}) }
}

// ---- 日志解析：一次扫出每平台的连接态 / 来信成员 / 最近会话 ----
function parseLog() {
  const per = { wecom: { subscribed: false, seenUsers: [], lastSession: "" }, weixin: { subscribed: false, seenUsers: [], lastSession: "" } }
  let lastErr = ""
  try {
    const tail = fs.readFileSync(logPath(), "utf8").split(/\r?\n/).slice(-600)
    for (const ln of tail) {
      if (ln.includes("wecom-ws: connecting")) per.wecom.subscribed = false
      if (ln.includes("wecom-ws: subscribed successfully")) per.wecom.subscribed = true
      if (/msg="platform ready".*platform=weixin/.test(ln)) per.weixin.subscribed = true
      if (/weixin.*(polling stopped|login expired|unauthorized)/i.test(ln)) per.weixin.subscribed = false
      const mp = ln.match(/msg="message received".*?platform=(\w+)/)
      if (mp) {
        const p = mp[1] === "weixin" ? "weixin" : "wecom"
        const mu = ln.match(/\buser=(\S+)/); if (mu && !per[p].seenUsers.includes(mu[1])) per[p].seenUsers.push(mu[1])
        const ms = ln.match(/\bsession=(\S+)/); if (ms) per[p].lastSession = ms[1]
      }
      if (/level=ERROR/.test(ln)) lastErr = ln.slice(0, 400)
    }
  } catch {}
  return { per, lastErr }
}

// ---- 状态（前端据此渲染两个独立平台区）----
export function status() {
  const s = loadState()
  const { per, lastErr } = parseLog()
  const plat = (p) => ({
    configured: platReady(s, p),
    boundSid: s[p].boundSid, boundDir: s[p].boundDir,
    allowFrom: s[p].allow_from,
    subscribed: running() && per[p].subscribed,
    seenUsers: per[p].seenUsers.slice(-10),
  })
  return {
    supported: supported(), ccBin: !!ccBin(),
    enabled: s.enabled, running: running(), progress: s.progress,
    thinking: s.thinking, uploadFirst: s.uploadFirst, model: s.model,
    wecom: { ...plat("wecom"), bot_id: s.wecom.bot_id },   // secret/token 永不回前端
    weixin: { ...plat("weixin") },
    // 认领用：每平台绑定目录 → 前端/网关据此给同目录会话挂图标、归文件夹
    boundDirs: { wecom: s.wecom.boundDir, weixin: s.weixin.boundDir },
    boundSids: { wecom: s.wecom.boundSid, weixin: s.weixin.boundSid },
    lastError: lastErr, lastExit, weixinSetup: weixinSetup(),
  }
}
// 网关认领会话用：directory → 它属于哪个平台（哪个平台绑了这个目录）。没有则 null。
export function platformOfDir(dirAbs) {
  if (!dirAbs) return null
  const s = loadState()
  const R = (x) => { try { return path.resolve(x).toLowerCase() } catch { return "" } }
  const d = R(dirAbs)
  for (const p of PLATFORMS) if (s[p].boundDir && R(s[p].boundDir) === d) return p
  return null
}
export function boundInfo() {
  const s = loadState()
  return { wecom: { sid: s.wecom.boundSid, dir: s.wecom.boundDir }, weixin: { sid: s.weixin.boundSid, dir: s.weixin.boundDir } }
}

// ---- 主动推送（定时任务跑完发到绑定的微信/企微对话）----
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"])
// 会话目录里的 _workflow.json（网关写的簿子）→ 模块 + 表单值，供产物分级判主/副。
// 不 import wf-state 只为读两个字段：那边还带着写入/记账逻辑，这里只要读。
function workflowOf(d) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(d, "_workflow.json"), "utf8"))
    if (!st || typeof st.module !== "string") return { mod: "", values: null }
    return { mod: st.module, values: st.form && typeof st.form === "object" ? st.form : null }
  } catch { return { mod: "", values: null } }
}
// 定时任务的产物在某会话目录里 → 推给"绑了这个目录的那个平台"。目录没被任何平台绑就不推。
export async function pushToChat({ text, files, dir: workDir } = {}) {
  const s = loadState()
  if (!running()) return { ok: false, err: "聊天接入未运行（软件需开着并已连接）" }
  const { per } = parseLog()
  // 目标平台：优先推"绑了这个产物目录"的平台；拿不到目录就推所有在线平台
  let targets = []
  const byDir = workDir ? platformOfDir(workDir) : null
  if (byDir) targets = [byDir]
  else targets = activePlats(s).filter((p) => per[p].subscribed)
  targets = targets.filter((p) => per[p].subscribed && per[p].lastSession)
  if (!targets.length) return { ok: false, err: "没有可推送的已连接对话（先在微信/企微里跟机器人说句话）" }

  // 【只推主产物】定时任务传来的是 /api/outputs 的整张清单（含中间文件，文件夹会话里还含
  // 用户自己原有的资料）。原来只按扩展名排掉 py/log/tmp，于是一次跑完能把十几个中间文件
  // 轰到手机上——判据改成与界面侧栏同一份（WF.pickChatFiles），中间文件只在文案里报个数。
  const MAX_FILES = 5, MAX_BYTES = 20 * 1024 * 1024
  const sized = (files || []).filter((f) => {
    try { const st = fs.statSync(f); return st.size > 0 && st.size <= MAX_BYTES } catch { return false }
  })
  const wf = workflowOf(workDir)
  const byRel = new Map()
  for (const f of sized) byRel.set(workDir ? path.relative(workDir, f).replace(/\\/g, "/") : path.basename(f), f)
  const { send: rels, held } = WF.pickChatFiles([...byRel.keys()], { mod: wf.mod, values: wf.values, max: MAX_FILES })
  const picked = rels.map((r) => byRel.get(r))
  if (held > 0) text = (text ? text + "\n" : "") + `（另有 ${held} 个中间文件留在软件的会话目录里，可在软件端查看或打包下载）`
  if (!text && !picked.length) return { ok: false, err: "没有可推送的内容" }

  // 投递看门狗的暂存（与 oc-wrap 同一份 .cc-connect\last-reply.json）：个人微信没有长连接，
  // 定时任务到点推送时用户往往几小时没跟机器人说过话，会话令牌必然过期、推送大概率被拒——
  // 先存下来，用户下次一说话（令牌刷新），oc-wrap 开跑前查到失败日志就补发。
  // 【写到目标平台的绑定目录，不是 workDir】workDir 是定时任务自己的新会话目录，
  // 而 oc-wrap 每轮的 cwd 是聊天接入的绑定目录——写错地方它永远看不到。
  for (const p of targets) {
    try {
      const d = path.join(s[p].boundDir, ".cc-connect")
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, "last-reply.json"),
        JSON.stringify({ at: Date.now(), text: String(text || ""), files: picked }))
    } catch {}
  }

  const sendOne = (p) => new Promise((resolve) => {
    const args = ["send", "-p", projectName(p, s[p].boundSid), "-s", per[p].lastSession]
    if (text) args.push("-m", String(text))
    for (const f of picked) args.push(IMG_EXT.has(path.extname(f).toLowerCase()) ? "--image" : "--file", f)
    execFile(ccBin(), args, { windowsHide: true }, (err, _o, se) => resolve(err ? { ok: false, platform: p, err: (String(se) || err.message || "").slice(0, 150) } : { ok: true, platform: p, session: per[p].lastSession }))
  })
  const results = await Promise.all(targets.map(sendOne))
  const ok = results.some((r) => r.ok)
  return { ok, results }
}

export function init(ctx) {
  CTX = ctx
  try { const s = loadState(); if (s.enabled) { const r = start(); if (!r.ok) CTX.log?.("chat-bridge: 自启未成功：" + r.err) } }
  catch (e) { CTX.log?.("chat-bridge: 自启异常：" + e.message) }
}
