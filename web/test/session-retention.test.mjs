// 会话永久保留 + 批量删除 —— 这一对行为的回归测试。
//
// 【为什么有这个文件】早先的网关有一档"非项目会话 7 天无活动就自动删"的 TTL：启动 15 秒后跑一次
// 清理、之后每小时一次。用户的稿子、图和数据就这么在第 8 天悄悄没了（打包版同样带着这个机制）。
// 现在会话永久保留，删只由用户主动发起——但"没有人删"这件事天然测不出来，只能反过来测：
// 把一批【早就过了老 TTL】的会话摆在 opencode 里，起网关、等过启动清理的时刻，看它有没有下过 DELETE。
// 一旦哪天有人把定时清理写回来，这条会立刻红。
//
// 顺带把"批量勾选删除"的服务端契约钉死：界面上的批量删除就是对 /api/session/delete 逐条调用
// （不另开批量接口，见 index.html 的 deleteSelected 注释），所以连删多条必须条条都真删。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { fileURLToPath } from "node:url"

let seq = 0

// ★ 会假会话的产物目录必须落在【真实的 outputs/ 根】之内。
// 删会话时保护用户目录的判据是【路径本身】（server.mjs 的 insideOutputs）：outputs/ 之外的
// 目录一律当成"用户自己的目录"保下来，一个字节都不删。这个文件早先把假目录建在 os.tmpdir()
// 下，2026-08-14 加上该守卫（9ea03a3f）之后批删用例就一直红——不是产品坏了，是假目录压根
// 不在我们的产物根里，现实中普通会话不会长在那儿（挑了工作目录的会话才在外面，而那种就是
// 该保住不删的，另见 session-folders 的用例）。OUTPUTS 在 server.mjs 里是按 __dirname 定死的、
// 没有环境变量口子，所以这里只能跟着用真实路径，测完自己清干净。
const REPO_OUTPUTS = path.join(path.resolve(fileURLToPath(import.meta.url), "..", "..", ".."), "outputs")

/**
 * 假 opencode：只实现网关会打的几个会话口。
 * state.deleted 记下所有被 DELETE 的会话 id —— 本测试的核心观测点。
 */
async function fakeOpencode(sessions, outRoot) {
  const state = { sessions: [...sessions], deleted: [] }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x")
    res.setHeader("content-type", "application/json")
    const m = /^\/session\/([^/]+)$/.exec(u.pathname)
    if (u.pathname === "/session" && req.method === "GET") return res.end(JSON.stringify(state.sessions))
    if (m && req.method === "GET") {
      const s = state.sessions.find((x) => x.id === m[1])
      if (!s) { res.statusCode = 404; return res.end(JSON.stringify({ error: "no such session" })) }
      return res.end(JSON.stringify({ ...s, directory: path.join(outRoot, s.id) }))
    }
    if (m && req.method === "DELETE") {
      state.deleted.push(m[1])
      state.sessions = state.sessions.filter((x) => x.id !== m[1])
      return res.end(JSON.stringify(true))
    }
    res.end(JSON.stringify({}))
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  return { state, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }
}

/** 起本机网关，接到假 opencode 上（不接管 opencode 进程，不连云端） */
async function gateway(ocUrl, dir) {
  const over = {
    MANAGE_OC: "0", PORT: "0", AUTH_ENABLED: "",
    OC_URL: ocUrl,
    HOME: dir, USERPROFILE: dir,                                   // quota.json / module-map.json 落临时目录
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),      // 别动开发机真实的 web/sessions-meta.json
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
    ALLOWED_SKILLS: "", ALLOWED_MODULES: "", SUGGEST_ENABLED: "0",
  }
  const saved = {}
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  let mod
  try { mod = await import(`../server.mjs?ret=${++seq}`) } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来")
  const base = `http://127.0.0.1:${port}`
  return {
    base,
    close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())),
    async get(p) { const r = await fetch(base + p); return { status: r.status, json: await r.json().catch(() => null) } },
    async post(p) { const r = await fetch(base + p, { method: "POST" }); return { status: r.status, json: await r.json().catch(() => null) } },
  }
}

const DAY = 86400_000

test("会话永久保留：早就过了老 7 天 TTL 的会话，启动清理跑过之后仍在", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessret-"))
  const outRoot = path.join(dir, "out")
  // 会话产物目录建出来：删除路径会 rmSync 它，测试要能验证"没被删"
  const ids = ["ses_ancient1", "ses_ancient2", "ses_fresh"]
  for (const id of ids) { fs.mkdirSync(path.join(outRoot, id), { recursive: true }); fs.writeFileSync(path.join(outRoot, id, "稿子.md"), "x") }
  const now = Date.now()
  const oc = await fakeOpencode([
    { id: "ses_ancient1", title: "200 天前的综述", time: { updated: now - 200 * DAY } },
    { id: "ses_ancient2", title: "30 天前的标书", time: { updated: now - 30 * DAY } },
    { id: "ses_fresh", title: "刚聊的", time: { updated: now } },
  ], outRoot)
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const list = await gw.get("/api/sessions")
  assert.equal(list.status, 200)
  assert.deepEqual(list.json.sessions.map((s) => s.id).sort(), [...ids].sort(), "三条会话都该列出来")
  for (const s of list.json.sessions) {
    assert.equal(s.permanent, true, `${s.id} 应标为永久保留`)
    assert.equal(s.expiresAt, null, `${s.id} 不该有到期时间`)
  }

  // 老实现在启动后 15 秒跑一次清理，会把前两条按"过期"删掉。等过这个点再看。
  await new Promise((r) => setTimeout(r, 18_000))
  assert.deepEqual(oc.state.deleted, [], "不该有任何会话被自动删除")
  for (const id of ids) assert.ok(fs.existsSync(path.join(outRoot, id, "稿子.md")), `${id} 的产物不该被自动清理`)
  const after = await gw.get("/api/sessions")
  assert.equal(after.json.sessions.length, 3, "会话数不该变")
})

test("批量删除：逐条调 /api/session/delete，条条真删（界面批量勾选走的就是这条路）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessret-"))
  // 见文件头 REPO_OUTPUTS 的注释：普通会话的产物目录得在真实的 outputs/ 里，否则会被
  // "保护用户目录"的判据保下来，这条用例就永远验不到"该删的真删了"。
  fs.mkdirSync(REPO_OUTPUTS, { recursive: true })
  const outRoot = fs.mkdtempSync(path.join(REPO_OUTPUTS, "sessret-"))
  const ids = ["ses_b1", "ses_b2", "ses_b3"]
  for (const id of ids) { fs.mkdirSync(path.join(outRoot, id), { recursive: true }); fs.writeFileSync(path.join(outRoot, id, "图.png"), "x") }
  const oc = await fakeOpencode(ids.map((id) => ({ id, title: id, time: { updated: Date.now() } })), outRoot)
  const gw = await gateway(oc.url, dir)
  t.after(async () => {
    await gw.close(); await oc.close()
    for (const p of [dir, outRoot]) { try { fs.rmSync(p, { recursive: true, force: true }) } catch {} }
  })

  // 前两条并发删（界面里是 3 个 worker 并发消费队列），第三条留着验证"只删勾中的"
  const rs = await Promise.all([gw.post("/api/session/delete?id=ses_b1"), gw.post("/api/session/delete?id=ses_b2")])
  for (const r of rs) { assert.equal(r.status, 200); assert.equal(r.json.ok, true) }
  assert.deepEqual([...oc.state.deleted].sort(), ["ses_b1", "ses_b2"], "两条都该真的下到 opencode")
  assert.ok(!fs.existsSync(path.join(outRoot, "ses_b1")), "产物目录该一并删掉")
  assert.ok(!fs.existsSync(path.join(outRoot, "ses_b2")), "产物目录该一并删掉")
  assert.ok(fs.existsSync(path.join(outRoot, "ses_b3", "图.png")), "没勾的会话不该被碰")

  const left = await gw.get("/api/sessions")
  assert.deepEqual(left.json.sessions.map((s) => s.id), ["ses_b3"])
})
