// 「工作目录选在应用之外」时，opencode 还能不能找到 provider / 技能 / AGENTS.md。
//
// 【这条测试是补一个真实事故】0.1.20 发出去之后，用户一挑工作目录就报"模型没有返回任何文本"。
// 根因：opencode 的 provider 配置、技能、AGENTS.md 全部按 project/worktree 解析，而 project 是
// 从会话的 directory 推出来的；把 directory 指到用户自己的文件夹 → project 变成 global、
// worktree 变成 /，于是 custom provider 消失（→ 整轮零文本）、28 个技能只剩 1 个（→ 所有模块
// 安静地退化成裸对话，连报错都没有）。
//
// 【为什么当初没测出来】那一版的自测用的是【假 opencode】：它照单收下 directory 就返回，
// "参数传对了"全绿，而"传对之后 opencode 还能不能用"从来没被验证过。所以这条测试的规矩是：
// **必须用真的 opencode 二进制**，跑不了就明确 skip，绝不用假的替身糊过去。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")

/** 找一个真的、能直接 spawn 的 opencode 可执行文件。找不到就返回 null（本文件整体 skip）。
 *  ★ Windows 上 `where opencode` 头一条往往是 npm 装的【无扩展名 shim】（一个 sh 脚本），
 *    spawn 它必然 ENOENT。所以只认 .exe，并顺着 shim 所在目录去摸 npm 包里的真二进制。 */
function findOpencode() {
  const win = process.platform === "win32"
  const ok = (p) => { try { return !!p && fs.statSync(p).isFile() && (!win || /\.exe$/i.test(p)) } catch { return false } }
  const cands = [
    process.env.OC_BIN,
    path.join(ROOT, "desktop", "dist", "bundle", "runtime", "opencode", "opencode.exe"),
  ]
  try {
    const lines = execFileSync(win ? "where" : "which", ["opencode"], { encoding: "utf8" })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    cands.push(...lines)
    // npm 全局安装的真身：<shim 所在目录>/node_modules/opencode-ai/node_modules/opencode-<平台>/bin/opencode(.exe)
    for (const l of lines) {
      const base = path.dirname(l)
      cands.push(path.join(base, "node_modules", "opencode-ai", "node_modules", "opencode-windows-x64", "bin", "opencode.exe"))
      cands.push(path.join(base, "node_modules", "opencode-ai", "bin", "opencode.exe"))
    }
  } catch {}
  return cands.find(ok) || null
}

const OC = findOpencode()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test("外部工作目录下，provider / 技能 / AGENTS.md 都还在", { skip: OC ? false : "本机找不到 opencode 可执行文件（设 OC_BIN 或先跑 desktop/bundle.ps1）" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fwd-"))
  const outside = path.join(dir, "用户自己的课题文件夹")     // 应用之外、且不是 git 仓库
  fs.mkdirSync(outside, { recursive: true })
  // 正常部署下 opencode 的配置目录被圈在【应用内】的 .ocglobal；这里用 SCI_OC_CONFIG_HOME
  // 把它重定向到临时目录，免得测试往开发机的检出里塞东西。
  const xdg = path.join(dir, "xdg")
  fs.mkdirSync(xdg, { recursive: true })

  // 本仓库的 opencode.json 平时可能没有 custom provider（没登录云端时就没有）。
  // 先在【网关会用的那份配置】里放一个假 provider，保证"provider 能不能跟到外部目录"这一栏
  // 真的被测到；网关启动时会在这份配置上补 instructions / tools（enforceOcTools）。
  const cfg = path.join(dir, "opencode.json")
  fs.writeFileSync(cfg, JSON.stringify({
    provider: { custom: {
      npm: "@ai-sdk/openai-compatible", name: "测试用 provider",
      options: { baseURL: "http://127.0.0.1:9/none", apiKey: "test-only" },
      models: { "probe-model": { name: "probe-model", tool_call: true } },
    } },
  }, null, 2))

  // ★ 这里【不】自己拼 opencode 的启动参数，而是让 server.mjs 自己去 spawnOc ——
  //   要测的正是"网关有没有把 OPENCODE_CONFIG 和技能联接接上"。自己拼一套的话，
  //   哪天有人把 spawnOc 里那两行删了，这条测试照样绿，等于白测。
  const port = 4200 + (process.pid % 300)
  const saved = {}
  const over = {
    MANAGE_OC: "1", OC_BIN: OC, OC_URL: `http://127.0.0.1:${port}`, PORT: "0",
    SCI_OC_CONFIG_HOME: xdg,                              // 把应用内的 .ocglobal 重定向到临时目录
    OC_CONFIG_PATH: cfg,
    HOME: dir, USERPROFILE: dir,
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "", SUGGEST_ENABLED: "0",
  }
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  let mod
  try { mod = await import(`../server.mjs?fwd=${process.pid}`) } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  t.after(async () => {
    try { mod?.server?.close() } catch {}
    // 网关起的 opencode 是 detached 的，得按端口收，否则会留一个占着 4200+ 的孤儿进程
    try {
      if (process.platform === "win32") execFileSync("cmd", ["/c", `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`], { stdio: "ignore" })
      else execFileSync("sh", ["-c", `lsof -ti tcp:${port} | xargs -r kill -9`], { stdio: "ignore" })
    } catch {}
    await wait(300)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  // 联接必须是【网关】建出来的，不是测试自己建的
  const link = path.join(xdg, "opencode", "skills")
  assert.ok(fs.existsSync(link), "网关没有建立全局技能联接（ensureOcSkillLink 没跑或失败了）")
  assert.equal(path.resolve(fs.readlinkSync(link)), path.resolve(ROOT, ".opencode", "skills"), "联接指错了地方")

  const api = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json()
  let up = false
  for (let i = 0; i < 90; i++) { try { await api("/config"); up = true; break } catch { await wait(1000) } }
  assert.ok(up, "opencode 没起来")

  const q = (d) => encodeURIComponent(d.replace(/\\/g, "/"))
  for (const [label, d] of [["应用目录内（对照）", ROOT], ["用户自己挑的目录", outside]]) {
    const cfgOut = await api(`/config?directory=${q(d)}`)
    const skills = await api(`/skill?directory=${q(d)}`)
    assert.ok(cfgOut.provider?.custom, `${label}：custom provider 不见了 —— 模型名 custom/… 会不存在，整轮零文本`)
    assert.ok(skills.some((s) => (s.name || s.id) === "reference-check"),
      `${label}：看不到本套件的技能（只有 ${skills.length} 个）—— 所有模块会安静退化成裸对话`)
    assert.match(String(cfgOut.instructions?.[0] || ""), /AGENTS\.md$/i, `${label}：AGENTS.md 没被加载`)
  }
})

// 指向【别处】的旧联接必须能被拆掉重建（换安装位置 / 重装到别的盘 / 换个检出跑都会留下它）。
// 反过来，那儿要是用户【自己的真目录】，一个字节都不许动。
test("旧联接指错地方要能自愈；用户自己的真技能目录绝不动", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fwd2-"))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const xdg = path.join(dir, "xdg")
  const link = path.join(xdg, "opencode", "skills")
  // 这一条只测联接的自愈逻辑，不需要真 opencode。但 import server.mjs 会把整个网关带起来，
  // 所以先按"最轻形态"设好环境：不接管 opencode、端口随机、状态全落临时目录。
  const over = {
    MANAGE_OC: "0", PORT: "0", OC_URL: "http://127.0.0.1:1", SCI_OC_CONFIG_HOME: xdg,
    HOME: dir, USERPROFILE: dir,
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "", SUGGEST_ENABLED: "0",
  }
  const saved = {}
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  const mod = await import(`../server.mjs?linkonly=${process.pid}`)
  const { ensureOcSkillLink } = mod
  t.after(() => {
    try { mod?.server?.close() } catch {}
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  fs.rmSync(link, { recursive: true, force: true })   // 网关启动时已经建过一次，这里从零开始摆

  // ① 指向别处的旧联接 → 重建到正确目标
  const stale = path.join(dir, "老的安装位置"); fs.mkdirSync(stale, { recursive: true })
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(stale, link, "junction")
  assert.equal(ensureOcSkillLink(), true, "旧联接应被重建")
  assert.equal(path.resolve(fs.readlinkSync(link)), path.resolve(ROOT, ".opencode", "skills"))

  // ② 用户自己的真目录 → 不动，且明确返回 false
  fs.rmSync(link, { recursive: true, force: true })
  fs.mkdirSync(link, { recursive: true })
  fs.writeFileSync(path.join(link, "我自己写的.md"), "别删我")
  assert.equal(ensureOcSkillLink(), false, "真目录不该被当成联接处理")
  assert.ok(fs.existsSync(path.join(link, "我自己写的.md")), "★ 用户自己的技能被删了")
})
