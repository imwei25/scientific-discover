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
// cc-connect 开始处理后 68ms 就写出去了，它仍在 460ms 之后判定为空、发出「(空响应)」占位符；
// 三次观测的放弃时长 528ms / 704ms / 1090ms 也毫无规律。结论：**cc-connect 处理排队消息时
// 根本不读 agent 的 stdout**，写什么、写多快都没用。修法必须绕开 stdout 这条通道（见下方
// deliverOutOfBand 的注释）。

// 产物分级判据与界面侧栏共用一份（web/workflows.mjs）。动态 import + 兜底：这份文件万一
// 加载不了（老界面包、打包漏文件），聊天不能整个哑掉 —— 退回"只发成品扩展名"的保守口径。
let WF = null
try { WF = await import("../workflows.mjs") } catch { WF = null }
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
// 个人微信（ilink）**没有长连接**：收消息靠长轮询，发消息必须凭随每条来信刷新的
// 会话令牌（context_token），令牌几分钟就过期。于是长任务跑完时回复常被平台拒收
// （bridge.log：`sendMessage ret=-2 "prepare failed" (expired context_token)`），用户看到
// 的就是"空响应/没收到"，而正文在软件端完好——丢在 cc-connect 往微信投递的最后一步，
// 且 cc-connect 只记日志、不补发。企微是 websocket 长连接，没有这个问题。
// 补法利用一个必然成立的时机：**用户下一条消息进来的瞬间令牌刚刷新**。所以：
//   · 每轮结束把最终答案 + 兜底补发的文件暂存进 .cc-connect\last-reply.json；
//   · 下一轮开跑前查 bridge.log 里暂存时刻之后有没有投递失败，有 → 先补发暂存内容再答新问题。
// 定时任务的推送（chat-bridge 的 pushToChat）也写同一个暂存文件，同样在下次对话时兜底。
const lastReplyFile = () => path.join(process.cwd(), ".cc-connect", "last-reply.json")
// bridge.log 与 wrap.log 同目录（都由 chat-bridge.mjs 定在 <root>\chat-bridge\ 下）
const bridgeLogPath = () =>
  process.env.SCI_WRAP_LOG ? path.join(path.dirname(process.env.SCI_WRAP_LOG), "bridge.log") : ""
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
  }
  return out
}

/**
 * 本轮的 stdout 是不是已经被 cc-connect 抛弃了？（纯函数，导出仅为单测。）
 *
 * 【背景】cc-connect v1.4.1 处理【排队消息】时不读 agent 的 stdout：它在 spawn 我们之后几百毫秒
 * 就宣告 `turn complete` 并把占位符「(空响应)」发给用户，之后我们写什么都没人接。真机三次实测
 * （2026-08-15 12:51/13:04/13:10）放弃时长 704/1090/528ms 毫无规律，且**抢在 68ms 就吐首字节
 * 也照样被判空**——所以不是等得不够，是根本没读。opencode 那一轮其实跑完了、活也干对了
 * （用户的定时任务确实被改掉），丢的只有回复。
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
    if (txt) args2.push("-m", "📮 上一条回复当时没送到（微信的会话令牌过期了，刚才你发消息把它刷新了），补发：\n" + txt)
    const files = fail.media ? (Array.isArray(j.files) ? j.files : []).filter((p) => { try { return fs.existsSync(p) } catch { return false } }).slice(0, 5) : []
    for (const p of files) args2.push(IMG_EXTS.has(path.extname(p).toLowerCase()) ? "--image" : "--file", p)
    if (args2.length <= 1) return
    execFile(CC, args2, { windowsHide: true }, () => {})
    if (process.env.SCI_WRAP_LOG)
      try { fs.appendFileSync(process.env.SCI_WRAP_LOG, new Date().toISOString() + ` 补发上轮丢失投递 text=${!!txt} files=${files.length}\n`) } catch {}
  } catch {}
}
const PROGRESS = process.env.SCI_WRAP_PROGRESS !== "0"
const THINKING = process.env.SCI_WRAP_THINKING === "1"       // 「输出思考」：聚合 reasoning 推一条
const UPLOAD_FIRST = process.env.SCI_WRAP_UPLOAD_FIRST === "1" // 「先上传后提问」：只发文件不触发会话
const args = process.argv.slice(2)

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
function runOpencode(stdinText, extraFiles = []) {
  const workDir = process.cwd()
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

  const child = spawn(REAL_OC, runArgs, { stdio: [stdinText == null ? "inherit" : "pipe", "pipe", "inherit"] })
  spawnedOpencode = true   // 走到这儿说明包装器本身没死，往后再出问题就是模型/事件流侧的事
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
  const sentLen = new Map()  // partId → 已推出的字符数（流式水位）
  const THINK_INTERVAL = 30_000
  let lastThink = Date.now()
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
  const ticker = (PROGRESS || THINKING) ? setInterval(() => {
    const now = Date.now()
    if (THINKING && now - lastThink >= THINK_INTERVAL) { lastThink = now; flushNewThinking() }
    if (PROGRESS && toolCount > pingedTools && now - lastPing >= PROGRESS_INTERVAL) {
      pingedTools = toolCount; lastPing = now
      const label = lastToolLabel ? `（最近步骤：${lastToolLabel}）` : ""
      execFile(CC, ["send", "-m", `⏳ 仍在处理中，已执行 ${toolCount} 个步骤${label}`], { windowsHide: true }, () => {})
    }
  }, 5000) : null

  rl.on("line", (line) => {
    const t = line.trim()
    if (t.startsWith("{")) {
      try {
        const evt = JSON.parse(t)
        const type = evt?.type ?? evt?.part?.type
        // 思考：开了就聚合、没开就丢；两种情况都【不逐条外发】
        if (type === "reasoning") {
          if (THINKING) {
            const id = evt?.part?.id || "r0"
            const txt = String(evt?.part?.text ?? evt?.text ?? "")
            if (txt) { if (!reason.has(id)) order.push(id); reason.set(id, txt) }
          }
          return
        }
        if (DROP.has(type)) {
          toolCount++
          const inp = evt?.part?.state?.input || {}
          lastToolLabel = String(evt?.part?.tool || "") + (inp.description ? `: ${inp.description}` : "")
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
          const txt = String(evt?.part?.text ?? evt?.text ?? "")
          if (txt) { if (!answer.has(id)) answerOrder.push(id); answer.set(id, txt) }
        }
        // 正文开始：先把剩余未发的思考发出去，并【扣住答案】直到它发出，保证「思考 → 答案」
        if (type === "text" && !answerGated) {
          answerGated = true
          if (THINKING) {
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
          out(JSON.stringify(evt) + "\n")
          return
        }
      } catch { /* 非 JSON 行原样放行 */ }
    }
    out(line + "\n")
  })

  const IMG = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"])
  const MAX_SEND = 5, MAX_BYTES = 50 * 1024 * 1024
  const finishAndExit = (exitCode) => {
    // 还扣着答案没放行（短任务：思考的 send 还没回调）→ 等放行后再收尾，别让答案抢在思考前落 stdout。
    if (holding && !released) { onReleased = () => finishAndExit(exitCode); return }
    if (ticker) clearInterval(ticker)
    // 收尾把剩余未发的思考补齐（短任务没到 30s、或思考在正文后还有尾巴）；现发的话留点送达时间再退。
    const flushedNow = flushNewThinking()
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
      }
    }
    // 【和文件补发合并成一条 send，别各发各的】两条 send 并发时，先回调的那条会 process.exit()，
    // 把另一条连同它的内容一起带走——那正是我们要修的"回复丢失"，不能在修复代码里再犯一次。
    if (rescueMsg && !toSend.length) {
      execFile(CC, ["send", "-m", rescueMsg], { windowsHide: true }, () => process.exit(exitCode))
      setTimeout(() => process.exit(exitCode), 30_000)
      return
    }

    if (!toSend.length) { setTimeout(() => process.exit(exitCode), (flushedNow || releasedAnswer) ? 1500 : 0); return }
    const sendArgs = ["send"]
    // 被折下的中间文件不单发一条消息（企微 30 条/分的限速经不起），搭在这条附件上说一句就够。
    // 【只能有一个 -m】抢救文案与"中间文件"提示要拼成一段，push 两次 -m 会被后一个覆盖，
    // 抢救文案（也就是本轮真正的答案）就又丢了。
    const heldNote = held > 0 ? `📎 本轮的交付物在下面；另有 ${held} 个中间文件留在软件的会话目录里，可在软件端查看或打包下载。` : ""
    const oneMsg = [rescueMsg, heldNote].filter(Boolean).join("\n\n")
    if (oneMsg) sendArgs.push("-m", oneMsg)
    for (const f of toSend) sendArgs.push(IMG.has(path.extname(f).toLowerCase()) ? "--image" : "--file", f)
    // 排障日志走独立文件（SCI_WRAP_LOG 由 chat-bridge 注入）。【不能写 stderr】：run 结束后的
    // stderr 会被 cc-connect 当成 "unsolicited agent error" 记 ERROR，吓人且污染真实错误的检索。
    if (process.env.SCI_WRAP_LOG) {
      try { fs.appendFileSync(process.env.SCI_WRAP_LOG, new Date().toISOString() + ` 兜底补发[mod=${mod || "chat"}] ` + toSend.map((f) => path.basename(f)).join(", ") + (held ? `（另折下 ${held} 个）` : "") + "\n") } catch {}
    }
    execFile(CC, sendArgs, { windowsHide: true }, () => process.exit(exitCode))
    setTimeout(() => process.exit(exitCode), 30_000)   // send 卡死也不拖着不退
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
  // 每条来信都是补发窗口：此刻微信的会话令牌刚被这条消息刷新，上一轮丢失的投递现在必能发出。
  // 【必须兜住】它读 bridge.log / last-reply.json / 调 cc-connect，任何一处抛出来都会让本轮
  // 在起 opencode 之前就静默死掉 —— 用户看到的就是「(空响应)」，而补发本身只是锦上添花，
  // 绝不该因为它失败就把用户真正要问的这句话吞掉。
  try { resendLostReply() } catch (e) { wlog("resendLostReply 异常（已忽略，继续本轮）：" + (e?.message || e)) }
  if (!UPLOAD_FIRST) {
    runOpencode(null)   // 关了「先上传后提问」：原样透传 stdin，行为不变
  } else {
    // 开了「先上传后提问」：先读走 cc-connect 从 stdin 喂进来的 prompt 再决定跑不跑模型。
    readStdin().then((prompt) => {
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
        runOpencode(eff, pendImgs)
      } catch {
        // 分析出岔子就按原样把 prompt 交给模型，绝不吞消息
        try { runOpencode(prompt) } catch { process.exit(1) }
      }
    }, () => runOpencode(null))
  }
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
