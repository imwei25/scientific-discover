// M2 网关层测试：转发、强制模型、注入 include_usage、按 usage 计量入账、额度闸、技能闸。
//
// 全程用一个假上游（本机 http server），不打真实模型；断言里既看客户端拿到什么，
// 也看上游【实际收到】什么 —— 计量和管控的正确性一半在"我们改写了请求"这件事上。
import test from "node:test"
import assert from "node:assert/strict"
import { startApp, adminLogin, asAdmin, startFakeUpstream, sse } from "./helper.mjs"
import { normalizeUsage, costOf, joinUpstream } from "../lib/gateway.mjs"

const STRONG = "Aa1!aaaa9"
const CHAT = "/llm/v1/chat/completions"

/** 起假上游 + app + 一个改完密的可用账号 */
async function rig({ upstream, env = {}, tier } = {}) {
  const up = await startFakeUpstream(upstream || ((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "x", model: "m", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }))
  }))
  const app = await startApp({ LLM_UPSTREAM_URL: up.url, ...env })
  const cookie = await adminLogin(app)
  const admin = asAdmin(app, cookie)
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
  const call = (body, headers = {}) => app.req(CHAT, {
    method: "POST", body, headers: { authorization: "Bearer " + chg.json.access, ...headers },
  })
  return {
    up, app, admin, uid, access: chg.json.access, call,
    async close() { await app.close(); await up.close() },
    cost: () => app.db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS c FROM usage_log WHERE user_id=?").get(uid).c,
    rows: () => app.db.prepare("SELECT * FROM usage_log WHERE user_id=? ORDER BY id").all(uid),
  }
}

/** 收集上游收到的请求（体 + 头） */
function recorder(respond) {
  const seen = []
  const h = (req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch {}
      seen.push({ url: req.url, method: req.method, headers: req.headers, body })
      respond(req, res, body)
    })
  }
  h.seen = seen
  return h
}

// ---- 纯函数 ----
test("normalizeUsage：兼容 DeepSeek / OpenAI 两种字段名", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 3, prompt_cache_hit_tokens: 4 }), { prompt: 10, completion: 3, cached: 4 })
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 6 } }), { prompt: 10, completion: 3, cached: 6 })
  assert.deepEqual(normalizeUsage({ prompt_tokens: 5, completion_tokens: 1 }), { prompt: 5, completion: 1, cached: 0 })
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage("x"), null)
})

test("normalizeUsage：缓存数不合理时钳制，别让计费变成负的", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 0, prompt_cache_hit_tokens: 99 }), { prompt: 10, completion: 0, cached: 10 })
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 0, prompt_cache_hit_tokens: -5 }), { prompt: 10, completion: 0, cached: 0 })
})

test("joinUpstream：客户端 /llm 与 /llm/v1 两种写法都要能用，且不出现 /v1/v1", () => {
  // 接 one-api（上游带 /v1）
  assert.equal(joinUpstream("http://127.0.0.1:3010/v1", "/v1/chat/completions"), "http://127.0.0.1:3010/v1/chat/completions")
  assert.equal(joinUpstream("http://127.0.0.1:3010/v1", "/chat/completions"), "http://127.0.0.1:3010/v1/chat/completions")
  assert.equal(joinUpstream("http://127.0.0.1:3010/v1/", "/v1/models"), "http://127.0.0.1:3010/v1/models")
  // 直连 DeepSeek（上游不带 /v1）
  assert.equal(joinUpstream("https://api.deepseek.com", "/v1/chat/completions"), "https://api.deepseek.com/v1/chat/completions")
  // 只吃掉【开头那一段】/v1，路径里别处的 v1 不能动
  assert.equal(joinUpstream("http://x/v1", "/v1/foo/v1/bar"), "http://x/v1/foo/v1/bar")
  assert.equal(joinUpstream("http://x/apiv1", "/v1/chat"), "http://x/apiv1/v1/chat", "只有真的以 /v1 结尾才算")
})

test("costOf：新鲜输入/缓存输入/输出 三段单价", () => {
  const cfg = { priceIn: 0.27, priceOut: 1.10, priceCached: 0.07 }
  // fresh=600*0.27 + cached=400*0.07 + out=500*1.10 = 162+28+550 = 740 / 1e6
  assert.equal(costOf({ prompt: 1000, cached: 400, completion: 500 }, cfg), 740 / 1e6)
  assert.equal(costOf(null, cfg), 0)
})

// ---- 鉴权闸 ----
test("网关：没 key / 停用 / 未改密 一律挡在门外", async (t) => {
  const r = await rig(); t.after(() => r.close())
  let x = await r.app.req(CHAT, { method: "POST", body: {} })
  assert.equal(x.status, 401)
  assert.equal(x.json.error.code, "KEY_MISSING")

  await r.admin("/admin/api/suspend", { method: "POST", body: { id: r.uid, suspended: true } })
  x = await r.call({ model: "m" })
  assert.equal(x.status, 403)
  assert.equal(x.json.error.code, "ACCOUNT_SUSPENDED")
  await r.admin("/admin/api/suspend", { method: "POST", body: { id: r.uid, suspended: false } })

  // 新建一个没改密的号：pwchange 票据不许调模型
  const add = await r.admin("/admin/api/user-add", { method: "POST", body: { username: "lisi", displayName: "李四" } })
  const li = await r.app.req("/api/auth/login", { method: "POST", body: { username: "lisi", password: add.json.initialPassword } })
  x = await r.app.req(CHAT, { method: "POST", body: {}, headers: { authorization: "Bearer " + li.json.access } })
  assert.equal(x.json.error.code, "PASSWORD_CHANGE_REQUIRED")
  assert.equal(r.up.srv.listening, true)
})

test("网关：没配上游 key → 503，且一个字节都不发给上游", async (t) => {
  const rec = recorder((_q, res) => res.end("{}"))
  const r = await rig({ upstream: rec, env: { LLM_UPSTREAM_KEY: "" } }); t.after(() => r.close())
  const x = await r.call({ model: "m" })
  assert.equal(x.status, 503)
  assert.equal(x.json.error.code, "UPSTREAM_UNCONFIGURED")
  assert.equal(rec.seen.length, 0)
})

// ---- 转发与改写 ----
test("转发：换成真实上游 key；客户端的 X-Skill/版本头不外泄；路径与查询串保留", async (t) => {
  const rec = recorder((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  const r = await rig({ upstream: rec }); t.after(() => r.close())
  await r.app.req(CHAT + "?beta=1", {
    method: "POST",
    body: { model: "whatever", messages: [] },
    headers: { authorization: "Bearer " + r.access, "x-skill": "write-paper", "x-client-version": "9.9.9" },
  })
  const got = rec.seen[0]
  assert.equal(got.url, "/v1/chat/completions?beta=1")
  assert.equal(got.headers.authorization, "Bearer upstream-key", "必须换成上游 key")
  assert.equal(got.headers["x-skill"], undefined, "内部头不该转给上游")
  assert.equal(got.headers["x-client-version"], undefined)
})

test("转发：客户端 access key 绝不出现在给上游的请求里", async (t) => {
  const rec = recorder((_q, res) => res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0 } })))
  const r = await rig({ upstream: rec }); t.after(() => r.close())
  await r.call({ model: "m", messages: [] })
  const dump = JSON.stringify(rec.seen[0])
  assert.equal(dump.includes(r.access), false)
})

test("强制模型：客户端传什么都覆盖成档位规定的模型", async (t) => {
  const rec = recorder((_q, res) => res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0 } })))
  const r = await rig({ upstream: rec, tier: { key: "gold", dailyUSD: 10, model: "model-of-tier" } })
  t.after(() => r.close())
  await r.call({ model: "gpt-please", messages: [{ role: "user", content: "hi" }] })
  assert.equal(rec.seen[0].body.model, "model-of-tier")
  assert.deepEqual(rec.seen[0].body.messages, [{ role: "user", content: "hi" }], "其余字段原样带过去")
})

// 【这是"老库里已经有"的形状，不是后台能建出来的形状】默认模型为空 = 该档用户可以在
// 请求体里随便点模型名（网关会照用），绕过允许清单、按 env 全局价计费。所以 /admin/api/tier
// 现在直接拒绝空默认模型（见下一条测试），这里只保证【已经长成这样的老库】仍然跑得通，
// 于是绕过后台、直接往库里塞一个这样的档位。
test("强制模型：档位没配模型时不动客户端的 model（老库兼容）", async (t) => {
  const rec = recorder((_q, res) => res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0 } })))
  const r = await rig({ upstream: rec, tier: { key: "nomodel", dailyUSD: 10, model: "placeholder" } })
  t.after(() => r.close())
  r.app.db.prepare("UPDATE tiers SET model='' WHERE key='nomodel'").run()
  await r.call({ model: "client-choice" })
  assert.equal(rec.seen[0].body.model, "client-choice")
})

test("档位：后台不许建「默认模型为空」的档位（那等于让该档用户自选任意模型名）", async (t) => {
  const r = await rig({}); t.after(() => r.close())
  const bad = await r.admin("/admin/api/tier", { method: "POST", body: { key: "hole", dailyUSD: 1, model: "" } })
  assert.equal(bad.status, 400)
  assert.match(bad.json.err, /默认模型/)
  assert.equal(r.app.db.prepare("SELECT COUNT(*) AS n FROM tiers WHERE key='hole'").get().n, 0)
})

test("档位：额度必须是 ≥0 的数字（负数/非数字会被 Number()||0 静默变成 0 = 不限）", async (t) => {
  const r = await rig({}); t.after(() => r.close())
  for (const body of [{ dailyUSD: -5 }, { monthlyUSD: -1 }, { dailyUSD: "abc" }, { dailyUSD: "1,000" }]) {
    const bad = await r.admin("/admin/api/tier", { method: "POST", body: { key: "t1", model: "m", ...body } })
    assert.equal(bad.status, 400, JSON.stringify(body))
    assert.match(bad.json.err, /额度/)
  }
  const ok = await r.admin("/admin/api/tier", { method: "POST", body: { key: "t1", model: "m", dailyUSD: 0, monthlyUSD: 2 } })
  assert.equal(ok.status, 200, "0 是合法的（= 不限）")
})

test("流式：自动注入 stream_options.include_usage（不注入就收不到 usage、计量直接失效）", async (t) => {
  const rec = recorder((_q, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(sse([{ choices: [] }, { usage: { prompt_tokens: 2, completion_tokens: 2 } }]))
  })
  const r = await rig({ upstream: rec }); t.after(() => r.close())
  await r.call({ model: "m", stream: true })
  assert.deepEqual(rec.seen[0].body.stream_options, { include_usage: true })

  await r.call({ model: "m", stream: false })
  assert.equal(rec.seen[1].body.stream_options, undefined, "非流式不该塞这个字段")
})

test("流式：已有 stream_options 时合并而不是覆盖", async (t) => {
  const rec = recorder((_q, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(sse([])) })
  const r = await rig({ upstream: rec }); t.after(() => r.close())
  await r.call({ model: "m", stream: true, stream_options: { something: 1 } })
  assert.deepEqual(rec.seen[0].body.stream_options, { something: 1, include_usage: true })
})

// ---- 计量 ----
test("计量：非流式响应按 usage 入账，成本口径与单价一致", async (t) => {
  const r = await rig({
    upstream: (_q, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ model: "m-real", usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 400 } }))
    },
    tier: { key: "big", dailyUSD: 0, model: "m" },   // 0 = 不限，免得被额度闸拦住
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m", messages: [] }, { "x-skill": "write-paper" })
  assert.equal(x.status, 200)
  assert.equal(Math.abs(r.cost() - 740 / 1e6) < 1e-12, true, "cost=" + r.cost())
  const row = r.rows()[0]
  assert.equal(row.prompt_tokens, 1000)
  assert.equal(row.completion_tokens, 500)
  assert.equal(row.cached_tokens, 400)
  // 【记的是对外模型名，不是上游回的那个】加了供应商目录之后，同一个对外名可能被改名转给
  // 某家（models.upstream），上游回的是它自己的名字。账要按用户看得见的模型对得上，
  // 所以 model 一律记对外名；实际服务的那家单独记在 provider 列（这里没建目录 → env 兜底 → ''）。
  assert.equal(row.model, "m", "记对外模型名")
  assert.equal(row.provider, "", "走 env 兜底上游时 provider 为空")
  assert.equal(row.skill, "write-paper")
})

test("计量：流式响应从最后一个 chunk 取 usage，且响应体原样透传给客户端", async (t) => {
  const body = sse([
    { choices: [{ delta: { content: "你好" } }] },
    { choices: [{ delta: { content: "世界" } }] },
    { model: "m-real", usage: { prompt_tokens: 100, completion_tokens: 50 } },
  ])
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(body) },
    tier: { key: "big", dailyUSD: 0, model: "m" },
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m", stream: true })
  assert.equal(x.status, 200)
  assert.equal(x.text, body, "透传必须逐字节一致")
  const expect = (100 * 0.27 + 50 * 1.10) / 1e6
  assert.equal(Math.abs(r.cost() - expect) < 1e-12, true, "cost=" + r.cost())
})

test("计量：多字节汉字被切在两个 chunk 之间也不影响解析（StringDecoder）", async (t) => {
  const body = sse([
    { choices: [{ delta: { content: "统计分析中文标签" } }] },
    { usage: { prompt_tokens: 10, completion_tokens: 10 } },
  ])
  const buf = Buffer.from(body, "utf8")
  const r = await rig({
    upstream: (_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      // 逐 3 字节切：几乎必然把某个 UTF-8 汉字劈成两半
      for (let i = 0; i < buf.length; i += 3) res.write(buf.subarray(i, i + 3))
      res.end()
    },
    tier: { key: "big", dailyUSD: 0, model: "m" },
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m", stream: true })
  assert.equal(x.text, body)
  assert.equal(r.rows().length, 1, "usage 仍要解析出来")
  assert.equal(r.rows()[0].prompt_tokens, 10)
})

test("计量：上游报错（4xx/5xx）不计费，状态码与错误体透传", async (t) => {
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(429, { "content-type": "application/json" }); res.end('{"error":{"message":"upstream busy"}}') },
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m" })
  assert.equal(x.status, 429)
  assert.equal(x.json.error.message, "upstream busy")
  assert.equal(r.rows().length, 0, "上游失败不该记账")
})

test("计量：上游 200 但没给 usage → 不记账（并在日志里可见）", async (t) => {
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"choices":[]}') },
  })
  t.after(() => r.close())
  assert.equal((await r.call({ model: "m" })).status, 200)
  assert.equal(r.rows().length, 0)
})

test("上游连不上 → 502 UPSTREAM_UNAVAILABLE（不是 500，也不该崩进程）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.up.close()                       // 把上游掐掉
  const x = await r.call({ model: "m" })
  assert.equal(x.status, 502)
  assert.equal(x.json.error.code, "UPSTREAM_UNAVAILABLE")
  assert.equal((await r.app.req("/healthz")).status, 200, "进程要还活着")
})

// ---- 额度闸 ----
test("额度：日额度用尽 → 429 QUOTA_EXCEEDED，且不再打上游", async (t) => {
  const rec = recorder((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } }))  // 一单就打爆
  })
  const r = await rig({ upstream: rec, tier: { key: "tiny", dailyUSD: 0.5, monthlyUSD: 0, model: "m" } })
  t.after(() => r.close())

  assert.equal((await r.call({ model: "m" })).status, 200)
  assert.equal(rec.seen.length, 1)
  assert.ok(r.cost() > 0.5, "第一单已把额度打爆：" + r.cost())

  const x = await r.call({ model: "m" })
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "QUOTA_EXCEEDED")
  assert.equal(x.json.error.scope, "daily")
  assert.equal(x.json.error.limit, 0.5)
  assert.equal(rec.seen.length, 1, "超限后一个字节都不该再发给上游（否则还在烧钱）")
})

test("额度：月额度独立生效", async (t) => {
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ usage: { prompt_tokens: 4000000, completion_tokens: 0 } })) },
    tier: { key: "m1", dailyUSD: 0, monthlyUSD: 1, model: "m" },   // 日不限、月限 $1
  })
  t.after(() => r.close())
  assert.equal((await r.call({ model: "m" })).status, 200)   // 4M * 0.27/1M = $1.08 > 1
  const x = await r.call({ model: "m" })
  assert.equal(x.status, 429)
  assert.equal(x.json.error.scope, "monthly")
})

test("额度：0 = 不限，不会被误判成已超额", async (t) => {
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ usage: { prompt_tokens: 9000000, completion_tokens: 9000000 } })) },
    tier: { key: "unlimited", dailyUSD: 0, monthlyUSD: 0, model: "m" },
  })
  t.after(() => r.close())
  for (let i = 0; i < 3; i++) assert.equal((await r.call({ model: "m" })).status, 200)
  assert.equal(r.rows().length, 3)
})

// 【改额度【不】吊销 key】额度根本不在票据里：authClient 只看 uid/ep/sc，网关每一单都
// 现查库拿 resolveEntitlement。为它 bumpEpoch 是白踢人 —— 给正在跑一小时综述的医生临时
// 加额，会把他这一轮登录态打断、要求重输口令，而这次吊销没有任何执行层面的必要。
test("额度：管理员当场调额，同一把 key 的下一次调用就按新额度判（不吊销、不踢人）", async (t) => {
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ usage: { prompt_tokens: 1000000, completion_tokens: 0 } })) },
    tier: { key: "t", dailyUSD: 0, model: "m" },
  })
  t.after(() => r.close())
  assert.equal((await r.call({ model: "m" })).status, 200)     // 记了 $0.27
  const up = await r.admin("/admin/api/user-update", { method: "POST", body: { id: r.uid, dailyOverride: 0.1 } })
  assert.equal(up.json.keyRevoked, false, "调额不该吊销 key")
  const x = await r.call({ model: "m" })
  assert.equal(x.status, 429, "同一把 key，已用 $0.27 > 新上限 $0.1")
  assert.equal(x.json.error.code, "QUOTA_EXCEEDED")
  // 反过来：加额也立刻生效，且人不用重新登录
  await r.admin("/admin/api/user-update", { method: "POST", body: { id: r.uid, dailyOverride: 99 } })
  assert.equal((await r.call({ model: "m" })).status, 200)
  // 而改【档位】仍然吊销 —— 它在票据里
  const t2 = await r.admin("/admin/api/user-update", { method: "POST", body: { id: r.uid, tier: "free" } })
  assert.equal(t2.json.keyRevoked, true)
  assert.equal((await r.call({ model: "m" })).json.error.code, "KEY_REVOKED")
})

// ---- 技能闸 ----
test("技能：白名单外的 X-Skill 被拒；白名单内放行；不带头放行（自由对话）", async (t) => {
  const rec = recorder((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0 } })) })
  const r = await rig({ upstream: rec, tier: { key: "ltd", dailyUSD: 0, model: "m", skills: "write-paper,search-lit" } })
  t.after(() => r.close())

  let x = await r.call({ model: "m" }, { "x-skill": "deep-research" })
  assert.equal(x.status, 403)
  assert.equal(x.json.error.code, "SKILL_NOT_ALLOWED")
  assert.equal(x.json.error.skill, "deep-research")
  assert.equal(rec.seen.length, 0)

  assert.equal((await r.call({ model: "m" }, { "x-skill": "write-paper" })).status, 200)
  assert.equal((await r.call({ model: "m" })).status, 200, "不带 X-Skill = 自由对话，不能一刀切拒")
  assert.equal(rec.seen.length, 2)
})

test("技能：档位未设白名单 = 全部放行", async (t) => {
  const r = await rig({ tier: { key: "all", dailyUSD: 0, model: "m", skills: "" } })
  t.after(() => r.close())
  assert.equal((await r.call({ model: "m" }, { "x-skill": "any-skill-id" })).status, 200)
})

// ---- 其它 ----
test("非 JSON 请求体原样透传（不崩，只是记不到账）", async (t) => {
  const rec = recorder((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}") })
  const r = await rig({ upstream: rec }); t.after(() => r.close())
  const x = await r.app.req(CHAT, {
    method: "POST", raw: true, body: "not-json-at-all",
    headers: { authorization: "Bearer " + r.access, "content-type": "text/plain" },
  })
  assert.equal(x.status, 200)
})

test("用量落进 /api/me 与后台明细", async (t) => {
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 0 } })) },
    tier: { key: "t", dailyUSD: 0, model: "m" },
  })
  t.after(() => r.close())
  await r.call({ model: "m" }, { "x-skill": "search-lit" })
  const me = await r.app.req("/api/me", { headers: { authorization: "Bearer " + r.access } })
  assert.ok(me.json.profile.usage.today > 0)
  const d = await r.admin("/admin/api/user-usage?id=" + r.uid)
  assert.equal(d.json.detail.length, 1)
  assert.equal(d.json.detail[0].skill, "search-lit")
  assert.equal(d.json.series[0].calls, 1)
})
