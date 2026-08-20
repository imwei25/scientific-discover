#!/usr/bin/env node
// opencode 事件流包装器（产品版）——给 cc-connect 当 agent 用。cc-connect 每收到一条消息
// 就 spawn 一次 `oc-wrap run …`，prompt 经【stdin】喂进来（v1.4.1：cmd.Stdin = prompt），
// 图片经 `--file <path>` 传，普通文件被存到 work_dir\.cc-connect\attachments\ 并把绝对路径
// 拼进 prompt 尾部「(Files saved locally, please read them: …)」。本包装器做四件事：
//
//  1) 过滤/聚合思考：默认丢弃 reasoning（思考过程），只在开「输出思考」时把它【聚合成一条】
//     在正文前推给聊天平台（SCI_WRAP_THINKING=1）。工具（tool）事件【任何时候都不外发】——
//     既防泄露又防长任务刷爆企微限速（30 条/分，errcode 846607）。
//  2) 进度提示：长任务每 45s 把工具活动压成一条聚合消息（cc-connect send -m），
//     替代被过滤掉的逐条刷屏。SCI_WRAP_PROGRESS=0 关闭。
//  3) 先上传后提问（SCI_WRAP_UPLOAD_FIRST=1）：一条消息若【只发了文件、没带问题】，就把文件
//     暂存进 work_dir\.cc-connect\staged\ 并回一句「已收到」，【不跑模型】（上传本身不触发会话）；
//     等用户真正提问时，把这些暂存文件的路径并进 prompt 一起交给模型。关掉则保持原样：
//     发文件即当场分析。
//  4) 产物兜底：run 结束后扫描工作目录新文件，模型忘了调 cc-connect send 也自动补发
//     （已在事件流里看见模型自己 send 过的路径会跳过，不重复发）。**只补发主产物**——
//     判据复用界面侧栏那一份（workflows.mjs 的 chatSendable / pickChatFiles），中间文件只
//     在随附文案里报个数，不往手机上轰（见那边的长注释）。
//
// 真 opencode 路径来自 env SCI_WRAP_OC，cc-connect 路径来自 SCI_WRAP_CC —— 都由
// chat-bridge.mjs 生成 config.toml 时注入，本文件不写死任何路径。
// 非 run 子命令（session list/delete、models…）原样透传。

import { spawn, execFile } from "node:child_process"
import http from "node:http"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"

// 直接被 node 跑起来才执行入口分发；被单测 import 时只暴露纯函数，不碰 stdin/进程。
// 【不能只比字符串】cc-connect 经【无空格 junction】调 oc-wrap（见 chat-bridge 的 spaceFree），
// argv[1] 是 junction 路径、import.meta.url 却是解析后的真实路径，两者永不相等 → main() 不执行、
// 聊天返回空响应（0.1.24 真机踩过）。所以两边都 realpath 到规范路径、小写化再比，吃掉
// junction / 8.3 短路径 / 盘符大小写的差异。
const canon = (p) => { try { return fs.realpathSync(p).toLowerCase() } catch { return String(p || "").toLowerCase() } }
const isMain = !!process.argv[1] && canon(fileURLToPath(import.meta.url)) === canon(process.argv[1])

// ---- 死也要留话（诊断）------------------------------------------------------
// 【为什么必须有这一层】本包装器【绝不能写 stderr】——cc-connect 会把 stderr 当错误消息发进
// 聊天。代价是它一旦异常退出就【完全静默】：cc-connect 拿不到 stdout，替换成占位符「(空响应)」
// 发给用户，而日志里什么都没有，根本无从查起。
// 真机 2026-08-15 12:51 就撞上：用户在 agent 忙时追发消息 → 排队 → 排队那轮 707ms 结束、
// opencode 连实例都没创建（opencode.log 里那个时段没有任何 run），用户只看到「(空响应)」。
// 所以：所有诊断信息一律写 SCI_WRAP_LOG（wrap.log），并在【确实一个字都没输出】时往 stdout
// 兜一句人话，别让用户对着「(空响应)」干瞪眼、也不知道该不该重发。
const wlog = (s) => {
  try {
    if (process.env.SCI_WRAP_LOG) {
      fs.appendFileSync(process.env.SCI_WRAP_LOG, `${new Date().toISOString()} [pid ${process.pid}] ${s}\n`)
    }
  } catch { /* 日志失败绝不能反过来搞挂本轮 */ }
}
let producedStdout = false        // 本轮有没有真的往 stdout 吐过东西（= 用户能看到内容）
let spawnedOpencode = false       // 有没有走到"起 opencode"这一步（用来区分死在包装器还是死在模型侧）
let exitReason = ""               // 已知的退出原因，供 exit 钩子写进日志
export function markStdout() { producedStdout = true }

process.on("uncaughtException", (e) => { exitReason = "uncaughtException: " + (e?.stack || e?.message || e); process.exit(1) })
process.on("unhandledRejection", (e) => { exitReason = "unhandledRejection: " + (e?.stack || e?.message || e) })
process.on("exit", (code) => {
  // 【用 process.argv 而不是下面那个 args】args 定义在本文件靠后，若进程在模块求值阶段就退出，
  // 这里读它会撞 TDZ 抛 ReferenceError，把仅有的诊断也一起弄没了。
  if (!isMain || process.argv[2] !== "run") return
  if (producedStdout) { if (exitReason) wlog(`本轮有输出但记到异常：${exitReason}`); return }
  // 一个字都没输出 —— 这正是用户看到「(空响应)」的那一刻，务必留下现场
  wlog(`⚠ 本轮零输出 exit=${code} 起过opencode=${spawnedOpencode} 原因=${exitReason || "（未知，无异常抛出）"} cwd=${process.cwd()}`)
  try {
    process.stdout.write(spawnedOpencode
      ? "⚠️ 这一轮模型没有返回内容（可能是上一条还在跑时被打断）。请把刚才那句话再发一次。"
      : "⚠️ 这一轮没能启动起来（常见于上一条还在处理时又追发了消息）。请等上一条回复完，再把刚才那句话发一次。")
  } catch { /* stdout 都写不了就真没辙了，日志已留 */ }
})

// 【已证伪，别再试】曾怀疑 cc-connect 对排队轮次是"1 秒内没等到第一个字节就放弃"，于是在这里
// 抢在慢 import 之前吐一个字节试图"点亮"管道。真机实测（2026-08-15 13:10）：首字节在
// cc-connect 开始处理后 68ms 就写出去了，它仍在 460ms 之后判定为空、发出「(空响应)」占位符。
//
// 【真正的根因（读 cc-connect 源码查实，2026-08-15）】我们的 stdout **是被读的**，问题在于
// 这一轮被外部提前判了"完成"：agent/opencode/session.go 里每次 Send() 都新起一个 opencode 进程，
// 而上一轮的进程在打完 step_finish 之后【还要拖几百毫秒才真正退出】，它的 readLoop 一直活到
// stdout EOF，然后触发兜底的 sendEventResult()。偏偏去重标志 resultSent 是 per-session 的、
// 会被下一次 Send() 重置——出队正好落在这个窗口里：上一轮的 EOF 兜底把一个【过期的 EventResult】
// 打进了新一轮，引擎当成新一轮完成了，此时模型还没出字 → 空响应。
// 这解释了全部现象：只有出队第一条会踩（只有它起在上一轮的拖尾窗口内）、放弃时长 528/704/1090ms
// 无规律（= 上一轮进程的退出延迟）、以及早吐首字节为什么没用（不是没读，是被外部提前关掉了）。
// 上游修法：给每次 Send() 加 turnGen 代次计数，过期 readLoop 的终结事件一律丢弃。
// 下面的 stdoutAbandoned() 是我们这侧的兜底，在用户还没升级到修好的 cc-connect 之前仍然有用。

// 产物分级判据与界面侧栏共用一份（web/workflows.mjs）。动态 import + 兜底：这份文件万一
// 加载不了（老界面包、打包漏文件），聊天不能整个哑掉 —— 退回"只发成品扩展名"的保守口径。
let WF = null
try { WF = await import("../workflows.mjs") } catch { WF = null }
// 零依赖 zip（与界面「打包下载」同一份实现）。加载不了就不打包、退回逐个发。
let ZIPPER = null
try { ZIPPER = await import("../minizip.mjs") } catch { ZIPPER = null }
const FALLBACK_DELIVERABLE = /\.(docx?|pdf|xlsx?|xlsm|pptx?|png|jpe?g|svg|tiff?|eps|zip|md|csv)$/i
const FALLBACK_SECRET = /(mapping|_map|crosswalk|对照表|还原表|keyfile).*\.csv$/i
/** 相对路径数组 → { send, held }。WF 在就用它，不在就用上面两条保守规则。（导出仅为单测。） */
export function pickOutputs(rels, mod, values, max = 5) {
  if (WF?.pickChatFiles) return WF.pickChatFiles(rels, { mod, values, max })
  const ok = rels.filter((r) => {
    const segs = r.split("/")
    if (segs.some((s) => s.startsWith("."))) return false
    if (segs[0].toLowerCase() === "uploads") return false
    const base = segs[segs.length - 1]
    return FALLBACK_DELIVERABLE.test(base) && !FALLBACK_SECRET.test(base)
  })
  const send = ok.slice(0, max)
  return { send, held: rels.length - send.length }
}
/** 会话目录里的 _workflow.json（网关写的簿子）→ 这个会话属于哪个模块、表单填了什么。 */
function workflowOf(d) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(d, "_workflow.json"), "utf8"))
    if (!st || typeof st.module !== "string") return { mod: "", values: null }
    return { mod: st.module, values: st.form && typeof st.form === "object" ? st.form : null }
  } catch { return { mod: "", values: null } }
}

const REAL_OC = process.env.SCI_WRAP_OC
const CC = process.env.SCI_WRAP_CC || "cc-connect"

// ---- 投递看门狗（个人微信丢消息的补发）--------------------------------------
// 个人微信（ilink）**没有长连接**：收消息靠长轮询，发消息受 ilink 的**限流配额**约束
// （约 5-6 条/天就开始拒收，cc-connect 自己卡在 4 条 fail fast）。于是长任务跑完时回复
// 常被平台拒收（bridge.log：`sendMessage ret=-2 "prepare failed"`），用户看到的就是
// "空响应/没收到"，而正文在软件端完好——丢在 cc-connect 往微信投递的最后一步，
// 且 cc-connect 只记日志、不补发。企微是 websocket 长连接、无此配额，没有这个问题。
//
// 【别再把 ret=-2 归因成"会话令牌过期"】曾经这么写过，是错的。查 cc-connect 源码
// （platform/weixin/weixin.go 的 isSendThrottled 上方注释）：ret=-2 "prepare failed" 是
// **bot 全局的限流惩罚**，"the gateway accepts any (or no) context_token on sends"。
// context_token 从来信里抓取后按 peer 存盘（context_tokens.json）、跨进程重启存活、
// **无 TTL 无淘汰**，它只是 cc-connect 侧"这个 peer 得先跟机器人说过话"的准入门槛
// （外加换 typing ticket）。所以主动推送隔几小时照发不误——真正会拒收的只有配额。
// 补发时机仍取"用户下一条消息进来时"，理由不是令牌刷新，而是那会儿离上次失败通常
// 已隔了一段时间、惩罚期多半过了（惩罚期内再发会加重，见 cc-connect sendChunk 注释）。
// 所以：
//   · 每轮结束把最终答案 + 兜底补发的文件暂存进 .cc-connect\last-reply.json；
//   · 下一轮开跑前查 bridge.log 里暂存时刻之后有没有投递失败，有 → 先补发暂存内容再答新问题。
// 定时任务的推送（chat-bridge 的 pushToChat）也写同一个暂存文件，同样在下次对话时兜底。
const lastReplyFile = () => path.join(process.cwd(), ".cc-connect", "last-reply.json")
// 发送记账：窗口内每条独立消息的时间戳。cc-connect 侧的配额是进程内存、我们看不见，
// 所以自己记一份用来【提前告诉用户】——只用于提示，不做任何拦截（拦截交给 cc-connect）。
const sendLogFile = () => path.join(process.cwd(), ".cc-connect", "send-log.json")
const SEND_WINDOW_MS = 3600_000
function noteSend(n = 1) {
  try { if (BUDGET_TIGHT) bumpQuota(n) } catch {}   // 微信才有额度这回事；企微是长连接
  try {
    const f = sendLogFile()
    let times = []
    try { times = JSON.parse(fs.readFileSync(f, "utf8")) } catch {}
    if (!Array.isArray(times)) times = []
    const now = Date.now()
    times = times.filter((t) => Number.isFinite(t) && now - t < SEND_WINDOW_MS)
    for (let i = 0; i < n; i++) times.push(now)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(times))
    return times.length
  } catch { return 0 }
}
function usedSends() {
  try { return countRecentSends(JSON.parse(fs.readFileSync(sendLogFile(), "utf8")), Date.now(), SEND_WINDOW_MS) }
  catch { return 0 }
}
// 与 chat-bridge.mjs 写进 config.toml 的 burst_limit 保持一致；由 env 传入避免两处写死。
const SEND_LIMIT = Number(process.env.SCI_WRAP_SEND_LIMIT) || 0
const SEND_WARN_AT = Number(process.env.SCI_WRAP_SEND_WARN) || 0

// ---- 微信主动发送额度：距【上次来信】发了几条 --------------------------------
// 【2026-08-20 实测定案，别再改回时间模型】ilink 给机器人的主动发送额度是
// **每收到一条用户来信重置一次**，一次约 10 条；用尽后所有发送被 ret=-2 拒。
//   · 时间【不】解禁：整夜每小时试一次，02:13 起连续 5 次全被拒（详见 memory）；
//   · 桥重启【不】解禁：那只清 cc-connect 的内存计数，腾讯是按来信记账的；
//   · 唯一的解禁事件就是【用户再发一条消息】。
// 所以在第 9 条时把话说明白，让用户回一句把额度续上——这比事后补发有用得多。
// 计数落在绑定目录（oc-wrap 每条消息都是新进程，内存里存不住），定时任务的
// pushToChat 也往同一个文件记；oc-wrap 被拉起 = 刚收到来信 = 归零。
const quotaFile = () => path.join(process.cwd(), ".cc-connect", "quota.json")
export const QUOTA_WARN_AT = 9
function readQuota() {
  try { const j = JSON.parse(fs.readFileSync(quotaFile(), "utf8")); return Number.isFinite(j?.n) ? j.n : 0 }
  catch { return 0 }
}
function writeQuota(n) {
  try {
    fs.mkdirSync(path.dirname(quotaFile()), { recursive: true })
    fs.writeFileSync(quotaFile(), JSON.stringify({ n, at: Date.now() }))
  } catch {}
}
function bumpQuota(k = 1) { const n = readQuota() + k; writeQuota(n); return n }
function resetQuota() { writeQuota(0) }
// 本轮答案是"上次来信之后的第几条"。只读一次并记住：微信上进度/思考/播报全关，
// 跑的过程中不会再有别的发送来改这个数，而 text 事件是逐字流式的、不能每次都读盘。
let quotaBaseMemo = null
function answerOrdinal() {
  if (quotaBaseMemo === null) quotaBaseMemo = readQuota()
  return quotaBaseMemo + 1
}

/**
 * 第 warnAt 条时给用户的额度提醒（纯函数，导出仅为单测）。
 * 【必须搭在正文那条消息里】自己单发一条会再吃掉一格额度，正是要避免的事；
 * 而且收尾时写 stdout 已经晚了（cc-connect 在 step_finish 就定稿，见落款那段头注）。
 */
export function quotaNotice(ordinal, warnAt = QUOTA_WARN_AT) {
  if (ordinal !== warnAt) return ""
  return "\n\n———\n" +
    `📮 当前已经是您上次发信息之后的第 ${warnAt} 条回复，受微信平台限制，` +
    `第 ${warnAt + 1} 条将触顶，请您及时向机器人回复任意信息，否则从第 ${warnAt + 2} 条开始信息将无法送达。`
}
// bridge.log 与 wrap.log 同目录（都由 chat-bridge.mjs 定在 <root>\chat-bridge\ 下）
const bridgeLogPath = () =>
  process.env.SCI_WRAP_LOG ? path.join(path.dirname(process.env.SCI_WRAP_LOG), "bridge.log") : ""
// 网关日志在应用根：<app>\gateway.log，即 chat-bridge 目录的上一级。
// 用它来回答"为什么半天没动静"——云端排队/上游限速只写在这里（网关只把它 SSE 广播给网页界面，
// 聊天这条链路收不到，2026-08-15 真机：用户问美股，10 分钟零反馈，gateway.log 里 6 条「上游限速中」）。
const gatewayLogPath = () =>
  process.env.SCI_WRAP_LOG ? path.join(path.dirname(path.dirname(process.env.SCI_WRAP_LOG)), "gateway.log") : ""

/**
 * 从 gateway.log 【本轮新增的部分】里认出"为什么卡着"。（纯函数，导出仅为单测。）
 * 【只看新增部分】gateway.log 里的行没有时间戳，无法判断新旧；用起跑时记下的字节偏移当分界，
 * 是这里唯一站得住的"最近"判据。
 */
/**
 * 该不该发一条「还没动静」的播报？（纯函数，导出仅为单测。）
 * 两个都得满足：距最后一次事件够久（quiet），且距上一次播报也够久（别刷屏）。
 * 首次门槛比后续短——此刻用户屏幕上什么都没有，等太久他就以为软件死了、开始反复重发。
 */
export function silenceDue({ now, lastEventAt, lastSilenceAt, notices, first, repeat, max }) {
  if (notices >= max) return false
  const due = notices === 0 ? first : repeat
  return now - lastEventAt >= due && now - lastSilenceAt >= due
}

export function stallReason(tailText) {
  const s = String(tailText || "")
  if (/上游限速中/.test(s)) return "云端上游正在限速（大家都在用，得排队）"
  if (/排队第\s*\d+\s*位/.test(s)) {
    const m = /排队第\s*(\d+)\s*位/.exec(s)
    return `云端排队中（当前第 ${m[1]} 位）`
  }
  return ""
}
const RESEND_TTL = 24 * 3600_000   // 隔天再来问别的，还补发昨天的旧答案就很怪了
const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"])

/**
 * bridge.log 文本里、sinceMs 之后有没有【微信】投递失败。（纯函数，导出仅为单测。）
 * text = 正文没送出去（ERROR：platform send failed / chunk send failed, message incomplete）；
 * media = 图片/文件没送出去（WARN：ret=-2 for media）。留 5s 时钟余量。
 * 只认 weixin 相关行：企微（websocket）不丢，别把无关失败当成补发信号。
 */
export function deliveryFailedSince(logText, sinceMs) {
  const out = { text: false, media: false }
  for (const ln of String(logText || "").split(/\r?\n/)) {
    const m = /^time=(\S+)/.exec(ln)
    if (!m) continue
    const t = Date.parse(m[1])
    if (!Number.isFinite(t) || t < Number(sinceMs) - 5000) continue
    if (!/weixin/i.test(ln)) continue
    if (/level=ERROR/.test(ln) && /(platform send failed|chunk send failed)/.test(ln)) out.text = true
    if (/ret=-2 for media/.test(ln)) out.media = true
    // 第三种长相（2026-08-19 真机漏网）：ilink 限流把【正文】整条拒收 ——
    //   WARN msg="weixin: sendMessage declined by API" ret=-2 errmsg="prepare failed"
    // 正文被拒后 cc-connect 不再发后面的附件，所以既算 text 失败也算 media 失败，
    // 补发时把暂存的文件一并带上（只按旧两条判，文件会被当成"已送达"而永久丢失）。
    if (/sendMessage declined by API/.test(ln) && /ret=-2/.test(ln)) { out.text = true; out.media = true }
  }
  return out
}

/**
 * 本轮的 stdout 是不是已经被 cc-connect 抛弃了？（纯函数，导出仅为单测。）
 *
 * 【背景】cc-connect v1.4.1 的一个竞态：上一轮 opencode 进程在打完 step_finish 后还要拖几百毫秒
 * 才退出，它的 readLoop 在 EOF 时触发兜底 sendEventResult()，而去重标志 resultSent 已被下一次
 * Send() 重置——于是这个【过期的完成事件】把刚开始的新一轮提前判了"完成"，此时模型还没出字，
 * 用户收到占位符「(空响应)」。只有【出队的第一条】会踩（只有它起在上一轮的拖尾窗口内）。
 * 真机三次实测（2026-08-15 12:51/13:04/13:10）：放弃时长 704/1090/528ms（= 上一轮进程的退出
 * 延迟，故无规律），且抢在 68ms 吐首字节也没用（不是没读，是被外部提前关掉了）。
 * opencode 那一轮其实跑完了、活也干对了（用户的定时任务确实被改掉），丢的只有回复。
 * 上游已定位并修复（turnGen 代次守卫）；本函数是用户升级到修好的 cc-connect 之前的兜底。
 *
 * 【判据】bridge.log 里出现一条属于**我们这个 agent_session**、时间落在
 *   (我们启动之后, 我们吐出第一个字节之前)
 * 的 `turn complete` —— 那一定是 cc-connect 在我们还没产出任何东西时就替我们"完成"了本轮。
 * 用「首个字节之前」而不是「本进程还活着」来卡，是为了排掉上一轮的 wrapper：它此刻可能仍在
 * 做收尾（送文件、等 send 回调），但它的答案早就写出去了，first-out 时刻远在这条记录之前，
 * 不会被误判成"被抛弃"，也就不会重复推送一遍。
 *
 * @param logText  bridge.log 全文
 * @param agentSession  argv 里 `--session` 的值
 * @param startMs  本进程起跑时刻
 * @param firstOutMs  首个 stdout 字节的时刻；还没输出过传 Infinity
 */
export function stdoutAbandoned(logText, agentSession, startMs, firstOutMs) {
  if (!agentSession) return false
  for (const ln of String(logText || "").split(/\r?\n/)) {
    if (!ln.includes("turn complete")) continue
    if (!ln.includes(`agent_session=${agentSession}`)) continue
    const m = /^time=(\S+)/.exec(ln)
    if (!m) continue
    const t = Date.parse(m[1])
    if (!Number.isFinite(t)) continue
    if (t > Number(startMs) && t < Number(firstOutMs)) return true
  }
  return false
}

/**
 * argv 里 `--session <id>` 的值 —— 与 bridge.log 里 `agent_session=<id>` 是同一个东西，
 * 用它把日志行圈到本次对话，别去匹配别人的 turn。（纯函数，导出仅为单测。）
 */
export function agentSessionOf(argv) {
  const i = (argv || []).indexOf("--session")
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : ""
}

/** 每轮收尾暂存（text/files 都空就不写——没东西可补）。 */
function saveLastReply(text, files) {
  try {
    const t = String(text || "").trim()
    const fl = (files || []).filter(Boolean)
    if (!t && !fl.length) return
    fs.mkdirSync(path.dirname(lastReplyFile()), { recursive: true })
    fs.writeFileSync(lastReplyFile(), JSON.stringify({ at: Date.now(), text: t, files: fl }))
  } catch {}
}

/** 新一轮开跑前调用：上一轮的投递失败了就补发。一次性（读完即删，绝不重复补）。 */
function resendLostReply() {
  try {
    const f = lastReplyFile()
    if (!fs.existsSync(f)) return
    const j = JSON.parse(fs.readFileSync(f, "utf8"))
    fs.rmSync(f)
    if (!j || !Number.isFinite(j.at) || Date.now() - j.at > RESEND_TTL) return
    const logF = bridgeLogPath()
    if (!logF || !fs.existsSync(logF)) return
    // 只读日志尾部 256KB：够覆盖一天的量，也不怕日志长了拖慢每轮启动
    const st = fs.statSync(logF)
    const size = Math.min(st.size, 256 * 1024)
    const buf = Buffer.alloc(size)
    const fd = fs.openSync(logF, "r")
    try { fs.readSync(fd, buf, 0, size, st.size - size) } finally { fs.closeSync(fd) }
    const fail = deliveryFailedSince(buf.toString("utf8"), j.at)
    if (!fail.text && !fail.media) return
    const args2 = ["send"]
    let txt = fail.text ? String(j.text || "") : ""
    if (txt.length > 1800) txt = txt.slice(0, 1800) + "…（太长截断，全文在软件的会话里）"
    if (txt) args2.push("-m", "📮 上一条回复当时没送到（微信那边发消息的次数到限了，过一阵会自动放开），补发：\n" + txt + SIGNATURE)
    const files = fail.media ? (Array.isArray(j.files) ? j.files : []).filter((p) => { try { return fs.existsSync(p) } catch { return false } }).slice(0, 5) : []
    for (const p of files) args2.push(IMG_EXTS.has(path.extname(p).toLowerCase()) ? "--image" : "--file", p)
    if (args2.length <= 1) return
    noteSend((txt ? 1 : 0) + files.length)   // 补发也吃额度：正文 1 条 + 每个附件各 1 条
    execFile(CC, args2, { windowsHide: true }, () => {})
    if (process.env.SCI_WRAP_LOG)
      try { fs.appendFileSync(process.env.SCI_WRAP_LOG, new Date().toISOString() + ` 补发上轮丢失投递 text=${!!txt} files=${files.length}\n`) } catch {}
  } catch {}
}
// 【个人微信每天只有 ~4 条独立消息的预算，附加消息是奢侈品】
// cc-connect 的 platform/weixin 实测：ilink 对机器人约 5-6 条/天就开始限流（ret=-2），且惩罚期内
// 继续发会加重，所以它自己卡在 4 条就 fail fast（defaultBurstLimit=4 / 24h）。
// 2026-08-15 真机血的教训：我加的「静默播报」在一轮云端限速里连发 4 条，把当天额度一次烧光，
// 之后【所有真实回复】全被配额闸挡下（bridge.log 连续 4 条 send budget exhausted），
// 用户在微信里什么都收不到——附加提示把它本要保护的东西挤掉了。
// 所以微信上：进度提示、思考推送、静默播报一律关，每轮只留【一条正式回复】。
// 企微是 websocket 长连接、没有这个配额，一切照旧。
/**
 * 一小时窗口内已经发了多少条独立消息 —— 用来在临近平台上限时提前告诉用户。（纯函数，导出仅为单测。）
 * 记录存在会话目录的 .cc-connect/send-log.json 里（跨轮次累计；oc-wrap 每条消息都是新进程，
 * 内存里存不住）。窗口滑动，过期的自动淘汰。
 */
export function countRecentSends(times, now, windowMs) {
  return (times || []).filter((t) => Number.isFinite(t) && now - t < windowMs).length
}

/**
 * 临近上限时给用户的提示，用普通人能懂的话。（纯函数，导出仅为单测。）
 * 不单独发一条——由调用方【搭在正常回复末尾】，否则提醒自己又吃掉一格，正是要避免的事。
 * 还很宽裕就返回空串（别没事吓唬人）。
 */
export function budgetNotice(used, limit, warnAt = Math.floor(limit * 0.8)) {
  if (!limit || used < warnAt) return ""
  if (used >= limit) {
    return "\n\n———\n📵 微信这边一小时内能发的消息数量已经到顶了，接下来的回复可能收不到。" +
      "过一会儿会自动恢复（大约一小时内逐步放开），不用做任何操作；急着看结果可以打开电脑上的软件。"
  }
  return `\n\n———\n📮 提示：微信一小时内能发的消息数量快到上限了（已用 ${used}/${limit}）。` +
    "如果接下来有回复没收到，等一会儿会自动恢复，不用重发。"
}

// 产物多于这个数就打包（仅微信）。与 pickOutputs 的 MAX_SEND 同口径：到了这个量级，
// 逐个发既吃配额（每个文件各计一条）又刷屏。
export const ZIP_THRESHOLD = 5

/**
 * 把多个产物压成一个 zip，返回压缩包路径；失败返回 ""（调用方退回逐个发，绝不因此丢交付）。
 * 复用仓库里那份零依赖的 minizip —— 与界面「打包下载」同一套实现。
 */
function zipFiles(files, workDir) {
  try {
    if (!ZIPPER?.zip) return ""
    const entries = files.map((f) => ({
      name: (workDir ? path.relative(workDir, f).replace(/\\/g, "/") : "") || path.basename(f),
      data: fs.readFileSync(f),
    }))
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")
    const out = path.join(workDir || process.cwd(), `交付物_${stamp}.zip`)
    fs.writeFileSync(out, ZIPPER.zip(entries))
    return out
  } catch (e) { wlog("打包产物失败（退回逐个发）：" + (e?.message || e)); return "" }
}

/**
 * 聊天里【不报路径】：把消息里的绝对路径压成文件名，纯目录压成「会话目录」。（纯函数，导出仅为单测。）
 * 【为什么在代码里做而不只靠提示词】用户在手机上，`D:\projects\...\outputs\<会话id>\fig.png` 这种串
 * 既占屏又点不开——他要的是文件本身（走 cc-connect send 发过去），不是路径。提示词管不住每一次
 * （模型顺手就写出来了），所以在出口处兜一道。软件端仍能在会话目录里看到全部文件，信息没丢，
 * 只是不往聊天里堆。只动【绝对路径】：相对文件名（report.docx）与 URL 都不碰。
 */
// 路径的终止字符：空白、引号、括号、竖线，以及中文标点（否则 "…\fig.png，" 会把逗号一起吞掉）
// （?<![\w:] 挡住 URL：https://a.cn/x 里的 "s:/" 否则会被当成盘符路径）
// 路径里【允许空格】（装机目录就叫 "Niuma Science"），但只在这个空格后面还有分隔符时才吃进来，
// 否则 "…\table1.xlsx 请查收" 会把后半句一起吞掉。
const WIN_ABS = /(?<![\w:])(?:[A-Za-z]:|\\\\[^\s"'`<>|*?\n)\]\\/，。、；：！？」）】]+)[\\/](?:[^\s"'`<>|*?\n)\]，。、；：！？」）】]| (?=[^ ]*[\\/]))*/g
const NIX_ABS = /(?<![\w.:/])\/(?:home|root|app|mnt|srv|opt|Users|tmp|var|outputs)\/(?:[^\s"'`<>|*?\n)\]，。、；：！？」）】]| (?=[^ ]*\/))*/g
export function scrubPaths(text) {
  const one = (m) => {
    const clean = m.replace(/[\\/]+$/, "").replace(/[.,;:]+$/, "")
    const seg = clean.split(/[\\/]/).pop() || ""
    return /\.[A-Za-z0-9]{1,8}$/.test(seg) ? seg : "会话目录"
  }
  return String(text ?? "").replace(WIN_ABS, one).replace(NIX_ABS, one)
}

// 每轮回复末尾的落款（一轮只加一次：优先加在正文那条，没有正文才加在附件那条）。
export const SIGNATURE = "\n\n-----\n来自Niuma Science科研小助手"

// ---- 续用绑定会话（手机消息接在软件里选定的那条会话后面）--------------------
// 【语义（2026-08-20 定）】绑定会话不再只是"目录锚点"：cc-connect 的调用里只有【它自己
// 新起会话的第一条】不带 --session —— 在那一刻注入 `--session <绑定会话id>`，opencode 就会
// 续跑软件里选定的那条会话；事件流回带 sessionID 后 cc-connect 自己学走，之后每轮都带对，
// 注入只发生一次。可行的根据：界面会话 id 就是 opencode 会话 id（server.mjs createSession
// 直接用 client.session.create 的返回），且网关的 serve 与这里的 `opencode run` 共用同一份
// 会话存储（同一套 OPENCODE_CONFIG / XDG_CONFIG_HOME——网关能列出并打开 cc-connect 建的
// 会话，就是这条通路一直在被使用的证据）。
// 【/new 逃生舱】注入时在绑定目录记"已收编"标记；此后再遇到不带 --session 的调用 = 用户
// 发了 /new（cc-connect 清掉了自己记的会话），放行让它另起新会话——绑定会话上下文太重时
// 用户还有退路。换绑到别的会话（boundSid 变了）标记自动失效、重新收编。
const BOUND_SID = process.env.SCI_WRAP_BOUND_SID || ""
const adoptFile = () => path.join(process.cwd(), ".cc-connect", "bound-adopted.json")
function readAdopted() {
  try { return String(JSON.parse(fs.readFileSync(adoptFile(), "utf8"))?.sid || "") } catch { return "" }
}
function writeAdopted(sid) {
  try { fs.mkdirSync(path.dirname(adoptFile()), { recursive: true }); fs.writeFileSync(adoptFile(), JSON.stringify({ sid, at: Date.now() })) } catch {}
}
/** 该注入就返回注入后的新 argv，不该注入返回 null。（纯函数，导出仅为单测。） */
export function adoptBoundSession(argv, boundSid, adoptedSid) {
  if (!boundSid) return null                              // 老版 chat-bridge 没传 → 保持原行为
  if ((argv || []).includes("--session")) return null     // cc-connect 已在续某个会话，别插手
  if (adoptedSid === boundSid) return null                // 已收编过还不带 --session = /new，放行
  const i = argv.indexOf("run")
  if (i < 0) return null
  const out = argv.slice()
  out.splice(i + 1, 0, "--session", boundSid)
  return out
}

// ---- 路线切换：/task 切到最近一次定时任务的会话，/back 切回绑定会话 ----------
// 【为什么要有】定时任务的推送产自它自己的会话目录——用户在手机上就推送内容追问时，
// 绑定会话的 agent 对"刚推送了什么"一无所知，必然答非所问。与其把推送上下文硬塞进
// 绑定会话，不如让用户自己选路线：/task 后消息真的发进任务那条会话（完整上下文+产物
// 都在），/back 随时回来。推送尾部会附上这两条指令（见 chat-bridge 的 pushToChat）。
// 【指令怎么到我们手里】cc-connect 对不认识的斜杠指令有明确行为（core/engine.go:2947
// 注释原文 "Unrecognized slash command — fall through to agent as normal message"），
// 内建表里没有 task/back、前缀匹配也不撞（timer/tts/bind 都不以它们开头）——消息会
// 原样落到 oc-wrap 的 stdin，我们在起 opencode 之前截下来处理，不烧模型。
// 【四种路线态】route.json 的 { mode, sid?, prev? }：
//   bound（默认，每次新绑定重置回它）→ 消息定向到绑定会话（--session 强制改写）；
//   task → 定向到 last-task.json 记的那条任务会话（opencode 子进程 cwd 也切到它的目录，
//          与续绑定会话同构：cwd = session.directory）。prev 记着切走前在哪（/back 按它还原：
//          原会话不一定是绑定会话——可能是 /new 出来的自由会话）；
//   pin  → 钉在指定 sid 的会话上（/back 回到 /new 会话时用：cc-connect 那时已学成任务会话的
//          id，不强制改写就回不去了。这些会话都建在绑定目录里，cwd 不用切）；
//   free → 用户发过 /new（cc-connect 自己另起了会话），我们不插手，等 /task 或 /back 归位。
const routeFile = () => path.join(process.cwd(), ".cc-connect", "route.json")
const lastTaskFile = () => path.join(process.cwd(), ".cc-connect", "last-task.json")
function readRoute() {
  try {
    const j = JSON.parse(fs.readFileSync(routeFile(), "utf8"))
    if (j?.mode === "task" || j?.mode === "free") return j
    if (j?.mode === "pin" && j?.sid) return j
    return { mode: "bound" }
  } catch { return { mode: "bound" } }
}
function writeRoute(route) {
  try { fs.mkdirSync(path.dirname(routeFile()), { recursive: true }); fs.writeFileSync(routeFile(), JSON.stringify({ ...route, at: Date.now() })) } catch {}
}
function readLastTask() {
  try {
    const j = JSON.parse(fs.readFileSync(lastTaskFile(), "utf8"))
    if (!j?.sid || !j?.dir) return null
    if (!fs.existsSync(j.dir)) return null   // 任务会话目录已被删 → 没有可切的目标
    return j
  } catch { return null }
}
/** 这条消息是不是路线指令：整条恰为 /task 或 /back 才算。【故意不剥附件引用块】——
 *  指令配着文件发时当普通消息落给模型，别把文件悄悄吞了。（纯函数，导出仅为单测。） */
export function routeCommandOf(prompt) {
  const t = String(prompt || "").trim().toLowerCase()
  if (t === "/task") return "task"
  if (t === "/back") return "back"
  return ""
}
/**
 * 按当前路线决定本轮的目标会话与 argv。（纯函数，导出仅为单测。）
 * 返回 { argv, sid, dir, adopt, setRoute }：argv 非 null = 要改写；sid = 目标会话（busy 探针
 * 与直播用）；dir 非空 = opencode 子进程要切到的工作目录；adopt = 本轮完成了绑定会话的
 * 首次收编（真正开跑时才落标记）；setRoute 非 null = 路线要迁移（/new → free）。
 */
export function routeArgs(argv, { route, boundSid, adoptedSid, task }) {
  const out = { argv: null, sid: "", dir: "", adopt: false, setRoute: null }
  if (!argv || argv[0] !== "run") return out
  const mode = route?.mode || "bound"
  const i = argv.indexOf("--session")
  const has = i >= 0 && !!argv[i + 1]
  // 钉住某条会话（task = 钉任务会话并切 cwd；pin = 钉 /back 回去的原会话，cwd 不动）
  const pinSid = mode === "task" && task ? task.sid : mode === "pin" ? route.sid : ""
  if (pinSid) {
    if (has) {
      out.sid = pinSid
      if (mode === "task") out.dir = task.dir
      if (argv[i + 1] !== pinSid) { const a = argv.slice(); a[i + 1] = pinSid; out.argv = a }
      return out
    }
    out.setRoute = { mode: "free" }   // 钉住期间发了 /new → cc-connect 另起新会话，放行并回自由态
    return out
  }
  if (mode === "free") { out.sid = has ? String(argv[i + 1]) : ""; return out }
  // bound（默认；mode=task 但任务目标已失效也落到这，等于自动切回绑定会话）
  if (has) {
    if (boundSid && argv[i + 1] !== boundSid) {   // /back 之后 cc-connect 还记着任务会话 → 改写回来
      const a = argv.slice(); a[i + 1] = boundSid; out.argv = a
    }
    out.sid = boundSid || String(argv[i + 1])
    return out
  }
  const injected = adoptBoundSession(argv, boundSid, adoptedSid)
  if (injected) { out.argv = injected; out.sid = boundSid; out.adopt = true; return out }
  if (boundSid && adoptedSid === boundSid) out.setRoute = { mode: "free" }   // 已收编还不带 --session = /new
  return out
}
/**
 * /task 与 /back 的路线迁移（纯函数，导出仅为单测）。cur = 当前 route；curSid = 这条指令
 * argv 里的 --session（= 用户此刻所在的会话，cc-connect 对指令消息照样带它）。
 * 【/back 回的是"切走前所在的会话"，不一定是绑定会话】用户可能先 /new 到一条自由会话再
 * /task ——所以 /task 时把"当时在哪"存进 prev，/back 按 prev 还原；回自由会话要用 pin 态
 * 钉住（cc-connect 那时已学成任务会话的 id，不强制改写就回不去）。连按 /task 保留原 prev。
 * /back 而当前不在任务路线上 → 兜底回绑定会话（再按一次 /back 的语义就是"回家"）。
 */
export function routeSwitch(cmd, cur, curSid) {
  if (cmd === "task") {
    const prev = cur.mode === "task" ? (cur.prev || { mode: "bound" })
      : cur.mode === "bound" ? { mode: "bound" }
      : cur.mode === "pin" ? { mode: "pin", sid: cur.sid }
      : { mode: "free", sid: curSid || "" }
    return { mode: "task", prev }
  }
  const prev = cur.mode === "task" ? cur.prev : null
  if ((prev?.mode === "pin" || prev?.mode === "free") && prev.sid) return { mode: "pin", sid: prev.sid }
  if (prev?.mode === "free") return { mode: "free" }   // 没能记下原会话 id：至少别把人拽回绑定会话
  return { mode: "bound" }
}
// 任务会话目录里补上聊天接入的 AGENTS.md 块（教 agent 用 cc-connect send 发文件）。
// 标记串必须与 chat-bridge.mjs 的 BLOCK_START/END 保持一字不差（解绑时靠它收回）。
function ensureAgentsBlock(dirAbs) {
  try {
    const f = path.join(dirAbs, "AGENTS.md")
    const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""
    if (cur.includes("sci-chat-bridge:start")) return
    const tpl = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "agents-template.md"), "utf8")
    fs.writeFileSync(f, cur +
      "\n\n<!-- sci-chat-bridge:start 由「聊天接入」自动注入，解绑时自动移除，请勿手工编辑 -->\n" +
      tpl.trim() + "\n<!-- sci-chat-bridge:end -->\n")
  } catch (e) { wlog("任务目录注入 AGENTS.md 失败（不阻塞本轮）：" + (e?.message || e)) }
}

/** 这个平台的发送预算紧不紧（纯函数，导出仅为单测）。 */
export const budgetTightFor = (p) => p === "weixin"
const PLATFORM = process.env.SCI_WRAP_PLATFORM || ""
const BUDGET_TIGHT = budgetTightFor(PLATFORM)
// 微信上【彻底不发】进度提示与静默播报——它们最不值钱，却和真正的回复抢同一格额度。
// 企微是 websocket、无此配额，照常。
const PROGRESS = process.env.SCI_WRAP_PROGRESS !== "0" && !BUDGET_TIGHT
// 思考在两个平台都保留，但【发法完全不同】：企微 30s 一条独立消息（长连接、无配额）；
// 微信【一条都不单发】，全部 inline 并进答案那一条（走 stdout，整体只算 1 条，分块不计费）。
// 代价：微信上长任务期间彻底安静（进度提示本来也是关的），换的是不跟真正的回复抢那 15 格额度。
const THINKING = process.env.SCI_WRAP_THINKING === "1"
const UPLOAD_FIRST = process.env.SCI_WRAP_UPLOAD_FIRST === "1" // 「先上传后提问」：只发文件不触发会话
const args = process.argv.slice(2)

// ---- 软件侧直播中继（把本轮的思考/工具/正文回传给网关）------------------------
// 【要解决什么】cc-connect 起的这个 opencode 进程【不经过网关的 opencode serve】，网关的事件
// 订阅一个事件都收不到 —— 于是微信那边正跑得热火朝天，用户打开软件却看不到"在跑"，更没有
// 思考与工具执行，只能干等整轮结束后在历史里读一段正文。我们这里本来就在逐行解析事件流
// （为了过滤思考、聚合进度），顺手转发一份给网关，它造个影子 job 广播给界面（见 server.mjs
// 的 bridgeIngest）。
// 【铁律：绝不能影响微信这一条主链路】发送全是 fire-and-forget，任何失败只吞掉；地址/令牌没注入
// （老版网关、单测）就整块静默关闭；队列有上限，网关挂了也不会把内存撑爆。
const LIVE_URL = process.env.SCI_WRAP_LIVE_URL || ""
const LIVE_TOKEN = process.env.SCI_WRAP_LIVE_TOKEN || ""
const LIVE_MAX_Q = 400          // 网关不通时最多攒这么多条，超了丢最老的（直播丢帧无所谓，内存不能涨）
const LIVE_FLUSH_MS = 300       // 攒一小会儿再发：思考/正文一秒能来几十条，一条一个请求纯属浪费
// 会话 id：cc-connect 每轮都带 --session，只有【它自己新起会话】的第一条没有 —— 那时先留空，
// 由网关按"工作目录 + 本轮起跑时刻"认领（bridgeResolveSid），认出来后回传给我们记住。
let liveSid = agentSessionOf(args)
const liveStartedAt = Date.now()
const liveQ = []
let liveTimer = null, liveSending = false
export function liveNote(ev) {
  if (!LIVE_URL) return
  liveQ.push(ev)
  while (liveQ.length > LIVE_MAX_Q) liveQ.shift()
  if (!liveTimer) { liveTimer = setTimeout(() => liveFlush(), LIVE_FLUSH_MS); liveTimer.unref?.() }
}
/** 把队列里的事件发一次；cb 在这次请求收尾（成功/失败/超时）后必被调用一次。（导出仅为单测。） */
export function liveFlush(cb) {
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null }
  const done = (() => {
    let called = false
    return () => {
      if (called) return
      called = true; liveSending = false
      // 这次请求期间又攒下了新事件 → 立刻排下一班，别等下一条 liveNote 来推
      if (liveQ.length && !liveTimer) { liveTimer = setTimeout(() => liveFlush(), LIVE_FLUSH_MS); liveTimer.unref?.() }
      cb && cb()
    }
  })()
  // 已有一发在路上：留着队列等它回来时自然接上（done 里会排下一班）。cb 交给调用方的兜底超时。
  if (liveSending) return
  if (!LIVE_URL || !liveQ.length) { done(); return }
  liveSending = true
  // 正文事件带的是【累计全文】，一批里只有最后一条有意义（前面的都是它的前缀）
  const evs = liveQ.splice(0, liveQ.length)
  const lastText = evs.map((e, i) => (e.k === "text" ? i : -1)).filter((i) => i >= 0).pop()
  const payload = evs.filter((e, i) => e.k !== "text" || i === lastText)
  const body = JSON.stringify({ sid: liveSid, dir: process.cwd(), startedAt: liveStartedAt, events: payload })
  try {
    const u = new URL(LIVE_URL)
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: "Bearer " + LIVE_TOKEN },
    }, (res) => {
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", (d) => { buf += d.length > 4096 ? "" : d })
      res.on("end", () => {
        // 网关认领出会话 id 了 → 记住，后面几轮不必再让它猜
        try { const j = JSON.parse(buf); if (!liveSid && j?.sid) liveSid = String(j.sid) } catch {}
        done()
      })
      res.on("error", done)
    })
    req.on("error", done)
    req.setTimeout(3000, () => { try { req.destroy() } catch {} ; done() })
    req.end(body)
  } catch { done() }
}
/** 绑定会话此刻是不是被软件端的一轮占着？问网关的 /api/chat-bridge/busy（与直播中继同一套
 *  地址与令牌）。续用绑定会话后，同一条会话可能出现两个写者：软件端在跑（真 job）、手机又来
 *  一条 —— 两个 opencode 进程并发写同一份会话历史会互相搅，所以起 opencode 前先问一句。
 *  【一律 fail-open】查不到 / 超时 / 老网关没这个端点，都按"不忙"放行——探针失灵不能瘫掉聊天。 */
function checkSessionBusy(sid, cb) {
  if (!LIVE_URL || !LIVE_TOKEN || !sid) return cb(false)
  let called = false
  const done = (busy) => { if (!called) { called = true; cb(!!busy) } }
  try {
    const u = new URL(LIVE_URL)
    const req = http.request({
      hostname: u.hostname, port: u.port || 80,
      path: "/api/chat-bridge/busy?sid=" + encodeURIComponent(sid), method: "GET",
      headers: { Authorization: "Bearer " + LIVE_TOKEN },
    }, (res) => {
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", (d) => { buf += d.length > 4096 ? "" : d })
      res.on("end", () => { try { done(JSON.parse(buf)?.busy) } catch { done(false) } })
      res.on("error", () => done(false))
    })
    req.on("error", () => done(false))
    req.setTimeout(1500, () => { try { req.destroy() } catch {} ; done(false) })
    req.end()
  } catch { done(false) }
}

/** 收尾：把最后一批（含 done）发出去再退出，最多等 1 秒 —— 退出比直播重要。 */
function liveExit(code) {
  if (!LIVE_URL) { process.exit(code); return }
  let gone = false
  const bye = () => { if (!gone) { gone = true; process.exit(code) } }
  setTimeout(bye, 1000).unref?.()
  liveFlush(bye)
}

// opencode 把上游/网络错误统一包成 {"type":"error",...,"error":{"name":"UnknownError",
// "data":{"message":"Unexpected server error. Check server logs..."}}}，cc-connect 会原样
// 拼成「❌ 错误: UnknownError: Unexpected server error…」发进聊天——用户看不懂也不知道该干嘛。
// 这里按关键词把它翻成中文、给出该怎么办。ref 保留（技术支持排云端日志时要用）。
function friendlyError(raw, name) {
  const s = ((raw || "") + " " + (name || "")).toLowerCase()
  if (/timeout|timed out|deadline|etimedout/.test(s))
    return { t: "模型响应超时", m: "长任务本来就慢，多半是这次上游特别久或网络不稳。重发一次通常就好；若反复如此，换个模型或把任务拆成几步。" }
  if (/econnreset|econnrefused|socket|connection|network|dns|enotfound|fetch failed|unreachable|aborted/.test(s))
    return { t: "网络连接中断", m: "跟模型服务的连接断了，多半是网络抖了一下，重发一次即可；若每次都在同一处断，多半是这一轮太长，拆成几步试试。" }
  if (/\b429\b/.test(s) || /quota|rate.?limit|too many|额度|限流|余额|balance|insufficient/.test(s))
    return { t: "额度用尽或被限流", m: "请稍后再试；若是积分用尽，在软件里查看剩余积分。" }
  if (/unexpected server error|internal server|server error|\b50[0234]\b|bad gateway|unavailable/.test(s))
    return { t: "模型服务暂时不可用", m: "当前模型的云端通道可能出故障了。在软件的「聊天接入」里换一个模型（比如 doubao）或过一会儿再试；若一直这样，把这条连同下面的编号告诉管理员。" }
  return { t: "出错了", m: (raw || "未知错误").slice(0, 300) }
}

// ---- 「先上传后提问」用到的工具（uploads 目录、pending 台账、prompt 解析）----------------
// 上传的文件【剪切】进会话目录下的 uploads\ —— 用户在界面「产出/文件」侧栏能看见自己传了什么；
// 从 cc-connect 存的 .cc-connect\attachments|images 里 move 出来，既去重又不受它清理原件影响。
// pending 台账放 .cc-connect\（点目录，不进侧栏）；uploads\ 非点目录，但暂存发生在【不跑模型】的
// 那一条消息里，等下一条提问真正 run 时它们已是"旧文件"，兜底扫描的 fresh 判定不会把它们回发。
const uploadsDir = () => path.join(process.cwd(), "uploads")
const ledgerFile = () => path.join(process.cwd(), ".cc-connect", "pending-uploads.json")
const PENDING_TTL = 2 * 60 * 60 * 1000   // 2 小时没被提问消费掉的暂存文件，下次上传时清掉台账

function loadPending() {
  try { const j = JSON.parse(fs.readFileSync(ledgerFile(), "utf8")); return Array.isArray(j) ? j : [] }
  catch { return [] }
}
function savePending(list) {
  try { fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true }); fs.writeFileSync(ledgerFile(), JSON.stringify(list)) } catch {}
}
// 同卷优先 rename（剪切）；跨卷/占用等失败再退回 copy+unlink，实在删不掉原件也不影响功能。
function moveInto(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const base = path.basename(src) || "file"
  let dest = path.join(destDir, base), n = 1
  while (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(src)) dest = path.join(destDir, (n++) + "_" + base)
  if (path.resolve(dest) === path.resolve(src)) return dest
  try { fs.renameSync(src, dest) }
  catch { fs.copyFileSync(src, dest); try { fs.rmSync(src) } catch {} }
  return dest
}
// 从 run 的 argv 里取出图片路径（cc-connect 把入站图片经 --file 传）
export function imageArgs(argv) {
  const out = []
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--file") out.push(argv[i + 1])
  return out.filter(Boolean)
}
// 从 prompt 尾部的「(Files saved locally, …: <绝对路径>, …)」块里抠出普通文件的绝对路径。
// 只认带 .cc-connect\attachments\ 的 Windows 路径（聊天接入仅 win32）：这样即便 cc-connect 把
// 外围提示文字本地化成中文，抠路径也不受影响（路径本身不翻译）。允许路径含空格（Niuma Science）。
export function attachPaths(prompt) {
  const out = []
  const re = /[A-Za-z]:[\\/][^\n\r,)]*?\.cc-connect[\\/]attachments[\\/][^\n\r,)]*/g
  let m; while ((m = re.exec(String(prompt || "")))) out.push(m[0].trim())
  return out
}
// 剥掉 cc-connect 自动拼的文件引用块与图片占位语，看用户到底有没有写正文。
// 尾部 (...) 块只按里面含 .cc-connect 来锚定，不依赖英文提示词——对本地化免疫。
export function stripRefs(prompt) {
  return String(prompt || "")
    .replace(/\s*\([^()]*\.cc-connect[^()]*\)\s*$/i, "")
    .replace(/please analyze the attached image\(s\)\.?/ig, "")
    .trim()
}
// 把入站文件剪切进会话 uploads\ 并登记 pending；返回本次新增项。
export function stageFiles(paths) {
  const list = loadPending()
  const added = []
  for (const src of paths) {
    try {
      if (!fs.existsSync(src)) continue
      const dest = moveInto(src, uploadsDir())
      const e = { path: dest, name: path.basename(dest), at: Date.now() }
      list.push(e); added.push(e)
    } catch {}
  }
  // 顺手清掉过期 / 已不存在的暂存项，避免越攒越多
  savePending(list.filter((e) => Date.now() - (e.at || 0) < PENDING_TTL && fs.existsSync(e.path)))
  return added
}
// 提问时把此前暂存、仍有效的文件取出来（并清空台账，避免每轮重复注入）
export function consumePending() {
  const list = loadPending().filter((e) => e && e.path && fs.existsSync(e.path) && Date.now() - (e.at || 0) < PENDING_TTL)
  try { fs.rmSync(ledgerFile()) } catch {}
  return list
}
// 判定一条 run 是不是「只发了文件、没提问」。staged = 本条带来的文件（图片来自 --file，
// 普通文件来自 prompt 尾部的 .cc-connect\attachments 路径）；residual = 剥掉引用块后剩的正文。
export function classifyRun(argv, prompt) {
  const staged = [...imageArgs(argv || []), ...attachPaths(prompt)].filter(Boolean)
  const residual = stripRefs(prompt)
  return { staged, residual, fileOnly: staged.length > 0 && residual === "" }
}
function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = ""
    try { process.stdin.setEncoding("utf8") } catch {}
    process.stdin.on("data", (d) => { buf += d })
    process.stdin.on("end", () => resolve(buf))
    process.stdin.on("error", reject)
  })
}

// ---- 跑一次真 opencode，并做过滤/聚合/进度/兜底。stdinText=null → 继承 stdin（原样透传）；
//      非 null → 用管道把（可能改写过的）prompt 喂进去（先上传后提问模式要往里塞暂存文件）。
//      targetDir 非空 = 本轮定向到别的会话（/task 路线）：opencode 子进程 cwd、产物快照/兜底
//      都以它为准（cwd 必须 = session.directory，与续绑定会话同构）；而额度/看门狗/路线这些
//      "聊天通道级"的账本仍按 process.cwd()（绑定目录）走，所以这里不 chdir。
function runOpencode(stdinText, extraFiles = [], targetDir = "") {
  const workDir = targetDir || process.cwd()
  const startedAt = Date.now()
  // 暂存的图片经 --file 传给 opencode（走视觉），比让它按路径去 Read 更靠谱
  const runArgs = extraFiles.length ? [...args, ...extraFiles.flatMap((f) => ["--file", f])] : args

  // 产物兜底的"开工快照"：路径 → mtimeMs。递归但跳过点目录（.venv/.git/.cc-connect 之类）
  const snapshot = new Map()
  const IGNORE = new Set(["AGENTS.md", "OPENCODE.md"])
  const scan = (d, depth) => {
    if (depth > 4) return
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) scan(p, depth + 1)
      else if (!IGNORE.has(e.name)) { try { snapshot.set(p, fs.statSync(p).mtimeMs) } catch {} }
    }
  }
  scan(workDir, 0)

  const child = spawn(REAL_OC, runArgs, { cwd: workDir, stdio: [stdinText == null ? "inherit" : "pipe", "pipe", "inherit"] })
  // 软件侧立刻显示"这条会话正在跑"，不必等第一个字（云端排队时那可能是好几分钟的空白）
  liveNote({ k: "start" })
  spawnedOpencode = true  // 走到这儿说明包装器本身没死，往后再出问题就是模型/事件流侧的事
  if (stdinText != null) { try { child.stdin.write(stdinText); child.stdin.end() } catch {} }
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const DROP = new Set(["tool", "tool_use", "tool_result"])   // 工具事件永远不外发
  const modelSent = new Set()      // 模型自己 send 过的文件（绝对路径小写），兜底时跳过
  let toolCount = 0
  let lastToolLabel = ""

  // 「输出思考」：把 reasoning 各段按出现顺序攒起来（同一段的增量事件取最新全文）。
  // 【流式推送】reasoning 是随生成【逐字增长】的，所以每约 30s 把"上次之后新增的思考"推一条，
  // 而不是全跑完才一口气发；正文开始前与收尾时再把剩余未发的补一条，保证「思考…→ 回答」的顺序。
  // 发送走 cc-connect（不进事件流、不受工具过滤影响）。
  const reason = new Map()   // partId → 最新全文
  const order = []           // partId 出现顺序
  // 投递看门狗要的"最终答案"：正文（text）各段按出现顺序攒起来（增量事件取最新全文），
  // 收尾时暂存到 last-reply.json —— cc-connect 投递失败时下一轮据此补发。
  const answer = new Map(), answerOrder = []
  // 最近一条 text 事件的原始对象 + 它的 partId：换 part 时要照它的形状把上一个 part 的落款撤掉
  let lastTextEvt = null, lastTextId = ""
  let signedInText = false   // 落款已随正文事件发出（收尾就别再补一份）
  const sentLen = new Map()  // partId → 已推出的字符数（流式水位）
  // 只对企微有意义：微信上思考不走定时器（一条都不单发，见 ticker 里的 BUDGET_TIGHT 判断）。
  const THINK_INTERVAL = 30_000
  let lastThink = Date.now()
  let thinkingEverSent = false   // 本轮有没有真的发出过思考（短任务合并的判据）
  /** 还没发出去的思考文本（收尾合并用；不改水位，调用方负责决定发不发）。 */
  const pendingThinkingText = () => {
    const parts = []
    for (const id of order) {
      const full = reason.get(id) || ""
      const sent = sentLen.get(id) || 0
      if (full.length > sent) parts.push(full.slice(sent))
    }
    let t = parts.join("\n").trim()
    if (t.length > 1800) t = "…" + t.slice(-1800)
    return t
  }
  /** 把水位推到"全部已发"，但不真发 —— 供"思考已 inline 写进正文"的路径推进水位。 */
  const markThinkingSent = () => { for (const id of order) sentLen.set(id, (reason.get(id) || "").length) }
  const flushNewThinking = (cb) => {   // 只发"上次之后新增"的思考；cb 在这条 send 真正发出后回调；返回是否真发了一条
    if (!THINKING) { cb && cb(); return false }
    const parts = []
    for (const id of order) {
      const full = reason.get(id) || ""
      const sent = sentLen.get(id) || 0
      if (full.length > sent) { parts.push(full.slice(sent)); sentLen.set(id, full.length) }
    }
    let piece = parts.join("\n").trim()
    if (!piece) { cb && cb(); return false }
    const MAX = 1800   // 单条别太长（企微限速 + 可读）；真超了只保留最新一段
    if (piece.length > MAX) piece = "…" + piece.slice(-MAX)
    thinkingEverSent = true
    noteSend()
    execFile(CC, ["send", "-m", "💭 " + piece], { windowsHide: true }, () => { cb && cb() })
    return true
  }

  // 「思考在前、答案在后」的保序：思考走 `cc-connect send`、答案走 stdout，两条通道不保序，答案常抢先。
  // 所以正文一开始就【扣住 stdout】，等"正文前那条思考"真正发出（send 回调 / 5s 兜底）再放行答案。
  let holding = false, released = false, answerGated = false, releasedAnswer = false
  const held = []
  let onReleased = null
  // firstOutMs：首个真正落到 stdout 的字节的时刻，stdoutAbandoned() 的判据之一（见那边的注释）。
  // 【记在真正 write 的那一刻，不是入队的那一刻】被 holding 扣住期间还没人看得见，不算产出。
  let firstOutMs = Infinity
  const out = (s) => {
    if (holding) { held.push(s); return }
    if (firstOutMs === Infinity) firstOutMs = Date.now()
    producedStdout = true
    process.stdout.write(s)
  }
  const releaseHold = () => {
    if (released) return
    released = true; holding = false
    if (held.length) {
      releasedAnswer = true; producedStdout = true
      if (firstOutMs === Infinity) firstOutMs = Date.now()   // 扣住的内容在此刻才真正见人
      for (const s of held) process.stdout.write(s)
      held.length = 0
    }
    if (onReleased) { const f = onReleased; onReleased = null; f() }
  }

  // 进度/思考推送：5s 一查。开了「输出思考」→ 每约 30s 把新增思考推一条（思考本身就是进度）。
  // 「仍在处理中」进度提示【很少发】：思考已经 30s 一条了，这条只为长时间【纯干活无思考】兜底，
  // 所以调到【5 分钟】才报一轮、且期间真有工具活动才报——不刷屏。
  const PROGRESS_INTERVAL = 5 * 60_000
  let lastPing = Date.now(), pingedTools = 0

  // ---- 「一点动静都没有」也要播报 ----------------------------------------
  // 上面那条进度提示的触发条件是 toolCount > pingedTools（**必须有工具活动**）。可最需要
  // 反馈的恰恰是【一个事件都没有】的情况：云端排队 / 上游限速时 opencode 一行都不输出，
  // toolCount 恒为 0 → 永远不报 → 用户面对无限沉默，还会以为软件死了而反复重发（那几条又
  // 全堵在队列里）。2026-08-15 真机：问"查一下昨天美股走势"，10 分钟零反馈，
  // 而 gateway.log 里已经写了 6 条「上游限速中」——信息一直有，只是没人告诉用户。
  // SCI_WRAP_SILENCE_MS 可调（也是单测用来把等待缩短的开关）；给个下限免得被调成刷屏。
  const SILENCE_FIRST = Math.max(3000, Number(process.env.SCI_WRAP_SILENCE_MS) || 90_000)
  const SILENCE_REPEAT = 5 * 60_000   // 之后每隔这么久再报，别刷屏
  const SILENCE_MAX = 4               // 报满这些次就闭嘴，剩下的交给用户自己判断
  let lastEventAt = Date.now(), silenceNotices = 0, lastSilenceAt = 0
  const gwOffset = (() => { try { return fs.statSync(gatewayLogPath()).size } catch { return 0 } })()
  const readStallReason = () => {
    try {
      const f = gatewayLogPath()
      if (!f) return ""
      const size = fs.statSync(f).size
      if (size <= gwOffset) return ""            // 网关这轮没写过新东西 → 说不出原因，别瞎猜
      const fd = fs.openSync(f, "r")
      try {
        const buf = Buffer.alloc(Math.min(size - gwOffset, 64 * 1024))
        fs.readSync(fd, buf, 0, buf.length, gwOffset)
        return stallReason(buf.toString("utf8"))
      } finally { fs.closeSync(fd) }
    } catch { return "" }
  }

  const ticker = (PROGRESS || THINKING) ? setInterval(() => {
    const now = Date.now()
    // 【微信上一条都不中途发】每条 send 各吃一格额度，而每小时只有 15 格，长任务能吃掉五六格。
    // 思考改为 inline 并进答案那一条（见正文开始处与收尾处），代价是长任务期间手机端会安静
    // ——微信上进度提示本来也是关的，这是为省额度自觉付的代价。企微是长连接、无配额，照常。
    if (THINKING && !BUDGET_TIGHT && now - lastThink >= THINK_INTERVAL) { lastThink = now; flushNewThinking() }
    if (PROGRESS && toolCount > pingedTools && now - lastPing >= PROGRESS_INTERVAL) {
      pingedTools = toolCount; lastPing = now
      lastSilenceAt = now   // 刚报过进度就别紧接着再报"没动静"
      const label = lastToolLabel ? `（最近步骤：${lastToolLabel}）` : ""
      noteSend()
      execFile(CC, ["send", "-m", `⏳ 仍在处理中，已执行 ${toolCount} 个步骤${label}`], { windowsHide: true }, () => {})
    }
    if (PROGRESS) {
      const quietFor = now - lastEventAt
      if (silenceDue({ now, lastEventAt, lastSilenceAt, notices: silenceNotices, first: SILENCE_FIRST, repeat: SILENCE_REPEAT, max: SILENCE_MAX })) {
        silenceNotices++; lastSilenceAt = now
        const why = readStallReason()
        const mins = Math.round(quietFor / 60_000)
        const msg = why
          ? `⏳ ${why}，已等 ${mins > 0 ? mins + " 分钟" : "一会儿"}。任务没丢，轮到就会继续——不用重发（重发会排在这条后面，更慢）。`
          : `⏳ 还在等模型响应（已等 ${mins > 0 ? mins + " 分钟" : "一会儿"}，暂时没有任何输出）。任务没丢，不用重发。`
        noteSend()
        wlog(`静默播报第 ${silenceNotices} 次：${why || "原因未知"}（已静默 ${quietFor}ms）`)
        execFile(CC, ["send", "-m", msg], { windowsHide: true }, () => {})
      }
    }
  }, 5000) : null

  rl.on("line", (line) => {
    lastEventAt = Date.now()   // 有任何一行输出就算"有动静"，静默播报据此计时
    // 默认原样放行；正文事件里若把路径抹掉了，就改发重新序列化的那一行（见 type === "text"）
    let emit = line
    const t = line.trim()
    if (t.startsWith("{")) {
      try {
        const evt = JSON.parse(t)
        const type = evt?.type ?? evt?.part?.type
        const part = evt?.part || evt
        // 会话 id 认领：--session 没传时（cc-connect 新起会话的第一条）从事件里捡一个
        if (!liveSid && part?.sessionID) liveSid = String(part.sessionID)
        // 思考：开了就聚合、没开就丢；两种情况都【不逐条外发到聊天】。
        // 【但软件侧照发】—— SCI_WRAP_THINKING 管的是"要不要把思考推到微信"（那边每条都吃发送
        // 额度，默认关），软件界面本来就有折叠好的「思考过程」块，没有任何理由跟着一起关掉。
        if (type === "reasoning") {
          const id = evt?.part?.id || "r0"
          const txt = String(evt?.part?.text ?? evt?.text ?? "")
          if (txt) liveNote({ k: "reasoning", id, text: txt })
          if (THINKING && txt) { if (!reason.has(id)) order.push(id); reason.set(id, txt) }
          return
        }
        if (DROP.has(type)) {
          toolCount++
          const inp = evt?.part?.state?.input || {}
          lastToolLabel = String(evt?.part?.tool || "") + (inp.description ? `: ${inp.description}` : "")
          // 工具事件同样不进聊天（防泄露 + 防刷爆限速），但软件侧要看得见"它正在干什么"
          if (part?.callID) liveNote({ k: "tool", callID: String(part.callID), tool: String(part.tool || ""),
            status: String(part.state?.status || ""), title: String(part.state?.title || ""),
            skill: part.tool === "skill" ? (inp.name || null) : null })
          // 模型自己调了 cc-connect send？记下路径免得兜底重发
          const cmd = String(inp.command || "")
          if (/cc-connect(\.\w+)?["']?\s+send/.test(cmd)) {
            for (const m of cmd.matchAll(/--(?:image|file|audio|video)\s+"?([^"\s]+(?:\s[^"\s]+)*?)"?(?=\s+--|\s*$|")/g)) {
              try { modelSent.add(path.resolve(m[1]).toLowerCase()) } catch {}
            }
            // 引号路径（含空格）另配一轮
            for (const m of cmd.matchAll(/--(?:image|file|audio|video)\s+"([^"]+)"/g)) {
              try { modelSent.add(path.resolve(m[1]).toLowerCase()) } catch {}
            }
          }
          return   // 工具进度：不给 cc-connect 看见
        }
        if (type === "text") {
          const id = evt?.part?.id || "t0"
          const raw0 = String(evt?.part?.text ?? evt?.text ?? "")
          // 【出口处抹掉绝对路径】手机上路径既点不开又占屏，用户要的是文件本身（走 send 发过去）。
          // 改写事件后必须重新序列化整行——下面兜底的 out(emit) 发的是这一行的字面量。
          const txt = scrubPaths(raw0)
          if (txt !== raw0) {
            if (evt?.part && "text" in evt.part) evt.part.text = txt
            if ("text" in evt) evt.text = txt
            emit = JSON.stringify(evt)
          }
          if (txt) {
            if (!answer.has(id)) answerOrder.push(id); answer.set(id, txt)
            // 【落款钉在最后一个 text part 的正文末尾，不能等收尾再补】2026-08-19 真机抓流：
            //   step_start → reasoning → text → step_finish(reason=stop) → …
            // cc-connect 在 step_finish 那一刻就定稿发消息了，之后写进 stdout 的东西一律被记成
            // "unsolicited events"、进不了这一轮的正文——微信企微都一样（此前"企微丢裸文本"的
            // 判断是错的：微信同样没有，只是没人注意）。所以落款必须【随正文事件一起】出去。
            // 多个 text part（多步/工具轮）时只有最后一个该带：新 part 一出现，就把上一个 part
            // 按原文重发一遍把落款撤掉（text 事件本就是"该 part 的当前全文"，同 id 覆盖，
            // 上面 answer.set 也是覆盖不是追加）。
            if (lastTextEvt && lastTextId && lastTextId !== id) out(JSON.stringify(withText(lastTextEvt, answer.get(lastTextId) || "")) + "\n")
            lastTextEvt = evt; lastTextId = id
            // 额度提醒【插在落款之前】，与落款同走这条 text 事件（自己单发会再吃一格额度，
            // 收尾再写又赶不上 step_finish）。只有微信有额度，企微恒为空串。
            emit = JSON.stringify(withText(evt, txt + (BUDGET_TIGHT ? quotaNotice(answerOrdinal()) : "") + SIGNATURE))
            signedInText = true
            // 软件侧的 text 事件按【累计全文】语义（与网关直播同口径），所以这里也发全文
            liveNote({ k: "text", text: answerOrder.map((x) => answer.get(x) || "").join("\n") })
          }
        }
        // 正文开始：先把剩余未发的思考发出去，并【扣住答案】直到它发出，保证「思考 → 答案」
        if (type === "text" && !answerGated) {
          answerGated = true
          // 【微信：思考不另发一条，直接写进正文前面】走 stdout 的内容整体只算【一条】消息
          // （分块不计费，maxWeixinChunk=3800），而 `cc-connect send` 每条各吃一格额度。
          // 微信每小时只有 15 格，长任务按 60s 一条思考能吃掉五六格 —— 那是真正的回复在抢的格子。
          // 所以这里把思考【inline 写进同一条消息】：既省掉全部额外开销，又天然保证"思考在前、
          // 答案在后"（stdout 是顺序写的，不像 send 与 stdout 那样两条通道不保序）。
          // 也因此不需要 holding/releaseHold 那套扣答案的保序机制 —— 没有异步 send 要等。
          if (THINKING && BUDGET_TIGHT) {
            const head = pendingThinkingText()
            if (head) {
              markThinkingSent()          // 推进水位，免得收尾又并一遍
              out("💭 " + head + "\n\n———\n\n")
              wlog(`思考写入正文前（微信合并策略）${head.length} 字`)
            }
          } else if (THINKING && !BUDGET_TIGHT) {   // 守卫写明：企微才走"另发一条 + 扣住答案保序"
            const sent = flushNewThinking(releaseHold)
            if (sent) { holding = true; setTimeout(releaseHold, 5000) }   // send 卡住也别永久扣着
          }
        }
        // 错误事件：把 opencode 的技术话术翻成中文再放行（cc-connect 从这条事件取文案发进聊天）
        if (type === "error" && evt?.error) {
          const e = evt.error
          const raw = String(e?.data?.message || e?.message || e?.name || "")
          const ref = e?.data?.ref
          const f = friendlyError(raw, e?.name)
          evt.error = { name: f.t, data: { message: f.m + (ref ? `（编号 ${ref}）` : ""), ref } }
          liveNote({ k: "error", message: f.t + "：" + f.m })   // 软件侧也要看到这一轮是怎么收场的
          out(JSON.stringify(evt) + "\n")
          return
        }
      } catch { /* 非 JSON 行原样放行 */ }
    }
    out(emit + "\n")
  })

  const IMG = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"])
  const MAX_SEND = 5, MAX_BYTES = 50 * 1024 * 1024
  /** 复制一条 text 事件、只换正文（原事件对象不动，外壳字段照抄）。 */
  const withText = (evt, text) => {
    const e2 = JSON.parse(JSON.stringify(evt))
    if (e2?.part && "text" in e2.part) e2.part.text = text
    if ("text" in e2) e2.text = text
    return e2
  }

  const finishAndExit = (exitCode) => {
    // 还扣着答案没放行（短任务：思考的 send 还没回调）→ 等放行后再收尾，别让答案抢在思考前落 stdout。
    if (holding && !released) { onReleased = () => finishAndExit(exitCode); return }
    if (ticker) clearInterval(ticker)
    // 收尾把剩余未发的思考补齐（短任务没到 30s、或思考在正文后还有尾巴）；现发的话留点送达时间再退。
    // 【微信不在这里发】它一条 send 就是一格额度；剩下的尾巴由下面的合并写进答案那一条里。
    const flushedNow = BUDGET_TIGHT ? false : flushNewThinking()
    // 产物兜底：新出现/被改写、且模型没自己发过的文件，补一条 send
    const fresh = []
    const rescan = (d, depth) => {
      if (depth > 4) return
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (e.name.startsWith(".")) continue
        const p = path.join(d, e.name)
        if (e.isDirectory()) { rescan(p, depth + 1); continue }
        if (IGNORE.has(e.name)) continue
        let st; try { st = fs.statSync(p) } catch { continue }
        const old = snapshot.get(p)
        if ((old === undefined || st.mtimeMs > old) && st.mtimeMs >= startedAt - 2000) fresh.push({ p, size: st.size })
      }
    }
    rescan(workDir, 0)
    // 候选：本轮新出现/被改写、模型没自己发过、大小合规的。
    // 【只发主产物】中间文件（脚本/日志/契约之外的中间 md、下载的全文、抽出来的 txt…）不推手机，
    // 只在文案里报个数——它们都在会话目录里，用户在软件端随时能看、能打包下载。
    const cand = fresh
      .filter((f) => !modelSent.has(path.resolve(f.p).toLowerCase()))
      .filter((f) => f.size > 0 && f.size <= MAX_BYTES)
    const byRel = new Map()
    for (const f of cand) byRel.set(path.relative(workDir, f.p).replace(/\\/g, "/"), f.p)
    const { mod, values } = workflowOf(workDir)
    const { send: rels, held } = pickOutputs([...byRel.keys()], mod, values, MAX_SEND)
    const toSend = rels.map((r) => byRel.get(r))
    // 投递看门狗的暂存：正文 + 本轮兜底要发的文件。cc-connect 是在本进程退出【之后】才投递的，
    // 成败此刻不可知——先存，下一轮开跑时对着 bridge.log 判断要不要补发。
    const answerText = answerOrder.map((id) => answer.get(id) || "").join("\n")
    // 软件侧收尾：把最终答案一并带上（网关据此推 final + done，界面才会停转圈并定稿渲染）。
    // 发送在下面的 liveExit 里做（它会等这一批真的送出去再退，最多 1 秒）。
    liveNote({ k: "done", text: answerText })
    // 【短任务把思考并进答案，省一条额度】思考走 send、答案走 stdout，本来是两条独立消息。
    // 可一轮只跑了几十秒时，两条内容紧挨着到达，分开发纯属浪费——而微信每条都吃额度。
    // 分块不额外计费（一条逻辑消息切几块都算 1 条，maxWeixinChunk=3800），所以合并几乎是纯赚。
    // 只在【一条思考都没发过】时合并：中途已经发过的话，收尾再重复一遍反而啰嗦。
    // 答案本身也是一条独立消息（cc-connect 读 stdout 后发出），记一笔再算提示
    const usedAfter = noteSend()
    const notice = BUDGET_TIGHT ? budgetNotice(usedAfter, SEND_LIMIT, SEND_WARN_AT) : ""
    if (notice) { out(notice); wlog(`额度提示：本小时已用 ${usedAfter}/${SEND_LIMIT}`) }
    // 微信上思考【从不中途发】——三处发送点都按 BUDGET_TIGHT 挡掉了（ticker、正文开始、这里的
    // 收尾 flush），主体在正文开始时已 inline 写进这条消息的【最前面】。这里只兜"正文之后才产生
    // 的尾巴"（少见），追加在末尾——它本来就发生在答案之后，顺序如实。零额外开销：都在同一条。
    // 【2026-08-16 修】此前这段注释就是这么写的，但 ticker 里【并没有】那个判断：微信上思考照样
    // 60s 一条、每条各吃一格额度，一个 5 分钟的任务能烧掉五六格（每小时只有 15 格）。注释先于
    // 实现写下、之后没人回来补，于是"已经处理好了"的错觉维持了很久。
    if (BUDGET_TIGHT && THINKING) {
      const tail = pendingThinkingText()
      if (tail) { out("\n\n———\n💭 " + tail + "\n"); wlog("思考尾巴并入答案（微信合并策略）") }
    }
    // 落款：【一轮只加一次，且加在整条消息的最后】。首选正文这条（走 stdout，不额外吃额度）；
    // 没有正文的轮次（只发文件）落到下面的附件消息上。
    let signed = false
    // 有正文的轮次：落款已经在正文那条 text 事件里了（见上面的头注），这里只记账。
    // signedInText 为假 = 一条 text 事件都没有过（只发文件的轮次），落款落到下面的附件消息上。
    if (signedInText) signed = true
    saveLastReply(answerText, toSend)

    // ---- 抢救被抛弃的回复 ----------------------------------------------------
    // cc-connect 对"出队的第一条消息"不读我们的 stdout（见 stdoutAbandoned 的头注：三次真机
    // 实测，抢在 68ms 吐首字节也没用）。此时活其实干完了、答案也在手上，只是没人接——那就改走
    // `cc-connect send` 这条【已验证一直可用】的主动推送通道（今天 A/B/C 三组实验：桥连续运行
    // 277 分钟、用户 14 小时没说话，文本和文件都照送）。
    // 只在判定成立且【确实有答案】时才推：没答案就推一句空话，比不推更糟。
    let rescueMsg = ""
    if (answerText.trim()) {
      let abandoned = false
      try {
        const lf = bridgeLogPath()
        if (lf && fs.existsSync(lf)) {
          abandoned = stdoutAbandoned(fs.readFileSync(lf, "utf8"), agentSessionOf(args), startedAt, firstOutMs)
        }
      } catch (e) { wlog("判定 stdout 是否被抛弃时出错（按未抛弃处理）：" + (e?.message || e)) }
      if (abandoned) {
        wlog(`⚠ 本轮 stdout 被 cc-connect 抛弃（出队首条），改用 send 补推答案 ${answerText.length} 字`)
        rescueMsg = "📮 刚才那条「(空响应)」是软件的问题：你连着发消息时，前一条还没答完，这一轮的回复被弄丢了。\n" +
          "**你的指令已经执行**，下面是完整回复：\n\n" + answerText
        // 这条 send 才是用户真正看到的那一条（stdout 那份没人接），落款跟着它走
        // 【无条件补落款】stdout 那份连同它里面的落款一起被丢了，signed 是对着"已经写出去"
        // 记的账，在这条路径上不作数：用户真正看到的只有眼前这条 send。
        rescueMsg += SIGNATURE; signed = true
      }
    }
    // 【和文件补发合并成一条 send，别各发各的】两条 send 并发时，先回调的那条会 process.exit()，
    // 把另一条连同它的内容一起带走——那正是我们要修的"回复丢失"，不能在修复代码里再犯一次。
    if (rescueMsg && !toSend.length) {
      noteSend()
      execFile(CC, ["send", "-m", rescueMsg], { windowsHide: true }, () => liveExit(exitCode))
      setTimeout(() => liveExit(exitCode), 30_000)
      return
    }

    if (!toSend.length) { setTimeout(() => liveExit(exitCode), (flushedNow || releasedAnswer) ? 1500 : 0); return }

    // 【微信：产物多就打包】cc-connect 的 media_outbound.go 里【每个文件各计一次发送配额】，
    // 所以 6 个文件 = 6 条，而实测发到第 20 条就被限流——一次交付就能吃掉三分之一额度。
    // 超过阈值就压成一个 zip 发出去：1 条搞定，用户在手机上也更好收。企微没有配额，保持原样
    // （逐个发更方便直接预览）。压缩失败不阻断交付，退回逐个发。
    let zipNote = ""
    if (BUDGET_TIGHT && toSend.length > ZIP_THRESHOLD) {
      const packed = zipFiles(toSend, workDir)
      if (packed) {
        zipNote = `📦 本轮有 ${toSend.length} 个交付物，已打成一个压缩包发给你（微信对机器人发消息的条数有限制，分开发容易被拦）。`
        wlog(`产物打包：${toSend.length} 个 → ${path.basename(packed)}`)
        toSend.length = 0
        toSend.push(packed)
      }
    }
    const sendArgs = ["send"]
    // 被折下的中间文件不单发一条消息（企微 30 条/分的限速经不起），搭在这条附件上说一句就够。
    // 【只能有一个 -m】抢救文案与"中间文件"提示要拼成一段，push 两次 -m 会被后一个覆盖，
    // 抢救文案（也就是本轮真正的答案）就又丢了。
    const heldNote = held > 0 ? `📎 本轮的交付物在下面；另有 ${held} 个中间文件留在软件的会话目录里，可在软件端查看或打包下载。` : ""
    // 没有正文的轮次（只发文件）：落款补在这条附件消息上，保证每轮都有且只有一个落款。
    const oneMsg = [rescueMsg, zipNote, heldNote].filter(Boolean).join("\n\n") + (signed ? "" : SIGNATURE)
    if (oneMsg.trim()) sendArgs.push("-m", oneMsg.replace(/^\n+/, ""))
    for (const f of toSend) sendArgs.push(IMG.has(path.extname(f).toLowerCase()) ? "--image" : "--file", f)
    // 排障日志走独立文件（SCI_WRAP_LOG 由 chat-bridge 注入）。【不能写 stderr】：run 结束后的
    // stderr 会被 cc-connect 当成 "unsolicited agent error" 记 ERROR，吓人且污染真实错误的检索。
    if (process.env.SCI_WRAP_LOG) {
      try { fs.appendFileSync(process.env.SCI_WRAP_LOG, new Date().toISOString() + ` 兜底补发[mod=${mod || "chat"}] ` + toSend.map((f) => path.basename(f)).join(", ") + (held ? `（另折下 ${held} 个）` : "") + "\n") } catch {}
    }
    // 【每个文件各计一格】见 cc-connect 的 media_outbound.go；正文（oneMsg）再算一条。
    noteSend((oneMsg.trim() ? 1 : 0) + toSend.length)
    execFile(CC, sendArgs, { windowsHide: true }, () => liveExit(exitCode))
    setTimeout(() => liveExit(exitCode), 30_000)   // send 卡死也不拖着不退
  }
  child.on("exit", (code, sig) => { rl.close(); finishAndExit(sig ? 1 : (code ?? 1)) })
  child.on("error", (e) => { console.error(e.message); process.exit(1) })
}

// ---- 入口分发 --------------------------------------------------------------
function main() {
  if (!REAL_OC || !fs.existsSync(REAL_OC)) {
    console.error("oc-wrap: SCI_WRAP_OC 未设置或不存在: " + REAL_OC)
    process.exit(1)
  }
  if (args[0] !== "run") {
    // 非 run 子命令原样透传（session list/delete、models…）
    const child = spawn(REAL_OC, args, { stdio: "inherit" })
    child.on("exit", (code, sig) => process.exit(sig ? 1 : (code ?? 1)))
    child.on("error", (e) => { console.error(e.message); process.exit(1) })
    return
  }
  // 回执并退出（不跑模型）：路线切换的确认、忙碌拒收都走这条。回执经 cc-connect 发出，
  // 也占一条消息，所以要记账。
  const replyAndExit = (msg) => {
    markStdout()
    noteSend()
    process.stdout.write(msg + SIGNATURE, () => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
  }
  // 【路线定向 + 续用绑定会话 + 双端并发防护】runOpencode 的所有调用点都换成走这里：
  //   ① 按 route.json 决定本轮目标会话（绑定会话 / 最近定时任务的会话 / 自由态），必要时改写
  //      args 里的 --session（routeArgs，纯函数）。改写必须在 runOpencode 之前落到 args
  //      （它和 stdoutAbandoned 都读 args）。
  //   ② 目标会话正被软件端占用时别再塞一轮（两个 opencode 进程并发写同一份会话历史会互相搅）。
  //      反方向早有防护（微信在跑时软件端发消息被影子 job 挡下）。
  // 【只在真正开跑时才写"已收编"标记】先上传后提问的纯暂存轮、忙碌被拒的轮都没起 opencode，
  // cc-connect 没机会从事件流学走会话 id —— 此时落了标记，下一条不带 --session 的消息就会被
  // 误判成 /new 而丢掉续跑。所以标记与 runOpencode 同一时刻落。
  const runGated = (stdinText, extraFiles = []) => {
    const r = routeArgs(args, { route: readRoute(), boundSid: BOUND_SID, adoptedSid: readAdopted(), task: readLastTask() })
    if (r.argv) {
      args.splice(0, args.length, ...r.argv)
      wlog(`路线定向：--session → ${r.sid}${r.dir ? `（cwd → ${r.dir}）` : ""}`)
    }
    if (r.setRoute) { writeRoute(r.setRoute); wlog(`路线迁移：${r.setRoute.mode}（用户发了 /new）`) }
    if (r.sid) liveSid = r.sid   // 直播中继不必再等事件认领：本轮就跑在目标会话里
    if (r.dir) ensureAgentsBlock(r.dir)   // 任务会话目录补上聊天接入说明（幂等）
    checkSessionBusy(r.sid || agentSessionOf(args), (busy) => {
      if (!busy) {
        if (r.adopt) writeAdopted(BOUND_SID)
        return runOpencode(stdinText, extraFiles, r.dir)
      }
      wlog("目标会话正被软件端占用，本条不跑，回执让用户稍后再发")
      replyAndExit(
        "⏳ 软件（电脑端）正在这条会话里跑任务，为避免两边互相打架，这条消息暂时没有处理。\n" +
        "等它跑完（软件里能看到进度）再把刚才的话发一次即可。")
    })
  }
  // 路线指令（/task //back）：在起 opencode 之前截下，不烧模型。
  const handleRouteCommand = (cmd) => {
    const cur = readRoute()
    if (cmd === "task" && !readLastTask())
      return replyAndExit("📂 还没有可切换的定时任务会话（要先有一次定时任务的推送）。当前会话不变。")
    const next = routeSwitch(cmd, cur, agentSessionOf(args))
    writeRoute(next)
    wlog(`路线切换：${cur.mode} → ${next.mode}${next.sid ? `（${next.sid}）` : ""}（用户发了 /${cmd}）`)
    if (cmd === "task") {
      const t = readLastTask()
      return replyAndExit(
        `📂 已切到定时任务的会话${t.label ? `「${t.label}」` : ""}，接下来的消息都发到那边（我能看到该任务的完整过程与产物）。\n` +
        "回复 /back 切回你原来所在的会话。")
    }
    return replyAndExit(next.mode === "bound"
      ? "↩️ 已切回你绑定的会话，接下来的消息接着之前的对话。"
      : "↩️ 已切回你原来所在的会话，接下来的消息接着之前的对话。")
  }
  // 【额度归零】cc-connect 每条来信 spawn 一次 oc-wrap，所以"本进程被拉起"就等于"刚收到一条
  // 来信"——而来信正是腾讯重置主动发送额度的唯一事件（见 quotaFile 那段头注）。必须放在
  // resendLostReply 之前：补发本身也是新窗口里的第一条，要计进去。
  if (BUDGET_TIGHT) { try { resetQuota() } catch {} }
  // 每条来信都是补发窗口：来信【就是】腾讯给额度解禁的那个事件，所以此刻必定发得出去。
  // 【必须兜住】它读 bridge.log / last-reply.json / 调 cc-connect，任何一处抛出来都会让本轮
  // 在起 opencode 之前就静默死掉 —— 用户看到的就是「(空响应)」，而补发本身只是锦上添花，
  // 绝不该因为它失败就把用户真正要问的这句话吞掉。
  try { resendLostReply() } catch (e) { wlog("resendLostReply 异常（已忽略，继续本轮）：" + (e?.message || e)) }
  // 【统一先读走 stdin】路线指令（/task //back）必须在起 opencode 之前截下，所以不再按
  // UPLOAD_FIRST 分"继承 stdin / 读走 stdin"两条路：一律读进来，非指令再按原逻辑喂回给
  // opencode（管道回喂与继承等价——「先上传后提问」在真机上一直就是这么跑的）。
  readStdin().then((prompt) => {
    const rc = routeCommandOf(prompt)
    if (rc) { try { handleRouteCommand(rc) } catch (e) { wlog("路线指令处理异常：" + (e?.message || e)); replyAndExit("⚠️ 切换没成功，请再发一次。") } ; return }
    if (!UPLOAD_FIRST) { runGated(prompt); return }   // 关了「先上传后提问」：prompt 原样喂给模型
    // 开了「先上传后提问」：判断这条是不是"只发文件没提问"再决定跑不跑模型。
    try {
      const { staged, fileOnly } = classifyRun(args, prompt)
      if (fileOnly) {
        // 只发了文件、没提问 → 暂存 + 回执，不触发会话
        const added = stageFiles(staged)
        const names = added.map((e) => e.name).join("、") || "文件"
        const ack = `📎 已收到 ${added.length || staged.length} 个文件：${names}，已存进会话的 uploads 目录。\n直接发送你的问题，我会基于这些文件作答。`
        execFile(CC, ["send", "-m", ack], { windowsHide: true }, () => process.exit(0))
        setTimeout(() => process.exit(0), 15000)
        return
      }
      // 真正的提问：把此前暂存、尚未消费的文件并进这一轮——图片走 --file（视觉），
      // 全部文件的路径再以文字附在 prompt 末尾，让模型知道有哪些、去哪读。
      const pending = consumePending()
      let eff = prompt
      let pendImgs = []
      if (pending.length) {
        const IMG = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"])
        pendImgs = pending.filter((e) => IMG.has(path.extname(e.path).toLowerCase())).map((e) => e.path)
        const lines = pending.map((e) => e.path).join("\n")
        eff += `\n\n(用户此前上传了这些文件，请在回答时一并读取参考：\n${lines}\n)`
      }
      runGated(eff, pendImgs)
    } catch {
      // 分析出岔子就按原样把 prompt 交给模型，绝不吞消息
      try { runGated(prompt) } catch { process.exit(1) }
    }
  }, () => runGated(null))
}

if (isMain) {
  wlog(`▶ 起跑 argv=${JSON.stringify(process.argv.slice(2)).slice(0, 300)} cwd=${process.cwd()}`)
  // main() 里同步抛出的任何东西都会让本轮零输出静默死掉。兜住 → 记日志 → 让 exit 钩子
  // 去给用户吐那句人话（这里不直接写 stdout，免得和钩子重复输出两遍）。
  try { main() } catch (e) { exitReason = "main() 抛出: " + (e?.stack || e?.message || e); process.exitCode = 1 }
} else {
  // isMain 判错过一次（0.1.24：junction 路径比字符串恒 false → 每条消息空响应）。它一旦再错，
  // 现象还是"全部空响应"，但这行日志能立刻把嫌疑锁死，不用再猜。
  wlog(`（未作为入口执行：argv[1]=${process.argv[1]} 解析后=${canon(process.argv[1] || "")} 本文件=${canon(fileURLToPath(import.meta.url))}）`)
}
