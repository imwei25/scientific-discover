// 把任务定义翻成 Windows 任务计划的条目——这一层是"软件关着也能跑"真正落地的地方。
//
// 【为什么用 /XML 注册，而不是 schtasks 的命令行参数】
// 命令行版（/SC DAILY /ST 07:00）开不了两个对本功能来说最要紧的开关：
//   · StartWhenAvailable —— 到点时机器是关着的（夜里关机、笔记本合盖），开机后【补跑】一次。
//     没有它，用户关机过夜等于这条定时任务当天直接消失，而他不会知道为什么没产物。
//   · WakeToRun —— 允许把睡眠中的机器唤醒来跑（台式机有效；笔记本合盖休眠仍不保证，见交付说明）。
// 这两项只在 XML 里有。所以注册一律走 XML。
//
// 【XML 文件必须是 UTF-16】schtasks /Create /XML 只认 UTF-16（带 BOM）。写成 UTF-8 会报
// "任务 XML 包含的值格式设置不正确" —— 报错文字完全指不到编码上，纯靠踩过才知道。
//
// 【为什么用 InteractiveToken（跟随登录用户）】它不需要保存用户密码，也不需要管理员权限，
// 装完即可用。代价写在说明里：**用户注销 / 切到别的 Windows 账户时不跑**（关软件、锁屏都照跑）。
// 换成 S4U/Password 才能在注销时跑，但那要么要密码、要么要管理员——对本产品的用户群不划算。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { nextRunAt } from "./tasks.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

/** 所有任务都挂在这个文件夹下：卸载时能整个删掉，也不会和用户自己的计划任务混在一起。 */
export const TASK_FOLDER = process.env.SCI_TASK_FOLDER || "NiumaScience"
export const taskName = (id) => `\\${TASK_FOLDER}\\${id}`

const WEEK_XML = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const pad = (n) => String(n).padStart(2, "0")
/** 本地时间的 ISO 形式（**不带 Z**）：任务计划把不带时区的时间当本地时间，正是我们要的。 */
const localIso = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

/**
 * 运行器的启动信息：拿哪个 node、跑哪个脚本、工作目录在哪。
 * 打包版里 node 在 bundle\runtime\node\node.exe，与开发机的 process.execPath 不是一回事——
 * 所以优先信壳写的快照（headless-env.json），它才知道自己被装到哪儿了。
 */
export function runnerSpec() {
  let snap = null
  try { snap = JSON.parse(fs.readFileSync(path.join(__dirname, "headless-env.json"), "utf8")) } catch {}
  const appDir = snap?.appDir || ROOT
  return {
    nodeExe: snap?.nodeExe || process.execPath,
    script: path.join(appDir, "web", "headless-run.mjs"),
    workDir: appDir,
    fromSnapshot: !!snap,
  }
}

/**
 * 任务定义 → 任务计划 XML（纯函数，可单测）。
 * `now` 只用来给 StartBoundary 挑一个"下一次"的具体时刻——日历触发器仍按 time/days 周期性触发，
 * StartBoundary 只是起算点。
 */
export function buildXml(task, { now = new Date(), spec = runnerSpec() } = {}) {
  const start = nextRunAt(task, now) || now
  const sch = task.schedule || {}
  let trigger
  if (sch.kind === "once") {
    // 【EndBoundary 不能省】只要写了 DeleteExpiredTaskAfter（让一次性任务跑完自己消失），
    // 任务计划就要求触发器有结束时间，否则注册直接被拒：
    //   「任务 XML 缺少个所需元素或属性。(46,4):EndBoundary:」——真机第一次注册就撞上。
    // 留 7 天的窗口：机器关了几天再开，StartWhenAvailable 仍能把它补跑掉；
    // 而一个搁置一周以上的一次性任务，再补跑已经没有意义了。
    const end = new Date(start.getTime() + 7 * 24 * 3600_000)
    trigger = `    <TimeTrigger>
      <StartBoundary>${localIso(start)}</StartBoundary>
      <EndBoundary>${localIso(end)}</EndBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>`
  } else if (sch.kind === "weekly") {
    const days = (sch.days || []).map((d) => `          <${WEEK_XML[d]} />`).join("\n")
    trigger = `    <CalendarTrigger>
      <StartBoundary>${localIso(start)}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <DaysOfWeek>
${days}
        </DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>`
  } else {
    trigger = `    <CalendarTrigger>
      <StartBoundary>${localIso(start)}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>`
  }
  // ExecutionTimeLimit 与运行器自己的超时（SCI_HEADLESS_RUN_MS，默认 2h）留出余量：
  // 让运行器【自己】超时收尾（它会 abort 会话、写运行记录），而不是被任务计划一刀砍掉——
  // 被砍掉的那次什么记录都不会留下，用户第二天只看到"这次好像没跑"。
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEsc(task.title || "")}（牛马科研 定时任务）</Description>
    <URI>${xmlEsc(taskName(task.id))}</URI>
  </RegistrationInfo>
  <Triggers>
${trigger}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>${task.enabled === false ? "false" : "true"}</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>
    <Priority>7</Priority>
    ${sch.kind === "once" ? "<DeleteExpiredTaskAfter>P1D</DeleteExpiredTaskAfter>" : ""}
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEsc(spec.nodeExe)}</Command>
      <Arguments>"${xmlEsc(spec.script)}" --task ${xmlEsc(task.id)}</Arguments>
      <WorkingDirectory>${xmlEsc(spec.workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

// ---- 与 schtasks.exe 打交道 ------------------------------------------------

export const isWindows = () => process.platform === "win32"

/**
 * schtasks 的输出编码是【系统 ANSI 代码页】，中文 Windows 上就是 GBK。
 * 直接 toString("utf8") 得到的是一串乱码 —— 而这串乱码会原样出现在用户看到的报错里
 * （实测："没能撤销系统里的计划任务：´íÎó: ÏµÍ³ÕÒ²»µ½..."），等于没有报错。
 * 用 TextDecoder("gbk") 解（Node 22 自带完整 ICU）；解不了再退回 utf8。
 */
const decodeOut = (buf) => {
  if (!buf || !buf.length) return ""
  try { return new TextDecoder("gbk").decode(buf) } catch { return buf.toString("utf8") }
}

function sh(args) {
  try {
    const out = execFileSync("schtasks.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    return { ok: true, out: decodeOut(out) }
  } catch (e) {
    const txt = [e?.stdout, e?.stderr].filter(Boolean).map(decodeOut).join(" ").trim()
    return { ok: false, code: e?.status ?? -1, out: txt || String(e?.message || e) }
  }
}

/** 注册（已存在则覆盖）。返回 {ok, err?}。 */
export function register(task, opts = {}) {
  if (!isWindows()) return { ok: false, err: "定时任务目前只支持 Windows" }
  const xml = buildXml(task, opts)
  const f = path.join(os.tmpdir(), `sci-task-${task.id}-${process.pid}.xml`)
  // UTF-16LE + BOM：schtasks /XML 只认这个，见文件头说明
  fs.writeFileSync(f, "﻿" + xml, "utf16le")
  try {
    const r = sh(["/Create", "/TN", taskName(task.id), "/XML", f, "/F"])
    return r.ok ? { ok: true } : { ok: false, err: `注册计划任务失败：${r.out}` }
  } finally { try { fs.rmSync(f) } catch {} }
}

export function unregister(id) {
  if (!isWindows()) return { ok: true }
  // 【幂等判据用"名字在不在清单里"，不是匹配报错文案】
  // 第一版是匹配 /找不到|does not exist/ —— 在中文 Windows 上永远匹配不上（输出是 GBK 字节），
  // 于是"计划任务早就被手动删掉了"的任务【在界面里永远删不掉】：撤销失败 → 按设计不删定义 →
  // 用户面对一条既不会跑、也删不掉的僵尸任务。实测踩到过。
  // 名字比对与编码、系统语言全都无关，这才是能一直站得住的判据。
  if (!listRegistered().includes(taskName(id))) return { ok: true }
  const r = sh(["/Delete", "/TN", taskName(id), "/F"])
  return r.ok ? { ok: true } : { ok: false, err: r.out }
}

/** 列出本产品注册过的任务名（卸载清理与"对账"用）。 */
export function listRegistered() {
  if (!isWindows()) return []
  const r = sh(["/Query", "/FO", "CSV", "/NH"])
  if (!r.ok) return []
  const names = []
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim())
    if (m && m[1].startsWith(`\\${TASK_FOLDER}\\`)) names.push(m[1])
  }
  return [...new Set(names)]
}

/** 卸载 / 重装时把整个文件夹清干净——留着的话它会到点去启动一个已经不存在的 exe。 */
export function unregisterAll() {
  if (!isWindows()) return { ok: true, removed: 0 }
  let removed = 0
  for (const n of listRegistered()) {
    const r = sh(["/Delete", "/TN", n, "/F"])
    if (r.ok) removed++
  }
  return { ok: true, removed }
}

/**
 * 让磁盘上的任务定义与系统里的计划任务对上：该注册的注册、该删的删。
 * 【为什么需要"对账"而不是只在增删时注册】任务定义是文件，用户可能手动改/拷贝/从备份恢复，
 * 系统里的计划任务也可能被别的工具删掉。每次网关启动跑一次对账，比指望两边永远同步现实得多。
 */
/**
 * @param prune 是否删掉"系统里有、定义里没有"的孤儿任务。
 *   【默认 false，而且这个默认很要紧】删除的依据是"我这份任务目录里没有它"——可一个把
 *   SCI_TASKS_DIR 指到别处的实例（自动化测试、临时起的第二个网关、拷错目录）看到的是一份
 *   空目录，于是它会把用户**真实的定时任务全部删光**，而且悄无声息。
 *   所以：自动跑的对账（网关启动）只补注册、不删；删除只在用户明确点「重新注册」/ 跑 `task-cli sync`
 *   时才做——那时他自己知道自己在对哪一份清单。
 */
export function sync(tasks, { prune = false } = {}) {
  if (!isWindows()) return { ok: false, err: "非 Windows，跳过", added: 0, removed: 0 }
  const want = new Map(tasks.map((t) => [taskName(t.id), t]))
  const have = new Set(listRegistered())
  let added = 0, removed = 0
  const errs = []
  for (const [, t] of want) {
    // 【一律重注册，不做"已存在就跳过"】改了时间的任务在系统里名字没变，跳过的话新时间永远
    //   落不下去，而界面显示的下次运行时间已经变了——两边对不上，且没有任何报错。
    //   /F 覆盖是幂等的，几个任务的开销可以忽略。
    // 停用的任务也注册（XML 里 Enabled=false），让 Windows 任务计划程序里看到的和软件里
    // 看到的是同一份清单，用户不会以为"停用 = 被删了"。
    const r = register(t)
    if (r.ok) added++; else errs.push(r.err)
  }
  const orphans = [...have].filter((n) => !want.has(n))
  if (prune) for (const name of orphans) { const r = unregister(name.split("\\").pop()); if (r.ok) removed++ }
  return { ok: errs.length === 0, added, removed, orphans: orphans.length, ...(errs.length ? { err: errs.join("；") } : {}) }
}
