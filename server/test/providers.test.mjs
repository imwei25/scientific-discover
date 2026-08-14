// 模型供应商与模型目录：后台加供应商/模型 → 档位开放 → 客户端拿到清单 → 网关按模型选家、
// 按该模型单价计费、前一家挂了自动落到下一家。
//
// 这一层的要害是【钱】和【可用性】：模型名与单价必须一一对上（否则账静默偏），
// 停用/删除必须立刻不出流量，故障切换不能把同一单记两次账。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { startApp, adminLogin, asAdmin, startFakeUpstream } from "./helper.mjs"
import * as DB from "../lib/db.mjs"
import { pickModel, buildAttempts } from "../lib/gateway.mjs"

const STRONG = "Aa1!aaaa9"
const CHAT = "/llm/v1/chat/completions"

/** 起 app + 一个改完密的账号；再按需挂供应商/模型 */
async function rig({ upstream, env = {}, tier } = {}) {
  const up = await startFakeUpstream(upstream || ((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ model: "env-model", usage: { prompt_tokens: 0, completion_tokens: 0 } }))
  }))
  const app = await startApp({ LLM_UPSTREAM_URL: up.url, ...env })
  const admin = asAdmin(app, await adminLogin(app))
  if (tier) await admin("/admin/api/tier", { method: "POST", body: tier })
  const add = await admin("/admin/api/user-add", {
    method: "POST", body: { username: "zhangsan", displayName: "张三", tier: tier ? tier.key : "free" },
  })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: STRONG },
  })
  const uid = add.json.user.id
  return {
    up, app, admin, uid, access: chg.json.access,
    call: (body, headers = {}) => app.req(CHAT, { method: "POST", body, headers: { authorization: "Bearer " + chg.json.access, ...headers } }),
    me: () => app.req("/api/me", { headers: { authorization: "Bearer " + chg.json.access } }),
    rows: () => app.db.prepare("SELECT * FROM usage_log WHERE user_id=? ORDER BY id").all(uid),
    async close() { await app.close(); await up.close() },
  }
}

/** 记下上游收到了什么 */
function recorder(respond) {
  const seen = []
  const h = (req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch {}
      seen.push({ url: req.url, headers: req.headers, body })
      respond(req, res, body)
    })
  }
  h.seen = seen
  return h
}

// ---- 纯函数 ----

test("pickModel：清单内的照办，清单外的一律打回默认模型", () => {
  const ent = { model: "std", models: ["std", "pro"] }
  assert.deepEqual(pickModel("pro", ent), { model: "pro", coerced: false })
  assert.deepEqual(pickModel("std", ent), { model: "std", coerced: false })
  assert.deepEqual(pickModel("gpt-9", ent), { model: "std", coerced: true })
  assert.deepEqual(pickModel("", ent), { model: "std", coerced: false }, "没点名 = 用默认，不算被打回")
  // 档位没开放切换（models 只有默认那个）时，点别的一样被打回
  assert.deepEqual(pickModel("pro", { model: "std", models: ["std"] }), { model: "std", coerced: true })
})

test("buildAttempts：目录里有就按目录（多家=按序兜底），没有才回落 env 上游", () => {
  const CFG = { upstreamUrl: "http://env", upstreamKey: "k", priceIn: 1, priceOut: 2, priceCached: 3 }
  const legacy = buildAttempts("m", [], CFG)
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].baseUrl, "http://env")
  assert.deepEqual(legacy[0].price, { priceIn: 1, priceOut: 2, priceCached: 3 })
  assert.equal(legacy[0].upstreamModel, "m")

  const routes = [
    { model: "m", provider: "a", base_url: "http://a", api_key: "ka", upstream: "", price_in: 0.1, price_out: 0.2, price_cached: 0.05 },
    { model: "m", provider: "b", base_url: "http://b", api_key: "kb", upstream: "b-real", price_in: 9, price_out: 9, price_cached: 9 },
  ]
  const at = buildAttempts("m", routes, CFG)
  assert.equal(at.length, 2)
  assert.equal(at[0].upstreamModel, "m", "没填上游名 = 同名")
  assert.equal(at[1].upstreamModel, "b-real", "填了就用这家自己的名字")
  assert.deepEqual(at[1].price, { priceIn: 9, priceOut: 9, priceCached: 9 }, "单价按行独立，不是全局一张表")
})

// ---- 迁移 ----

test("老库（v1）升上来：补列不丢数据，且默认不开放任何模型切换", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sci-mig-"))
  const file = path.join(dir, "old.db")
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  // 手搓一个 v1 形状的库：tiers 没有 models 列、usage_log 没有 provider 列
  {
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE tiers (key TEXT PRIMARY KEY, daily_usd REAL NOT NULL DEFAULT 0, monthly_usd REAL NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '', skills TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ts INTEGER NOT NULL,
        day TEXT NOT NULL, month TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', skill TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0);
      INSERT INTO meta(k,v) VALUES('schema_version','1');
      INSERT INTO tiers(key,daily_usd,model,skills,note) VALUES('plus',1.5,'deepseek-v4-pro','','专业版');
      INSERT INTO usage_log(user_id,ts,day,month,model,cost_usd) VALUES(1,1,'2026-07-01','2026-07','deepseek-v4-pro',0.5);
    `)
    old.close()
  }
  const db = DB.openDb(file)
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, String(DB.SCHEMA_VERSION))
  const t1 = DB.getTier(db, "plus")
  assert.equal(t1.model, "deepseek-v4-pro", "老档位内容不能丢")
  assert.equal(t1.models, "", "升级后默认不开放切换，行为与升级前一致")
  assert.equal(db.prepare("SELECT provider FROM usage_log WHERE id=1").get().provider, "", "老账目补列后为空")
  // 允许清单只含默认模型 —— 用户不会因为一次升级就突然多出模型可选
  const ent = DB.resolveEntitlement(db, { tier: "plus", daily_override: null, monthly_override: null, skills_override: null })
  assert.deepEqual(ent.models, ["deepseek-v4-pro"])
  db.close()
})

// ---- 后台 ----

test("后台：加供应商→接入模型→勾进档位，客户端 /api/me 立刻拿到清单（不用重新登录）", async (t) => {
  const r = await rig({ tier: { key: "plus", dailyUSD: 0, model: "std" } }); t.after(() => r.close())

  // 一开始只有默认模型
  let me = await r.me()
  assert.deepEqual(me.json.profile.models.map((m) => m.model), ["std"])

  let x = await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", name: "硅基流动", baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-sf" } })
  assert.equal(x.json.ok, true)
  x = await r.admin("/admin/api/model", { method: "POST", body: { items: [{ model: "fast", provider: "sf", label: "快模型", priceIn: 0.1, priceOut: 0.2, priceCached: 0.05 }] } })
  assert.equal(x.json.ok, true)
  // 只是接入目录还不够，得勾进档位的允许清单
  me = await r.me()
  assert.deepEqual(me.json.profile.models.map((m) => m.model), ["std"], "没勾进档位就不该对用户可见")

  await r.admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 0, model: "std", models: "fast" } })
  me = await r.me()
  assert.deepEqual(me.json.profile.models.map((m) => m.model), ["std", "fast"])
  const fast = me.json.profile.models.find((m) => m.model === "fast")
  assert.equal(fast.label, "快模型")
  assert.equal(fast.providerName, "硅基流动")
  assert.deepEqual(fast.price, { input: 0.1, output: 0.2, cached: 0.05 })
  // ★ 这一条就是"打包版不用重装也能用上新模型"的依据：同一把 access key，没重新登录
})

test("后台：不回显 API Key；编辑时留空 = 不改", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", name: "硅基", baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-secret" } })
  const list = await r.admin("/admin/api/providers")
  assert.equal(JSON.stringify(list.json).includes("sk-secret"), false, "后台响应里绝不能出现上游 key")
  assert.equal(list.json.providers[0].hasKey, true)

  // 只改名字、key 字段留空
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", name: "硅基流动", baseURL: "http://127.0.0.1:9/v1" } })
  assert.equal(DB.getProvider(r.app.db, "sf").api_key, "sk-secret", "留空不该把 key 洗掉")
  assert.equal(DB.getProvider(r.app.db, "sf").name, "硅基流动")
})

test("后台：删供应商连带删它的模型，并报出影响面", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", baseURL: "http://127.0.0.1:9/v1", apiKey: "k" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [{ model: "a", provider: "sf" }, { model: "b", provider: "sf" }] } })
  const x = await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", remove: true } })
  assert.equal(x.json.removedModels, 2)
  assert.equal(DB.listModels(r.app.db).length, 0)
})

test("后台：供应商键与地址要校验，新建必须给 key", async (t) => {
  const r = await rig(); t.after(() => r.close())
  assert.equal((await r.admin("/admin/api/provider", { method: "POST", body: { key: "Bad Key", baseURL: "http://x", apiKey: "k" } })).status, 400)
  assert.equal((await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", baseURL: "127.0.0.1:9", apiKey: "k" } })).status, 400, "地址要带协议头")
  assert.equal((await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", baseURL: "http://127.0.0.1:9" } })).status, 400, "新建不给 key 要拒")
})

// ---- 网关：选家、改名、计价 ----

test("网关：客户端点名允许的模型 → 打给那家、用它的真实模型名、按它的单价记账", async (t) => {
  const h = recorder((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ model: "sf-real", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }))
  })
  const r = await rig({ upstream: h, tier: { key: "plus", dailyUSD: 0, model: "std" } })
  t.after(() => r.close())
  // 把假上游当成一家供应商接进来（地址就用假上游）
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", name: "硅基流动", baseURL: r.up.url + "/v1", apiKey: "sk-sf" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [{ model: "fast", provider: "sf", upstream: "sf-real", priceIn: 3, priceOut: 0, priceCached: 0 }] } })
  await r.admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 0, model: "std", models: "fast" } })

  const x = await r.call({ model: "fast", messages: [] })
  assert.equal(x.status, 200)
  assert.equal(h.seen.at(-1).body.model, "sf-real", "转给上游时换成这家自己的模型名")
  assert.equal(h.seen.at(-1).headers.authorization, "Bearer sk-sf", "用这家的 key，不是 env 那把")

  const row = r.rows().at(-1)
  assert.equal(row.model, "fast", "记的是对外模型名")
  assert.equal(row.provider, "sf", "同时记下实际服务的那家")
  assert.equal(Math.abs(row.cost_usd - 3) < 1e-9, true, "按这一行的单价算：100万输入 × $3/百万 = $3，不是 env 的全局价")
})

test("网关：点名档位没开放的模型 → 静默打回默认模型（老客户端不能被打死）", async (t) => {
  const h = recorder((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 } }))
  })
  const r = await rig({ upstream: h, tier: { key: "plus", dailyUSD: 0, model: "std" } })
  t.after(() => r.close())
  const x = await r.call({ model: "偷偷换个贵的", messages: [] })
  assert.equal(x.status, 200)
  assert.equal(h.seen.at(-1).body.model, "std")
  assert.equal(r.rows().at(-1).model, "std")
})

test("网关：模型或供应商一停用，立刻不再对用户提供（清单里也没有）", async (t) => {
  const r = await rig({ tier: { key: "plus", dailyUSD: 0, model: "std" } }); t.after(() => r.close())
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", baseURL: r.up.url + "/v1", apiKey: "k" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [{ model: "fast", provider: "sf" }] } })
  await r.admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 0, model: "std", models: "fast" } })
  assert.equal((await r.me()).json.profile.models.length, 2)

  // 停用供应商
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", baseURL: r.up.url + "/v1", status: "disabled" } })
  assert.deepEqual((await r.me()).json.profile.models.map((m) => m.model), ["std"], "停用后不该还挂在用户清单里")

  // 恢复供应商、改停模型本身，效果一样
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", baseURL: r.up.url + "/v1", status: "active" } })
  const m = DB.listModels(r.app.db)[0]
  await r.admin("/admin/api/model", { method: "POST", body: { id: m.id, model: "fast", provider: "sf", status: "disabled" } })
  assert.deepEqual((await r.me()).json.profile.models.map((m2) => m2.model), ["std"])
})

// ---- 故障切换 ----

test("网关：第一家 5xx → 自动落到第二家，客户端无感，且只记一次账", async (t) => {
  const bad = await startFakeUpstream((_q, res) => { res.writeHead(503); res.end("boom") })
  const good = recorder((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ model: "b-real", usage: { prompt_tokens: 1000, completion_tokens: 0 } }))
  })
  const r = await rig({ upstream: good, tier: { key: "plus", dailyUSD: 0, model: "std" } })
  t.after(async () => { await r.close(); await bad.close() })

  await r.admin("/admin/api/provider", { method: "POST", body: { key: "a", name: "主", baseURL: bad.url + "/v1", apiKey: "ka" } })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "b", name: "备", baseURL: r.up.url + "/v1", apiKey: "kb" } })
  // 同一个对外模型名两行：sort 小的先上
  await r.admin("/admin/api/model", { method: "POST", body: { items: [
    { model: "std", provider: "a", sort: 0, priceIn: 1, priceOut: 0, priceCached: 0 },
    { model: "std", provider: "b", sort: 1, upstream: "b-real", priceIn: 2, priceOut: 0, priceCached: 0 },
  ] } })

  const x = await r.call({ model: "std", messages: [] })
  assert.equal(x.status, 200, "主挂了也该拿到正常响应")
  assert.equal(good.seen.length, 1, "备用家确实收到了这一单")
  assert.equal(good.seen[0].body.model, "b-real")
  const rows = r.rows()
  assert.equal(rows.length, 1, "一单只能记一次账")
  assert.equal(rows[0].provider, "b", "记在真正服务的那家头上")
  assert.equal(Math.abs(rows[0].cost_usd - 0.002) < 1e-9, true, "按备用家的单价算：0.001M × $2 = $0.002")
})

test("网关：主供应商余额耗尽（402）→ 切备用，而不是把 402 甩给用户", async (t) => {
  // 2026-07-29 真实事故：DeepSeek 余额耗尽回 402，当时只对 5xx 切家 → 备用一次没被用上，
  // 而前端把空响应渲染成空气泡，用户完全不知道发生了什么。这条钉住"402 必须切家"。
  const broke = await startFakeUpstream((_q, res) => {
    res.writeHead(402, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "Insufficient Balance" } }))
  })
  const good = recorder((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  const r = await rig({ upstream: good, tier: { key: "plus", dailyUSD: 0, model: "std" } })
  t.after(async () => { await r.close(); await broke.close() })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "poor", name: "余额耗尽的那家", baseURL: broke.url + "/v1", apiKey: "k1" } })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "rich", name: "备用", baseURL: r.up.url + "/v1", apiKey: "k2" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [
    { model: "std", provider: "poor", sort: 0 }, { model: "std", provider: "rich", sort: 1 },
  ] } })

  const x = await r.call({ model: "std", messages: [] })
  assert.equal(x.status, 200, "余额耗尽应当自动落到备用家，而不是把 402 透给客户端")
  assert.equal(good.seen.length, 1)
  assert.equal(r.rows().at(-1).provider, "rich")
})

test("后台：整家批改优先级 —— 一次点击就把主备换过来（供应商的 sort 不参与路由）", async (t) => {
  // 2026-08-12 线上踩的：管理员改了【供应商】那个 sort，以为主备换了，实际路由只看
  // models.sort，一动没动 —— 于是每一单都还先撞额度耗尽的那家。这条同时钉住两件事：
  // ① 供应商 sort 改了不影响出流量；② priority 接口把这家名下【所有】模型行一起改掉。
  const a = recorder((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  const b = await startFakeUpstream((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  const r = await rig({ upstream: a, tier: { key: "plus", dailyUSD: 0, model: "std" } })
  t.after(async () => { await r.close(); await b.close() })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "a", baseURL: r.up.url + "/v1", apiKey: "ka", sort: 0 } })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "b", baseURL: b.url + "/v1", apiKey: "kb", sort: 9 } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [
    { model: "std", provider: "a", sort: 0 }, { model: "x2", provider: "a", sort: 0 },
    { model: "std", provider: "b", sort: 1 }, { model: "x2", provider: "b", sort: 1 },
  ] } })

  await r.call({ model: "std", messages: [] })
  assert.equal(r.rows().at(-1).provider, "a", "优先级 0 的 a 先出流量")

  // 只改供应商的 sort：路由必须【纹丝不动】
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "b", baseURL: b.url + "/v1", sort: -1 } })
  await r.call({ model: "std", messages: [] })
  assert.equal(r.rows().at(-1).provider, "a", "供应商 sort 只排后台显示顺序，不该影响出流量")

  // 整家批改：a 名下两个模型行一起降为备用
  const x = await r.admin("/admin/api/provider", { method: "POST", body: { key: "a", action: "priority", sort: 5 } })
  assert.equal(x.status, 200)
  assert.equal(x.json.updated, 2, "这家名下两行都要改到，改漏一行就是主备只换了一半")
  await r.call({ model: "std", messages: [] })
  assert.equal(r.rows().at(-1).provider, "b", "批改后主备真的换了")
  const seenBefore = a.seen.length
  await r.call({ model: "x2", messages: [] })
  assert.equal(a.seen.length, seenBefore, "同一家的另一个模型也跟着换了，没有漏行")

  // 越界与非整数要挡住，别把路由写成 NaN
  for (const bad of [-1, 1000, 1.5, "abc"])
    assert.equal((await r.admin("/admin/api/provider", { method: "POST", body: { key: "a", action: "priority", sort: bad } })).status,
      400, `优先级 ${bad} 应当被拒`)
  assert.equal((await r.admin("/admin/api/provider", { method: "POST", body: { key: "nope", action: "priority", sort: 0 } })).status, 404)
})

test("网关：请求本身的问题（400/404）不切家，原样透传给客户端诊断", async (t) => {
  const bad = await startFakeUpstream((_q, res) => {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "model not found" } }))
  })
  const other = recorder((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}") })
  const r = await rig({ upstream: other, tier: { key: "plus", dailyUSD: 0, model: "std" } })
  t.after(async () => { await r.close(); await bad.close() })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "a", baseURL: bad.url + "/v1", apiKey: "k" } })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "b", baseURL: r.up.url + "/v1", apiKey: "k" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [
    { model: "std", provider: "a", sort: 0 }, { model: "std", provider: "b", sort: 1 },
  ] } })
  const x = await r.call({ model: "std", messages: [] })
  assert.equal(x.status, 404, "模型名不对这种事换谁都一样，别偷偷绕过去")
  assert.equal(other.seen.length, 0, "不该去打第二家")
})

test("网关：连不上第一家（端口没人听）也切下一家", async (t) => {
  const good = recorder((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  const r = await rig({ upstream: good, tier: { key: "plus", dailyUSD: 0, model: "std" } })
  t.after(() => r.close())
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "dead", baseURL: "http://127.0.0.1:1/v1", apiKey: "k" } })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "ok", baseURL: r.up.url + "/v1", apiKey: "k2" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [
    { model: "std", provider: "dead", sort: 0 }, { model: "std", provider: "ok", sort: 1 },
  ] } })
  const x = await r.call({ model: "std", messages: [] })
  assert.equal(x.status, 200, "体=" + x.text)
  assert.equal(good.seen.length, 1)
})

test("网关：所有家都挂 → 502，且不记账", async (t) => {
  const r = await rig({ tier: { key: "plus", dailyUSD: 0, model: "std" } }); t.after(() => r.close())
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "d1", baseURL: "http://127.0.0.1:1/v1", apiKey: "k" } })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "d2", baseURL: "http://127.0.0.1:2/v1", apiKey: "k" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [
    { model: "std", provider: "d1", sort: 0 }, { model: "std", provider: "d2", sort: 1 },
  ] } })
  const x = await r.call({ model: "std", messages: [] })
  assert.equal(x.status, 502)
  assert.equal(x.json.error.code, "UPSTREAM_UNAVAILABLE")
  assert.equal(r.rows().length, 0)
})

test("网关：目录里没有这个模型名 → 照旧走 env 上游（老部署一字不改也能跑）", async (t) => {
  const h = recorder((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }))
  })
  const r = await rig({ upstream: h, tier: { key: "plus", dailyUSD: 0, model: "env-only" }, env: { COST_INPUT: "0.5" } })
  t.after(() => r.close())
  // 目录里只有别的模型，env-only 查不到 → 回落
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "sf", baseURL: "http://127.0.0.1:9/v1", apiKey: "k" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [{ model: "other", provider: "sf" }] } })

  const x = await r.call({ model: "env-only", messages: [] })
  assert.equal(x.status, 200)
  assert.equal(h.seen.at(-1).headers.authorization, "Bearer upstream-key", "用的是 env 里的上游 key")
  const row = r.rows().at(-1)
  assert.equal(row.provider, "", "env 兜底记作空供应商")
  assert.equal(Math.abs(row.cost_usd - 0.5) < 1e-9, true, "用全局 COST_*")
})
