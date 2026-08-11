// 定时任务无头运行器的端到端回归：**壳没开**的情况下，一条命令行把任务从头跑到尾。
//
// 这是本功能唯一真正要验证的东西——"软件关着也能干活"。链路与生产同构，只把模型换成
// 脚本化 mock（不花钱、结果确定）：
//   headless-run.mjs → 自起 node server.mjs（另一对端口）→ 真 opencode serve → mock 模型
// 断言：会自动续跑到 [FINAL] 收官、退出码 0、运行记录落盘且 lastRun 回写、锁被释放。
//
// mock 模型与 opencode 的搭台方式抄自 autopilot-e2e.test.mjs（含那条踩坑教训：provider
// 必须写【仓库根】的 opencode.json，否则 opencode 为会话目录另起的 instance 看不见它）。
// 【别和 autopilot-e2e 并行跑】两者都要写仓库根的 opencode.json，会互相覆盖。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import net from "node:net"
import { spawn, execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const hasOpencode = (() => { try { execSync("opencode --version", { stdio: "pipe", shell: true }); return true } catch { return false } })()
const WEB = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ROOT = path.resolve(WEB, "..")

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)) }) })

// 剧本：第 1 轮抛编号问题（考验无人值守敢不敢自己选 1），第 2 轮干活，第 3 轮交付 + 哨兵。
const partText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text || "").join("") : "")
function scriptReply(userTexts) {
  const r = userTexts.filter((t) => t.includes("自动续跑 第")).length
  if (r === 0) return "先定方向：**1)** 方向A（推荐） **2)** 方向B。回 1 或 2 即可。"
  if (r === 1) return "已按推荐采用方向A，正在整理，还差最后一步。"
  return "全部完成：结论已写好，产物 weekly.md。\n\n[FINAL]"
}
function mockLLM(delayMs = 500) {
  const srv = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.includes("/chat/completions")) { res.statusCode = 404; return res.end("{}") }
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch {}
      const text = scriptReply((body.messages || []).filter((m) => m.role === "user").map((m) => partText(m.content)))
      const usage = { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 }
      if (!body.stream) {
        res.setHeader("content-type", "application/json")
        return res.end(JSON.stringify({ id: "m1", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }))
      }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" })
      const chunk = (delta, fin) => res.write(`data: ${JSON.stringify({ id: "m1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: fin || null }], ...(fin ? { usage } : {}) })}\n\n`)
      chunk({ role: "assistant" })
      const mid = Math.ceil(text.length / 2)
      chunk({ content: text.slice(0, mid) })
      setTimeout(() => { chunk({ content: text.slice(mid) }); chunk({}, "stop"); res.write("data: [DONE]\n\n"); res.end() }, delayMs)
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => new Promise((x) => srv.close(x)) })))
}

test("定时任务无头运行（壳没开）", { skip: hasOpencode ? false : "本机没有 opencode CLI" }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "headless-e2e-"))
  const tasksDir = path.join(tmp, "tasks")
  const mock = await mockLLM()
  const ocCfgPath = path.join(ROOT, "opencode.json")
  const ocCfgBak = fs.existsSync(ocCfgPath) ? fs.readFileSync(ocCfgPath) : null
  fs.writeFileSync(ocCfgPath, JSON.stringify({
    provider: { custom: { npm: "@ai-sdk/openai-compatible", name: "Custom (OpenAI 兼容)", options: { baseURL: mock.url, apiKey: "x" }, models: { "mock-m": { name: "mock-m", tool_call: true, attachment: true, cost: { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: 0 } } } } },
    tools: { question: false }, permission: { external_directory: "allow" },
  }, null, 2))
  const ocPort = await freePort()
  const ocProc = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(ocPort)],
    { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_DATA_HOME: path.join(tmp, "data") } })
  ocProc.stdout.on("data", () => {}); ocProc.stderr.on("data", () => {})

  t.after(async () => {
    try { execSync(`taskkill /pid ${ocProc.pid} /T /F`, { stdio: "pipe" }) } catch {}
    try { await mock.close() } catch {}
    if (ocCfgBak) fs.writeFileSync(ocCfgPath, ocCfgBak); else { try { fs.unlinkSync(ocCfgPath) } catch {} }
  })

  const deadline = Date.now() + 60_000
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${ocPort}/session`, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) break } catch {}
    if (Date.now() > deadline) throw new Error("opencode serve 没起来")
    await new Promise((r) => setTimeout(r, 500))
  }

  // 任务落盘（用定义层自己的 API，顺带验证 headless-run 读得懂它写的东西）
  fs.writeFileSync(path.join(tmp, "model-config.json"), JSON.stringify({ route: "custom", baseURL: mock.url, apiKey: "x", modelID: "mock-m" }))
  const env = {
    ...process.env,
    SCI_TASKS_DIR: tasksDir,
    SCI_HEADLESS_PORT: String(await freePort()),
    SCI_HEADLESS_OC_URL: `http://127.0.0.1:${ocPort}`,
    SCI_HEADLESS_MANAGE_OC: "0",          // opencode 由本测试管，别让网关再拉一个
    // ★ 关掉网关启动时的计划任务对账：测试起的网关会把本测试的临时任务【真的注册进 Windows】，
    //   而测试结束只删临时目录，系统里那条就留下来了（到点还会去跑一个不存在的任务）。
    SCI_TASK_SYNC: "0",
    HOME: tmp, USERPROFILE: tmp,
    SESSIONS_META_PATH: path.join(tmp, "sessions-meta.json"),
    MODEL_CFG_PATH: path.join(tmp, "model-config.json"),
    OC_CONFIG_PATH: ocCfgPath,
    CLOUD_STATE_PATH: path.join(tmp, "no-cloud-state.json"),
    CLOUD_CFG_PATH: path.join(tmp, "no-such-cloud.json"),
    SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
    ALLOWED_SKILLS: "", ALLOWED_MODULES: "", SUGGEST_ENABLED: "0",
    OC_AUTO_MAX_ROUNDS: "5", DAILY_COST_LIMIT: "0",
    // mock 模型一个工具都不调 → 每轮在网关眼里都是"只说话没动手"，不放宽的话本剧本会被
    // 空转闸在第 2 轮截停，测不到第 3 轮的哨兵收官。空转闸本身在 autopilot 那两个文件里测。
    OC_AUTO_IDLE_MAX: "999",
  }
  // 【顺序要紧】tasks.mjs 在【模块求值时】读 SCI_TASKS_DIR，import 之后再设就晚了——
  // 那样测试端会去读开发机真实的 tasks/，而子进程写的是临时目录，永远对不上（首版就栽在这）。
  process.env.SCI_TASKS_DIR = tasksDir
  const T = await import(`../tasks.mjs?e2e=${Date.now()}`)
  const { task } = T.normalizeTask({ title: "e2e 任务", prompt: "帮我把本周文献扫一遍", schedule: { kind: "daily", time: "07:00" } })
  fs.mkdirSync(tasksDir, { recursive: true })
  fs.writeFileSync(path.join(tasksDir, `${task.id}.json`), JSON.stringify(task, null, 2))

  const run = spawn(process.execPath, [path.join(WEB, "headless-run.mjs"), "--task", task.id, "--no-reuse"],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  run.stdout.on("data", (c) => { out += c }); run.stderr.on("data", (c) => { out += c })
  // 兜底超时用 unref 的定时器：不 unref 的话它会把测试进程【吊满 5 分钟】才退出，
  // 哪怕子进程 20 秒就跑完了（首版实测：子测试 26s，整个文件 306s）。
  const code = await new Promise((r) => {
    const kill = setTimeout(() => { try { run.kill() } catch {} }, 300_000)
    kill.unref?.()
    run.on("exit", (c) => { clearTimeout(kill); r(c) })
  })

  assert.equal(code, 0, `无头运行应成功收官，退出码 ${code}\n---- 输出 ----\n${out}`)
  assert.match(out, /自起网关/, "壳没开时应自己起一套网关")

  const runs = T.listRuns(task.id)
  assert.equal(runs.length, 1, "应落下一条运行记录")
  const rec = runs[0]
  assert.equal(rec.ok, true, `记录应为成功：${rec.reason}`)
  assert.equal(rec.rounds, 3, `应恰好 3 轮（问题→干活→交付），实际 ${rec.rounds}`)
  assert.ok(rec.sid, "记录里要有会话 id，用户才能在界面里点进去看")
  assert.ok(!/\[FINAL\]/.test(JSON.stringify(rec)), "哨兵是网关与模型之间的协议标记，不该出现在记录里")

  const saved = T.readTask(task.id)
  assert.equal(saved.lastRun.ok, true, "lastRun 摘要要回写进任务本体（界面列表靠它）")
  assert.ok(!fs.existsSync(path.join(tasksDir, "runs", task.id, ".lock")), "跑完必须把锁释放，否则下一次定时会被自己挡住")

  // ---- 另一条分支：软件正开着 → 复用它的网关，不再自起一套 ----
  // 早上 7 点用户人就在电脑前的情况走的就是这条。要验证的是"不另起进程"，
  // 否则两套网关同时管着同一批会话文件与端口，症状是随机的文件互相覆盖。
  await t.test("软件开着时复用现有网关，不另起一套", async () => {
    const gwPort = await freePort()
    const gw = spawn(process.execPath, [path.join(WEB, "server.mjs")],
      { cwd: ROOT, env: { ...env, PORT: String(gwPort), OC_URL: `http://127.0.0.1:${ocPort}`, MANAGE_OC: "0" }, stdio: ["ignore", "pipe", "pipe"] })
    gw.stdout.on("data", () => {}); gw.stderr.on("data", () => {})
    try {
      const dl = Date.now() + 60_000
      for (;;) {
        const r = await fetch(`http://127.0.0.1:${gwPort}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
        if (r && r.status === 200) break
        if (Date.now() > dl) throw new Error("陪跑的网关没起来")
        await new Promise((x) => setTimeout(x, 500))
      }
      const t2 = T.normalizeTask({ title: "复用分支", prompt: "再扫一遍", schedule: { kind: "daily", time: "07:00" } }).task
      fs.writeFileSync(path.join(tasksDir, `${t2.id}.json`), JSON.stringify(t2, null, 2))
      const run2 = spawn(process.execPath, [path.join(WEB, "headless-run.mjs"), "--task", t2.id],
        { cwd: ROOT, env: { ...env, SCI_GATEWAY_URL: `http://127.0.0.1:${gwPort}` }, stdio: ["ignore", "pipe", "pipe"] })
      let out2 = ""
      run2.stdout.on("data", (c) => { out2 += c }); run2.stderr.on("data", (c) => { out2 += c })
      const code2 = await new Promise((r) => {
        const kill = setTimeout(() => { try { run2.kill() } catch {} }, 300_000); kill.unref?.()
        run2.on("exit", (c) => { clearTimeout(kill); r(c) })
      })
      assert.equal(code2, 0, `复用分支应成功\n---- 输出 ----\n${out2}`)
      assert.match(out2, /复用已在跑的网关/)
      assert.ok(!/自起网关/.test(out2), "已经有网关了就不该再起一个")
      assert.equal(T.listRuns(t2.id)[0]?.ok, true)
    } finally {
      try { execSync(`taskkill /pid ${gw.pid} /T /F`, { stdio: "pipe" }) } catch {}
    }
  })
})
