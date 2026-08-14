// 无人值守（autopilot）端到端回归：真 opencode serve + 脚本化 mock 模型 + 真网关。
//
// 链路与生产完全同构：网关 client.session.prompt → opencode → (OpenAI 兼容) mock 模型，
// 事件经 /global/event 回流、SSE 直播给前端。mock 模型按「剧本」回话——第几轮说什么由
// 请求里的续跑轮数决定，从而确定性地验证：
//   ① 模型停下问编号问题 → 网关自动续跑（auto 事件、第 N 轮）直到 [FINAL] 哨兵收官；
//   ② 首轮即 [FINAL] → 不续跑；未勾选 auto → 问题就停在那，不续跑；
//   ③ 永不完成 → 轮数上限兜底停（OC_AUTO_MAX_ROUNDS=3）；
//   ④ 连续两轮输出相同 → 停滞检测停；连续两轮没调任何工具 → 空转检测停；
//   ⑤ 循环中用户 abort → 立即停且不再续；
//   ⑥ [FINAL] 不出现在直播 final 文本与 /api/history 回显里。
//
// 需要本机装有 opencode CLI（部署钉的同款 1.17.14）；找不到则整文件跳过。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import net from "node:net"
import { spawn, execSync } from "node:child_process"

const hasOpencode = (() => { try { execSync("opencode --version", { stdio: "pipe", shell: true }); return true } catch { return false } })()

// ---- 脚本化 mock 模型（OpenAI 兼容 /v1/chat/completions，支持 stream）----
// 轮数 = 对话里「自动续跑 第」用户消息的条数；剧本按 (场景, 轮数) 决定回什么。
const partText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text || "").join("") : "")
function scriptReply(userTexts) {
  const all = userTexts.join("\n")
  const r = userTexts.filter((t) => t.includes("自动续跑 第")).length
  if (all.includes("SCENARIO_QA")) {
    if (r === 0) return "这个任务有两个方向：**1)** 方向A（推荐，代价小） **2)** 方向B。直接回 1 或 2 即可。"
    if (r === 1) return "已自动采用：方向A。开始执行：第一部分已完成，还差第二部分，下一步继续。"
    return "第二部分完成，全部交付：结果 X=42，报告已写好。\n\n[FINAL]"
  }
  if (all.includes("SCENARIO_ONESHOT")) return "小任务，一次做完：答案是 7。\n[FINAL]"
  if (all.includes("SCENARIO_NEVER")) return `第${r}轮：继续处理模块${r}，进度 ${10 + r * 7}%，尚未完成。`
  if (all.includes("SCENARIO_STALL")) return "我已经把能做的都做完了，等待进一步指示。"
  return "（剧本外的请求）"
}
// delayMs 同时决定两轮之间客户端重连（re-attach）的时间窗：太小则慢机器上测试端还没
// 接上流、这一轮已经结束（final/auto 不在 attach 快照里，错过就是错过）→ 假失败。
function mockLLM(delayMs = 700) {
  const srv = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.includes("/chat/completions")) { res.statusCode = 404; return res.end("{}") }
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch {}
      const userTexts = (body.messages || []).filter((m) => m.role === "user").map((m) => partText(m.content))
      const text = scriptReply(userTexts)
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
      // 收尾前压一拍：给测试客户端在两轮之间重新 attach 的时间窗（生产里模型没这么快）
      setTimeout(() => { chunk({ content: text.slice(mid) }); chunk({}, "stop"); res.write("data: [DONE]\n\n"); res.end() }, delayMs)
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => new Promise((x) => srv.close(x)) })))
}

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)) }) })

// ---- SSE 收流：读一轮直播到服务端关流为止，返回 [{ev, data}] ----
// 【超时要留足】串行全量套件里 opencode 为每个会话目录 bootstrap instance 会越跑越慢
// （实测末位子测试的首轮能超过 30s）——超时把轮切一半，auto/final 事件被截断，表现成
// "循环只跑了 1 轮"的假失败。120s 只是兜底，正常远用不满。
async function collectRound(base, sid, timeoutMs = 120_000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const events = []
  try {
    const r = await fetch(`${base}/api/chat/attach?sid=${encodeURIComponent(sid)}`, { signal: ac.signal, headers: { accept: "text/event-stream" } })
    let buf = ""
    for await (const c of r.body) {
      buf += Buffer.from(c).toString("utf8")
      let i
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        let ev = "message", data = ""
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) ev = line.slice(7)
          else if (line.startsWith("data: ")) data += line.slice(6)
        }
        let parsed = null; try { parsed = data ? JSON.parse(data) : null } catch {}
        events.push({ ev, data: parsed })
      }
    }
  } catch { /* 服务端 finish() 关流 / 超时中止：收到多少算多少 */ }
  clearTimeout(timer)
  return events
}
const evOf = (events, name) => events.filter((e) => e.ev === name)
/** 起一轮并跟完整个无人值守循环：返回每轮的事件列表（最多跟 10 轮，防测试自己失控） */
async function runConversation(base, { q, auto }) {
  const r = await fetch(`${base}/api/chat/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q, auto }) })
  const j = await r.json()
  assert.equal(j.sent, true, `起轮失败：${JSON.stringify(j)}`)
  const rounds = []
  for (let i = 0; i < 10; i++) {
    const events = await collectRound(base, j.sid)
    rounds.push(events)
    if (!evOf(events, "auto").length) break   // 服务端没宣告下一轮 → 循环结束
  }
  return { sid: j.sid, rounds }
}

// ---- 环境搭建：mock 模型 → opencode serve（临时项目目录）→ 网关 ----
let mock, ocProc, ocPort, gw, tmp, ocCfgPath
async function setup() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-e2e-"))
  mock = await mockLLM()
  // 【关键教训（本文件首版踩坑）】网关把每个会话的 directory 定在 <仓库根>/outputs/<ws>，
  // opencode 会为该目录向上找项目根（git 根）另起 instance、按【那个根】加载 opencode.json ——
  // provider 写在别的临时项目里它根本看不见（表现：ProviderModelNotFoundError，正文空）。
  // 所以 mock provider 必须写到【仓库根】的 opencode.json（该文件已 gitignore），opencode 的
  // cwd 也用仓库根 —— 与生产布局完全一致。
  const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..")
  const provider = { custom: { npm: "@ai-sdk/openai-compatible", name: "Custom (OpenAI 兼容)", options: { baseURL: mock.url, apiKey: "x" }, models: { "mock-m": { name: "mock-m", tool_call: true, attachment: true, cost: { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: 0 } } } } }
  ocCfgPath = path.join(rootDir, "opencode.json")
  fs.writeFileSync(ocCfgPath, JSON.stringify({ provider, tools: { question: false }, permission: { external_directory: "allow" } }, null, 2))
  ocPort = await freePort()
  // 会话库隔离到临时目录（XDG_DATA_HOME），别往本机真实 opencode.db 里塞测试会话；
  // 配置目录用真实的（provider 的 npm 包缓存在那，隔离掉就要现场重新下载）。
  ocProc = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(ocPort)], { cwd: rootDir, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_DATA_HOME: path.join(tmp, "data") } })
  ocProc.stdout.on("data", () => {})
  ocProc.stderr.on("data", () => {})
  const deadline = Date.now() + 60_000
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${ocPort}/session`, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) break } catch {}
    if (Date.now() > deadline) throw new Error("opencode serve 没起来")
    await new Promise((r) => setTimeout(r, 500))
  }
  // 网关：路由=custom（model-config 指向 mock），OC 不接管，额度不设限，轮数上限 3
  fs.writeFileSync(path.join(tmp, "model-config.json"), JSON.stringify({ route: "custom", baseURL: mock.url, apiKey: "x", modelID: "mock-m" }))
  gw = await startGateway("autopilot-e2e", {
    // 【空转闸在这里让开】mock 模型永远不调工具，也就是每一轮在网关眼里都是"只说话没动手"。
    // 不放宽的话下面所有剧本都会在第 2 轮被空转闸截停，问编号/轮数上限/终止这些用例就测不成了。
    // 空转闸自己另起一个默认配置的网关实例单测（见「空转闸」子测试）。
    OC_AUTO_IDLE_MAX: "999",
  })
}
/** 起一个网关实例（同一个 opencode + mock 模型）；extra 覆盖 env，用来测不同护栏配置 */
async function startGateway(tag, extra = {}) {
  const over = {
    MANAGE_OC: "0", PORT: "0",
    OC_URL: `http://127.0.0.1:${ocPort}`,
    HOME: tmp, USERPROFILE: tmp,
    SESSIONS_META_PATH: path.join(tmp, "sessions-meta.json"),
    MODEL_CFG_PATH: path.join(tmp, "model-config.json"),
    OC_CONFIG_PATH: ocCfgPath,
    CLOUD_STATE_PATH: path.join(tmp, "no-cloud-state.json"),
    CLOUD_CFG_PATH: path.join(tmp, "no-such-cloud.json"),
    SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
    ALLOWED_SKILLS: "", ALLOWED_MODULES: "", SUGGEST_ENABLED: "0",
    OC_AUTO_MAX_ROUNDS: "3", DAILY_COST_LIMIT: "0",
    ...extra,
  }
  const savedEnv = {}
  for (const [k, v] of Object.entries(over)) { savedEnv[k] = process.env[k]; process.env[k] = v }
  let mod
  try { mod = await import(`../server.mjs?${tag}`) } finally {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来")
  return { mod, base: `http://127.0.0.1:${port}` }
}
async function teardown() {
  try { await new Promise((r) => (gw?.mod?.server ? gw.mod.server.close(r) : r())) } catch {}
  if (ocProc?.pid) { try { execSync(`taskkill /pid ${ocProc.pid} /T /F`, { stdio: "pipe" }) } catch {} }
  try { await mock?.close() } catch {}
  try { fs.unlinkSync(ocCfgPath) } catch {}   // 别把指向 mock 的 provider 留在仓库根影响开发机
}

test("无人值守端到端", { skip: hasOpencode ? false : "本机没有 opencode CLI" }, async (t) => {
  await setup()
  t.after(teardown)

  await t.test("问编号问题 → 自动续跑到 [FINAL] 收官，哨兵不外露", async () => {
    const { rounds } = await runConversation(gw.base, { q: "SCENARIO_QA 请帮我完成任务A", auto: true })
    assert.equal(rounds.length, 3, `应恰好 3 轮（问题→干活→交付），实际 ${rounds.length} 轮`)
    // 第 1、2 轮各宣告一次续跑，轮数递增
    assert.deepEqual(evOf(rounds[0], "auto").map((e) => e.data.round), [1])
    assert.deepEqual(evOf(rounds[1], "auto").map((e) => e.data.round), [2])
    assert.equal(evOf(rounds[2], "auto").length, 0, "末轮见哨兵，不再续跑")
    for (const r of rounds) assert.ok(evOf(r, "done").length, "每轮都正常 done 收尾")
    const finalTexts = rounds.map((r) => evOf(r, "final").at(-1)?.data?.text || "")
    assert.match(finalTexts[0], /方向A（推荐/, "首轮就是模型的提问原文")
    assert.match(finalTexts[2], /X=42/)
    assert.ok(!finalTexts[2].includes("[FINAL]"), "直播 final 文本已剥哨兵")
  })

  await t.test("历史回显：哨兵剥掉、续跑指令如实可见", async () => {
    const { sid, rounds } = await runConversation(gw.base, { q: "SCENARIO_QA 再来一遍", auto: true })
    assert.equal(rounds.length, 3)
    const hist = await (await fetch(`${gw.base}/api/history?sid=${encodeURIComponent(sid)}`)).json()
    const asst = hist.filter((m) => m.role === "assistant").map((m) => m.text)
    assert.equal(asst.length, 3)
    assert.ok(asst.every((tx) => !tx.includes("[FINAL]")), "历史里的助手文本同样不含哨兵")
    const users = hist.filter((m) => m.role === "user").map((m) => m.text)
    assert.ok(users.some((tx) => tx.includes("自动续跑 第 1 轮")), "续跑轮的用户消息在历史里如实可见")
  })

  await t.test("首轮即 [FINAL] → 不续跑", async () => {
    const { rounds } = await runConversation(gw.base, { q: "SCENARIO_ONESHOT 算个数", auto: true })
    assert.equal(rounds.length, 1)
    assert.equal(evOf(rounds[0], "auto").length, 0)
    assert.match(evOf(rounds[0], "final").at(-1).data.text, /答案是 7/)
  })

  await t.test("没勾 auto：模型问了问题也不续跑", async () => {
    const { rounds } = await runConversation(gw.base, { q: "SCENARIO_QA 但我要自己拍板", auto: false })
    assert.equal(rounds.length, 1)
    assert.equal(evOf(rounds[0], "auto").length, 0)
    assert.match(evOf(rounds[0], "final").at(-1).data.text, /直接回 1 或 2/)
  })

  await t.test("永不完成 → 轮数上限（3）兜底停 + 提示", async () => {
    const { rounds } = await runConversation(gw.base, { q: "SCENARIO_NEVER 无底洞任务", auto: true })
    assert.equal(rounds.length, 4, "1 手动轮 + 3 自动轮")
    assert.equal(evOf(rounds[3], "auto").length, 0)
    const notes = evOf(rounds[3], "notice").map((e) => e.data.message).join("|")
    assert.match(notes, /为防失控已停止/)
  })

  await t.test("连续两轮输出相同 → 停滞检测停 + 提示", async () => {
    const { rounds } = await runConversation(gw.base, { q: "SCENARIO_STALL 会打转的任务", auto: true })
    assert.equal(rounds.length, 2, "第 2 轮与第 1 轮输出相同即停")
    const notes = evOf(rounds[1], "notice").map((e) => e.data.message).join("|")
    assert.match(notes, /原地打转/)
  })

  await t.test("空转闸：连续两轮没动手 → 停（默认配置，单起一个网关实例）", async () => {
    // 这道闸是给"模型漏打哨兵"兜底的：单步任务（画一张图）做完就交付了，模型常常忘了那行标记，
    // 于是被推着一轮轮给已经交付的东西继续加工。NEVER 剧本正是这个形状——每轮说得热闹、
    // 一个工具都不调。上限 3 轮的闸要到第 4 轮才停，空转闸应当在第 2 轮就收住。
    const g2 = await startGateway("autopilot-e2e-idle")   // 不放宽 OC_AUTO_IDLE_MAX
    try {
      const { rounds } = await runConversation(g2.base, { q: "SCENARIO_NEVER 只说不做的任务", auto: true })
      assert.equal(rounds.length, 2, `空转闸应在第 2 轮收住（轮数上限 3 要到第 4 轮），实际 ${rounds.length} 轮`)
      assert.equal(evOf(rounds[1], "auto").length, 0)
      const notes = evOf(rounds[1], "notice").map((e) => e.data.message).join("|")
      assert.match(notes, /没有再动手做事/)
    } finally { await new Promise((r) => (g2.mod?.server ? g2.mod.server.close(r) : r())) }
  })

  await t.test("循环中终止：立即停且不再自动续跑", async () => {
    // 前置条件用 /api/job 轮询而不是抓 SSE 事件：无人值守的轮与轮之间同步衔接，
    // 循环没结束 running 恒 true —— 这判据不受"测试端有没有恰好接上流"的时序影响。
    const r = await fetch(`${gw.base}/api/chat/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "SCENARIO_NEVER 跑起来我就砍", auto: true }) })
    const j = await r.json()
    assert.equal(j.sent, true)
    const running = async () => (await (await fetch(`${gw.base}/api/job?sid=${encodeURIComponent(j.sid)}`)).json()).running
    const deadline = Date.now() + 60_000
    while (!(await running())) { assert.ok(Date.now() < deadline, "循环迟迟没跑起来"); await new Promise((x) => setTimeout(x, 100)) }
    await new Promise((x) => setTimeout(x, 900))   // 让它跑进循环深处再砍（NEVER 剧本不会自己停）
    const ab = await (await fetch(`${gw.base}/api/chat/abort?sid=${encodeURIComponent(j.sid)}`, { method: "POST" })).json()
    assert.equal(ab.aborted, true, "终止时确有在跑的一轮")
    await new Promise((x) => setTimeout(x, 700))
    assert.equal(await running(), false, "终止即停，没有在跑的轮")
    // ★ 数【自动续跑消息】而不是用户消息总数。
    //   总数是个代理指标，且有已知假阳性：被砍那一轮自己的用户消息可能还没落库（原注释写着
    //   "实测取到 0 条"），2 秒后补齐入列就被误判成"偷跑注入" —— 原来靠一个固定 700ms 的
    //   等待去躲它，实测 3 次里仍会挂 1 次（差值恰好是 1，且两次 running() 都是 false）。
    //   而本用例真正要验的是"不再自动续跑"，那种消息带着「自动续跑 第」标记（autoContinueText
    //   与 mock 的轮数判据用的都是它）。改数它：假阳性没了，真注入照样抓得到 —— 只会更严，不会更松。
    const autoN = (h) => h.filter((m) => m.role === "user" && /自动续跑 第/.test(m.text || "")).length
    const hist1 = await (await fetch(`${gw.base}/api/history?sid=${encodeURIComponent(j.sid)}`)).json()
    await new Promise((x) => setTimeout(x, 2000))   // 若终止没清掉无人值守，这个窗口足够它偷跑下一轮
    assert.equal(await running(), false, "终止后没有偷跑新一轮")
    const hist2 = await (await fetch(`${gw.base}/api/history?sid=${encodeURIComponent(j.sid)}`)).json()
    assert.equal(autoN(hist2), autoN(hist1), "终止后没再注入新的续跑消息")
  })
})
