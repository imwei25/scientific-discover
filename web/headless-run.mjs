#!/usr/bin/env node
// 无头运行器：到点了，在【没有界面、没有人】的情况下把一个定时任务跑完。
//
//   node web/headless-run.mjs --task <任务id>
//   node web/headless-run.mjs --file <任务json>     # 不落库直接跑（调试用）
//   node web/headless-run.mjs --task <id> --dry-run # 只做前置检查，不发消息、不花钱
//
// Windows 任务计划到点执行的就是这条命令（注册层见后续阶段）。
//
// 【它凭什么能在软件关着时干活】三个前提，缺一条就在这儿明确报错，绝不硬跑：
//   ① 登录态：cloud-state.json 里的 refresh token 是长期凭证，用户登录过一次就够，
//      无头进程能自己换到 access token（见 cloud-account.mjs 顶部说明）。所以本功能
//      **要求用户至少成功启动并登录过一次**——从没登录过的机器不该被定时任务偷偷唤醒。
//   ② 执行体：网关 + opencode。壳开着就复用它那套（省一份内存，也不抢同一批会话文件）；
//      壳没开就自己起一套在【另一对端口】上，跑完连进程树一起收掉。
//   ③ 收敛条件：无人值守（autopilot）的 [FINAL] 哨兵与三道护栏（轮数/停滞/额度）
//      已经在网关里了，这里不重复实现，只负责发起、盯着、记账。
//
// 【为什么盯进度用轮询 + SSE 两条腿】
// 一轮结束时网关会在【同一个 tick 里】直接起下一轮（server.mjs 的 `startJob(sid, autoContinueText(...))`），
// 而 SSE 连接是【每轮一条】、上一轮 finish() 时就 end 掉了。只看 SSE 会把"轮次交接"误判成
// "任务结束"；只轮询 /api/job 又拿不到停下来的【原因】（哨兵收官 / 撞护栏 / 出错）。
// 所以：SSE 断了就回头问一次 /api/job，还在跑就重新接上；两者都停才算真结束。
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as T from "./tasks.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const SHELL_PORT = Number(process.env.SCI_SHELL_PORT || 27821)   // 打包版壳里的网关端口（main.rs 的 PORT）
const OWN_PORT = Number(process.env.SCI_HEADLESS_PORT || 27831)  // 自起时用的端口，刻意与壳错开
const OWN_OC_PORT = Number(process.env.SCI_HEADLESS_OC_PORT || 27832)
const BOOT_TIMEOUT_MS = Number(process.env.SCI_HEADLESS_BOOT_MS || 240_000)   // 冷启动含 opencode 扫技能，慢机器要几十秒
const RUN_TIMEOUT_MS = Number(process.env.SCI_HEADLESS_RUN_MS || 2 * 3600_000)
const POLL_MS = 3000

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 参数 ----------------------------------------------------------------

export function parseArgs(argv) {
  const out = { dryRun: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--task") out.task = argv[++i]
    else if (a === "--file") out.file = argv[++i]
    else if (a === "--dry-run") out.dryRun = true
    else if (a === "--force") out.force = true            // 无视 enabled=false（界面上的"立即试跑"用）
    else if (a === "--no-reuse") out.noReuse = true       // 别复用已在跑的网关，自己起一套（测试/排障）
  }
  return out
}

// ---- HTTP 小工具 ---------------------------------------------------------

async function jget(base, p, ms = 8000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const r = await fetch(base + p, { signal: ac.signal })
    return { status: r.status, body: await r.json().catch(() => null) }
  } catch (e) {
    return { status: 0, err: String(e?.message || e) }
  } finally { clearTimeout(t) }
}

async function jpost(base, p, body, ms = 30_000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const r = await fetch(base + p, {
      method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  } catch (e) {
    return { status: 0, err: String(e?.message || e) }
  } finally { clearTimeout(t) }
}

// ---- 网关：复用还是自起 ---------------------------------------------------

/**
 * 找一个活着的网关。**必须带 quick=1**：不带的话这个口会先去探 opencode（2.5s 超时），
 * 而"opencode 还没起来"恰恰是我们要能区分的另一种状态（见下面 waitOpencode）。
 */
async function probeGateway() {
  const cands = [
    process.env.SCI_GATEWAY_URL,
    `http://127.0.0.1:${SHELL_PORT}`,
    process.env.PORT ? `http://127.0.0.1:${Number(process.env.PORT)}` : null,
    `http://127.0.0.1:${OWN_PORT}`,
  ].filter(Boolean)
  for (const base of cands) {
    const r = await jget(base, "/api/health?quick=1", 2500)
    if (r.status === 200 && r.body?.gateway) return base
  }
  return null
}

/**
 * 自起一套网关（壳没开时走这条）。
 *
 * 【env 从哪来】打包版里那一大堆 env（PATH 前插 runtime、OC_BIN、SCI_PYTHON、MATPLOTLIBRC…）
 * 是壳在 main.rs 里算出来的，无头进程自己重算一遍必然与壳漂移——漂了以后症状是
 * "定时跑出来的图没有中文字体""agent 找不到 python"，而这些只在无人值守时发生，最难查。
 * 所以约定：壳启动时把它算好的那份 env 快照写到 headless-env.json，这里原样加载。
 * 快照不存在（开发机、或壳还没升到带快照的版本）→ 退回继承当前 env，并在日志里说清楚。
 */
function loadEnvSnapshot() {
  const f = path.join(__dirname, "headless-env.json")
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"))
    if (j && typeof j.env === "object") return j.env
  } catch {}
  return null
}

function spawnGateway() {
  const snap = loadEnvSnapshot()
  if (!snap) log("[gw] 没有 headless-env.json，按当前进程环境启动（开发机正常；打包版出现这条要查壳有没有写快照）")
  const env = {
    ...process.env, ...(snap || {}),
    PORT: String(OWN_PORT),
    // 两个逃生口：外面已经有一个自己管着的 opencode 时（e2e 测试、排障）用它们接管，
    // 免得这里再拉一个起来抢端口。生产路径两个都不设，走下面的默认。
    OC_URL: process.env.SCI_HEADLESS_OC_URL || `http://127.0.0.1:${OWN_OC_PORT}`,
    MANAGE_OC: process.env.SCI_HEADLESS_MANAGE_OC || "1",
    SCI_HEADLESS: "1",   // 网关侧可据此少做点只对界面有意义的事（目前只用于日志辨识）
  }
  const logFile = path.join(ROOT, "headless-gateway.log")
  let out = "ignore"
  try { out = fs.openSync(logFile, "w") } catch {}
  const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
    cwd: ROOT, env, stdio: ["ignore", out, out], windowsHide: true, detached: false,
  })
  log(`[gw] 自起网关 pid=${child.pid} 端口 ${OWN_PORT}（日志 ${logFile}）`)
  return child
}

/** 等 opencode 也就绪——只等网关 listen 是不够的：那时发消息会直接撞上"后台未就绪"。 */
async function waitReady(base, deadline) {
  let lastErr = ""
  while (Date.now() < deadline) {
    const r = await jget(base, "/api/health", 5000)
    if (r.status === 200 && r.body?.opencode) return { ok: true }
    lastErr = r.status ? `health=${r.status} opencode=${r.body?.opencode}` : (r.err || "连不上")
    await sleep(2000)
  }
  return { ok: false, err: `等后台就绪超时（${lastErr}）` }
}

/** 收掉自起的那套。Windows 上必须按进程树杀：node → cmd → opencode，直接 kill 只带走最上面一层。 */
function killTree(child) {
  if (!child?.pid) return
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    else child.kill("SIGTERM")
  } catch {}
}

// ---- 额度 ----------------------------------------------------------------

const CREDIT_USD = 0.01   // 与云端同口径：1 积分 = $0.01
/** 从 /api/quota 取"已用积分"（云端日线优先；没有云端账号就退回本机 env 额度那条线）。 */
export function usedCredits(q) {
  const d = q?.cloud?.daily
  if (d && Number.isFinite(Number(d.usedUsd))) return Number(d.usedUsd) / CREDIT_USD
  if (Number.isFinite(Number(q?.used))) return Number(q.used) / CREDIT_USD
  return null
}
const exhausted = (l) => !!l && !l.unlimited && Number(l.limitUsd) > 0 && Number(l.usedUsd) >= Number(l.limitUsd)
/**
 * 还剩多少积分。日线与月线取【小的那个】——两条线任一见底都跑不动，
 * 只看日线的话，月底额度快用完时保护线形同虚设。不限额（两条都 unlimited）返回 null。
 */
export function remainCredits(q) {
  const vals = [q?.cloud?.daily, q?.cloud?.monthly]
    .filter((l) => l && !l.unlimited && Number.isFinite(Number(l.remain)))
    .map((l) => Number(l.remain))
  return vals.length ? Math.min(...vals) : null
}

// ---- 盯一轮（含自动续跑的整串） -------------------------------------------

/**
 * 订阅一条 SSE 直到它断掉，把这一轮的事件收进 acc。
 * 【别用 EventSource】Node 内置的那个不带自定义超时也不好中断；这里手撕一个够用的解析器。
 */
async function streamRound(base, sid, acc, signal) {
  let r
  try { r = await fetch(`${base}/api/chat/attach?sid=${encodeURIComponent(sid)}`, { signal }) }
  catch (e) { acc.streamErr = String(e?.message || e); return }
  if (!r.ok || !r.body) { acc.streamErr = `attach ${r.status}`; return }
  const ct = r.headers.get("content-type") || ""
  if (!ct.includes("text/event-stream")) {   // 没有进行中的轮 → 网关回 JSON 的 idle
    acc.idle = true
    try { await r.text() } catch {}
    return
  }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    let chunk
    try { chunk = await reader.read() } catch (e) { acc.streamErr = String(e?.message || e); break }
    if (chunk.done) break
    buf += dec.decode(chunk.value, { stream: true })
    let i
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2)
      const ev = /^event: (.+)$/m.exec(raw)?.[1]
      const dataRaw = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n")
      let data = dataRaw
      try { data = JSON.parse(dataRaw) } catch {}
      onEvent(ev, data, acc)
    }
  }
}

export const newAcc = () => ({ finalText: "", notices: [], rounds: 0, doneCount: 0, sawFinal: false, sawAuto: false, failed: "", streamErr: "", timeout: false, overCredits: 0, idle: false })

export function onEvent(ev, data, acc) {
  if (ev === "final") { acc.finalText = String(data?.text || ""); acc.sawFinal = true }
  else if (ev === "idle") { acc.idle = true }
  else if (ev === "auto") { acc.rounds = Math.max(acc.rounds, Number(data?.round) || 0); acc.sawAuto = true }
  else if (ev === "failed") { acc.failed = String(data?.message || "本轮出错"); }
  else if (ev === "notice") { acc.notices.push(String(data?.message || "")) }
  else if (ev === "done") { acc.doneCount++; acc.sawAuto = false }
}

/**
 * 从"消息已发出"盯到"整串自动续跑结束"。
 * 中途每隔一轮查一次额度：单次任务积分上限（maxCredits）是本功能新加的那道闸，
 * 现有的日额度拦不住"一个任务把当天额度吃光"。超了就 abort，并如实记进运行记录。
 */
async function watchUntilIdle(base, sid, task, acc, deadline, creditsAtStart) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.max(1000, deadline - Date.now()))
  try {
    for (;;) {
      await streamRound(base, sid, acc, ac.signal)
      if (Date.now() > deadline) { acc.timeout = true; break }
      // 额度闸（本次任务花掉多少）
      if (task.maxCredits > 0 && creditsAtStart != null) {
        const now = usedCredits((await jget(base, "/api/quota?fresh=1", 15_000)).body)
        if (now != null && now - creditsAtStart >= task.maxCredits) {
          acc.overCredits = Math.round((now - creditsAtStart) * 10) / 10
          await jpost(base, "/api/chat/abort", { sid }, 15_000)
          break
        }
      }
      // SSE 断了不代表结束：轮次交接就在同一 tick，问一次 job 才知道
      const j = await jget(base, `/api/job?sid=${encodeURIComponent(sid)}`, 8000)
      if (!j.body?.running) break
      await sleep(POLL_MS)
    }
  } finally { clearTimeout(timer) }
  if (acc.timeout) { try { await jpost(base, "/api/chat/abort", { sid }, 15_000) } catch {} }
}

// ---- 主流程 --------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let task = null
  if (args.file) {
    const n = T.normalizeTask(JSON.parse(fs.readFileSync(args.file, "utf8")))
    if (!n.ok) { console.error("任务定义有问题：" + n.errors.join("；")); process.exit(2) }
    task = n.task
  } else if (args.task) {
    task = T.readTask(args.task)
    if (!task) { console.error(`找不到任务 ${args.task}`); process.exit(2) }
  } else {
    console.error("用法：node headless-run.mjs --task <id> | --file <task.json> [--dry-run] [--force]")
    process.exit(2)
  }
  if (!task.enabled && !args.force) { log(`任务「${task.title}」已停用，跳过`); process.exit(0) }

  const startedAt = new Date().toISOString()
  const rec = { taskId: task.id, title: task.title, startedAt, endedAt: null, ok: false, reason: "", sid: "", rounds: 0, outputs: [], credits: null, notices: [], quota: false }
  // 只有【真的跑起来】才写记录：dry-run 与"锁被别人占着"都不该在历史里留下一条失败
  let writeRecord = false
  let child = null
  const lock = T.acquireLock(task.id)
  if (!lock.ok) { log(`任务「${task.title}」上一次还在跑（pid ${lock.holder?.pid}），本次跳过`); process.exit(0) }

  try {
    // ① 执行体：复用壳的，或自起一套
    let base = args.noReuse ? null : await probeGateway()
    const reused = !!base
    if (base) log(`[gw] 复用已在跑的网关 ${base}`)
    else { child = spawnGateway(); base = `http://127.0.0.1:${OWN_PORT}` }

    const ready = await waitReady(base, Date.now() + BOOT_TIMEOUT_MS)
    if (!ready.ok) { rec.reason = ready.err; writeRecord = true; throw new Error(ready.err) }

    // ② 前置闸：登录态与额度。**在发消息之前查**——无人值守时没人看得见报错，
    //    与其让它撞进一轮必然失败的对话，不如当场记一条清清楚楚的失败。
    const cs = (await jget(base, "/api/cloud/status")).body
    if (cs && cs.configured && !cs.loggedIn) {
      rec.reason = "未登录云端账号（定时任务需要你先在软件里登录过一次）"
      writeRecord = true; throw new Error(rec.reason)
    }
    const q0 = (await jget(base, "/api/quota?fresh=1", 20_000)).body
    if (exhausted(q0?.cloud?.daily) || exhausted(q0?.cloud?.monthly)) {
      rec.reason = "积分已用尽，本次没跑（额度恢复后的下一次定时会照常执行）"
      rec.quota = true   // 下次开界面要专门提示这一类，见网关的 taskNews
      writeRecord = true; throw new Error(rec.reason)
    }
    // 用户自己设的保护线：剩余积分低于它就不跑，把额度留给他本人白天用。
    // 【查的是"剩余"不是"已用"】用户想的是"给我自己留 50 积分"，而不是"任务花到 50 就停"。
    const cfg = (await jget(base, "/api/tasks", 15_000)).body
    const minC = Math.max(0, Number(cfg?.settings?.minCredits) || 0)
    const remain = remainCredits(q0)
    if (minC > 0 && remain != null && remain < minC) {
      rec.reason = `剩余积分 ${remain} 低于你设的下限 ${minC}，本次没跑（把额度留给你自己用）`
      rec.quota = true
      writeRecord = true; throw new Error(rec.reason)
    }
    // 该档强制用哪个模型（管理员在后台按档钉的；'' = 不强制）。基础档的模板任务走便宜模型。
    const taskModel = String(cfg?.taskModel || "")
    const c0 = usedCredits(q0)

    if (args.dryRun) {
      log(`[dry-run] 前置检查全通过：网关 ${base}（${reused ? "复用" : "自起"}）、登录态 OK、已用积分 ${c0 ?? "?"}`)
      log(`[dry-run] 将要发送的任务内容：\n${task.prompt.slice(0, 500)}${task.prompt.length > 500 ? " …" : ""}`)
      return
    }

    // ③ 发起一轮无人值守。sid 不传 → 网关现建会话（目录即产物目录），跑完在界面里能看到。
    const start = await jpost(base, "/api/chat/start",
      { q: task.prompt, module: task.module || "chat", auto: true, ...(taskModel ? { taskModel } : {}) }, 60_000)
    if (!start.body?.ok || !start.body?.sent) {
      rec.reason = start.body?.err || start.body?.notice || `网关拒收（HTTP ${start.status}${start.err ? " " + start.err : ""}）`
      writeRecord = true; throw new Error(rec.reason)
    }
    rec.sid = start.body.sid
    writeRecord = true   // 从这里开始，无论怎么收场都要留下记录：钱已经开始花了
    log(`[run] 会话 ${rec.sid} 已起轮，盯着直到收官…`)

    // ④ 盯完整串
    const acc = newAcc()
    await watchUntilIdle(base, rec.sid, task, acc, Date.now() + RUN_TIMEOUT_MS, c0)

    // ⑤ 结账
    const q1 = (await jget(base, "/api/quota?fresh=1", 20_000)).body
    const c1 = usedCredits(q1)
    rec.credits = c0 != null && c1 != null ? Math.round((c1 - c0) * 10) / 10 : null
    // 轮数以【历史】为准，不用 SSE 数出来的 doneCount。
    // 【为什么】两轮之间网关是在同一个 tick 里接着起下一轮的，而 SSE 每轮一条、上一轮 finish()
    // 时就断了；重连总有个时间窗，恰好落在窗里的那一轮 done 事件收不到 —— 实测 3 轮数成 2 轮。
    // 历史里一条 user 消息就是一轮（自动续跑注入的续跑指令也是 user 消息），与竞态无关。
    const hist = (await jget(base, `/api/history?sid=${encodeURIComponent(rec.sid)}`, 30_000)).body
    const users = Array.isArray(hist) ? hist.filter((m) => m.role === "user").length : 0
    rec.rounds = Math.max(1, users, acc.doneCount)
    // 正文同理走历史兜底：末轮的 final 事件也可能没收到，而"有没有正文"是判成败的依据之一。
    if (!acc.finalText.trim() && Array.isArray(hist))
      acc.finalText = [...hist].reverse().find((m) => m.role === "assistant")?.text || ""
    rec.notices = acc.notices.filter(Boolean).slice(-5)
    const outs = (await jget(base, `/api/outputs?sid=${encodeURIComponent(rec.sid)}`, 20_000)).body
    rec.outputs = Array.isArray(outs) ? outs.map((f) => (typeof f === "string" ? f : f?.name || f?.path || "")).filter(Boolean) : []

    // 成败口径：网关报错 / 超时 / 撞了积分闸 → 失败；否则以"有没有产物 + 有没有正文"为准。
    // 【不拿哨兵当唯一判据】哨兵是模型自报完成，它撞了轮数上限也可能已经交付了大部分东西；
    // 那种情况记成"部分完成"比记成失败有用——用户第二天看到的是产物，不是一个红叉。
    // 轮内触顶（网关认出云端 429 后广播的 failed）也算积分类，下次开界面要专门提示
    if (acc.failed) { rec.ok = false; rec.reason = acc.failed; if (/积分|额度|配额|quota/i.test(acc.failed)) rec.quota = true }
    else if (acc.timeout) { rec.ok = false; rec.reason = `超时（超过 ${Math.round(RUN_TIMEOUT_MS / 60000)} 分钟仍未收官，已终止）` }
    else if (acc.overCredits) { rec.ok = false; rec.reason = `本次任务已花掉 ${acc.overCredits} 积分，达到你为它设的上限，已终止` }
    else if (rec.outputs.length || acc.finalText.trim()) { rec.ok = true; rec.reason = acc.notices.length ? "完成（有提示，见 notices）" : "完成" }
    else { rec.ok = false; rec.reason = "跑完了但既没有产物也没有正文（多半是上游异常）" }
    log(`[run] ${rec.ok ? "✔" : "✘"} ${rec.reason}；${rec.rounds} 轮、产物 ${rec.outputs.length} 个、约 ${rec.credits ?? "?"} 积分`)

    // ④ 推送到「聊天接入」绑定的微信/企微（可选，task.pushChat）。
    // 【只在复用壳网关时推】桥由壳网关(27821)托管；自起网关(27831)时软件是关着的、桥必然不在，
    // 推了也没有对象——这正是"软件关着能跑但推不了"的技术根因，如实跳过并记一句。
    if (task.pushChat && !args.dryRun) {
      if (!reused) {
        log("[push] 跳过推送：软件没开着（定时任务自起了网关），聊天接入不在运行")
      } else {
        try {
          const head = acc.finalText.trim().replace(/\s+/g, " ").slice(0, 300)
          const txt = `【定时任务·${task.title}】${rec.ok ? "已完成" : "未完成：" + rec.reason}` +
            (head ? "\n" + head : "")
          // 带上产物：文件名 + 本轮会话 id，由网关侧解析成绝对路径再发（图片内联、文档附件，
          // 服务端限大小/数量）。没能发的大文件仍留在软件里可下载。
          const pr = await jpost(base, "/api/chat-bridge/push", { text: txt, sid: rec.sid, files: rec.outputs }, 60_000)
          log(`[push] ${pr?.body?.ok ? "已推送到聊天接入" : "未推送（" + (pr?.body?.err || "?") + "）"}`)
        } catch (e) { log("[push] 推送异常：" + (e?.message || e)) }
      }
    }
  } catch (e) {
    if (!rec.reason) rec.reason = String(e?.message || e)
    log(`[run] ✘ ${rec.reason}`)
  } finally {
    rec.endedAt = new Date().toISOString()
    if (writeRecord && !args.dryRun && !args.file) T.writeRun(task.id, rec)
    lock.release()
    if (child) { log("[gw] 收掉自起的网关进程树"); killTree(child) }
  }
  process.exit(rec.ok ? 0 : 1)
}

// 只有被【直接执行】时才跑（被测试 import 时不能自动开跑，那会真去连网关）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))
  main().catch((e) => { console.error(e); process.exit(1) })
