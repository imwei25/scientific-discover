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
//     （已在事件流里看见模型自己 send 过的路径会跳过，不重复发）。
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

const REAL_OC = process.env.SCI_WRAP_OC
const CC = process.env.SCI_WRAP_CC || "cc-connect"
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
  if (stdinText != null) { try { child.stdin.write(stdinText); child.stdin.end() } catch {} }
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const DROP = new Set(["tool", "tool_use", "tool_result"])   // 工具事件永远不外发
  const modelSent = new Set()      // 模型自己 send 过的文件（绝对路径小写），兜底时跳过
  let toolCount = 0
  let lastToolLabel = ""

  // 「输出思考」：把 reasoning 各段按出现顺序攒起来（同一段的增量事件取最新全文），
  // 到正文开始（或收尾）时【聚合成一条】推给聊天平台，绕过事件流，不受工具过滤影响。
  const reason = new Map()   // partId → 最新全文
  const order = []           // partId 出现顺序
  let thinkFlushed = false
  const flushThinking = () => {   // 返回是否真发了一条（收尾兜底时据此决定要不要留出送达时间）
    if (!THINKING || thinkFlushed) return false
    thinkFlushed = true
    let txt = order.map((id) => reason.get(id)).filter(Boolean).join("\n\n").trim()
    if (!txt) return false
    const MAX = 3000
    if (txt.length > MAX) txt = txt.slice(0, MAX) + "\n…（思考较长，已截断）"
    execFile(CC, ["send", "-m", "💭 思考过程\n" + txt], { windowsHide: true }, () => {})
    return true
  }

  // 进度提示：45s 一查，期间有工具活动才发；发送本身也走 cc-connect（不进事件流，不受过滤影响）
  let lastPing = Date.now(), pingedTools = 0
  const ticker = PROGRESS ? setInterval(() => {
    if (toolCount > pingedTools && Date.now() - lastPing >= 45_000) {
      pingedTools = toolCount; lastPing = Date.now()
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
        // 正文开始：把攒好的思考先推一条，保证顺序是「思考 → 回答」
        if (type === "text") flushThinking()
        // 错误事件：把 opencode 的技术话术翻成中文再放行（cc-connect 从这条事件取文案发进聊天）
        if (type === "error" && evt?.error) {
          const e = evt.error
          const raw = String(e?.data?.message || e?.message || e?.name || "")
          const ref = e?.data?.ref
          const f = friendlyError(raw, e?.name)
          evt.error = { name: f.t, data: { message: f.m + (ref ? `（编号 ${ref}）` : ""), ref } }
          process.stdout.write(JSON.stringify(evt) + "\n")
          return
        }
      } catch { /* 非 JSON 行原样放行 */ }
    }
    process.stdout.write(line + "\n")
  })

  const IMG = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"])
  const MAX_SEND = 5, MAX_BYTES = 50 * 1024 * 1024
  const finishAndExit = (exitCode) => {
    if (ticker) clearInterval(ticker)
    // 全程没冒出正文（比如只调了工具就结束）也别把思考漏掉；这里现发的话要留点送达时间再退。
    const flushedNow = flushThinking()
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
    const toSend = fresh
      .filter((f) => !modelSent.has(path.resolve(f.p).toLowerCase()))
      .filter((f) => f.size > 0 && f.size <= MAX_BYTES)
      .filter((f) => ![".py", ".log", ".tmp"].includes(path.extname(f.p).toLowerCase()))  // 脚本/日志是过程不是交付物
      .slice(0, MAX_SEND)
    if (!toSend.length) { setTimeout(() => process.exit(exitCode), flushedNow ? 1500 : 0); return }
    const sendArgs = ["send"]
    for (const f of toSend) sendArgs.push(IMG.has(path.extname(f.p).toLowerCase()) ? "--image" : "--file", f.p)
    // 排障日志走独立文件（SCI_WRAP_LOG 由 chat-bridge 注入）。【不能写 stderr】：run 结束后的
    // stderr 会被 cc-connect 当成 "unsolicited agent error" 记 ERROR，吓人且污染真实错误的检索。
    if (process.env.SCI_WRAP_LOG) {
      try { fs.appendFileSync(process.env.SCI_WRAP_LOG, new Date().toISOString() + " 兜底补发 " + toSend.map((f) => path.basename(f.p)).join(", ") + "\n") } catch {}
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
  } else if (!UPLOAD_FIRST) {
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

if (isMain) main()
