// 云端账号模块的集成测试：真起一个 sci-auth（内存库、随机端口）当对端，不打网络。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let seq = 0
/** 起一个 sci-auth 实例并建好一个可用账号，返回 {base, admin, close, user} */
async function cloud() {
  const prev = { ...process.env }
  const secret = "web-test-" + (++seq)
  Object.assign(process.env, {
    DB_FILE: ":memory:", LISTEN: "127.0.0.1:0", ADMIN_PASSWORD: "adminpw",
    KEY_SECRET: secret, LLM_UPSTREAM_KEY: "up", DATA_DIR: "", TEST_BYPASS_TOKEN: "t-bypass",
  })
  const mod = await import(`../../server/sci-auth.mjs?w=${seq}`)
  await new Promise((r) => mod.server.listen(0, "127.0.0.1", r))
  const base = `http://127.0.0.1:${mod.server.address().port}`
  process.env = prev

  const req = async (p, { method = "GET", body, headers = {} } = {}) => {
    const h = { ...headers }
    if (body !== undefined) h["content-type"] = "application/json"
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, json: await r.json().catch(() => null), headers: Object.fromEntries(r.headers) }
  }
  const lo = await req("/admin/api/login", { method: "POST", body: { password: "adminpw" }, headers: { "x-test-bypass": "t-bypass" } })
  const cookie = (lo.headers["set-cookie"] || "").split(";")[0]
  const admin = (p, o = {}) => req(p, { ...o, headers: { ...(o.headers || {}), cookie } })
  return { base, req, admin, db: mod.db, close: () => new Promise((r) => mod.server.close(r)) }
}

/** 每个用例一个独立的状态文件目录，互不干扰 */
async function mod(base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudstate-"))
  const prev = { ...process.env }
  process.env.CLOUD_STATE_PATH = path.join(dir, "cloud-state.json")
  // 钉死到一个不存在的 cloud.json：否则开发机上真实的仓库根 cloud.json 会被读进来，
  // "没配云端地址"这类用例就会莫名其妙地失败
  process.env.CLOUD_CFG_PATH = path.join(dir, "no-such-cloud.json")
  process.env.SCI_CLOUD_URL = base
  const m = await import(`../cloud-account.mjs?t=${++seq}`)
  process.env = prev
  // 恢复 env 后再设回去供运行时读取（模块里的路径是每次调用现读的）
  process.env.CLOUD_STATE_PATH = path.join(dir, "cloud-state.json")
  process.env.CLOUD_CFG_PATH = path.join(dir, "no-such-cloud.json")
  process.env.SCI_CLOUD_URL = base
  return m
}

/** 建号 + 改密，返回可直接登录的凭据 */
async function makeUser(c, username = "zhangsan", tier = "plus") {
  const add = await c.admin("/admin/api/user-add", { method: "POST", body: { username, displayName: "张三", tier } })
  const pw0 = add.json.initialPassword
  return { id: add.json.user.id, username, pw0, pw: "Cloud!test2026" }
}

test("cloudBase：/llm、/llm/v1、/v1、尾斜杠 都归一成站点根", async () => {
  const m = await mod("http://x")
  const cases = [
    ["https://a.com", "https://a.com"],
    ["https://a.com/", "https://a.com"],
    ["https://a.com/llm", "https://a.com"],
    ["https://a.com/llm/v1", "https://a.com"],
    ["https://a.com/llm/v1/", "https://a.com"],
    ["https://a.com/v1", "https://a.com"],
  ]
  for (const [inp, want] of cases) {
    process.env.SCI_CLOUD_URL = inp
    assert.equal(m.cloudBase(), want, inp)
  }
  process.env.SCI_CLOUD_URL = ""
  assert.equal(m.cloudBase(), "")
})

test("登录：成功落盘、失败不落盘且给结构化错误", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  const u = await makeUser(c)

  let r = await m.login(u.username, "wrong-pw")
  assert.equal(r.ok, false)
  assert.equal(r.error.code, "BAD_CREDENTIALS")
  assert.equal(m.loadState(), null, "失败不该留下登录态")

  r = await m.login(u.username, u.pw0)
  assert.equal(r.ok, true)
  assert.equal(r.state.username, u.username)
  assert.equal(r.state.mustChangePassword, true)
  assert.equal(r.state.scope, "pwchange")
  assert.ok(r.state.access && r.state.refresh)
  assert.ok(fs.existsSync(process.env.CLOUD_STATE_PATH))
})

test("首次强制改密：改完拿到 full 票据并落盘", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  const u = await makeUser(c)
  await m.login(u.username, u.pw0)

  let r = await m.changePassword(u.pw0, "weak")
  assert.equal(r.ok, false)
  assert.equal(r.error.code, "WEAK_PASSWORD")

  r = await m.changePassword(u.pw0, u.pw)
  assert.equal(r.ok, true)
  assert.equal(r.state.scope, "full")
  assert.equal(r.state.mustChangePassword, false)
  assert.equal(m.loadState().scope, "full")
})

test("currentAccess：没到期就用缓存，临近到期才续", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  const u = await makeUser(c)
  await m.login(u.username, u.pw0)
  await m.changePassword(u.pw0, u.pw)

  const before = m.loadState()
  const a = await m.currentAccess()
  assert.equal(a.ok, true)
  assert.equal(a.token, before.access, "还早得很，不该换 key")
  assert.equal(m.loadState().refresh, before.refresh)

  // 把到期时间改到"马上过期"，再取就该续
  m.saveState({ ...before, accessExp: Date.now() + 1000 })
  const b = await m.currentAccess()
  assert.equal(b.ok, true)
  assert.notEqual(b.token, before.access, "该换一把新 key")
  assert.notEqual(m.loadState().refresh, before.refresh, "refresh 也应轮换")
})

test("续期是 single-flight：并发只换一次，不会把 refresh 用废", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  const u = await makeUser(c)
  await m.login(u.username, u.pw0)
  await m.changePassword(u.pw0, u.pw)
  m.saveState({ ...m.loadState(), accessExp: Date.now() + 1000 })

  // refresh token 是一次性轮换的：若不做 single-flight，并发里除了第一个都会拿废票去换
  const rs = await Promise.all(Array.from({ length: 6 }, () => m.currentAccess()))
  assert.equal(rs.every((r) => r.ok), true, JSON.stringify(rs.filter((r) => !r.ok)))
  assert.equal(new Set(rs.map((r) => r.token)).size, 1, "六个并发应拿到同一把新 key")
  const live = c.db.prepare("SELECT COUNT(*) AS n FROM refresh_tokens WHERE revoked=0").get().n
  assert.equal(live, 1, "只该剩一把有效 refresh")
})

test("续期：云端明确否掉（账号被删）才清登录态", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  const u = await makeUser(c)
  await m.login(u.username, u.pw0)
  await m.changePassword(u.pw0, u.pw)

  await c.admin("/admin/api/user-del", { method: "POST", body: { id: u.id, confirm: u.username } })
  const r = await m.renew()
  assert.equal(r.ok, false)
  assert.equal(r.status, 401)
  assert.equal(m.loadState(), null, "云端说票据无效 → 清掉本地登录态")
})

test("续期：网络不通【不】清登录态（断网一次不该把人登出）", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  const u = await makeUser(c)
  await m.login(u.username, u.pw0)
  await m.changePassword(u.pw0, u.pw)
  const kept = m.loadState()

  process.env.SCI_CLOUD_URL = "http://127.0.0.1:1"   // 必定连不上
  m._resetRenewing()
  const r = await m.renew()
  assert.equal(r.ok, false)
  assert.equal(r.error.code, "NETWORK")
  assert.deepEqual(m.loadState().refresh, kept.refresh, "登录态必须原样保留")

  process.env.SCI_CLOUD_URL = c.base
  m._resetRenewing()
  assert.equal((await m.renew()).ok, true, "网络恢复后能接着用")
})

test("停用：续期被拒并清态；档位变更同理", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  const u = await makeUser(c)
  await m.login(u.username, u.pw0)
  await m.changePassword(u.pw0, u.pw)

  await c.admin("/admin/api/suspend", { method: "POST", body: { id: u.id, suspended: true } })
  m._resetRenewing()
  const r = await m.renew()
  assert.equal(r.ok, false)
  assert.equal(m.loadState(), null)
})

test("fetchProfile：拿到档位/模型/额度并写回缓存", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  await c.admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 1.5, model: "m-plus", skills: "write-paper" } })
  const u = await makeUser(c)
  await m.login(u.username, u.pw0)
  await m.changePassword(u.pw0, u.pw)

  const r = await m.fetchProfile()
  assert.equal(r.ok, true)
  assert.equal(r.profile.tier, "plus")
  assert.equal(r.profile.model, "m-plus")
  assert.deepEqual(r.profile.skills, ["write-paper"])
  assert.equal(m.loadState().profile.model, "m-plus")
})

test("status：不含任何凭证", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  let s = m.status()
  assert.equal(s.loggedIn, false)
  assert.equal(s.configured, true)

  const u = await makeUser(c)
  await m.login(u.username, u.pw0)
  await m.changePassword(u.pw0, u.pw)
  s = m.status()
  assert.equal(s.loggedIn, true)
  assert.equal(s.username, u.username)
  const dump = JSON.stringify(s)
  assert.equal(dump.includes(m.loadState().access), false, "status 不能带 access")
  assert.equal(dump.includes(m.loadState().refresh), false, "status 不能带 refresh")
})

test("logout：清本地态并让云端作废 refresh", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  const u = await makeUser(c)
  await m.login(u.username, u.pw0)
  await m.changePassword(u.pw0, u.pw)
  const old = m.loadState().refresh

  await m.logout()
  assert.equal(m.loadState(), null)
  const r = await c.req("/api/auth/refresh", { method: "POST", body: { refresh: old } })
  assert.equal(r.status, 401, "云端那把 refresh 也该废了")
})

test("没配云端地址：所有调用给出明确错误而不是崩", async () => {
  const m = await mod("")
  process.env.SCI_CLOUD_URL = ""
  const r = await m.login("a", "b")
  assert.equal(r.ok, false)
  assert.equal(r.error.code, "NO_CLOUD_URL")
  assert.equal(m.status().configured, false)
})

test("状态文件是原子写：中途读不到半个 JSON", async (t) => {
  const c = await cloud(); t.after(() => c.close())
  const m = await mod(c.base)
  const u = await makeUser(c)
  await m.login(u.username, u.pw0)
  for (let i = 0; i < 20; i++) {
    m.saveState({ ...m.loadState(), updatedAt: Date.now() + i })
    assert.ok(m.loadState(), "每次都该读到完整 JSON")
  }
  assert.equal(fs.existsSync(process.env.CLOUD_STATE_PATH + ".tmp"), false, "临时文件不该残留")
})

test("cloud.json 带 BOM 也要能读（PowerShell/记事本默认就写 BOM）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudbom-"))
  const cfg = path.join(dir, "cloud.json")
  const m = await mod("")
  process.env.SCI_CLOUD_URL = ""
  process.env.CLOUD_CFG_PATH = cfg

  // 无 BOM
  fs.writeFileSync(cfg, JSON.stringify({ gatewayUrl: "https://a.com" }))
  assert.equal(m.cloudBase(), "https://a.com")
  // 带 BOM —— JSON.parse 见了 BOM 直接抛，不处理就等于"配置在、程序当没配"
  fs.writeFileSync(cfg, "﻿" + JSON.stringify({ gatewayUrl: "https://b.com" }))
  assert.equal(m.cloudBase(), "https://b.com", "带 BOM 的 cloud.json 必须也能读")
})
