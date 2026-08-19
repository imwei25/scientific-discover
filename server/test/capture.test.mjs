// 请求抓包（调试用）：管理员按用户开关，开着时把该用户打到 /llm 的完整请求体落盘；
// 关着 / 别的用户不受影响。既测 capture.mjs 的纯逻辑，也测网关端到端真的抓到了 body。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startApp, adminLogin, asAdmin, startFakeUpstream } from "./helper.mjs"
import { initCapture } from "../lib/capture.mjs"

const STRONG = "Aa1!aaaa9"
const CHAT = "/llm/v1/chat/completions"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cap-"))
}

// record 落盘是异步的（fs.writeFile）——轮询等到抓够 n 条【且内容已写完能解析】
async function waitFiles(c, n, ms = 1000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const st = c.status()
    if (st.files.length >= n) {
      // 文件出现在 readdir 里可能早于内容 flush；确认最新一条能解析再返回
      try { JSON.parse(c.readFile(st.files[0].name).toString("utf8")); return st } catch {}
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  return c.status()
}

// ---- 纯逻辑：capture.mjs ----
test("capture：默认全关，record 不落盘", () => {
  const dir = tmpDir()
  const c = initCapture(dir)
  assert.equal(c.isOn("zhangsan"), false)
  c.record("zhangsan", { model: "m" }, Buffer.from('{"a":1}'))
  assert.equal(c.status().files.length, 0)
})

test("capture：开开关后 record 落盘，含完整 body", async () => {
  const dir = tmpDir()
  const c = initCapture(dir)
  c.toggle("zhangsan", true)
  assert.equal(c.isOn("zhangsan"), true)
  c.record("zhangsan", { model: "deepseek", skill: "write-paper", path: "/llm/v1/chat/completions" },
    Buffer.from(JSON.stringify({ messages: [{ role: "system", content: "SKILL 正文在此" }] })))
  const st = await waitFiles(c, 1)
  assert.equal(st.users.includes("zhangsan"), true)
  assert.equal(st.files.length, 1)
  const buf = c.readFile(st.files[0].name)
  const rec = JSON.parse(buf.toString("utf8"))
  assert.equal(rec.model, "deepseek")
  assert.equal(rec.skill, "write-paper")
  assert.equal(rec.body.messages[0].content, "SKILL 正文在此")
})

test("capture：只抓开着的用户，别人不落盘", async () => {
  const dir = tmpDir()
  const c = initCapture(dir)
  c.toggle("zhangsan", true)
  c.record("zhangsan", {}, Buffer.from("{}"))
  c.record("lisi", {}, Buffer.from("{}"))       // 没开，不该抓
  const st = await waitFiles(c, 1)
  assert.equal(st.files.length, 1)
  assert.equal(st.files[0].user, "zhangsan")
})

test("capture：关掉后不再抓", () => {
  const dir = tmpDir()
  const c = initCapture(dir)
  c.toggle("zhangsan", true)
  c.toggle("zhangsan", false)
  assert.equal(c.isOn("zhangsan"), false)
  c.record("zhangsan", {}, Buffer.from("{}"))
  assert.equal(c.status().files.length, 0)
})

test("capture：开关状态持久化（重启后仍在抓）", () => {
  const dir = tmpDir()
  initCapture(dir).toggle("zhangsan", true)
  const c2 = initCapture(dir)                    // 模拟重启：重新 init 同目录
  assert.equal(c2.isOn("zhangsan"), true)
})

test("capture：deleteFiles 只删点名的那几条，路径穿越/config.json 一律不碰", async () => {
  const dir = tmpDir()
  const c = initCapture(dir)
  c.toggle("zhangsan", true)
  c.toggle("lisi", true)
  for (let i = 0; i < 3; i++) c.record("zhangsan", { model: "m" }, Buffer.from(`{"i":${i}}`))
  c.record("lisi", { model: "m" }, Buffer.from('{"x":1}'))
  const st = await waitFiles(c, 4)
  const mine = st.files.filter((f) => f.user === "zhangsan").map((f) => f.name)
  assert.equal(mine.length, 3)

  const r = c.deleteFiles(mine.slice(0, 2))
  assert.equal(r.ok, true)
  assert.equal(r.n, 2)
  const left = c.status().files
  assert.equal(left.length, 2)                                    // 剩 zhangsan 1 条 + lisi 1 条
  assert.equal(left.filter((f) => f.user === "lisi").length, 1)    // 别人的没被误删
  assert.equal(c.isOn("zhangsan"), true)                           // 开关不受影响

  // 越界与非抓包文件：一条都不该删，config.json 还在
  assert.equal(c.deleteFiles(["../../etc/passwd"]).n, 0)
  assert.equal(c.deleteFiles(["a/b/c"]).n, 0)
  assert.equal(c.deleteFiles(["zhangsan/../config.json"]).n, 0)
  assert.equal(c.deleteFiles(["./config.json"]).n, 0)
  assert.equal(fs.existsSync(path.join(dir, "captures", "config.json")), true)
  assert.equal(c.deleteFiles([]).ok, false)
  assert.equal(c.status().files.length, 2)
})

test("capture：clearUser 删文件但保留开关", async () => {
  const dir = tmpDir()
  const c = initCapture(dir)
  c.toggle("zhangsan", true)
  c.record("zhangsan", {}, Buffer.from("{}"))
  await waitFiles(c, 1)
  assert.equal(c.status().files.length, 1)
  c.clearUser("zhangsan")
  assert.equal(c.status().files.length, 0)
  assert.equal(c.isOn("zhangsan"), true)         // 还在抓，只是文件清了
})

test("capture：超过 10 天的抓包文件被自动清理", async () => {
  const dir = tmpDir()
  const c = initCapture(dir)
  c.toggle("zhangsan", true)
  c.record("zhangsan", {}, Buffer.from("{}"))
  await waitFiles(c, 1)
  // 手工把这条文件改名成 11 天前的时间戳前缀（prune 按文件名前缀判龄）
  const udir = path.join(dir, "captures", "zhangsan")
  const cur = fs.readdirSync(udir)[0]
  const oldTs = Date.now() - 11 * 24 * 60 * 60 * 1000
  fs.renameSync(path.join(udir, cur), path.join(udir, `${oldTs}-9.json`))
  // 造一条新文件，触发 prune（record 落盘后会 prune 该目录）
  c.record("zhangsan", {}, Buffer.from("{}"))
  await new Promise((r) => setTimeout(r, 50))
  const names = fs.readdirSync(udir)
  assert.equal(names.some((n) => n.startsWith(String(oldTs))), false, "11 天前的文件应被清掉")
  assert.equal(names.length, 1, "只剩那条新的")
})

test("capture：readFile 拒绝路径穿越", () => {
  const dir = tmpDir()
  const c = initCapture(dir)
  assert.equal(c.readFile("../../etc/passwd"), null)
  assert.equal(c.readFile("a/b/c"), null)
  assert.equal(c.readFile("x/../../y.json"), null)
})

test("capture：用户名里的路径分隔符被消毒（不逃出 captures 目录）", async () => {
  const dir = tmpDir()
  const c = initCapture(dir)
  c.toggle("../evil", true)
  c.record("../evil", {}, Buffer.from("{}"))
  await waitFiles(c, 1)
  // 落在 captures/_.._evil/ 下，绝不在 captures 之外
  const outside = path.join(dir, "evil")
  assert.equal(fs.existsSync(outside), false)
})

// ---- 端到端：网关真的抓到 opencode 发出的 body ----
async function rig() {
  const up = await startFakeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "x", model: "m", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  const dataDir = tmpDir()
  const app = await startApp({ LLM_UPSTREAM_URL: up.url, DATA_DIR: dataDir })
  const cookie = await adminLogin(app)
  const admin = asAdmin(app, cookie)
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三", tier: "free" } })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: STRONG },
  })
  const call = (body) => app.req(CHAT, { method: "POST", body, headers: { authorization: "Bearer " + chg.json.access } })
  return { up, app, admin, dataDir, call, async close() { await app.close(); await up.close() } }
}

test("capture 端到端：开了才抓，抓到的是完整 messages", async () => {
  const r = await rig()
  try {
    const payload = { model: "deepseek-chat", messages: [{ role: "system", content: "这是技能正文，验证它进没进上下文" }] }

    // 没开：不抓
    await r.call(payload)
    let st = (await r.admin("/admin/api/capture")).json
    assert.equal(st.files.length, 0)

    // 开
    const on = await r.admin("/admin/api/capture", { method: "POST", body: { username: "zhangsan", on: true } })
    assert.equal(on.status, 200)
    assert.equal(on.json.users.includes("zhangsan"), true)

    // 再打一轮 → 抓到
    await r.call(payload)
    st = (await r.admin("/admin/api/capture")).json
    assert.equal(st.files.length, 1)

    // 下载这条，body 里能看到那段"技能正文"
    const name = st.files[0].name
    const dl = await r.admin("/admin/api/capture-file?name=" + encodeURIComponent(name))
    const rec = JSON.parse(dl.text)
    assert.equal(rec.body.messages[0].content, "这是技能正文，验证它进没进上下文")
    // body 里是客户端原始点名的模型；rec.model 是网关定档后实际发出的（free 档把 deepseek-chat 打回默认）
    assert.equal(rec.body.model, "deepseek-chat")
    assert.ok(rec.model, "记录了实际发出的模型名")
  } finally { await r.close() }
})

test("capture 端到端：开不存在的用户被拒", async () => {
  const r = await rig()
  try {
    const res = await r.admin("/admin/api/capture", { method: "POST", body: { username: "nobody", on: true } })
    assert.equal(res.status, 404)
  } finally { await r.close() }
})

test("capture 端到端：未登录管理员不能开抓包", async () => {
  const r = await rig()
  try {
    const res = await r.app.req("/admin/api/capture", { method: "POST", body: { username: "zhangsan", on: true } })
    assert.equal(res.status, 401)
  } finally { await r.close() }
})
