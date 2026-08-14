#!/usr/bin/env node
// 定时任务的管理入口（界面出来之前，这就是唯一的入口；界面出来之后它仍是排障工具）。
//
//   node web/task-cli.mjs list
//   node web/task-cli.mjs add --title "每周文献扫描" --prompt "..." --daily 07:00
//   node web/task-cli.mjs add --title "周一汇总" --prompt-file plan.md --weekly 1,4 --time 08:30 --max-credits 50
//   （加 --push-chat：跑完把结果+主产物推到「聊天接入」绑定的微信/企微；前提见 headless-run 的推送注释）
//   node web/task-cli.mjs add --title "临时" --prompt "..." --once 2026-08-20 --time 09:00
//   node web/task-cli.mjs enable <id> / disable <id> / rm <id>
//   node web/task-cli.mjs run <id>          # 立刻跑一次（前台，能看到日志）
//   node web/task-cli.mjs sync              # 磁盘定义 ↔ Windows 计划任务 对账
//   node web/task-cli.mjs doctor            # 装没装好：快照、node 路径、已注册的任务
//
// 增 / 删 / 改都会【当场同步到 Windows 计划任务】——定义与计划任务分家是这功能最容易出的错：
// 用户在软件里删了任务，系统里那条还在，到点照样起一个进程去跑一个已经不存在的任务。
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as T from "./tasks.mjs"
import * as S from "./schtasks.mjs"
import * as P from "./task-presets.mjs"
import * as Cloud from "./cloud-account.mjs"

// ---- 档位门禁：与网关 /api/tasks 同一套判据 ----
//
// 【为什么 CLI 也必须判】技能（scheduled-task）在对话里就是调这个 CLI 建任务的。只在网关的
// HTTP 接口上把门，等于留了一扇后门：基础档用户对 AI 说一句"每天帮我干 X"，技能照样能建出
// 一个自由指令任务，档位限制形同虚设。两条入口必须同一套规则。
// 取不到档案（未登录 / 离线 / 老服务端）→ off，理由同网关：宁可少给。
function tierMode() {
  const p = Cloud.loadState()?.profile
  if (!p) return Cloud.cloudBase() ? "off" : "full"   // 没接平台 = 用户自己的 key，花自己的钱
  return ["preset", "full"].includes(p.tasksMode) ? p.tasksMode : "off"
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function argMap(argv) {
  const m = { __params: {} }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2)
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"
      // --param key=value 可重复：模板任务的参数走它（模板字段是数据驱动的，不给每个字段单开一个开关）
      if (k === "param") {
        const eq = v.indexOf("=")
        if (eq > 0) m.__params[v.slice(0, eq)] = v.slice(eq + 1)
      } else m[k] = v
    } else rest.push(argv[i])
  }
  return { m, rest }
}

const fmtNext = (t) => {
  if (t.enabled === false) return "已停用"
  const n = T.nextRunAt(t)
  if (!n) return "不再触发"
  const p = (x) => String(x).padStart(2, "0")
  return `${n.getMonth() + 1}月${n.getDate()}日 ${p(n.getHours())}:${p(n.getMinutes())}`
}

function cmdList() {
  const tasks = T.listTasks()
  if (!tasks.length) return console.log("还没有定时任务。用 add 建一个。")
  const registered = new Set(S.listRegistered())
  for (const t of tasks) {
    const reg = registered.has(S.taskName(t.id)) ? "" : "  ⚠ 未注册到系统（跑一次 sync）"
    console.log(`${t.id}  ${t.title}`)
    console.log(`    下次：${fmtNext(t)}    上次：${T.runSummary(t.lastRun)}${reg}`)
  }
}

// 当前工作目录是不是「聊天接入」的绑定目录。聊天（微信/企微）里的对话就跑在绑定目录里，
// 所以"在聊天里建任务"时 cwd 必然命中；定时任务的无头会话 cwd 是自己的会话目录，不会误判。
// 用它给 pushChat 定默认值：在聊天里建的任务默认推送回聊天——用户在手机上建任务就是想在
// 手机上收结果，这不能指望模型每次记得加 --push-chat（提示词会被旧会话上下文/旧技能版本
// 盖过，真机 2026-08-14 建出来的任务就漏了）。--no-push-chat 可显式关掉。
function cwdBoundToChat() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "chat-bridge", "state.json"), "utf8").replace(/^﻿/, ""))
    const R = (p) => { try { return fs.realpathSync(p).toLowerCase() } catch { try { return path.resolve(p).toLowerCase() } catch { return "" } } }
    const cwd = R(process.cwd())
    return !!cwd && ["wecom", "weixin"].some((p) => s?.[p]?.boundDir && R(s[p].boundDir) === cwd)
  } catch { return false }
}

function scheduleFrom(m) {
  if (m.daily) return { kind: "daily", time: m.daily === "true" ? m.time : m.daily }
  if (m.weekly) return { kind: "weekly", time: m.time, days: String(m.weekly).split(",").map(Number) }
  if (m.once) return { kind: "once", time: m.time, date: m.once }
  return {}
}

function cmdAdd(m) {
  const mode = tierMode()
  if (mode === "off") {
    console.error("你的账号档位没有开通定时任务。（如果你确实需要，请联系管理员调整档位。）")
    process.exit(3)
  }
  let prompt = m["prompt-file"] ? fs.readFileSync(m["prompt-file"], "utf8") : m.prompt
  let preset = m.preset, params = null
  if (mode === "preset") {
    // 基础档只能用模板：prompt 由模板拼，命令行给的自由指令一律丢弃（与网关口径一致）
    if (!preset) {
      console.error("你的账号档位只能使用任务模板，不能写自由指令。可用模板：\n" +
        P.presetList().map((p) => `  --preset ${p.id}   ${p.name} —— ${p.desc}\n` +
          p.fields.map((f) => `      --param ${f.key}=…   ${f.label}${f.required ? "（必填）" : ""}`).join("\n")).join("\n"))
      process.exit(3)
    }
    const built = P.buildPreset(preset, m.__params || {})
    if (!built.ok) { console.error(built.err); process.exit(2) }
    prompt = built.prompt; params = built.params
    if (!m.title) m.title = built.title
  }
  const { ok, task, errors } = T.normalizeTask({
    title: m.title, prompt, module: mode === "preset" ? "chat" : (m.module || "chat"),
    schedule: scheduleFrom(m),
    maxCredits: m["max-credits"], maxRounds: m["max-rounds"],
    // 跑完推送到聊天接入（微信/企微）。界面/命令行建的默认关（不是每个任务都想往手机上刷消息）；
    // 【聊天里建的默认开】判据见 cwdBoundToChat 的注释——这是确定性兜底，不依赖模型记得传参。
    pushChat: m["no-push-chat"] === "true" ? false : (m["push-chat"] === "true" || cwdBoundToChat()),
    ...(params ? { preset, params } : {}),
  })
  if (!ok) { console.error("任务定义有问题：\n  - " + errors.join("\n  - ")); process.exit(2) }
  T.saveTask(task)
  const r = S.register(task)
  console.log(`已建任务 ${task.id}「${task.title}」，下次 ${fmtNext(task)}${task.pushChat ? "；跑完会推送到聊天（软件开着才推得了；个人微信不实时、下次说话自动补发）" : ""}`)
  if (!r.ok) console.error(`⚠ 但没能注册到 Windows 计划任务：${r.err}\n  → 它不会自动跑。修好后执行：node web/task-cli.mjs sync`)
}

function cmdToggle(id, enabled) {
  const t = T.readTask(id)
  if (!t) { console.error(`找不到任务 ${id}`); process.exit(2) }
  t.enabled = enabled
  t.updatedAt = new Date().toISOString()
  T.saveTask(t)
  const r = S.register(t)
  console.log(`${enabled ? "已启用" : "已停用"} ${id}「${t.title}」${r.ok ? "" : "（计划任务同步失败：" + r.err + "）"}`)
}

function cmdRm(id) {
  const t = T.readTask(id)
  if (!t) { console.error(`找不到任务 ${id}`); process.exit(2) }
  // 【先撤计划任务再删定义】反过来的话，中间若失败就留下一条"孤儿计划任务"——
  // 它到点仍会启动运行器，而运行器找不到定义只能报错退出，用户看不见也查不着。
  const r = S.unregister(id)
  if (!r.ok) { console.error(`没能撤掉系统里的计划任务：${r.err}\n  为免留下会空跑的孤儿任务，本次不删定义。`); process.exit(1) }
  T.deleteTask(id)
  console.log(`已删除 ${id}「${t.title}」（含运行记录）`)
}

function cmdRun(id, extra = []) {
  const t = T.readTask(id)
  if (!t) { console.error(`找不到任务 ${id}`); process.exit(2) }
  const child = spawn(process.execPath, [path.join(__dirname, "headless-run.mjs"), "--task", id, "--force", ...extra], { stdio: "inherit" })
  child.on("exit", (c) => process.exit(c ?? 1))
}

function cmdSync() {
  // 用户明确跑了 sync → 允许清孤儿（见 schtasks.mjs sync 的注释：自动对账不删）
  const r = S.sync(T.listTasks(), { prune: true })
  console.log(`对账完成：注册/更新 ${r.added} 条，清掉多余 ${r.removed} 条${r.err ? "\n⚠ " + r.err : ""}`)
  if (!r.ok) process.exit(1)
}

function cmdDoctor() {
  const spec = S.runnerSpec()
  const mode = tierMode()
  console.log(`账号档位：定时任务 = ${({ off: "未开通", preset: "只能用模板", full: "自由指令" })[mode]}`)
  console.log(`平台：${process.platform}${S.isWindows() ? "" : "（定时任务只支持 Windows）"}`)
  console.log(`环境快照：${spec.fromSnapshot ? "有（壳写的）" : "无 —— 打包版出现这条要查壳有没有写 headless-env.json；开发机正常"}`)
  console.log(`node：${spec.nodeExe}  ${fs.existsSync(spec.nodeExe) ? "" : "⚠ 文件不存在"}`)
  console.log(`运行器：${spec.script}  ${fs.existsSync(spec.script) ? "" : "⚠ 文件不存在"}`)
  console.log(`隐藏启动器：${spec.launcher ? "有（到点后台跑，不弹黑窗口）" : "无 —— 到点会弹出控制台窗口（老版本包；跑一次 sync 前先确认 web/headless-launch.vbs 在不在）"}`)
  console.log(`工作目录：${spec.workDir}`)
  const tasks = T.listTasks()
  const reg = S.listRegistered()
  console.log(`任务定义 ${tasks.length} 条；系统里注册了 ${reg.length} 条`)
  const missing = tasks.filter((t) => !reg.includes(S.taskName(t.id)))
  if (missing.length) console.log(`⚠ 有定义但没注册（不会自动跑）：${missing.map((t) => t.id).join(", ")} → 跑 sync`)
  const orphan = reg.filter((n) => !tasks.some((t) => S.taskName(t.id) === n))
  if (orphan.length) console.log(`⚠ 系统里有孤儿计划任务（会空跑）：${orphan.join(", ")} → 跑 sync`)
  const login = fs.existsSync(path.join(__dirname, "cloud-state.json"))
  console.log(`登录态：${login ? "有（无头进程能自己续 token）" : "⚠ 没有 —— 定时任务需要你先在软件里登录过一次"}`)
}

const { m, rest } = argMap(process.argv.slice(2))
const cmd = rest[0]
switch (cmd) {
  case "list": cmdList(); break
  case "add": cmdAdd(m); break
  case "enable": cmdToggle(rest[1], true); break
  case "disable": cmdToggle(rest[1], false); break
  case "rm": case "remove": case "delete": cmdRm(rest[1]); break
  case "run": cmdRun(rest[1], m["dry-run"] ? ["--dry-run"] : []); break
  case "sync": cmdSync(); break
  case "doctor": cmdDoctor(); break
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"))
}
