// 聊天接入桥（chat-bridge）：把打包版的某个【会话】接到企业微信 / 微信。
//
// 架构（详见 desktop/方案设计-聊天工具接入产品化.md）：
//   企微/微信 ←WebSocket/长轮询← cc-connect（托管子进程）→ spawn oc-wrap.mjs → 内置 opencode
// cc-connect 负责平台协议（MIT，二进制预置在 runtime\cc-connect\，开发机回退 npm 全局），
// 我们负责：生成它的 config.toml、托管生命周期、会话绑定/换绑、把发文件说明书注入会话目录。
//
// 【绑定的语义】绑定会话 = 微信端的对话在该会话的产物目录里干活（文件互通、产物出现在该会话
// 的"产出"侧栏），但微信端是独立的对话上下文（不接管界面里那条对话的历史）。教程里要向用户
// 说清这一点。
//
// 【换绑三件事，顺序有讲究】停桥 → 收回旧目录注入的 AGENTS.md 块 + 注入新目录 → 换 project
// 名重启。project 名带会话 id（sci-<sid8>），cc-connect 的会话状态按 project 落盘
// （~/.cc-connect/sessions/<project>_*.json），换名后旧状态永不复用——否则 cc-connect 会
// resume 一个 directory 钉在【旧目录】的 opencode 会话，消息全落错地方。
//
// 【注入必须可收回】AGENTS.md 用标记块（BLOCK_START/END）追加：会话目录可能是用户自己的
// 文件夹（文件夹会话），里面可能已有用户的 AGENTS.md，绝不能整文件覆盖/删除；收回时只删
// 我们的块，删完变空文件才连文件一起删。

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { spawn, execFileSync, execFile } from "node:child_process"

const BLOCK_START = "<!-- sci-chat-bridge:start 由「聊天接入」自动注入，解绑时自动移除，请勿手工编辑 -->"
const BLOCK_END = "<!-- sci-chat-bridge:end -->"

let CTX = null            // { root, webDir, sessionOut, getModel, log }
let proc = null           // cc-connect 子进程
let restartCount = 0      // 崩溃退避计数（成功存活 60s 后清零）
let lastExit = null       // { code, at } 最近一次异常退出
let startingAt = 0

const dir = () => path.join(CTX.root, "chat-bridge")
const statePath = () => path.join(dir(), "state.json")
const configPath = () => path.join(dir(), "config.toml")
const logPath = () => path.join(dir(), "bridge.log")

// ---- 状态文件（含 bot 凭证，纳入卸载清理；与 cloud-state.json 同待遇）----
const defState = () => ({
  enabled: false,
  platform: "wecom",                    // "wecom" | "weixin"
  // 白名单【按平台分开存】：两边的成员 id 体系完全不同（企微 woXXXX vs 微信 xxx@im.wechat），
  // 共用一个字段的话切平台就会拿错体系的 id 把机主自己拦在门外（真机踩过：微信消息被静默丢弃）
  wecom: { bot_id: "", bot_secret: "", allow_from: "" },
  // weixin（个人号，腾讯官方 ilink 机器人网关）：token 来自扫码（weixinSetup 驱动
  // `cc-connect weixin setup --qr-image` 拿的），account_id/base_url 也是 setup 写回的
  weixin: { token: "", account_id: "", base_url: "", allow_from: "" },
  boundSid: "",
  boundDir: "",                         // 绑定时的绝对目录快照：会话之后被删也要能收回注入块
  progress: true,                       // 长任务进度提示（oc-wrap 里实现）
  model: "",                            // 聊天接入专用模型（modelID，空=跟随界面/网关当前模型）
})
export function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8").replace(/^\uFEFF/, ""))
    const s = {
      ...defState(), ...raw,
      wecom: { ...defState().wecom, ...(raw.wecom || {}) },
      weixin: { ...defState().weixin, ...(raw.weixin || {}) },
    }
    // \u8FC1\u79FB\u65E7\u5B57\u6BB5\uFF1A\u65E9\u671F\u7248\u672C\u7684\u9876\u5C42 allowFrom \u662F\u4F01\u5FAE\u65F6\u4EE3\u8BBE\u7684\uFF0C\u5F52\u5165 wecom
    if (raw.allowFrom && !s.wecom.allow_from) s.wecom.allow_from = String(raw.allowFrom)
    delete s.allowFrom
    return s
  } catch { return defState() }
}
// \u5F53\u524D\u5E73\u53F0\u7684\u767D\u540D\u5355\uFF08\u8BFB\u5199\u90FD\u8D70\u8FD9\u4E24\u4E2A\uFF0C\u522B\u76F4\u63A5\u6478\u5B57\u6BB5\uFF09
const curAllow = (s) => (s.platform === "weixin" ? s.weixin.allow_from : s.wecom.allow_from) || ""
const setCurAllow = (s, v) => { if (s.platform === "weixin") s.weixin.allow_from = v; else s.wecom.allow_from = v }
function saveState(s) {
  fs.mkdirSync(dir(), { recursive: true })
  const tmp = statePath() + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, statePath())
}

// ---- 路径工具 ----
// launcher 传进来的 env 路径常带 \\?\ 前缀（长路径语法），子进程/TOML 里都别用它
const stripLP = (p) => String(p || "").replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "")
// cc-connect 把 cmd 按【空格】拆分（实测），所以 cmd 里的每段路径都不能含空格。
// 短路径（8.3）是最省事的解法；拿不到（卷禁用了 8.3、或 cmd 引号被转义搅坏）就在
// 无空格处建 junction 兜底。（导出仅为单测。）
export function spaceFree(p) {
  p = stripLP(p)
  if (!p.includes(" ")) return p
  try {
    const out = execFileSync("cmd.exe", ["/c", `for %A in ("${p}") do @echo %~sA`], { windowsHide: true }).toString().trim()
    if (out && !out.includes(" ") && fs.existsSync(out)) return out
  } catch {}
  // junction 兜底：建在 ProgramData（路径固定无空格）；只对目录建，文件用 目录junction+文件名。
  // 【名字必须用整个路径的哈希】曾用"路径前 12 字符的 hex"当名字——node 目录和包装器目录
  // 都在 c:\users\<u>\ 下，前缀相同 → 两个目标撞进同一个 junction，包装器路径指进 node
  // 目录找不到文件（真机踩过：Cannot find module ...\j_xxx\oc-wrap.mjs）。
  const st = fs.statSync(p)
  const targetDir = st.isDirectory() ? p : path.dirname(p)
  const juncRoot = path.join(process.env.ProgramData || "C:\\ProgramData", "niuma-chat-bridge")
  fs.mkdirSync(juncRoot, { recursive: true })
  const name = "j_" + crypto.createHash("sha1").update(targetDir.toLowerCase()).digest("hex").slice(0, 16)
  const junc = path.join(juncRoot, name)
  // 已存在的 junction 要核对指向：同名但目标不对（旧版撞车的残留）就重建
  try {
    if (fs.existsSync(junc) && path.resolve(fs.readlinkSync(junc)).toLowerCase() !== path.resolve(targetDir).toLowerCase()) fs.rmSync(junc)
  } catch {}
  if (!fs.existsSync(junc)) fs.symlinkSync(targetDir, junc, "junction")
  return st.isDirectory() ? junc : path.join(junc, path.basename(p))
}

// ---- 二进制定位 ----
export function ccBin() {
  const cands = [
    process.env.SCI_CC_BIN,                                                        // 显式覆盖（测试用）
    path.join(CTX.root, "..", "runtime", "cc-connect", "cc-connect.exe"),          // 打包预置
    path.join(process.env.LOCALAPPDATA || "", "nvm", "v22.14.0", "node_modules", "cc-connect", "bin", "cc-connect.exe"),
    "C:\\nvm4w\\nodejs\\node_modules\\cc-connect\\bin\\cc-connect.exe",            // 开发机 npm 全局
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
  retractAgents(dirAbs)   // 幂等：已有我们的块先删掉再注入，免得重复
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

// ---- config.toml 生成 ----
const tq = (s) => `'${String(s)}'`                       // TOML literal string（Windows 路径不转义）
const projectName = (sid) => "sci-" + String(sid || "unbound").replace(/[^a-zA-Z0-9]/g, "").slice(-8)
export function renderConfig(s) {
  const nodeExe = spaceFree(process.execPath)
  const wrap = spaceFree(path.join(CTX.webDir, "chat-bridge", "oc-wrap.mjs"))
  const cc = ccBin()
  // 模型：聊天接入可单独指定一个（s.model 存 modelID，空=跟随界面/网关当前模型）。
  // provider 恒用网关当前的（云端账号形态下就是 custom，指向本机 /cloud 转发）——聊天接入的
  // opencode 与界面主 opencode 共用同一份 opencode.json 的 provider，只是模型名可以不同。
  const gm = CTX.getModel()   // { providerID, modelID }
  const model = { providerID: gm.providerID, modelID: (s.model || gm.modelID) }
  const env = {
    OPENCODE_CONFIG: stripLP(path.join(CTX.root, "opencode.json")),
    XDG_CONFIG_HOME: stripLP(path.join(CTX.root, ".ocglobal")),
    PATH: [path.dirname(cc), stripLP(process.env.PATH || "")].join(";"),
    SCI_WRAP_OC: ocBin(),                                 // 包装器要 spawn 的真 opencode
    SCI_WRAP_CC: cc,                                      // 包装器产物兜底要调的 cc-connect
    SCI_WRAP_PROGRESS: s.progress ? "1" : "0",
    SCI_WRAP_LOG: path.join(dir(), "wrap.log"),           // 包装器排障日志（不能走 stderr，见 oc-wrap 注释）
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
  }
  // 把网关给 opencode 的技能相关 env 一并带上（REPO_ROOT/SCI_PYTHON/SKILL_DIR/MPL*…）
  for (const k of ["REPO_ROOT", "SCI_PYTHON", "SKILL_DIR", "MPLBACKEND", "MATPLOTLIBRC",
    "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_DISABLE_PIP_VERSION_CHECK",
    "SCI_IMAGE_URL", "SCI_IMAGE_TOKEN", "SCI_OCR_URL", "SCI_OCR_TOKEN"])
    if (process.env[k]) env[k] = stripLP(process.env[k])

  const lines = [
    "# 本文件由打包版「聊天接入」自动生成，每次启动/换绑都会重写 —— 手工修改会被覆盖。",
    `language = "zh"`,
    "",
    "[[projects]]",
    `name = ${tq(projectName(s.boundSid))}`,
    // admin_from 永远不写：/shell /dir 等特权命令在产品形态没有存在理由
    ...(curAllow(s).trim() ? [`allow_from = ${tq(curAllow(s).trim())}`] : []),
    "",
    "[projects.agent]",
    `type = "opencode"`,
    "",
    "[projects.agent.options]",
    `cmd = ${tq(nodeExe + " " + wrap)}`,
    `work_dir = ${tq(s.boundDir)}`,
    `model = ${tq(model.providerID + "/" + model.modelID)}`,
    `mode = "default"`,
    "",
    "[projects.agent.options.env]",
    ...Object.entries(env).map(([k, v]) => `${k} = ${tq(v)}`),
    "",
    "[[projects.platforms]]",
    `type = ${tq(s.platform)}`,
    "",
    "[projects.platforms.options]",
    ...(s.platform === "weixin"
      ? [
        `token = ${tq(s.weixin.token)}`,
        ...(s.weixin.account_id ? [`account_id = ${tq(s.weixin.account_id)}`] : []),
        ...(s.weixin.base_url ? [`base_url = ${tq(s.weixin.base_url)}`] : []),
        ...(s.weixin.allow_from.trim() ? [`allow_from = ${tq(s.weixin.allow_from.trim())}`] : []),
      ]
      : [
        `mode = "websocket"`,
        `bot_id = ${tq(s.wecom.bot_id)}`,
        `bot_secret = ${tq(s.wecom.bot_secret)}`,
      ]),
    "",
  ]
  return lines.join("\n")
}

// ---- 生命周期 ----
export function running() { return !!(proc && proc.exitCode === null) }
export async function stop() {
  if (!running()) { proc = null; return }
  const p = proc; proc = null
  try { p.kill() } catch {}
  // Windows 上 kill 可能留孤儿：给 1.5s 优雅期，再 taskkill 兜底
  await new Promise((r) => { const t = setTimeout(() => r(), 1500); p.once("exit", () => { clearTimeout(t); r() }) })
  if (p.exitCode === null) try { execFileSync("taskkill", ["/F", "/T", "/PID", String(p.pid)], { windowsHide: true }) } catch {}
}
export function start() {
  const s = loadState()
  if (!s.enabled || !supported()) return { ok: false, err: !s.enabled ? "未开启" : "缺 cc-connect 或 opencode 二进制" }
  if (running()) return { ok: true, already: true }
  if (s.platform === "weixin") {
    if (!s.weixin.token) return { ok: false, err: "微信尚未扫码绑定" }
  } else {
    if (!s.wecom.bot_id || !s.wecom.bot_secret) return { ok: false, err: "尚未填写企微机器人凭证" }
  }
  if (!s.boundSid || !s.boundDir) return { ok: false, err: "尚未绑定会话" }
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(configPath(), renderConfig(s))
  const out = fs.openSync(logPath(), "a")
  startingAt = Date.now()
  proc = spawn(ccBin(), ["--config", configPath(), "--force"], {
    cwd: dir(), stdio: ["ignore", out, out], windowsHide: true,
  })
  proc.once("exit", (code) => {
    fs.closeSync(out)
    lastExit = { code, at: Date.now() }
    if (proc === null) return               // stop() 主动杀的，不算崩溃
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

// ---- 微信个人号扫码（腾讯官方 ilink 机器人网关）----
// 流程：spawn `cc-connect weixin setup --config <临时toml> --qr-image <png>` → UI 轮询到
// 二维码就展示 → 用户手机微信扫码 → setup 成功退出并把 token/account_id/base_url/allow_from
// 写进临时 toml → 抽出来存 state（我们每次启动都重写 config.toml，token 必须自己持久化）→
// 临时文件即删（含 token）。扫码期间停桥：ilink 单会话，旧 token 的长轮询会跟新登录打架。
let setupProc = null
let setupInfo = { state: "idle", err: "" }   // idle | running | done | failed
const qrPath = () => path.join(dir(), "weixin-qr.png")
const setupCfgPath = () => path.join(dir(), "weixin-setup.toml")
const platformReady = (s) => (s.platform === "weixin" ? !!s.weixin.token : !!(s.wecom.bot_id && s.wecom.bot_secret))

export async function weixinSetupStart() {
  if (!supported()) return { ok: false, err: "缺 cc-connect 组件" }
  if (setupProc && setupProc.exitCode === null) return { ok: true, already: true }
  fs.mkdirSync(dir(), { recursive: true })
  for (const f of [qrPath(), setupCfgPath()]) { try { fs.rmSync(f) } catch {} }
  await stop()
  // 预写一个带 weixin 平台块的最小配置：setup 是"往既有配置里填 token"的语义，
  // 不依赖它能否从零建文件
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
        s.weixin = { token, account_id: pick("account_id"), base_url: pick("base_url") }
        const af = pick("allow_from")
        if (af) s.weixin.allow_from = af   // setup 若回填扫码者 id——正好实现"只允许机主"（实测不一定回填，靠面板一键锁兜底）
        s.platform = "weixin"
        saveState(s)
        setupInfo = { state: "done", err: "" }
        if (s.enabled && s.boundSid) start()
      } else {
        let tail = ""; try { tail = fs.readFileSync(path.join(dir(), "setup.log"), "utf8").trim().split(/\r?\n/).slice(-3).join(" | ") } catch {}
        setupInfo = { state: "failed", err: "扫码未完成（超时/取消）" + (tail ? "：" + tail.slice(0, 200) : "") }
        // 扫码没成 → 桥要回到原平台继续服务（扫码前 stop() 过；不补这一下，企微就一直断着）
        const s = loadState()
        if (s.enabled && s.boundSid && platformReady(s)) start()
      }
    } catch (e) { setupInfo = { state: "failed", err: e.message } }
    for (const f of [setupCfgPath(), qrPath()]) { try { fs.rmSync(f) } catch {} }   // 临时 toml 含 token，用完即删
  })
  return { ok: true }
}
export function weixinSetup() { return { ...setupInfo, qrReady: fs.existsSync(qrPath()) } }
export function qrFile() { return fs.existsSync(qrPath()) ? qrPath() : "" }
export async function weixinReset() {
  await stop()
  const s = loadState()
  s.weixin = { token: "", account_id: "", base_url: "" }
  saveState(s)
  return { ok: true }
}

// ---- 绑定 / 换绑 / 解绑 ----
export async function bind(sid) {
  const dirAbs = stripLP(await CTX.sessionOut(sid))
  if (!dirAbs) return { ok: false, err: "找不到该会话的产物目录" }
  // 目录可能还没在磁盘上（会话建了但没产出过文件）：路径既然是会话的规范产物目录，补建是安全的
  try { fs.mkdirSync(dirAbs, { recursive: true }) } catch { return { ok: false, err: "会话产物目录无法创建：" + dirAbs } }
  const s = loadState()
  await stop()
  if (s.boundDir && path.resolve(s.boundDir) !== path.resolve(dirAbs)) retractAgents(s.boundDir)  // 自动脱离前一个：收回注入
  injectAgents(dirAbs)
  s.boundSid = sid; s.boundDir = dirAbs                    // 凭证/allowFrom/开关全部沿用 —— 这就是"默认沿用前一个的配置"
  saveState(s)
  restartCount = 0
  const r = s.enabled && platformReady(s) ? start() : { ok: true, idle: true }
  return { ...r, boundSid: sid, boundDir: dirAbs }
}
export async function unbind() {
  const s = loadState()
  await stop()
  if (s.boundDir) retractAgents(s.boundDir)
  s.boundSid = ""; s.boundDir = ""
  saveState(s)
  return { ok: true }
}
export async function setConfig(patch) {
  const s = loadState()
  if (patch.platform === "wecom" || patch.platform === "weixin") s.platform = patch.platform
  if (patch.wecom) s.wecom = { bot_id: String(patch.wecom.bot_id ?? s.wecom.bot_id).trim(), bot_secret: String(patch.wecom.bot_secret ?? s.wecom.bot_secret).trim() }
  if (patch.allowFrom !== undefined) setCurAllow(s, String(patch.allowFrom).trim())   // 写的是【当前平台】的白名单
  if (patch.progress !== undefined) s.progress = !!patch.progress
  if (patch.model !== undefined) s.model = String(patch.model).trim()   // 空串=跟随网关默认
  if (patch.enabled !== undefined) s.enabled = !!patch.enabled
  saveState(s)
  const wasRunning = running()
  await stop()
  restartCount = 0
  // 配置本身已保存成功；「还启动不了」（没绑会话/没填全凭证）不是错误，是流程中间态——
  // UI 的正常顺序就是先存凭证再绑会话，这里报错会把第一步卡死。
  const r = s.enabled ? start() : { ok: true, idle: true }
  return { ok: true, restarted: wasRunning, ...(r.ok === false ? { warn: r.err } : {}) }
}

// ---- 状态（含从日志提取的连接态与最近来信成员）----
export function status() {
  const s = loadState()
  let subscribed = false, seenUsers = [], lastErrLine = ""
  try {
    const tail = fs.readFileSync(logPath(), "utf8").split(/\r?\n/).slice(-400)
    for (const ln of tail) {
      if (ln.includes("wecom-ws: connecting")) subscribed = false     // 以最后状态为准，重连中=未订阅
      if (ln.includes("wecom-ws: subscribed successfully")) subscribed = true
      // weixin 是 HTTP 长轮询没有"订阅成功"事件：platform ready + engine started 即视为在线
      if (s.platform === "weixin" && /msg="platform ready".*platform=weixin/.test(ln)) subscribed = true
      if (/weixin.*(polling stopped|login expired|unauthorized)/i.test(ln)) subscribed = false
      const m = ln.match(/msg="message received".*?\buser=(\S+)/)
      if (m && !seenUsers.includes(m[1])) seenUsers.push(m[1])
      if (/level=ERROR/.test(ln)) lastErrLine = ln.slice(0, 400)
    }
  } catch {}
  return {
    supported: supported(), ccBin: ccBin() ? true : false,
    enabled: s.enabled, running: running(), subscribed,
    boundSid: s.boundSid, boundDir: s.boundDir,
    platform: s.platform,
    wecomConfigured: !!(s.wecom.bot_id && s.wecom.bot_secret),
    weixinConfigured: !!s.weixin.token,
    bot_id: s.wecom.bot_id,                                  // secret/token 永远不回给前端
    allowFrom: curAllow(s), progress: s.progress, model: s.model,
    seenUsers: seenUsers.slice(-10), lastError: lastErrLine,
    lastExit, weixinSetup: weixinSetup(),
  }
}

// ---- 主动推送（定时任务跑完把结果发到绑定的微信/企微对话）----
// 定时任务是独立进程、不在 cc-connect 的 session 上下文里，所以 send 必须【显式指定
// project + session】（不指定时 cc-connect 报 "no active session"，实测）。
// project 名由 boundSid 推出；session key 从桥日志里最近一条 "message received" 提取
// ——即"用户最后一次跟机器人说话的那个对话"，推给它最符合直觉。
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"])
export function lastSessionKey() {
  try {
    const tail = fs.readFileSync(logPath(), "utf8").split(/\r?\n/).slice(-800)
    let key = ""
    for (const ln of tail) { const m = ln.match(/msg="message received".*?\bsession=(\S+)/); if (m) key = m[1] }
    return key
  } catch { return "" }
}
export async function pushToChat({ text, files } = {}) {
  const s = loadState()
  if (!running()) return { ok: false, err: "聊天接入未运行（软件需开着并已连接）" }
  if (!status().subscribed) return { ok: false, err: "聊天接入未连接，无法推送" }
  const session = lastSessionKey()
  if (!session) return { ok: false, err: "还没有对话记录，无法确定推送对象（先在微信/企微里跟机器人说句话）" }
  const args = ["send", "-p", projectName(s.boundSid), "-s", session]
  if (text) args.push("-m", String(text))
  for (const f of (files || [])) {
    try { if (fs.existsSync(f)) args.push(IMG_EXT.has(path.extname(f).toLowerCase()) ? "--image" : "--file", f) } catch {}
  }
  if (args.length <= 6 && !text) return { ok: false, err: "没有可推送的内容" }
  return await new Promise((resolve) => {
    execFile(ccBin(), args, { windowsHide: true }, (err, _out, stderr) => {
      if (err) resolve({ ok: false, err: (String(stderr) || err.message || "").slice(0, 200) })
      else resolve({ ok: true, session })
    })
  })
}

export function init(ctx) {
  CTX = ctx
  // 开机自启：上次是开启且绑定完整的状态 → 直接拉起（失败不阻塞网关启动）
  try { const s = loadState(); if (s.enabled) { const r = start(); if (!r.ok) CTX.log?.("chat-bridge: 自启未成功：" + r.err) } }
  catch (e) { CTX.log?.("chat-bridge: 自启异常：" + e.message) }
}
