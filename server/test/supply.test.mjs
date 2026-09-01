// 供应侧闸：每家还剩多少额度、刚撞过墙的家要不要跳过。
//
// 这一层是 2026-08「火山账户额度耗尽 → 全站输出空白」的正面回应，所以最要紧的几条断言是：
//   ① 预算用尽的家不再被派单，流量自动落到同一模型名下的下一家；
//   ② 但**筛不空**——全被筛掉时必须 fail-open 兜底放行，绝不能让这层自己把全站饿死；
//   ③ 5xx 不摘家（那是抖动，不是"这家不能用了"），402/401/429 才摘；
//   ④ 冷却到期后自动半开重试，成功即恢复 —— 管理员充完值不用手动点。
import test from "node:test"
import assert from "node:assert/strict"
import { startApp, adminLogin, asAdmin, startFakeUpstream } from "./helper.mjs"
import * as DB from "../lib/db.mjs"
import {
  WINDOWS, windowStart, classifyFailure, filterAttempts, budgetLine, createSupply,
} from "../lib/supply.mjs"

const STRONG = "Aa1!aaaa9"
const CHAT = "/llm/v1/chat/completions"
const H = 3600_000

// ---- 纯函数 ------------------------------------------------------------------

test("窗口全部是滚动的（不是自然日切）", () => {
  const now = 1_700_000_000_000
  assert.equal(windowStart("h5", now), now - 5 * H)
  assert.equal(windowStart("day", now), now - 24 * H)
  assert.equal(windowStart("week", now), now - 7 * 24 * H)
  assert.equal(windowStart("month", now), now - 30 * 24 * H)
  // total 从充值时刻起算，与 now 无关
  assert.equal(windowStart("total", now, 12345), 12345)
  // 认不出的窗口名 = 不限（起点 0），别把脏数据变成"永远超支"
  assert.equal(windowStart("nonsense", now), 0)
  // 时钟回拨也不该算出负起点
  assert.equal(windowStart("day", 1000), 0)
})

test("失败分类：402/401/403/429 摘家，5xx 与网络错误不摘", () => {
  assert.equal(classifyFailure(402).state, "dry")
  assert.equal(classifyFailure(401).state, "invalid_key")
  assert.equal(classifyFailure(403).state, "invalid_key")
  assert.equal(classifyFailure(429).state, "rate_limited")
  // 【这四条是防倒退的】按 5xx 摘家会把上游一次几秒的抖动放大成半小时降级
  for (const s of [500, 502, 503, 504]) assert.equal(classifyFailure(s), null, `${s} 不该摘家`)
  assert.equal(classifyFailure(0), null, "网络错误（无状态码）不摘家")
  assert.equal(classifyFailure(400), null, "请求本身的问题不摘家")
  assert.equal(classifyFailure(404), null)
})

test("429 听 Retry-After，但有上限；402/401 的冷却按各自节奏", () => {
  assert.equal(classifyFailure(429, 5000).cooldownMs, 5000)
  assert.equal(classifyFailure(429, 0).cooldownMs, 60_000, "没给 Retry-After 用默认值")
  assert.equal(classifyFailure(429, 99 * 60_000).cooldownMs, 10 * 60_000, "再长也钳到 10 分钟")
  // key 失效要人换 key，冷却比"钱没了"更长
  assert.ok(classifyFailure(401).cooldownMs > classifyFailure(402).cooldownMs)
})

test("filterAttempts：筛掉挡住的，但一个都不剩时 fail-open 原样放回", () => {
  const A = { provider: "a", providerName: "甲" }
  const B = { provider: "b", providerName: "乙" }

  let r = filterAttempts([A, B], (p) => (p === "a" ? { why: "预算用尽" } : null))
  assert.deepEqual(r.attempts, [B])
  assert.equal(r.dropped.length, 1)
  assert.equal(r.failOpen, false)

  // 【这条是这个模块最重要的一条】全被挡住时必须原样放回，而不是返回空数组。
  // 允许筛空的话，一个估算错误就能让全站彻底不可用 —— 比它要治的那个病严重得多。
  r = filterAttempts([A, B], () => ({ why: "都挡住了" }))
  assert.deepEqual(r.attempts, [A, B], "全挡住 → 兜底放行全部候选")
  assert.equal(r.failOpen, true)
  assert.equal(r.dropped.length, 2, "但要如实报出被挡了哪些，好让上层告警")

  // env 兜底那条（provider 为空串）永不参与筛选：它没有预算与健康记录，筛它等于把老部署的唯一一条路掐了
  const ENV = { provider: "", providerName: "默认上游(env)" }
  r = filterAttempts([ENV], () => ({ why: "不该问到它" }))
  assert.deepEqual(r.attempts, [ENV])
  assert.equal(r.failOpen, false)
})

test("budgetLine：剩余不为负，用尽判定用 >=", () => {
  const l = budgetLine({ win: "day", limit_usd: 10, anchor: 0 }, 3)
  assert.equal(l.remainUsd, 7)
  assert.equal(l.pct, 30)
  assert.equal(l.exhausted, false)
  // 超支（并发轮同时收尾会出现）时剩余给 0，不是负数
  const over = budgetLine({ win: "day", limit_usd: 10, anchor: 0 }, 12)
  assert.equal(over.remainUsd, 0)
  assert.equal(over.exhausted, true)
  assert.equal(budgetLine({ win: "day", limit_usd: 10, anchor: 0 }, 10).exhausted, true, "刚好用完就算用尽")
  // 上限 0 = 没设这条线，永不算用尽
  assert.equal(budgetLine({ win: "day", limit_usd: 0, anchor: 0 }, 99).exhausted, false)
})

// ---- 跟踪器（带库） ----------------------------------------------------------

/** 一个只有 usage_log 的最小环境 */
function rigDb() {
  const db = DB.openDb(":memory:")
  const logs = [], audits = []
  const spend = (provider, usd, ts = Date.now()) =>
    DB.recordUsage(db, 1, { ts, model: "m", provider, cost_usd: usd })
  return { db, logs, audits, spend,
    supply: (opts = {}) => createSupply({ db, log: (m) => logs.push(m), audit: (e, f) => audits.push({ e, ...f }), ...opts }) }
}

test("预算用尽 → 这家被挡；没设预算的家不受影响", () => {
  const r = rigDb()
  DB.setBudget(r.db, "vol", "day", 1.0)
  r.spend("vol", 0.4)
  const s = r.supply()
  assert.equal(s.blockOf("vol"), null, "还没用尽，放行")
  assert.equal(s.blockOf("other"), null, "没设预算 = 不限")

  r.spend("vol", 0.7)              // 累计 1.1 > 1.0
  s.invalidate("vol")              // 管理员改了预算/充了值都会走这条；这里模拟缓存失效
  const b = s.blockOf("vol")
  assert.ok(b, "用尽后要挡住")
  assert.match(b.why, /预算已用尽/)
})

test("noteSpend 让预算闸在缓存到期前就跟上（并发冲穿防护）", () => {
  const r = rigDb()
  DB.setBudget(r.db, "vol", "day", 1.0)
  const s = r.supply({ cacheMs: 60_000 })   // 故意把缓存设长：只靠 TTL 的话这一条必挂
  assert.equal(s.blockOf("vol"), null)

  // 一波并发长任务在缓存有效期内花掉了预算。闸必须立刻看见，而不是等 60 秒后才反应过来。
  s.noteSpend("vol", 0.6)
  s.noteSpend("vol", 0.5)
  assert.ok(s.blockOf("vol"), "增量记账后立刻挡住")
})

test("多条预算线：任意一条用尽就挡住", () => {
  const r = rigDb()
  DB.setBudget(r.db, "go", "h5", 12)
  DB.setBudget(r.db, "go", "month", 60)
  r.spend("go", 12.5)              // 5 小时线爆了，30 天线还早
  const s = r.supply()
  const b = s.blockOf("go")
  assert.ok(b)
  assert.match(b.why, /5 小时/)
})

test("total 窗口只算 anchor 之后的消费", () => {
  const r = rigDb()
  const now = Date.now()
  r.spend("vol", 5, now - 10 * 24 * H)     // 上一次充值周期的老账
  const anchor = now - 24 * H              // 昨天又充了一笔
  DB.setBudget(r.db, "vol", "total", 3, anchor)
  r.spend("vol", 1, now - 2 * H)
  const s = r.supply()
  assert.equal(s.blockOf("vol"), null, "anchor 之前的 5 块不该算进这一轮")
  const line = s.snapshot(["vol"])[0].budgets[0]
  assert.equal(Math.abs(line.spentUsd - 1) < 1e-9, true)
})

test("撞墙后摘除 → 冷却到期自动半开 → 成功即恢复", () => {
  const r = rigDb()
  let t = 1_700_000_000_000
  const s = r.supply({ now: () => t })

  s.noteFailure("vol", 402, 0, t)
  const b = s.blockOf("vol", t)
  assert.ok(b, "刚撞过 402 要挡住")
  assert.match(b.why, /402/)

  t += 10 * 60_000
  assert.ok(s.blockOf("vol", t), "冷却期内继续挡")

  t += 25 * 60_000                        // 累计 35 分钟 > 30 分钟冷却
  assert.equal(s.blockOf("vol", t), null, "冷却到期自动放行一单探路（半开）")

  // 探路成功 → 彻底恢复。这就是"管理员充完值不用手动点"的实现。
  s.noteSuccess("vol")
  assert.equal(s.blockOf("vol", t), null)
  assert.equal(DB.listHealth(r.db).length, 0, "库里的标记也要清掉")
})

test("5xx 不摘家（抖动 ≠ 这家不能用了）", () => {
  const r = rigDb()
  const s = r.supply()
  s.noteFailure("vol", 503)
  s.noteFailure("vol", 500)
  assert.equal(s.blockOf("vol"), null)
  assert.equal(DB.listHealth(r.db).length, 0)
})

test("摘除标记落库，重启后还在（否则一重启就又开始挨家撞 402）", () => {
  const r = rigDb()
  let t = 1_700_000_000_000
  r.supply({ now: () => t }).noteFailure("vol", 402, 0, t)

  // 换一个新的跟踪器 = 进程重启
  const after = r.supply({ now: () => t })
  assert.ok(after.blockOf("vol", t), "重启后仍然记得这家干涸了")
  const row = DB.listHealth(r.db)[0]
  assert.equal(row.state, "dry")
  assert.equal(row.trips, 1)
})

test("跳闸次数累计；402/401 进审计，429 不进（限流是常态，别刷屏）", () => {
  const r = rigDb()
  let t = 1_700_000_000_000
  const s = r.supply({ now: () => t })
  s.noteFailure("vol", 402, 0, t); t += 60 * 60_000
  s.noteFailure("vol", 402, 0, t)
  assert.equal(DB.listHealth(r.db)[0].trips, 2)
  assert.equal(r.audits.filter((a) => a.e === "supply.trip").length, 2)

  s.noteFailure("sf", 429, 1000, t)
  assert.equal(r.audits.filter((a) => a.e === "supply.trip" && a.target === "sf").length, 0)
})

test("低水位（≥85%）告警一次，不重复刷", () => {
  const r = rigDb()
  DB.setBudget(r.db, "vol", "day", 10)
  r.spend("vol", 9)
  const s = r.supply()
  s.blockOf("vol"); s.blockOf("vol"); s.blockOf("vol")
  const warns = r.audits.filter((a) => a.e === "supply.low_water")
  assert.equal(warns.length, 1, "同一条线在静默期内只喊一次")
  assert.match(warns[0].detail, /90%/)
})

test("clear 会连告警去重一起忘掉（换了新账号就该重新提醒）", () => {
  const r = rigDb()
  DB.setBudget(r.db, "vol", "day", 10)
  r.spend("vol", 9)
  const s = r.supply()
  s.blockOf("vol")
  s.clear("vol")
  s.blockOf("vol")
  assert.equal(r.audits.filter((a) => a.e === "supply.low_water").length, 2)
})

// ---- 端到端：预算用尽 → 网关跳过这家 ------------------------------------------

async function rigApp({ upstream } = {}) {
  const up = await startFakeUpstream(upstream)
  const app = await startApp({ LLM_UPSTREAM_URL: up.url })
  const admin = asAdmin(app, await adminLogin(app))
  await admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 0, model: "std" } })
  const add = await admin("/admin/api/user-add", {
    method: "POST", body: { username: "zhangsan", displayName: "张三", tier: "plus" },
  })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: STRONG },
  })
  return {
    up, app, admin,
    call: (body) => app.req(CHAT, { method: "POST", body, headers: { authorization: "Bearer " + chg.json.access } }),
    async close() { await app.close(); await up.close() },
  }
}

test("端到端：主供应商预算用尽 → 这一单直接走备用，不再白撞一次", async (t) => {
  const seen = []
  const backup = await startFakeUpstream((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ model: "b-real", usage: { prompt_tokens: 1000, completion_tokens: 0 } }))
  })
  // 主家指向一个必然连不上的地址：一旦闸失灵、真去打了它，这条用例就会以"备用没收到"暴露出来
  const r = await rigApp()
  t.after(async () => { await r.close(); await backup.close() })

  await r.admin("/admin/api/provider", { method: "POST", body: { key: "vol", name: "火山", baseURL: "http://127.0.0.1:9/v1", apiKey: "kv" } })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "bk", name: "备用", baseURL: backup.url + "/v1", apiKey: "kb" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [
    { model: "std", provider: "vol", sort: 0, priceIn: 1, priceOut: 0, priceCached: 0 },
    { model: "std", provider: "bk", sort: 1, upstream: "b-real", priceIn: 1, priceOut: 0, priceCached: 0 },
  ] } })

  // 火山已经花掉 $2，额度只有 $1 —— 后台一填额度，下一单就不该再派给它
  DB.recordUsage(r.app.db, 1, { model: "std", provider: "vol", cost_usd: 2 })
  const sv = await r.admin("/admin/api/supply", { method: "POST", body: { provider: "vol", action: "budget", budgets: [{ win: "day", limitUSD: 1 }] } })
  assert.equal(sv.json.ok, true)

  const x = await r.call({ model: "std", messages: [] })
  assert.equal(x.status, 200)
  assert.equal(seen.length, 1, "备用家收到了这一单")

  // 后台那一页要能看见"为什么没走火山"
  const list = await r.admin("/admin/api/providers")
  const vol = list.json.supply.find((s) => s.provider === "vol")
  assert.equal(vol.blocked, true)
  assert.match(vol.blockedWhy, /预算已用尽/)
  assert.equal(vol.budgets[0].exhausted, true)
})

test("端到端：订阅过期被错报成 400 → 照样切备用，且这家被摘掉不再挨个撞", async (t) => {
  // 2026-09-01 用户实测：火山把「CodingPlan 订阅过期」回成 HTTP 400。400 历来"不切家"
  // （请求本身的问题换谁都一样），于是备用一次没被用上；supply 也不认这个码，没人手动去
  // 后台停用的话每一单都还先撞它一次 —— 无人值守的定时任务就整轮烂在那里。
  const seen = []
  const backup = await startFakeUpstream((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 0 } }))
  })
  const expired = await startFakeUpstream((_q, res) => {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message:
      "Your account (2130613591) does not have a valid CodingPlan subscription, or your subscription has expired." } }))
  })
  const r = await rigApp()
  t.after(async () => { await r.close(); await backup.close(); await expired.close() })

  await r.admin("/admin/api/provider", { method: "POST", body: { key: "vol", name: "火山", baseURL: expired.url + "/v1", apiKey: "kv" } })
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "bk", name: "备用", baseURL: backup.url + "/v1", apiKey: "kb" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [
    { model: "std", provider: "vol", sort: 0 }, { model: "std", provider: "bk", sort: 1 },
  ] } })

  const x = await r.call({ model: "std", messages: [] })
  assert.equal(x.status, 200, "订阅过期应当自动落到备用家，而不是把 400 甩给用户")
  assert.equal(seen.length, 1, "备用家收到了这一单")

  // 熔断：后台那一页要看得见"为什么不再走火山"，且下一单根本不去撞它
  const list = await r.admin("/admin/api/providers")
  const vol = list.json.supply.find((s) => s.provider === "vol")
  assert.equal(vol.blocked, true, "撞过一次就该摘掉，否则每一单都要再白撞一个 RTT")
  assert.match(vol.blockedWhy || vol.reason || "", /订阅过期|余额/)
  await r.call({ model: "std", messages: [] })
  assert.equal(seen.length, 2, "第二单直接走备用")
})

test("端到端：全部候选都被挡 → 兜底放行，不把全站饿死", async (t) => {
  const seen = []
  const only = await startFakeUpstream((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ model: "m", usage: { prompt_tokens: 0, completion_tokens: 0 } }))
  })
  const r = await rigApp()
  t.after(async () => { await r.close(); await only.close() })

  await r.admin("/admin/api/provider", { method: "POST", body: { key: "vol", name: "火山", baseURL: only.url + "/v1", apiKey: "kv" } })
  await r.admin("/admin/api/model", { method: "POST", body: { items: [{ model: "std", provider: "vol", priceIn: 1, priceOut: 0, priceCached: 0 }] } })
  DB.recordUsage(r.app.db, 1, { model: "std", provider: "vol", cost_usd: 5 })
  await r.admin("/admin/api/supply", { method: "POST", body: { provider: "vol", action: "budget", budgets: [{ win: "day", limitUSD: 1 }] } })

  const x = await r.call({ model: "std", messages: [] })
  assert.equal(x.status, 200, "唯一一家超预算也得放行——否则这层就成了新的全站故障源")
  assert.equal(seen.length, 1)
})

test("端到端：额度接口校验窗口名与数值，clear 能手动解除", async (t) => {
  const r = await rigApp()
  t.after(() => r.close())
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "vol", baseURL: "http://127.0.0.1:9/v1", apiKey: "kv" } })

  assert.equal((await r.admin("/admin/api/supply", { method: "POST", body: { provider: "nope", action: "clear" } })).status, 404)
  assert.equal((await r.admin("/admin/api/supply", {
    method: "POST", body: { provider: "vol", action: "budget", budgets: [{ win: "fortnight", limitUSD: 1 }] } })).status, 400)
  assert.equal((await r.admin("/admin/api/supply", {
    method: "POST", body: { provider: "vol", action: "budget", budgets: [{ win: "day", limitUSD: "abc" }] } })).status, 400)

  // 落一条再取消（limitUSD ≤ 0 = 删行，不是"额度为 0"）
  await r.admin("/admin/api/supply", { method: "POST", body: { provider: "vol", action: "budget", budgets: [{ win: "day", limitUSD: 5 }] } })
  assert.equal(DB.listBudgets(r.app.db, "vol").length, 1)
  await r.admin("/admin/api/supply", { method: "POST", body: { provider: "vol", action: "budget", budgets: [{ win: "day", limitUSD: 0 }] } })
  assert.equal(DB.listBudgets(r.app.db, "vol").length, 0)

  assert.equal((await r.admin("/admin/api/supply", { method: "POST", body: { provider: "vol", action: "clear" } })).json.ok, true)
})

test("删掉供应商，预算与健康跟着走（否则重建同名会继承上一次的干涸标记）", async (t) => {
  const r = await rigApp()
  t.after(() => r.close())
  await r.admin("/admin/api/provider", { method: "POST", body: { key: "vol", baseURL: "http://127.0.0.1:9/v1", apiKey: "kv" } })
  await r.admin("/admin/api/supply", { method: "POST", body: { provider: "vol", action: "budget", budgets: [{ win: "day", limitUSD: 5 }] } })
  DB.saveHealth(r.app.db, "vol", { state: "dry", until: Date.now() + 60_000, reason: "x", notedAt: Date.now(), trips: 1 })

  await r.admin("/admin/api/provider", { method: "POST", body: { key: "vol", remove: true } })
  assert.equal(DB.listBudgets(r.app.db, "vol").length, 0)
  assert.equal(DB.listHealth(r.app.db).filter((h) => h.provider === "vol").length, 0)
})

test("窗口清单对外可见（后台画表单要用）", () => {
  assert.deepEqual(Object.keys(WINDOWS).sort(), ["day", "h5", "month", "total", "week"])
})
