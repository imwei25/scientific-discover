// 运营后台改了技能授权，客户端到底看不看得见 —— 这一条链的回归测试。
//
// 链路：sci-auth 的用户档案（profile.skills）→ 本机 cloud-state.json → 本机网关的技能闸
//   ① /api/modules 的模块卡片可用性（界面）
//   ② POST /api/chat/start 对被收权模块直接 403（执行）
//   ③ entRev 摘要变化 + 公告轮询顺带同步档案（"不用等下次登录"的那条路）
// 上游 sci-auth 是假的（只回 /api/me、/api/notice），opencode 不接管。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

let seq = 0

/**
 * 假 sci-auth：只实现客户端会打的几个口。
 * state.profile 随时可换（模拟管理员改授权）；state.epochBumped=true 则模拟"改权限吊销了票据"——
 * /api/me 回 KEY_EXPIRED、/api/auth/refresh 回 REFRESH_INVALID（真服务端的 bumpEpoch 就是这个效果）。
 */
async function fakeCloud(profile) {
  const state = { profile, meCalls: 0, refreshCalls: 0, epochBumped: false }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x")
    res.setHeader("content-type", "application/json")
    if (u.pathname === "/api/me") {
      state.meCalls++
      if (state.epochBumped) { res.statusCode = 401; return res.end(JSON.stringify({ error: { code: "KEY_EXPIRED", message: "票据已失效" } })) }
      return res.end(JSON.stringify({ profile: state.profile }))
    }
    if (u.pathname === "/api/auth/refresh") {
      state.refreshCalls++
      res.statusCode = 401
      return res.end(JSON.stringify({ error: { code: "REFRESH_INVALID", message: "账号信息已变更，请重新登录" } }))
    }
    if (u.pathname === "/api/notice") return res.end(JSON.stringify({ notice: null }))
    res.statusCode = 404; res.end(JSON.stringify({ error: { message: "no" } }))
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  return { state, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }
}

/** 起本机网关：已登录云端账号（状态文件手写），不接管 opencode */
async function gateway({ cloudUrl, profile, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skgate-"))
  // 登录态直接落盘：loadState 只要求有 refresh 字段。accessExp 给足，别让 currentAccess 去续期。
  fs.writeFileSync(path.join(dir, "cloud-state.json"), JSON.stringify({
    username: "zhangsan", access: "acc-1", accessExp: Date.now() + 3600_000,
    refresh: "ref-1", refreshExp: Date.now() + 30 * 86400_000, scope: "full", profile,
  }))
  const over = {
    MANAGE_OC: "0", PORT: "0",
    OC_URL: "http://127.0.0.1:1",
    HOME: dir, USERPROFILE: dir,                                   // quota.json / module-map.json 落临时目录
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),       // 别动开发机真实的 web/sessions-meta.json
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    SCI_CLOUD_URL: cloudUrl || "",
    OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
    ALLOWED_SKILLS: "", ALLOWED_MODULES: "", SUGGEST_ENABLED: "0",
    ...env,
  }
  // 逐个存取，别用 process.env = prev：那样换不回真实（native）环境变量，os.homedir() 会卡在第一次的值
  const saved = {}
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  let mod
  try { mod = await import(`../server.mjs?sk=${++seq}`) } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来")
  const base = `http://127.0.0.1:${port}`
  // 运行时也要看得到这几个（cloud-account 每次调用现读 env）
  process.env.CLOUD_STATE_PATH = over.CLOUD_STATE_PATH
  process.env.CLOUD_CFG_PATH = over.CLOUD_CFG_PATH
  if (cloudUrl) process.env.SCI_CLOUD_URL = cloudUrl
  return {
    base, dir,
    close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())),
    async get(p) { const r = await fetch(base + p); return { status: r.status, json: await r.json().catch(() => null) } },
    async post(p, body) {
      const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      return { status: r.status, json: await r.json().catch(() => null) }
    },
    /** 模块 id → 是否可用 */
    async modules() {
      const j = (await this.get("/api/modules")).json
      const out = {}
      for (const m of j.modules) out[m.id] = m.allowed
      return { map: out, entRev: j.entRev }
    },
  }
}

const prof = (skills) => ({ username: "zhangsan", tier: "plus", model: "m1", models: [{ model: "m1" }], skills, limits: { daily: 5, monthly: 50 }, usage: { today: 0, month: 0 } })

test("云端档案的技能白名单直接决定模块卡片：没授权的模块置灰", async (t) => {
  const gw = await gateway({ profile: prof(["grant-proposal"]) })
  t.after(() => gw.close())
  const { map } = await gw.modules()
  assert.equal(map.chat, true, "自由对话没有绑定技能，永远可用")
  assert.equal(map.grant, true, "白名单里有 grant-proposal")
  assert.equal(map.refcheck, false, "reference-check 不在白名单")
  assert.equal(map.humanize, false)
})

test("白名单为空 = 不限：所有模块都开", async (t) => {
  const gw = await gateway({ profile: prof([]) })
  t.after(() => gw.close())
  const { map } = await gw.modules()
  assert.deepEqual(map, { chat: true, grant: true, refcheck: true, humanize: true })
})

test("容器 env 白名单与云端白名单取交集（两层都得放行）", async (t) => {
  const gw = await gateway({ profile: prof(["grant-proposal", "reference-check"]), env: { ALLOWED_SKILLS: "reference-check,humanize-academic" } })
  t.after(() => gw.close())
  const { map } = await gw.modules()
  assert.equal(map.refcheck, true, "两边都有 → 放行")
  assert.equal(map.grant, false, "env 没给 → 拦")
  assert.equal(map.humanize, false, "云端没给 → 拦")
})

test("被收权的模块：起轮直接 403 说人话，不是默默降级成自由对话", async (t) => {
  const gw = await gateway({ profile: prof(["grant-proposal"]) })
  t.after(() => gw.close())
  const r = await gw.post("/api/chat/start", { q: "帮我查这几条引用", module: "refcheck" })
  assert.equal(r.status, 403)
  assert.equal(r.json.sent, false)
  assert.match(r.json.err, /未开通/)
  // 放行的那个模块不该被这道闸挡住（opencode 没接管，所以这里预期的是"过了授权闸之后"的 503）
  const ok = await gw.post("/api/chat/start", { q: "写个标书", module: "grant" })
  assert.notEqual(ok.status, 403, "有授权的模块不该被授权闸拦下")
})

test("管理员改完授权，客户端不用等下次登录：公告轮询顺带同步档案，entRev 跟着变", async (t) => {
  const cloud = await fakeCloud(prof(["grant-proposal"]))
  const gw = await gateway({ cloudUrl: cloud.url, profile: prof(["grant-proposal"]) })
  t.after(async () => { await gw.close(); await cloud.close() })

  const before = await gw.modules()
  assert.equal(before.map.grant, true)
  assert.equal(before.map.humanize, false)

  // 管理员在后台把授权改成"只许去 AI 味"
  cloud.state.profile = prof(["humanize-academic"])

  // 前端 5 分钟一次的公告轮询：网关顺手同步一次 /api/me
  const n = await gw.get("/api/cloud/notice")
  assert.equal(n.status, 200)
  assert.equal(cloud.state.meCalls, 1, "这条轮询应当同步过一次档案")
  assert.ok(n.json.entRev, "公告要带上授权摘要，前端据此决定要不要重取模块清单")

  const after = await gw.modules()
  assert.equal(after.map.grant, false, "被收回的模块应当立刻置灰")
  assert.equal(after.map.humanize, true, "新授权的模块应当立刻可用")
  assert.notEqual(after.entRev, before.entRev, "摘要必须变，否则前端不会去刷新界面")
  assert.equal(n.json.entRev, after.entRev, "两个口算的摘要要一致，不然前端会来回打转")

  // 同步有 5 分钟节流：紧接着再轮询不该再打 /api/me
  await gw.get("/api/cloud/notice")
  assert.equal(cloud.state.meCalls, 1, "节流失效会把 /api/me 打穿（多标签页 + 聚焦补拉很密）")
})

test("改权限吊销了票据：轮询当场把人标成需重新登录，不是等他发消息才被打断", async (t) => {
  const cloud = await fakeCloud(prof(["grant-proposal"]))
  const gw = await gateway({ cloudUrl: cloud.url, profile: prof(["grant-proposal"]) })
  t.after(async () => { await gw.close(); await cloud.close() })

  cloud.state.epochBumped = true          // 管理员改了技能 → access key 与 refresh 一起作废
  const n = await gw.get("/api/cloud/notice")
  assert.equal(n.status, 200)
  assert.equal(cloud.state.meCalls, 1)
  assert.equal(cloud.state.refreshCalls, 1, "档案拿不到时要主动续一次，才能确认登录态是真没了")
  assert.equal(n.json.loggedOut, true, "同一次回包就要如实说'登录态没了'，别让前端多等 5 分钟")
  assert.equal(fs.existsSync(path.join(gw.dir, "cloud-state.json")), false, "云端明确否掉才清登录态")
})

test("没登录云端账号时这条闸完全不生效（容器/自设 API 形态照旧只看 env）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skgate-none-"))
  const saved = {}
  const over = { CLOUD_STATE_PATH: path.join(dir, "nope.json") }
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  const gw = await gateway({ profile: prof(["grant-proposal"]), env: over })
  // 状态文件指向一个不存在的路径 → 未登录 → 云端白名单不参与
  t.after(async () => {
    await gw.close()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  const { map } = await gw.modules()
  assert.deepEqual(map, { chat: true, grant: true, refcheck: true, humanize: true })
})
