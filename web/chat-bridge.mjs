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
// 给用户看的名字（报错文案用）。别在别处再各写一遍中文名。
const PLAT_CN = { wecom: "企业微信", weixin: "个人微信" }
// 个人微信的发送配额（cc-connect 的 platform/weixin 用 burst_limit / burst_window_secs 读）。
// 【为什么不用它的默认值】它默认 4 条/24 小时，依据只是作者源码注释里的一次黑盒实测
// （"ilink 约 5-6 条/天"）——而同一个仓库的 config.example.toml 却写着"0.5 条/秒、罚约一小时"，
// 两处差了四个数量级；联网查证也没找到腾讯公开过任何频率数字，第三方实测指向的都是
// 秒~小时级短窗口节流。默认值太严：2026-08-15 真机上 4 条提示就把当天额度烧光，
// 之后所有真实回复全被它自己挡下，用户什么都收不到。
// 【别再往上调，这个数是实测出来的】2026-08-15 先按"短窗口"口径试过 100/小时，另一台机器
// 实测【发到第 20 条就被限流】——所以平台的真实阈值比短窗口口径低得多，也比作者注释的
// "4 条/24h"高。取 15/小时：明显低于观测到的 20，留出安全余量；正常聊天一轮一条回复，
// 15 条足够，真撞上也会在回复末尾提前告知（见 oc-wrap 的 budgetNotice）。
// 配套的保守策略见 oc-wrap：微信上不发任何过程消息（思考只在最后随答案发一次）、
// 产物超过 5 个打成压缩包发（每个文件各计一条配额，见 cc-connect 的 media_outbound.go）。
const WEIXIN_BURST_LIMIT = 15
const WEIXIN_BURST_WINDOW_SECS = 3600
const WEIXIN_BURST_WARN = 10

let CTX = null            // { root, webDir, sessionOut, getModel, getCloudEnv, log }
let proc = null           // cc-connect 子进程
let restartCount = 0      // 崩溃退避计数（成功存活 60s 后清零）
let lastExit = null       // { code, at } 最近一次异常退出
let startingAt = 0

const dir = () => path.join(CTX.root, "chat-bridge")
const statePath = () => path.join(dir(), "state.json")
const configPath = () => path.join(dir(), "config.toml")
const logPath = () => path.join(dir(), "bridge.log")
// 【私有 data_dir】cc-connect 默认把内部 API 的 socket 放 ~\.cc-connect\run\api.sock —— 一条
// 【全机唯一】的路径。而 --force 的语义是"杀掉 config 相同的实例"，管不住用户自己装的那份
// （配置在 ~\.cc-connect\config.toml，我们的在 bundle 里）。两个实例轮流 unlink-rebind 同一个
// socket，谁后退出谁留下一个没人监听的孤儿文件：进程活着、日志照写 "api server started"、
// 客户端却 ECONNREFUSED。症状是【文字正常、发文件全哑】—— 正文走 oc-wrap 的 stdout 管道不碰
// socket，而附件/思考/进度全靠 `cc-connect send` 连这个 socket（2026-08-16 另一台机器实测）。
// 把 data_dir 整个挪到我们私有的目录，从根上不与任何别的 cc-connect 共用这条路径。
// 【服务端和客户端各认各的开关，两边都要设】2026-08-16 实测（vendor 的 fix.3）：
//   · 服务端只认 config.toml 的 `data_dir`（见 renderConfig），给它 CC_DATA_DIR 完全无效；
//   · 客户端 `cc-connect send` 只认 CC_DATA_DIR（见 commonEnv）—— 它是 oc-wrap 起的新进程，
//     不带 --config，不设就回落到 ~\.cc-connect。
// 只改一边比不改更糟：服务端和客户端分处两个目录，发文件从"偶尔坏"变成"必然坏"。
// 【必须放短路径】Windows 的 AF_UNIX 同样吃 108 字节的 sockaddr_un 限制，而装机路径
// ...\Niuma Science\bundle\app\chat-bridge\ 再挂 data\run\api.sock 已经 90 字节，用户名长一点
// 就直接 bind 失败 —— 所以放 LOCALAPPDATA 下的短目录，不跟着 dir() 走。实测超长时 cc-connect
// 只记一条 WARN "api server unavailable" 就照常跑下去，日志一点都不刺眼（故有下面的长度闸）。
const ccDataDir = () => path.join(process.env.LOCALAPPDATA || os.homedir(), "niuma-cc")
const ccSockPath = () => path.join(ccDataDir(), "run", "api.sock")
// 起桥前清掉上一轮的 socket 残留：我们自己崩掉 / 被 taskkill /T 收走时它不会被清理，而残留
// 文件会让客户端"连得上路径、连不上人"。此刻我们没有在跑的实例（running() 已在 start() 里
// 挡掉），私有 data_dir 下也不会有别人的实例，所以删它是安全的。
function clearStaleSock() {
  try { fs.rmSync(ccSockPath(), { force: true }) }
  catch (e) { CTX.log?.("chat-bridge: 清理残留 api.sock 失败（不阻塞起桥）: " + e.message) }
}
// ---- 排查路标：把"服务端在哪、该用哪个 exe、命令怎么敲"写在手边 ----
//
// 【为什么需要】data_dir 搬进私有目录之后，手敲 `cc-connect send` 会【静默指向空位置】：
// 默认路径 ~\.cc-connect 那边没人监听，报错只说"这条路径连不上"，【不会说服务端其实在别处】。
// 机器上通常还有第二份 cc-connect（npm 全局装的，往往是更老的版本，连 CC_DATA_DIR 都不认），
// 而 `--data-dir` 又【只有 send 子命令接受】—— 三件事叠在一起，排查一次要绕很多圈（2026-08-16
// 真机上就绕了十几轮）。所以起桥时把这些事实写死在 chat-bridge\ 目录里，别让人再去猜。
export function writeDebugHelp() {   // 导出仅为单测
  const exe = ccBin(), dd = ccDataDir()
  try {
    // 只包 send：--data-dir 是 send 专属，做成万能转发反而会让 --version 之类报错。
    fs.writeFileSync(path.join(dir(), "cc-send.cmd"),
      "@echo off\r\n" +
      "rem 手动给聊天接入发消息/发文件。exe 与 data_dir 已预置，直接：cc-send.cmd -m \"hello\"\r\n" +
      "rem 【注意】真发出去会占用个人微信的发送额度（每天只有几条），别拿它当探活手段。\r\n" +
      `"${exe}" send --data-dir "${dd}" %*\r\n`)
    fs.writeFileSync(path.join(dir(), "如何手动排查.txt"), [
      "聊天接入 手动排查备忘（每次起桥自动重写，改了也会被覆盖）",
      "",
      "【服务端在哪】",
      `  data_dir : ${dd}`,
      `  socket   : ${ccSockPath()}`,
      `  可执行档 : ${exe}`,
      "",
      "【最常见的坑】直接敲 cc-connect 多半是错的",
      "  PATH 里那个 cc-connect 往往是 npm 全局装的另一份（版本可能老很多），",
      "  它默认连 ~\\.cc-connect\\run\\api.sock —— 那里【没有人监听】，必然报",
      "    dial unix ...: connect: No connection could be made ...",
      "  这【不代表坏了】，只代表你敲的那份客户端找错了地方。",
      "  老版本连 CC_DATA_DIR 环境变量都不认，必须显式传 --data-dir（且只有 send 收这个参数）。",
      "",
      "【正确的敲法】",
      `  "${exe}" send --data-dir "${dd}" -m "hello"`,
      "  或直接用同目录下预置好的： cc-send.cmd -m \"hello\"",
      "",
      "【还会卡住的两个参数】（2026-08-16 实测，两台机器都在这里绕了很久）",
      "  · 绑了两个平台时必须指定 project，否则回 project is required：",
      "      cc-send.cmd -p <project 名>  ← 名字在同目录 config.toml 的 name = '...' 里",
      "  · 当前没有进行中的对话时，还要显式给会话 key，否则回 no active session：",
      "      cc-send.cmd -p <project> -s <会话key>",
      "    会话 key 从 bridge.log 里捞： 搜 session=weixin:dm:  （企微是 session=wecom:...）",
      "  两个都给齐了才会真发出去（回 Message sent successfully.）。",
      "  发文件/图片：把 -m 换成或加上 --image <路径> / --file <路径>。",
      "",
      "【怎么确认通不通，又不烧额度】",
      "  跑上面的命令但【当前没有进行中的对话】时，会回：",
      "    no active session   或   project is required (multiple projects configured)",
      "  这两种都是【连上之后】的应用层回复 —— 看到它们就说明 socket 是好的，消息并没有发出去。",
      "  反之只有 connect: refused / socket not found 才是真没通。",
      "",
      "【真没通时看这两处】",
      "  bridge.log 里搜 \"api server started\"，确认它绑的就是上面那个 socket 路径；",
      "  搜 \"api server unavailable\" —— 出现它说明 bind 失败了（多半是路径太长，见 AF_UNIX 108 字节上限）。",
      "",
      "【发送失败最常见的原因不是 socket，是额度】",
      "  个人微信对机器人的发送条数掐得很紧（上游注释：约 5-6 条/天）。",
      "  日志里 \"send budget exhausted\" 或 ilink 的 ret=-2 都属于限流，不是连不上，",
      "  而且限流期间每次重试都会加重惩罚 —— 遇到就停手等，别重试。",
      "",
    ].join("\r\n"))
  } catch (e) { CTX.log?.("chat-bridge: 写排查备忘失败（不阻塞起桥）: " + e.message) }
}
// ---- 一次性迁移：把旧 data_dir 的个人微信 context_token 搬进私有目录 ----
//
// 【为什么必须搬】读 cc-connect 源码（platform/weixin）确认的机制：
//   · context_token 【只能从入站消息里拿到】—— 长轮询与心跳都不带它，没有任何主动刷新途径；
//   · 拿到即落盘到 <data_dir>/weixin/<project>/<bot>/context_tokens.json，且【不记过期时间】，
//     启动时原样读回（loadTokens），所以它是【可跨重启复用的持久凭据】；
//   · 发送【强制】要它：没有就直接报 "context_token is required for send"，主动推送根本发不出去。
// 于是换 data_dir 会让 token 表从空开始：升级后第一次主动推送（定时任务、产物补发）必然失败，
// 直到用户先在微信里发一条消息。这是 0.1.31 换私有目录带来的一次性回归 —— 起因是我先前把
// context_token 误判成"分钟级过期的易失数据"（那其实是 ret=-2，属 ilink 的发送限流，不是过期）。
//
// 【只搬 token，不搬 get_updates.buf】后者是长轮询游标，搬过去可能重收或漏收消息，而它本来就
// 会自己重新同步 —— 拿"可能丢消息"换"少一次同步"，不划算。
// 【只在目标缺失时搬 + 标记文件】两重幂等：别把用户后来刷新出来的新 token 覆盖成旧的。
const oldCcDir = () => path.join(process.env.USERPROFILE || os.homedir(), ".cc-connect")
export function migrateContextTokens(projectDirName) {   // 导出仅为单测
  const marker = path.join(ccDataDir(), ".tokens-migrated")
  if (fs.existsSync(marker)) return { ok: true, skipped: "已迁移过" }
  const srcRoot = path.join(oldCcDir(), "weixin")
  const dstRoot = path.join(ccDataDir(), "weixin")
  const done = []
  try {
    if (fs.existsSync(srcRoot) && projectDirName) {
      // 旧目录按 project 分层，而 project 名带着当时绑定的会话 id（换绑就换名）。token 本身是
      // 【按对话方(peer)】存的、与 project 无关，所以跨 project 取最新的那份即可。
      const byBot = new Map()   // bot 目录名 → { file, mtime }
      for (const proj of fs.readdirSync(srcRoot)) {
        const pd = path.join(srcRoot, proj)
        let bots = []; try { bots = fs.readdirSync(pd) } catch { continue }
        for (const bot of bots) {
          const f = path.join(pd, bot, "context_tokens.json")
          let st; try { st = fs.statSync(f) } catch { continue }
          const cur = byBot.get(bot)
          if (!cur || st.mtimeMs > cur.mtime) byBot.set(bot, { file: f, mtime: st.mtimeMs })
        }
      }
      for (const [bot, { file }] of byBot) {
        const dst = path.join(dstRoot, projectDirName, bot, "context_tokens.json")
        if (fs.existsSync(dst)) continue          // 新的已经有了，别覆盖
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(file, dst)
        done.push(bot)
      }
    }
    fs.mkdirSync(ccDataDir(), { recursive: true })
    fs.writeFileSync(marker, new Date().toISOString() + " " + (done.join(",") || "(无可搬运的 token)") + "\n")
    if (done.length) CTX?.log?.(`chat-bridge: 已从旧 data_dir 迁移 ${done.length} 份 context_token（升级后首次主动推送不必再等用户先发消息）`)
    return { ok: true, migrated: done }
  } catch (e) {
    CTX?.log?.("chat-bridge: 迁移 context_token 失败（不阻塞起桥，最坏情况是首次推送前需用户先发一条）: " + e.message)
    return { ok: false, err: e.message }
  }
}

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
function commonEnv(s, platform) {
  const cc = ccBin()
  const env = {
    OPENCODE_CONFIG: stripLP(path.join(CTX.root, "opencode.json")),
    XDG_CONFIG_HOME: stripLP(path.join(CTX.root, ".ocglobal")),
    PATH: [path.dirname(cc), stripLP(process.env.PATH || "")].join(";"),
    SCI_WRAP_OC: ocBin(),
    SCI_WRAP_CC: cc,
    // 【服务端与客户端必须同一个 data_dir】oc-wrap 里每一条 `cc-connect send`（附件、思考、
    // 进度、抢救补推）都是【新进程】，它自己按 CC_DATA_DIR 找 socket。桥进程的环境变量不
    // 一定原样传到这一层，所以这里显式再写一遍，别只靠继承。少了它 = 服务端在私有目录、
    // 客户端还去 ~\.cc-connect 找，症状与本次修的 bug 一模一样（文字通、文件全哑）。
    CC_DATA_DIR: ccDataDir(),
    // 【个人微信每天只有 ~4 条独立消息的预算】cc-connect 的 platform/weixin 里实测得出：
    // ilink 对机器人约 5-6 条/天就开始限流（ret=-2），它自己卡在 4 条快速失败。所以进度提示、
    // 思考推送、静默播报这类"附加消息"在微信上是【奢侈品】——2026-08-15 真机：我加的静默播报
    // 在一轮限速里连发 4 条，把当天额度烧光，之后所有真实回复全被配额闸挡下，用户什么都收不到。
    // 企微是 websocket 长连接，没有这个限制，照常。
    SCI_WRAP_PLATFORM: platform,
    // 与下面写进 config.toml 的 burst_limit 同源，别两处各写一个数
    SCI_WRAP_SEND_LIMIT: String(WEIXIN_BURST_LIMIT),
    SCI_WRAP_SEND_WARN: String(WEIXIN_BURST_WARN),
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
  // 直播中继（软件侧实时看到微信这一轮的思考与工具执行）：地址+令牌都是网关本进程算出来的，
  // 与生图/OCR 同理，主进程 env 里没有，只能由 init 传进来的 getLiveEnv 取实时值。
  Object.assign(env, CTX.getLiveEnv?.() || {})
  return env
}
function renderProject(s, platform) {
  const b = s[platform]
  const nodeExe = spaceFree(process.execPath)
  const wrap = spaceFree(path.join(CTX.webDir, "chat-bridge", "oc-wrap.mjs"))
  const gm = CTX.getModel()
  const modelStr = gm.providerID + "/" + (s.model || gm.modelID)
  const env = commonEnv(s, platform)
  const platOpts = platform === "weixin"
    ? [
      // 排队时那句「消息已收到，将在当前任务完成后处理」不发：它每条都是一条独立消息，
      // 和真正的回复抢同一格额度，而且合并开着时这些消息本来就会并成一轮，说了也没意义。
      `notify_queued = false`,
      `burst_limit = ${WEIXIN_BURST_LIMIT}`,
      `burst_window_secs = ${WEIXIN_BURST_WINDOW_SECS}`,
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
    // 用户连着发几条时，把堆在队列里的消息折成一轮再交给模型。
    // 【为什么开】不合并的话每条各起一轮：既多烧一次上游调用（限速时尤其疼），模型每轮又只
    // 看到半截意图——「改成 12:55」「改成 13:00」分开跑会先白改一次。合并后它一次看到完整意图。
    // 命令（/new 等）、不同发送者、纯附件消息都不会被折进来，见 cc-connect 的 mergeQueuedMessages。
    // 【需要 fix.2 及以上的 cc-connect】官方 v1.4.1 不认这个键；TOML 里多一个不认识的键是安全的
    // （被忽略），所以退回官方版也不会起不来，只是不合并而已。
    `merge_queued_messages = true`,
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
    // 【服务端的 data_dir 只认这个键，不认 CC_DATA_DIR】2026-08-16 实测：环境变量只有客户端
    // （`cc-connect send`）认，服务端照样绑 ~\.cc-connect\run\api.sock。所以两边【各用各的
    // 机制】才能对齐 —— 服务端写这里，客户端在 commonEnv 里给 CC_DATA_DIR，两者同一个值。
    // 只改一边比不改更糟：服务端与客户端分处两个目录，发文件 100% 哑掉。
    `data_dir = ${tq(ccDataDir())}`,
    "",
  ].join("\n")
  return head + activePlats(s).map((p) => renderProject(s, p)).join("\n")
}

// ---- 生命周期 ----
export function running() { return !!(proc && proc.exitCode === null) }
// getCloudEnv 输出的快照（起桥写 config.toml 那一刻）。env 是烘进 config 的，之后
// 登录态再变，跑着的桥不会自己知道 —— syncCloudEnv 拿当前值与快照比对来决定要不要重启。
let bakedCloudSig = ""
// 直播中继的地址/令牌也烘在 config.toml 里（端口与令牌都随网关进程走），一并纳入快照比对
const cloudSig = () => JSON.stringify([CTX?.getCloudEnv?.() || {}, CTX?.getLiveEnv?.() || {}])
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
  fs.mkdirSync(path.join(ccDataDir(), "run"), { recursive: true })
  clearStaleSock()
  // 长度闸：见 ccDataDir 上面那段。bind 失败只有一条 WARN，排查起来要跨机器折腾半天，
  // 这里先吼一声。留 8 字节余量（108 上限，含结尾 NUL）。
  // 见 migrateContextTokens 的头注：换私有 data_dir 会把【可跨重启复用】的 context_token 落在
  // 旧目录里，导致升级后第一次主动推送必然失败。只在微信绑着时有意义（企微是长连接、不用它）。
  if (s.weixin.boundSid) migrateContextTokens(projectName("weixin", s.weixin.boundSid))
  writeDebugHelp()   // 排查路标：见该函数头注（手敲 cc-connect 会静默找错地方，这是最省时间的一步）
  CTX.log?.(`chat-bridge: data_dir=${ccDataDir()}（手动排查见 chat-bridge\\如何手动排查.txt，或用同目录 cc-send.cmd）`)
  const sockLen = Buffer.byteLength(ccSockPath())
  if (sockLen > 100) CTX.log?.(`chat-bridge: ⚠ api socket 路径过长（${sockLen}B > 100B），` +
    `cc-connect 可能 bind 失败 → 发文件/思考/进度全部失效（正文仍正常）。路径：${ccSockPath()}`)
  fs.writeFileSync(configPath(), renderConfig(s))
  bakedCloudSig = cloudSig()
  const out = fs.openSync(logPath(), "a")
  startingAt = Date.now()
  proc = spawn(ccBin(), ["--config", configPath(), "--force"], {
    cwd: dir(), stdio: ["ignore", out, out], windowsHide: true,
    env: { ...process.env, CC_DATA_DIR: ccDataDir() },
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
    // 与起桥同一个 data_dir：扫码进程也会起一个 api server，让它跟桥共用私有目录，
    // 别去 ~\.cc-connect 跟别人抢那条全机唯一的 socket（抢完退出就留下孤儿文件）。
    `data_dir = ${tq(ccDataDir())}`,
    "[[projects]]", `name = 'setup'`,
    "[projects.agent]", `type = "opencode"`,
    "[[projects.platforms]]", `type = "weixin"`,
    "[projects.platforms.options]", `token = ""`, "",
  ].join("\n"))
  const out = fs.openSync(path.join(dir(), "setup.log"), "w")
  setupInfo = { state: "running", err: "" }
  setupProc = spawn(ccBin(), ["weixin", "setup", "--config", setupCfgPath(), "--project", "setup",
    "--qr-image", qrPath(), "--timeout", "300"], { cwd: dir(), stdio: ["ignore", out, out], windowsHide: true,
    env: { ...process.env, CC_DATA_DIR: ccDataDir() } })   // 客户端侧的开关，与上面的 data_dir 配套
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
export async function pushToChat({ text, files, dir: workDir, only } = {}) {
  const s = loadState()
  if (!running()) return { ok: false, err: "聊天接入未运行（软件需开着并已连接）" }
  const { per } = parseLog()
  // 目标平台，优先级从高到低：
  //   ① only —— 调用方点名的平台（定时任务的 pushTo 字段）。定时任务跑在自己的新会话目录里，
  //      ② 的 platformOfDir 必然认不出来，于是会落到 ③ 双发；用户只勾了一个「推送到微信/企微」
  //      却两边各收一份，这个参数就是让他能指定推给谁。
  //   ② 绑了这个产物目录的平台（聊天里直接对话的场景，目录就是绑定目录）。
  //   ③ 都认不出来 → 推所有在线平台（历史行为，pushTo 留空时保持不变）。
  let targets = []
  if (only && PLATFORMS.includes(only)) targets = [only]
  else {
    const byDir = workDir ? platformOfDir(workDir) : null
    targets = byDir ? [byDir] : activePlats(s).filter((p) => per[p].subscribed)
  }
  targets = targets.filter((p) => per[p].subscribed && per[p].lastSession)
  if (!targets.length) {
    // 点名了却推不出去，要说清是"这个平台没连上"，不能笼统说"没有已连接的对话"——
    // 用户明明在另一个平台上聊着天，那句话只会让他以为是软件坏了。
    return { ok: false, err: only
      ? `${PLAT_CN[only] || only}没有可推送的对话（没连上，或还没跟机器人说过话）`
      : "没有可推送的已连接对话（先在微信/企微里跟机器人说句话）" }
  }

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
