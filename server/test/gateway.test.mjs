// M2 网关层测试：转发、强制模型、注入 include_usage、按 usage 计量入账、额度闸、技能闸。
//
// 全程用一个假上游（本机 http server），不打真实模型；断言里既看客户端拿到什么，
// 也看上游【实际收到】什么 —— 计量和管控的正确性一半在"我们改写了请求"这件事上。
import test from "node:test"
import assert from "node:assert/strict"
import zlib from "node:zlib"
import { startApp, adminLogin, asAdmin, startFakeUpstream, sse } from "./helper.mjs"
import { normalizeUsage, costOf, joinUpstream, isUpstreamQuotaExhausted, extractResetHint,
  isMisreportedBillingError } from "../lib/gateway.mjs"

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
  // 上游端点不是 /v1 而是 /v3（火山方舟：/api/coding/v3、/api/v3）——客户端照旧发 /v1/...，
  // 版本以上游 base 为准，别拼出 /v3/v1/...（后台「测试连通」是绿的，转发却 404，最难查）
  assert.equal(joinUpstream("https://ark.cn-beijing.volces.com/api/coding/v3", "/v1/chat/completions"),
    "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions")
  assert.equal(joinUpstream("https://ark.cn-beijing.volces.com/api/v3", "/chat/completions"),
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions")
  assert.equal(joinUpstream("https://ark.cn-beijing.volces.com/api/v3/", "/v1/models"),
    "https://ark.cn-beijing.volces.com/api/v3/models")
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
    upstream: (_q, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"bad request"}}') },
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m" })
  assert.equal(x.status, 400)
  assert.equal(x.json.error.message, "bad request", "请求本身的问题原样透传才有诊断价值")
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

// ---- 并发闸 / 排队 ----
//
// 用一个"可控上游"：请求到达后【挂住不回】，直到测试自己放闸。这样才能稳定构造出
// "第一单还在飞、第二单撞上并发上限"的时刻 —— 靠 sleep 去凑是必然会偶发的。
function gatedUpstream() {
  const arrived = []                 // 每个元素是 release()：调用它这一单才回 200
  const h = (req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let done = false
      // 【放闸必须幂等】用例结尾统一"把还没放的都放掉"，而其中一部分在用例里已经放过了；
      // 不幂等的话收尾时就会对同一个响应第二次 writeHead，整条用例挂在清理钩子上。
      arrived.push(() => {
        if (done || res.writableEnded) return
        done = true
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ model: "m", usage: { prompt_tokens: 10, completion_tokens: 5 } }))
      })
    })
  }
  h.arrived = arrived
  return h
}
/** 等条件成立（最多 waitMs），比 sleep 稳 */
async function until(fn, waitMs = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < waitMs) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

test("并发闸：超出上限的请求排队，不打上游；前一单结束后自动放行", async (t) => {
  const up = gatedUpstream()
  const r = await rig({ upstream: up, env: { LLM_MAX_CONCURRENCY: "1" } })
  t.after(async () => { up.arrived.forEach((f) => f()); await r.close() })

  const p1 = r.call({ model: "m" })
  assert.ok(await until(() => up.arrived.length === 1), "第一单应当直接到上游")

  const p2 = r.call({ model: "m" })
  // 队列状态是唯一可靠的"它已经进队了"的证据（HTTP 层此刻什么都看不到）
  let snap = null
  assert.ok(await until(() => {
    snap = r.app.mod.queue.snapshot(r.uid)
    return snap.waiting === 1
  }), "第二单应当在队里等，而不是打上游")
  assert.equal(up.arrived.length, 1, "排队期间一个字节都不该发给上游")
  assert.equal(snap.position, 1)
  assert.equal(snap.running, 1)

  // 客户端问到的那份（前端就靠它显示"前面还有几个"）
  const qs = await r.app.req("/api/queue", { headers: { authorization: "Bearer " + r.access } })
  assert.equal(qs.status, 200)
  assert.equal(qs.json.queue.waitingMine, 1)
  assert.equal(qs.json.queue.position, 1)
  assert.equal(qs.json.queue.limit, 1)

  up.arrived[0]()                     // 第一单收尾 → 位子还回来
  const x1 = await p1
  assert.equal(x1.status, 200)
  assert.ok(await until(() => up.arrived.length === 2), "第二单这时才该到上游")
  up.arrived[1]()
  const x2 = await p2
  assert.equal(x2.status, 200)
  assert.ok(Number(x2.headers["x-queue-waited-ms"]) > 0, "排过队要如实报等了多久")
  assert.equal(r.rows().length, 2, "排队的那一单照样要计量入账")
  assert.equal(r.app.mod.queue.stats().running, 0, "位子必须全还回来，漏一个闸就越来越紧")
})

test("并发闸：排队等超时 → 503 QUEUE_TIMEOUT（不无声地悬着）", async (t) => {
  const up = gatedUpstream()
  const r = await rig({ upstream: up, env: { LLM_MAX_CONCURRENCY: "1", LLM_QUEUE_WAIT_MS: "1000" } })
  t.after(async () => { up.arrived.forEach((f) => f()); await r.close() })

  const p1 = r.call({ model: "m" })
  assert.ok(await until(() => up.arrived.length === 1))
  const x2 = await r.call({ model: "m" })
  assert.equal(x2.status, 503)
  assert.equal(x2.json.error.code, "QUEUE_TIMEOUT")
  assert.ok(x2.json.error.retryAfterMs > 0)
  up.arrived[0]()
  assert.equal((await p1).status, 200)
})

test("并发闸：队排满 → 503 QUEUE_FULL，当场回绝不再往里塞", async (t) => {
  const up = gatedUpstream()
  const r = await rig({ upstream: up, env: { LLM_MAX_CONCURRENCY: "1", LLM_QUEUE_MAX: "1", LLM_QUEUE_WAIT_MS: "3000" } })
  t.after(async () => { up.arrived.forEach((f) => f()); await r.close() })

  const p1 = r.call({ model: "m" })
  assert.ok(await until(() => up.arrived.length === 1))
  const p2 = r.call({ model: "m" })                     // 占满唯一的排队位
  assert.ok(await until(() => r.app.mod.queue.stats().waiting === 1))
  const x3 = await r.call({ model: "m" })
  assert.equal(x3.status, 503)
  assert.equal(x3.json.error.code, "QUEUE_FULL")
  assert.equal(x3.json.error.running, 1)
  up.arrived[0]()
  assert.equal((await p1).status, 200)
  await until(() => up.arrived.length === 2)
  up.arrived[1]?.()
  await p2
})

test("并发闸：排队中客户端断开 → 位子不漏，后面的人照样进得来", async (t) => {
  const up = gatedUpstream()
  const r = await rig({ upstream: up, env: { LLM_MAX_CONCURRENCY: "1" } })
  t.after(async () => { up.arrived.forEach((f) => f()); await r.close() })

  const p1 = r.call({ model: "m" })
  assert.ok(await until(() => up.arrived.length === 1))

  const ac = new AbortController()
  const p2 = fetch(r.app.base + CHAT, {
    method: "POST", signal: ac.signal,
    headers: { authorization: "Bearer " + r.access, "content-type": "application/json" },
    body: JSON.stringify({ model: "m" }),
  }).catch(() => "aborted")
  assert.ok(await until(() => r.app.mod.queue.stats().waiting === 1))
  ac.abort()                                            // 用户点了终止 / 客户端退出
  assert.equal(await p2, "aborted")
  assert.ok(await until(() => r.app.mod.queue.stats().waiting === 0), "断开的请求要从队里摘掉")

  up.arrived[0]()
  assert.equal((await p1).status, 200)
  assert.equal(r.app.mod.queue.stats().running, 0)
  // 位子确实还回来了：再来一单能【当场】打到上游（不是又在队里等）
  const p3 = r.call({ model: "m" })
  assert.ok(await until(() => up.arrived.length === 2), "位子没还回来的话这一单会一直排队")
  up.arrived[1]()
  assert.equal((await p3).status, 200)
})

test("并发闸：不限（默认）时行为与加这层之前一致", async (t) => {
  const up = gatedUpstream()
  const r = await rig({ upstream: up })
  t.after(async () => { up.arrived.forEach((f) => f()); await r.close() })
  const ps = [r.call({ model: "m" }), r.call({ model: "m" }), r.call({ model: "m" })]
  assert.ok(await until(() => up.arrived.length === 3), "不限并发时三单应当一起打出去")
  up.arrived.forEach((f) => f())
  for (const p of ps) assert.equal((await p).status, 200)
})

test("档位可以单独给并发（超出就排队），改档位不吊销 key", async (t) => {
  const up = gatedUpstream()
  const r = await rig({
    upstream: up,
    env: { LLM_MAX_CONCURRENCY: "10" },
    tier: { key: "one", dailyUSD: 0, model: "m", maxConc: 1 },
  })
  t.after(async () => { up.arrived.forEach((f) => f()); await r.close() })

  const p1 = r.call({ model: "m" })
  assert.ok(await until(() => up.arrived.length === 1))
  const p2 = r.call({ model: "m" })
  assert.ok(await until(() => r.app.mod.queue.stats().waiting === 1), "该档只给 1 路，第二单要等")

  // 后台把该档并发放宽 → 队里的人立刻被放出去，而且没人被踢下线
  const set = await r.admin("/admin/api/tier", { method: "POST", body: { key: "one", dailyUSD: 0, model: "m", maxConc: 3 } })
  assert.equal(set.status, 200)
  assert.equal(set.json.affected, 0, "只改并发不该吊销 key")
  // 放宽只影响【新来的】请求：已经在队里的那位仍等前一单结束（队列不重算旧等待者的 cap）
  up.arrived[0]()
  assert.equal((await p1).status, 200)
  assert.ok(await until(() => up.arrived.length === 2))
  up.arrived[1]()
  assert.equal((await p2).status, 200)
})

test("上游限速（429）→ 429 UPSTREAM_RATE_LIMITED，且 /api/queue 报「上游限速中」", async (t) => {
  const r = await rig({
    upstream: (_q, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" })
      res.end('{"error":{"message":"rate limit reached"}}')
    },
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m" })
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "UPSTREAM_RATE_LIMITED")
  assert.equal(x.json.error.retryAfterMs, 7000, "上游给的 Retry-After 要透出来")
  assert.equal(r.rows().length, 0, "限速不计费")

  const q = await r.app.req("/api/queue", { headers: { authorization: "Bearer " + r.access } })
  assert.ok(q.json.queue.rateLimited, "前端要能据此显示「上游限速，正在等待」而不是「服务器坏了」")
  assert.ok(q.json.queue.rateLimited.retryAfterMs > 0)
})

// 这一段是照 2026-08-07 生产实况写的：火山方舟账号 5 小时配额打光时回的【也是 429】。
// 修前全被当成限速 → queue 记 rateLimited → 客户端显示「上游限速中，正在等待重试…本轮会在
// 限速解除后自动继续，请不要重发」，同时首输出看门狗被 cloudQueueBlocking 每 30 秒续一次命、
// 永不超时 → 用户守着转圈等一个五小时后才恢复的额度，还被明确告知别重发。
const ARK_QUOTA_BODY = JSON.stringify({ error: {
  code: "AccountQuotaExceeded", type: "TooManyRequests", param: "",
  message: "You have exceeded the 5-hour usage quota. It will reset at 2026-08-07 14:12:52 +0800 CST. "
    + "We recommend upgrading your plan for more quota, or waiting for the reset. Request id: 0217860715299",
} })

test("上游额度耗尽（火山 429 AccountQuotaExceeded）→ 与限速分开：给恢复时刻，且不记 rateLimited", async (t) => {
  const r = await rig({
    upstream: (_q, res) => {
      res.writeHead(429, { "content-type": "application/json" })   // 注意：火山不给 Retry-After
      res.end(ARK_QUOTA_BODY)
    },
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m" })
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "UPSTREAM_QUOTA_EXCEEDED", "不能再判成 UPSTREAM_RATE_LIMITED：" + JSON.stringify(x.json))
  assert.equal(x.json.error.resetHint, "2026-08-07 14:12:52 +0800 CST", "恢复时刻只存在于上游原话里，丢了用户只能盲试")
  assert.match(x.json.error.message, /不是你的积分/, "必须说清跟他自己的积分无关")
  assert.match(x.json.error.message, /14:12:52/)
  assert.match(x.json.error.message, /重试不会成功/, "别给出'稍等片刻再试'这种反向建议")
  assert.equal(r.rows().length, 0, "没生成内容，不计费")

  // ★ 关键：不许记成"正在限速"。这个状态是客户端「请不要重发 + 看门狗无限续命」的唯一来源，
  //   老客户端也靠它 —— 不喂它，老客户端至少不会卡在假等待里。
  const q = await r.app.req("/api/queue", { headers: { authorization: "Bearer " + r.access } })
  assert.ok(!q.json.queue.rateLimited, "额度耗尽 ≠ 限速，绝不能记 rateLimited：" + JSON.stringify(q.json.queue))
})

test("真限速仍走老路（措辞相反，不能被上一条改坏）", async (t) => {
  const r = await rig({
    upstream: (_q, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" })
      res.end('{"error":{"message":"Rate limit reached for TPM","type":"rate_limit_error"}}')
    },
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m" })
  assert.equal(x.json.error.code, "UPSTREAM_RATE_LIMITED")
  assert.match(x.json.error.message, /稍等片刻再试/)
  const q = await r.app.req("/api/queue", { headers: { authorization: "Bearer " + r.access } })
  assert.ok(q.json.queue.rateLimited, "真限速照旧要记，前端提示「稍等自动重试」是对的建议")
})

test("读不到错误体时按限速处理（保守，行为同修改前）", async (t) => {
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(429, { "content-type": "application/json" }); res.end("") },
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m" })
  assert.equal(x.json.error.code, "UPSTREAM_RATE_LIMITED", "分不出来就别乱判成额度耗尽")
})

test("额度耗尽的分类函数：认机器码、认措辞，不误伤纯限速", () => {
  const F = isUpstreamQuotaExhausted
  assert.equal(F(ARK_QUOTA_BODY), true, "火山 AccountQuotaExceeded")
  assert.equal(F('{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}'), true, "OpenAI 系")
  assert.equal(F('{"error":{"code":"insufficient_user_quota"}}'), true, "one-api 中转")
  assert.equal(F('{"error":{"message":"当前账户额度已用尽"}}'), true, "中文措辞")
  assert.equal(F('{"error":{"message":"余额不足，请充值"}}'), true)
  // ★ 纯限速一律不能被认成额度耗尽：认错了就会告诉用户"重试不会成功"，而其实等几秒就好
  assert.equal(F('{"error":{"message":"Rate limit reached for TPM","type":"rate_limit_error"}}'), false)
  assert.equal(F('{"error":{"message":"Too many requests, please slow down"}}'), false)
  assert.equal(F('{"error":{"message":"concurrency limit exceeded"}}'), false, "并发上限是限速，不是额度")
  assert.equal(F(""), false, "读不到体 → 保守按限速")
  assert.equal(F("<html>502 Bad Gateway</html>"), false)
})

// 2026-09-01 用户实测：火山方舟把「CodingPlan 订阅过期」回成 HTTP 400，于是既不切家、
// supply 也不摘家，无人值守的定时任务整轮烂掉。下面三条钉住这个 400 的特殊处理。
const ARK_SUB_BODY = JSON.stringify({ error: { message:
  "Your account (2130613591) does not have a valid CodingPlan subscription, or your subscription has expired. Please visit https://console.volcengine.com/ark/region" } })

test("被错报成 400 的计费/订阅错误：认得出，且不误伤真正的参数错", () => {
  const F = isMisreportedBillingError
  assert.equal(F(ARK_SUB_BODY), true, "火山 CodingPlan 订阅过期")
  assert.equal(F('{"error":{"code":"SubscriptionExpired"}}'), true, "机器码")
  assert.equal(F('{"error":{"message":"Your plan has expired"}}'), true)
  assert.equal(F('{"error":{"message":"账户订阅已过期，请续订"}}'), true, "中文措辞")
  assert.equal(F('{"error":{"message":"Insufficient Balance"}}'), true, "欠费也算（复用额度那套判据）")
  // ★ 下面这些是真正的"请求本身有问题"，认错了就会在每家上都撞一遍，还把错因换成计费话术
  assert.equal(F('{"error":{"message":"model `gpt-9` not found"}}'), false)
  assert.equal(F('{"error":{"message":"Invalid value for parameter temperature"}}'), false)
  assert.equal(F('{"error":{"message":"messages: at least one message is required"}}'), false)
  assert.equal(F('{"error":{"message":"unsupported subscription_id field"}}'), false, "只出现 subscription 这个词不算")
  assert.equal(F(""), false, "读不到体 → 保守按参数错，原样透传")
})

test("上游订阅过期（400）且无备用可切 → 402 UPSTREAM_BILLING_ERROR，别把裸 400 甩给用户", async (t) => {
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end(ARK_SUB_BODY) },
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m" })
  assert.equal(x.status, 402)
  assert.equal(x.json.error.code, "UPSTREAM_BILLING_ERROR")
  assert.match(x.json.error.upstreamMessage, /CodingPlan/, "上游原话要带上，否则管理员不知道去哪续订")
})

test("认不出的 400 仍原样透传（体一个字节都不能少，含多字节汉字）", async (t) => {
  const body = JSON.stringify({ error: { message: "参数 temperature 非法：必须在 0 到 2 之间" } })
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end(body) },
  })
  t.after(() => r.close())
  const x = await r.call({ model: "m" })
  assert.equal(x.status, 400, "参数错换谁都一样，不该被改写成 402")
  assert.equal(x.text, body, "错误体必须逐字节原样回去 —— 诊断价值全在这里")
})

test("恢复时刻抽取：抠不出来就返回空串，别编一个时间", () => {
  const E = extractResetHint
  assert.equal(E(ARK_QUOTA_BODY), "2026-08-07 14:12:52 +0800 CST")
  assert.equal(E('{"error":{"message":"额度已用尽，恢复时间：2026-08-07 14:12"}}'), "2026-08-07 14:12")
  assert.equal(E('{"error":{"message":"quota exhausted"}}'), "", "没说什么时候恢复就别瞎猜")
  assert.equal(E(""), "")
})

test("后台能改并发上限并立刻生效，且重启后仍是新值（落库）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  let g = await r.admin("/admin/api/limits")
  assert.equal(g.status, 200)
  assert.equal(g.json.limits.maxConcurrent, 0, "默认不限")

  assert.equal((await r.admin("/admin/api/limits", { method: "POST", body: { maxConcurrent: -3 } })).status, 400)
  assert.equal((await r.admin("/admin/api/limits", { method: "POST", body: { maxConcurrent: "abc" } })).status, 400)
  assert.equal(r.app.mod.queue.limits().maxConcurrent, 0, "非法值不许悄悄改成 0/NaN")

  const p = await r.admin("/admin/api/limits", { method: "POST", body: { maxConcurrent: 4, perUser: 2, maxQueue: 50, maxWaitMs: 60000 } })
  assert.equal(p.status, 200)
  assert.equal(r.app.mod.queue.limits().maxConcurrent, 4, "内存里的闸当场就变（不用重启）")
  g = await r.admin("/admin/api/limits")
  assert.equal(g.json.limits.perUser, 2)
  assert.deepEqual(
    JSON.parse(r.app.db.prepare("SELECT v FROM meta WHERE k='llm_limits'").get().v),
    { maxConcurrent: 4, perUser: 2, maxQueue: 50, maxWaitMs: 60000 },
    "库是权威：重启后要还按这个值跑")
  // 未登录的人不该看得见这些
  assert.equal((await r.app.req("/admin/api/limits")).status, 401)
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

test("上游回 gzip 也要计到账（转发钉 identity + 记账侧兜底解压）", async (t) => {
  // 真机踩的：客户端默认带 accept-encoding: gzip,br，照转过去火山方舟就回压缩体，
  // 旁路攒到压缩字节 → JSON.parse 失败 → usage 丢 → 这一单白送，客户端毫无察觉。
  let sawAcceptEncoding = ""
  const r = await rig({
    upstream: (req, res) => {
      sawAcceptEncoding = String(req.headers["accept-encoding"] || "")
      // 故意无视 identity，硬回 gzip：兜底那层要能接住
      const body = zlib.gzipSync(Buffer.from(JSON.stringify({ model: "m", usage: { prompt_tokens: 1000, completion_tokens: 0 } })))
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" })
      res.end(body)
    },
    tier: { key: "t", dailyUSD: 0, model: "m" },
  })
  t.after(() => r.close())
  await r.call({ model: "m" })
  assert.equal(sawAcceptEncoding, "identity", "转发时必须把 accept-encoding 钉成 identity")
  assert.equal(r.rows().length, 1, "压缩响应仍要入账")
  assert.equal(r.rows()[0].prompt_tokens, 1000)
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
