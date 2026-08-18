#!/usr/bin/env node
// 把文件/消息推到用户已接入的微信/企业微信。调本机网关 /api/chat-bridge/push（它封装了
// 目标选择、会话 key、主产物筛选、落款、失败暂存补发）。本脚本负责：预检定位问题 →
// 能自愈的先修（桥没起来/socket 残留 → restart 一次）→ 修不了的输出【用户需要做什么】。
//
// 用法：node push.mjs [--to weixin|wecom|all] [-m "配文"] [--gateway http://...] [文件 ...]
// 输出约定（供 agent 转述）：每行一条，前缀 OK / FAIL / FIXED / ACTION（用户需做）/ INFO。
// 退出码：0=至少一个平台推成功；1=全部失败。
import fs from "node:fs"
import path from "node:path"

const argv = process.argv.slice(2)
let to = "all", text = "", gateway = process.env.SCI_GATEWAY_URL || "http://127.0.0.1:27821"
const files = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--to") to = String(argv[++i] || "all")
  else if (argv[i] === "-m") text = String(argv[++i] || "")
  else if (argv[i] === "--gateway") gateway = String(argv[++i] || gateway)
  else files.push(argv[i])
}
if (!["weixin", "wecom", "all"].includes(to)) { console.log("FAIL --to 只能是 weixin / wecom / all"); process.exit(1) }
const CN = { weixin: "微信", wecom: "企业微信" }

const j = async (method, p, body, timeout = 60000) => {
  const r = await fetch(gateway + p, {
    method, headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  })
  return r.json()
}

// ---- 文件核验（路径错、超限在这层就能修/说清，别浪费一次发送）----
const abs = []
for (const f of files) {
  const p = path.resolve(f)
  if (!fs.existsSync(p)) { console.log(`FAIL 文件不存在：${f}（解析为 ${p}）——检查路径后重试`); process.exit(1) }
  const sz = fs.statSync(p).size
  if (sz > 15 * 1024 * 1024) { console.log(`FAIL ${f} 有 ${(sz / 1048576).toFixed(1)}MB，超过单文件 15MB 上限——超限文件请用户在软件端查看或打包下载；也可换更小的产物（如推 md 而不是 pdf）或压缩后再推`); process.exit(1) }
  abs.push(p)
}
if (abs.length > 5) console.log(`INFO 一次最多 5 个文件，只推前 5 个：${abs.slice(0, 5).map((p) => path.basename(p)).join("、")}`)
if (!text && !abs.length) { console.log("FAIL 没有可推送的内容：至少给 -m 配文或一个文件"); process.exit(1) }

// ---- 预检（不占发送额度）：把大多数问题在这里定位掉 ----
let st
try { st = await j("GET", "/api/chat-bridge/status", null, 10000) }
catch { console.log(`FAIL 连不上本机网关（${gateway}）`); console.log("ACTION 请打开 Niuma Science 软件（推送依赖软件在运行）"); process.exit(1) }
if (!st || !st.ok || !st.supported) { console.log("FAIL 此部署形态不支持聊天接入（仅 Windows 桌面版）"); console.log("ACTION 请在 Windows 桌面版软件里使用此功能"); process.exit(1) }
if (st.ccBin === false) { console.log("FAIL 缺少 cc-connect 组件（安装不完整）"); console.log("ACTION 请重新安装软件"); process.exit(1) }
if (st.enabled === false) { console.log("FAIL 聊天接入总开关是关的"); console.log("ACTION 请点侧栏「手机接入」打开设置，勾选「启用聊天接入」（不替你改设置，开关由你拍板）"); process.exit(1) }

// 桥该跑没跑 → 自愈：restart 一次（此时没有在跑的对话可被打断，重启无副作用）
if (st.running === false) {
  console.log("INFO 聊天接入已启用但桥进程没在运行，尝试自动重启…")
  try {
    const r = await j("POST", "/api/chat-bridge/restart", {}, 30000)
    if (r && r.ok) { await new Promise((s) => setTimeout(s, 3000)); st = await j("GET", "/api/chat-bridge/status", null, 10000); console.log("FIXED 桥已重启") }
    else { console.log(`FAIL 桥重启失败：${(r && r.err) || "?"}`); console.log("ACTION 请重启软件；仍不行时把 chat-bridge\\bridge.log 反馈给管理员"); process.exit(1) }
  } catch (e) { console.log("FAIL 桥重启异常：" + (e?.message || e)); process.exit(1) }
}

// 平台可用性预检：点名的平台不可用 → 把该做的事说清（这些都不是脚本能修的）
const platCheck = (p) => {
  const x = st[p] || {}
  if (!x.configured) return `ACTION ${CN[p]}还没接入过：请点侧栏「手机接入」完成${p === "weixin" ? "扫码登录" : "机器人配置"}`
  if (!x.subscribed) return `ACTION ${CN[p]}当前没连上${p === "weixin" ? "（个人微信登录可能过期，请到「手机接入」重新扫码）" : "（请到「手机接入」检查机器人配置）"}`
  // 发送必须有会话地址（key），它只能从来信里学到——软件启动后一条消息都没收到的平台推不了
  if (Array.isArray(x.seenUsers) && !x.seenUsers.length)
    return `ACTION ${CN[p]}已连接但软件启动后还没收到过你的消息（拿不到会话地址）：请在${CN[p]}里给机器人随便发条消息（如"在吗"），然后告诉我再推一次`
  return ""
}
if (to !== "all") {
  const a = platCheck(to)
  if (a) { console.log(`FAIL ${CN[to]}不可用`); console.log(a); process.exit(1) }
} else {
  // all：只要有一个能用就继续推；不可用的先把 ACTION 说出来
  const acts = ["weixin", "wecom"].map(platCheck).filter(Boolean)
  acts.forEach((a) => console.log(a))
  if (acts.length === 2) { console.log("FAIL 微信、企业微信都不可用"); process.exit(1) }
}

// ---- 推送（发送层 socket 残留 → 自愈重启一次再重试）----
const doPush = () => j("POST", "/api/chat-bridge/push", { text, files: abs.slice(0, 5), only: to === "all" ? "" : to })
let r = await doPush()
const results = () => (Array.isArray(r?.results) ? r.results : [])
if (!r?.ok && (r?.err || "").concat(results().map((x) => x.err).join(" ")).includes("api.sock")) {
  console.log("INFO 发送层连不上 cc-connect（socket 残留），自动重启桥后重试一次…")
  try { await j("POST", "/api/chat-bridge/restart", {}, 30000); await new Promise((s) => setTimeout(s, 3000)); r = await doPush(); console.log("FIXED 已重启桥并重试") } catch {}
}

// ---- 结果逐平台转述 ----
let anyOk = false
for (const x of results()) {
  if (x.ok) { anyOk = true; console.log(`OK 已推送到${CN[x.platform] || x.platform}`) }
  else if (/会话 key 未知|没跟机器人说过话/.test(x.err || "")) {
    console.log(`FAIL ${CN[x.platform] || x.platform}没推到：软件启动后它还没收到过你的消息，拿不到会话地址`)
    console.log(`ACTION 请在${CN[x.platform] || x.platform}里给机器人随便发条消息（如"在吗"），然后告诉我再推一次`)
  } else {
    console.log(`FAIL ${CN[x.platform] || x.platform}没推到：${x.err || "?"}`)
    console.log(`ACTION 若原因看不懂，可把 chat-bridge\\bridge.log 最后几十行发给管理员`)
  }
}
if (!results().length && !r?.ok) { console.log(`FAIL 推送失败：${r?.err || "?"}`) }
if (!anyOk && r?.ok) anyOk = true
console.log(anyOk ? "INFO 推送已达成（失败平台见上；失败内容网关已暂存，用户下次在手机上说话会自动补发）" : "INFO 全部失败；失败内容网关已暂存，用户下次在手机上对机器人说话时会自动补发")
process.exit(anyOk ? 0 : 1)
