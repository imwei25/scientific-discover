#!/usr/bin/env node
// opencode 事件流包装器（产品版）——给 cc-connect 当 agent 用，三件事：
//  1) 过滤：丢弃 reasoning（思考过程）与 tool（工具进度）事件。cc-connect 会把这两类
//     无条件推到聊天平台：既泄露思考，又在长任务里刷爆企微限速（30 条/分，errcode 846607）。
//  2) 进度提示：长任务每 45s 把工具活动压成一条聚合消息（cc-connect send -m），
//     替代被过滤掉的逐条刷屏。SCI_WRAP_PROGRESS=0 关闭。
//  3) 产物兜底：run 结束后扫描工作目录新文件，模型忘了调 cc-connect send 也自动补发
//     （已在事件流里看见模型自己 send 过的路径会跳过，不重复发）。
//
// 真 opencode 路径来自 env SCI_WRAP_OC，cc-connect 路径来自 SCI_WRAP_CC —— 都由
// chat-bridge.mjs 生成 config.toml 时注入，本文件不写死任何路径。
// 非 run 子命令（session list/delete、models…）原样透传。

import { spawn, execFile } from "node:child_process"
import { createInterface } from "node:readline"
import fs from "node:fs"
import path from "node:path"

const REAL_OC = process.env.SCI_WRAP_OC
const CC = process.env.SCI_WRAP_CC || "cc-connect"
const PROGRESS = process.env.SCI_WRAP_PROGRESS !== "0"
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

if (!REAL_OC || !fs.existsSync(REAL_OC)) {
  console.error("oc-wrap: SCI_WRAP_OC 未设置或不存在: " + REAL_OC)
  process.exit(1)
}

if (args[0] !== "run") {
  const child = spawn(REAL_OC, args, { stdio: "inherit" })
  child.on("exit", (code, sig) => process.exit(sig ? 1 : (code ?? 1)))
  child.on("error", (e) => { console.error(e.message); process.exit(1) })
} else {
  const workDir = process.cwd()
  const startedAt = Date.now()

  // 产物兜底的"开工快照"：路径 → mtimeMs。递归但跳过点目录（.venv/.git 之类不该在会话目录，防御一下）
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

  const child = spawn(REAL_OC, args, { stdio: ["inherit", "pipe", "inherit"] })
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const DROP = new Set(["reasoning", "tool", "tool_use", "tool_result"])
  const modelSent = new Set()      // 模型自己 send 过的文件（绝对路径小写），兜底时跳过
  let toolCount = 0
  let lastToolLabel = ""

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
          return   // 思考与工具进度：不给 cc-connect 看见
        }
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
    if (!toSend.length) return process.exit(exitCode)
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
