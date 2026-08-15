// 定时任务的【定义与运行记录】——纯 fs + 纯函数，不碰网络、不碰 opencode。
//
// 分三层，这里是最底下一层：
//   ① 本文件：任务定义怎么存、下次该什么时候跑、跑过的记下什么（可单测）；
//   ② headless-run.mjs：到点了真去把任务跑完（起/复用网关 → 发一轮无人值守 → 收结果）；
//   ③ 计划任务注册层 + 界面（后续阶段）：把 ① 的 schedule 翻成 Windows 任务计划的 XML。
//
// 【为什么下次运行时间在这儿算，而不是全交给 Windows】
// 界面要显示"下次 8 月 12 日 07:00 运行"，注册层要把同一份语义翻成 XML，跑完还要判断
// "这次是不是补跑的"。三处若各算各的，早晚会出现界面显示的时间和真正触发的时间对不上——
// 而这种偏差用户只会当成"这软件的定时不准"，没人报得清。所以语义只有 nextRunAt 一个出处。
//
// 【时间一律按本机本地时区】Windows 任务计划就是按本地时间触发的，这里跟着它走；
// 存盘存的是 "HH:MM" 这样的墙上时间而不是时间戳，用户改时区后行为符合直觉（还是早上 7 点跑）。
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

// 测试与多实例要能整体重定向（server.mjs 里 SESSIONS_META_PATH 等同款做法）
export const TASKS_DIR = process.env.SCI_TASKS_DIR || path.join(ROOT, "tasks")
export const RUNS_DIR = path.join(TASKS_DIR, "runs")

/** 每个任务最多保留几条运行记录（超出删最旧的）。长跑一年也不至于攒出几千个小文件。 */
export const KEEP_RUNS = Math.max(1, Number(process.env.SCI_TASK_KEEP_RUNS || 30))
/** 锁多久算失效：进程被强杀（关机/任务管理器）时锁文件会留下，不设时效就永远跑不了了。 */
const LOCK_STALE_MS = Math.max(60_000, Number(process.env.SCI_TASK_LOCK_STALE_MS || 6 * 3600_000))

const WEEK_DAYS = [0, 1, 2, 3, 4, 5, 6]   // 0 = 周日，与 Date.getDay() 同口径
// pushTo 的合法取值。"" = 全部已连接平台（默认，也是老任务的行为）。
// 平台名与 chat-bridge.mjs 的 PLATFORMS 同一套，别各写各的。
export const PUSH_TARGETS = new Set(["", "wecom", "weixin"])

// ---- 存取 ----------------------------------------------------------------

const taskFile = (id) => path.join(TASKS_DIR, `${id}.json`)
const readJson = (f, dflt = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return dflt } }
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  // 先写临时文件再改名：到点触发时 headless-run 正在读，界面同时在改 —— 半截 JSON 会让
  // 任务"看起来消失了"。rename 在同一卷上是原子的。
  const tmp = f + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2))
  fs.renameSync(tmp, f)
}

/** 任务 id：只用文件名安全字符——它会原样出现在文件名与 Windows 计划任务名里。 */
export const newTaskId = () =>
  "t" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)

/** id 合法性（防目录穿越：这个 id 直接拼进文件路径）。 */
export const validTaskId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(String(id || ""))

export function listTasks() {
  let names = []
  try { names = fs.readdirSync(TASKS_DIR).filter((n) => n.endsWith(".json")) } catch { return [] }
  return names
    .map((n) => readJson(path.join(TASKS_DIR, n)))
    .filter((t) => t && validTaskId(t.id))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
}

export function readTask(id) {
  if (!validTaskId(id)) return null
  return readJson(taskFile(id))
}

export function saveTask(task) {
  if (!validTaskId(task?.id)) throw new Error("非法任务 id")
  writeJson(taskFile(task.id), task)
  return task
}

export function deleteTask(id) {
  if (!validTaskId(id)) return false
  try { fs.rmSync(taskFile(id)) } catch { return false }
  try { fs.rmSync(path.join(RUNS_DIR, id), { recursive: true, force: true }) } catch {}
  return true
}

// ---- 校验与归一 ----------------------------------------------------------

const isHHMM = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ""))
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))

/**
 * 把外部（界面 / 技能 / 手写 json）传来的东西归一成一个完整任务，并把问题一次性列全。
 * 返回 {ok, task, errors:[]}。**不写盘**——调用方决定要不要存。
 */
export function normalizeTask(input, { now = new Date() } = {}) {
  const errors = []
  const src = input && typeof input === "object" ? input : {}
  const id = src.id && validTaskId(src.id) ? src.id : newTaskId()

  const title = String(src.title || "").trim().slice(0, 120)
  if (!title) errors.push("缺标题")

  const prompt = String(src.prompt || "").trim()
  if (!prompt) errors.push("缺任务内容（prompt）")
  else if (prompt.length > 20_000) errors.push("任务内容过长（超过 2 万字）")

  const sch = src.schedule && typeof src.schedule === "object" ? src.schedule : {}
  const kind = ["daily", "weekly", "once"].includes(sch.kind) ? sch.kind : null
  if (!kind) errors.push("schedule.kind 只能是 daily / weekly / once")
  const time = isHHMM(sch.time) ? sch.time : null
  if (!time) errors.push("schedule.time 要形如 07:00")
  let days = null
  if (kind === "weekly") {
    days = Array.isArray(sch.days) ? [...new Set(sch.days.map(Number).filter((d) => WEEK_DAYS.includes(d)))].sort() : []
    if (!days.length) errors.push("每周任务要至少选一天（schedule.days，0=周日）")
  }
  let date = null
  if (kind === "once") {
    date = isDate(sch.date) ? sch.date : null
    if (!date) errors.push("一次性任务要给 schedule.date（YYYY-MM-DD）")
  }

  // 无人值守的两道钱闸。maxCredits 是本功能【新加】的那道：现有的日额度对定时任务不够用——
  // 半夜一个跑飞的任务能把当天额度吃光，早上人来了什么都干不成。0 = 不额外限制（仍受日额度管）。
  const maxCredits = Math.max(0, Number(src.maxCredits) || 0)
  const maxRounds = Math.max(0, Math.min(50, Number(src.maxRounds) || 0))   // 0 = 用网关默认

  const task = {
    id,
    title,
    prompt,
    // 模板任务（基础档）：留着模板 id 与参数，编辑时才能把表单原样填回去。
    // prompt 仍然是权威的那份（由服务端按模板拼好），运行器只认它——两份不一致时以 prompt 为准，
    // 因为它才是真正会发出去的东西。
    ...(src.preset ? { preset: String(src.preset), params: src.params && typeof src.params === "object" ? src.params : {} } : {}),
    module: String(src.module || "chat"),
    enabled: src.enabled !== false,
    // 跑完把结果推到「聊天接入」绑定的微信/企微对话（前提：软件开着、桥在跑；关着照跑但不推，
    // 见 headless-run 的 pushToChatBridge）。默认关——不是每个定时任务都想往微信刷消息。
    pushChat: src.pushChat === true,
    // 推给哪个平台："" = 全部已连接的（历史行为，也是默认值）／"wecom" 企微／"weixin" 个人微信。
    // 【为什么要这个字段】定时任务跑在自己的新会话目录里，chat-bridge 的 platformOfDir() 认不出
    // 它属于哪个平台，于是回落到"推给所有在线平台"——企微和个人微信都连着时两边各收一份，
    // 而界面上只有一个「推送到我的微信/企业微信」勾选框，用户根本看不出来会双发。
    // 留空是刻意的：老任务没有这个字段，读出来就是 ""，行为与升级前完全一致，不用迁移。
    pushTo: PUSH_TARGETS.has(String(src.pushTo || "")) ? String(src.pushTo || "") : "",
    schedule: { kind, time, ...(days ? { days } : {}), ...(date ? { date } : {}) },
    maxRounds,
    maxCredits,
    createdAt: src.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
  }
  return { ok: errors.length === 0, task, errors }
}

// ---- 下次运行时间 --------------------------------------------------------

const atLocal = (y, m, d, hh, mm) => new Date(y, m, d, hh, mm, 0, 0)

/**
 * 下一次该跑的时刻（本地时区），返回 Date；一次性任务已过期则返回 null。
 * 边界口径：**与 from 同一分钟的时间点算"已经过去"**——注册层与界面都在跑完的瞬间重算下次，
 * 若算成"还没到"，界面会显示一个 0 秒后的下次运行时间，看着像卡住了。
 */
export function nextRunAt(task, from = new Date()) {
  const sch = task?.schedule || {}
  if (!isHHMM(sch.time)) return null
  const [hh, mm] = sch.time.split(":").map(Number)
  const base = new Date(from.getTime())
  base.setSeconds(0, 0)

  if (sch.kind === "once") {
    if (!isDate(sch.date)) return null
    const [y, m, d] = sch.date.split("-").map(Number)
    const at = atLocal(y, m - 1, d, hh, mm)
    return at.getTime() > base.getTime() ? at : null
  }
  const okDay = (dt) => (sch.kind === "weekly" ? (sch.days || []).includes(dt.getDay()) : true)
  // 最多往后找 8 天：每周任务最坏要跨 7 天，多留一天给夏令时/闰秒之类的边角
  for (let i = 0; i < 8; i++) {
    const dt = atLocal(base.getFullYear(), base.getMonth(), base.getDate() + i, hh, mm)
    if (dt.getTime() > base.getTime() && okDay(dt)) return dt
  }
  return null
}

// ---- 运行记录 ------------------------------------------------------------

const runDir = (taskId) => path.join(RUNS_DIR, taskId)
const lockFile = (taskId) => path.join(runDir(taskId), ".lock")

/** 记录文件名用本地时间戳，便于人肉按时间排（排序仍按文件名字典序，与时间序一致）。 */
const stamp = (d) => {
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 抢锁。同一任务上一次还没跑完（机器慢 / 上次挂在半路）时，本次直接跳过——
 * 【不能排队等】定时任务每天都会再来一次，等着只会攒出一串同时醒来的进程。
 * 返回 {ok:true, release()} 或 {ok:false, reason, holder}。
 */
export function acquireLock(taskId, { now = Date.now(), pid = process.pid } = {}) {
  fs.mkdirSync(runDir(taskId), { recursive: true })
  const f = lockFile(taskId)
  const cur = readJson(f)
  if (cur && now - Number(cur.at || 0) < LOCK_STALE_MS && pidAlive(cur.pid))
    return { ok: false, reason: "running", holder: cur }
  // 过期锁 / 持有者已死 → 直接夺锁。夺锁这件事要留痕，否则"上次为什么被顶掉"查不出来。
  const stale = cur ? { staleFrom: cur } : {}
  writeJson(f, { pid, at: now, ...stale })
  return {
    ok: true,
    release: () => { try { fs.rmSync(f) } catch {} },
  }
}

/** 进程还在不在。跨平台：signal 0 只探活不发信号；EPERM = 存在但不是我的（也算活）。 */
function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try { process.kill(n, 0); return true } catch (e) { return e?.code === "EPERM" }
}

/**
 * 落一条运行记录并按 KEEP_RUNS 修剪历史。record 至少含 {startedAt, endedAt, ok, reason}。
 * 同时把摘要回写进任务本体的 lastRun —— 界面列表要一眼看到"上次成功没有"，
 * 不能为了画一行列表去读 N 个任务的历史目录。
 */
export function writeRun(taskId, record) {
  const dir = runDir(taskId)
  fs.mkdirSync(dir, { recursive: true })
  const name = `${stamp(new Date(record.startedAt || Date.now()))}.json`
  writeJson(path.join(dir, name), record)

  let files = []
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort() } catch {}
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_RUNS)))
    { try { fs.rmSync(path.join(dir, old)) } catch {} }

  const t = readTask(taskId)
  if (t) {
    t.lastRun = {
      at: record.startedAt, ok: !!record.ok, reason: record.reason || "",
      sid: record.sid || "", outputs: (record.outputs || []).length, credits: record.credits ?? null,
    }
    // 一次性任务跑过就自动停用：否则它会在【每天】的同一时刻被 Windows 触发
    // （注册层给 once 也是按日历项注册的），用户以为只跑一次，实则天天来。
    if (t.schedule?.kind === "once") t.enabled = false
    saveTask(t)
  }
  return path.join(dir, name)
}

export function listRuns(taskId, limit = KEEP_RUNS) {
  const dir = runDir(taskId)
  let files = []
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort().reverse() } catch { return [] }
  return files.slice(0, limit).map((n) => readJson(path.join(dir, n))).filter(Boolean)
}

/** 供 headless-run 与后续界面共用的一行人话摘要。 */
export const runSummary = (r) =>
  !r ? "从未运行"
    : r.ok ? `成功（${r.rounds || 1} 轮，产物 ${(r.outputs || []).length} 个）`
      : `未完成：${r.reason || "未知原因"}`

export const _internals = { pidAlive, stamp, LOCK_STALE_MS, os }
