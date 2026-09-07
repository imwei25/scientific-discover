// 企业版 coding plan 席位在客户端这一侧的全链路：
//   管理员分配 → 本机网关对账拿到凭证 → 存进凭证档（带 seat 标记、不占 3 格）→ opencode 切成直连
//   → 用户「切回云端」→ 凭证还在、不再被自动推回 → 「使用」再切回 → 管理员换 key 原地更新
//   → 管理员收回 → 凭证删掉、路由回云端。三层都是真的：假上游 ← sci-auth（内存库）← 本机网关（不接管 opencode）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

let seq = 0

function fakeUpstream() {
  const srv = http.createServer((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ model: "tier-model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    srv, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((x) => srv.close(x)),
  })))
}

async function cloudBackend(upstreamUrl) {
  const prev = { ...process.env }
  Object.assign(process.env, {
    DB_FILE: ":memory:", LISTEN: "127.0.0.1:0", ADMIN_PASSWORD: "adminpw",
    KEY_SECRET: "seat-" + (++seq), LLM_UPSTREAM_KEY: "up-key", LLM_UPSTREAM_URL: upstreamUrl,
    DATA_DIR: "", TEST_BYPASS_TOKEN: "t-bypass",
  })
  const mod = await import(`../../server/sci-auth.mjs?s=${seq}`)
  await new Promise((r) => mod.server.listen(0, "127.0.0.1", r))
  const base = `http://127.0.0.1:${mod.server.address().port}`
  process.env = prev
  const req = async (p, { method = "GET", body, headers = {} } = {}) => {
    const h = { ...headers }; if (body !== undefined) h["content-type"] = "application/json"
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, json: await r.json().catch(() => null), headers: Object.fromEntries(r.headers) }
  }
  const lo = await req("/admin/api/login", { method: "POST", body: { password: "adminpw" }, headers: { "x-test-bypass": "t-bypass" } })
  const cookie = (lo.headers["set-cookie"] || "").split(";")[0]
  const admin = (p, o = {}) => req(p, { ...o, headers: { ...(o.headers || {}), cookie } })
  await admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 5, model: "tier-model" } })
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "vip", displayName: "王医生", tier: "plus" } })
  return {
    base, req, admin, db: mod.db,
    user: { id: add.json.user.id, username: "vip", pw0: add.json.initialPassword, pw: "Seat!test2026" },
    close: () => new Promise((r) => mod.server.close(r)),
  }
}

async function gateway(cloudUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seatgw-"))
  const env = {
    MANAGE_OC: "0", PORT: "0", AUTH_ENABLED: "",
    OC_URL: "http://127.0.0.1:1",
    ALLOW_PRIVATE_MODEL_URL: "1",                     // 席位地址是 127.0.0.1 的假上游，默认会被 SSRF 护栏拒
    SCI_CLOUD_URL: cloudUrl,
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    API_PROFILES_PATH: path.join(dir, "api-profiles.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
    OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
  }
  const prev = { ...process.env }
  Object.assign(process.env, env)
  const mod = await import(`../server.mjs?seat=${++seq}`)
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来（10 秒内没绑上端口）")
  process.env = prev
  Object.assign(process.env, env)   // 运行时按调用现读这些变量（cloud-account / 路径），要留着
  const base = `http://127.0.0.1:${port}`
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) } catch { return null } }
  return {
    base, dir,
    close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())),
    cfg: () => readJson("model-config.json"),
    profs: () => readJson("api-profiles.json") || [],
    oc: () => readJson("opencode.json"),
    async req(p, { method = "GET", body } = {}) {
      const r = await fetch(base + p, {
        method, headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await r.text()
      let js = null; try { js = JSON.parse(text) } catch {}
      return { status: r.status, json: js, text }
    },
  }
}

async function rig() {
  const up = await fakeUpstream()
  const be = await cloudBackend(up.url)
  const gw = await gateway(be.base)
  // 登录 + 改密 → cloud 路由
  await gw.req("/api/cloud/login", { method: "POST", body: { username: be.user.username, password: be.user.pw0 } })
  const x = await gw.req("/api/cloud/password", { method: "POST", body: { oldPassword: be.user.pw0, newPassword: be.user.pw } })
  assert.equal(x.json.route, "cloud")
  return { up, be, gw, close: async () => { await gw.close(); await be.close(); await up.close() } }
}
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 60)) } return false }

test("分配 → 对账拿凭证 → 直连；切回云端不再被推回；「使用」切回；换 key 原地更新；收回 → 清掉并回云端", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const seatURL = r.up.url + "/coding/v3"
  const seat = (await r.be.admin("/admin/api/seat", { method: "POST", body: { name: "火山 #1", baseURL: seatURL, apiKey: "sk-seat-0001", models: "seat-a\nseat-b" } })).json.id
  await r.be.admin("/admin/api/seat-assign", { method: "POST", body: { seatId: seat, userId: r.be.user.id } })

  // 用户手点「刷新」→ 立刻对账
  let x = await r.gw.req("/api/cloud/refresh", { method: "POST" })
  assert.equal(x.json.ok, true, x.text)
  assert.equal(x.json.seatChange, "assigned")
  assert.equal(x.json.route, "seat")
  assert.equal(x.json.seat.active, true)
  assert.equal(x.json.seat.name, "火山 #1")
  // opencode 指向席位地址、贴席位 key，模型全注册
  let oc = r.gw.oc().provider.custom
  assert.equal(oc.options.baseURL, seatURL)
  assert.equal(oc.options.apiKey, "sk-seat-0001")
  assert.deepEqual(Object.keys(oc.models), ["seat-a", "seat-b"])
  let cfg = r.gw.cfg()
  assert.equal(cfg.route, "seat"); assert.equal(cfg.seatId, seat); assert.equal(cfg.modelID, "seat-a")
  // 凭证档：一条席位记录，带 seat 标记与 applied
  let ps = r.gw.profs()
  assert.equal(ps.length, 1); assert.equal(ps[0].seat.id, seat); assert.equal(ps[0].seat.applied, true); assert.equal(ps[0].apiKey, "sk-seat-0001")
  // 前端看到的：/api/model 与 /api/models（key 不回显）
  let m = (await r.gw.req("/api/model")).json
  assert.equal(m.route, "seat"); assert.equal(m.seat.active, true); assert.deepEqual(m.customModels, ["seat-a", "seat-b"])
  assert.equal(m.profiles.length, 1); assert.equal(m.profiles[0].seat.id, seat); assert.ok(!JSON.stringify(m).includes("sk-seat-0001"))
  const ml = (await r.gw.req("/api/models")).json
  assert.equal(ml.route, "seat"); assert.deepEqual(ml.models.map((z) => z.model), ["seat-a", "seat-b"]); assert.match(ml.models[0].provider, /席位 火山 #1/)
  // 一次性提示：只出一次
  let q = (await r.gw.req("/api/quota?fresh=1")).json
  assert.equal(q.seatEvent.kind, "assigned"); assert.equal(q.seat.active, true)
  q = (await r.gw.req("/api/quota?fresh=1")).json
  assert.equal(q.seatEvent, undefined)
  // 网关额度已压到 free 一半（plus 5 → free 0.3 的一半 = 0.15 = 15 积分）
  assert.equal(q.cloud.daily.limit, 15)
  // 席位路由下切模型：沿用席位凭证，route 仍是 seat
  x = await r.gw.req("/api/model/pick", { method: "POST", body: { model: "seat-b" } })
  assert.equal(x.json.ok, true, x.text); assert.equal(r.gw.cfg().route, "seat"); assert.equal(r.gw.cfg().modelID, "seat-b")
  assert.equal((await r.gw.req("/api/model/pick", { method: "POST", body: { model: "nope" } })).status, 400)
  // 席位凭证不能删
  x = await r.gw.req("/api/model/profiles/delete", { method: "POST", body: { id: ps[0].id } })
  assert.equal(x.status, 400); assert.equal(r.gw.profs().length, 1)

  // 用户「切回云端」：路由回 cloud、凭证还在；再对账不推回
  x = await r.gw.req("/api/model/reset", { method: "POST" })
  assert.equal(x.json.route, "cloud")
  assert.match(r.gw.oc().provider.custom.options.baseURL, /\/cloud\/v1$/)
  assert.equal(r.gw.profs().length, 1)
  x = await r.gw.req("/api/cloud/refresh", { method: "POST" })
  assert.equal(x.json.seatChange, "none"); assert.equal(x.json.route, "cloud"); assert.equal(x.json.seat.active, false)
  q = (await r.gw.req("/api/quota?fresh=1")).json
  assert.equal(q.seatEvent, undefined, "尊重用户的切回，不该再弹提示")
  // 解锁重登（同账号）也不动他的选择
  x = await r.gw.req("/api/cloud/login", { method: "POST", body: { username: "vip", password: r.be.user.pw } })
  assert.equal(x.json.route, "cloud")

  // 「使用」这套席位凭证 → 回到 seat 路由
  x = await r.gw.req("/api/model/profiles/use", { method: "POST", body: { id: ps[0].id, model: "seat-b" } })
  assert.equal(x.json.ok, true, x.text); assert.equal(r.gw.cfg().route, "seat"); assert.equal(r.gw.cfg().modelID, "seat-b")
  // 正跑在席位上时解锁重登：路由保持 seat（不被挪回网关）
  x = await r.gw.req("/api/cloud/login", { method: "POST", body: { username: "vip", password: r.be.user.pw } })
  assert.equal(x.json.route, "seat", "解锁不该把席位用户挪回网关")
  assert.equal(r.gw.oc().provider.custom.options.baseURL, seatURL)

  // 管理员换 key → rev 变 → 对账原地更新，路由不变、用户选的模型保住
  await r.be.admin("/admin/api/seat", { method: "POST", body: { id: seat, apiKey: "sk-seat-0002" } })
  x = await r.gw.req("/api/cloud/refresh", { method: "POST" })
  assert.equal(x.json.seatChange, "updated"); assert.equal(x.json.route, "seat")
  assert.equal(r.gw.oc().provider.custom.options.apiKey, "sk-seat-0002")
  assert.equal(r.gw.cfg().modelID, "seat-b")
  assert.equal(r.gw.profs()[0].apiKey, "sk-seat-0002")
  assert.equal((await r.gw.req("/api/quota?fresh=1")).json.seatEvent.kind, "updated")

  // 管理员收回：靠 /api/quota 那条轮询自己发现（不用手点刷新）→ 凭证删掉、路由回云端
  await r.be.admin("/admin/api/seat-assign", { method: "POST", body: { seatId: seat, release: true } })
  await r.gw.req("/api/quota?fresh=1")
  assert.ok(await until(() => r.gw.cfg()?.route === "cloud"), "轮询应当发现席位被收回并切回云端")
  assert.equal(r.gw.profs().length, 0, "收回后本机不该再留席位凭证")
  assert.match(r.gw.oc().provider.custom.options.baseURL, /\/cloud\/v1$/)
  q = (await r.gw.req("/api/quota?fresh=1")).json
  assert.equal(q.seatEvent.kind, "revoked"); assert.equal(q.seat, null)
  assert.equal(q.cloud.daily.limit, 500, "额度恢复成 plus 档（5 美元 = 500 积分）")
})

test("轮询发现新分配 → 自动直连；席位凭证不占用户自己的 3 格、不会被挤掉；登出清掉席位凭证", async (t) => {
  const r = await rig(); t.after(() => r.close())
  // 先存满用户自己的 3 套
  for (const n of [1, 2, 3]) {
    const x = await r.gw.req("/api/model", { method: "POST", body: { baseURL: `http://127.0.0.1:9/v${n}`, apiKey: "sk-own-" + n, models: "m", remember: true, name: "own" + n } })
    assert.equal(x.json.ok, true, x.text)
  }
  await r.gw.req("/api/model/reset", { method: "POST" })
  assert.equal(r.gw.profs().length, 3)

  const seat = (await r.be.admin("/admin/api/seat", { method: "POST", body: { name: "S", baseURL: r.up.url + "/v1", apiKey: "sk-seat", models: "seat-a" } })).json.id
  await r.be.admin("/admin/api/seat-assign", { method: "POST", body: { seatId: seat, userId: r.be.user.id } })
  // 不点刷新，只靠额度轮询
  await r.gw.req("/api/quota?fresh=1")
  assert.ok(await until(() => r.gw.cfg()?.route === "seat"), "轮询应当发现新席位并切成直连")
  let ps = r.gw.profs()
  assert.equal(ps.length, 4, "席位那套不占 3 格")
  assert.equal(ps.filter((p) => p.seat).length, 1)
  // 再存一套自己的：挤掉的是自己的最旧那套，席位不动
  const x = await r.gw.req("/api/model", { method: "POST", body: { baseURL: "http://127.0.0.1:9/v4", apiKey: "sk-own-4", models: "m", remember: true, name: "own4" } })
  assert.equal(x.json.dropped, "own1")
  ps = r.gw.profs()
  assert.equal(ps.length, 4); assert.equal(ps.filter((p) => p.seat).length, 1)
  assert.deepEqual(ps.filter((p) => !p.seat).map((p) => p.name).sort(), ["own2", "own3", "own4"])
  // 存自己的凭证把路由切成了 custom；席位还在列表里可"使用"
  assert.equal(r.gw.cfg().route, "custom")
  const m = (await r.gw.req("/api/model")).json
  assert.equal(m.seat.active, false); assert.equal(m.seat.id, seat)

  // 登出：席位凭证跟账号走，自己的留着
  await r.gw.req("/api/cloud/logout", { method: "POST" })
  ps = r.gw.profs()
  assert.equal(ps.filter((p) => p.seat).length, 0)
  assert.equal(ps.length, 3)
})
