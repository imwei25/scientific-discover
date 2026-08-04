// 积分（客户端看得见的额度单位）：换算规则 + /api/quota + 档案里的积分视图 + 撞限时的措辞。
//
// 这层的全部价值在于"用户看到的数不能骗人"：显示还剩 N 积分就必须真的还能发；
// 所以取整方向的断言（下取整剩余、上取整已用）才是这个文件里最要紧的几条。
import test from "node:test"
import assert from "node:assert/strict"
import { startApp, adminLogin, asAdmin, startFakeUpstream } from "./helper.mjs"
import * as Credits from "../lib/credits.mjs"

const STRONG = "Aa1!aaaa9"

/** 起 app + 一个改完密的账号（可指定档位额度） */
async function rig({ env = {}, tier } = {}) {
  const up = await startFakeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "x", model: "m", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }))
  })
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
  const auth = { authorization: "Bearer " + chg.json.access }
  return {
    app, admin, uid, access: chg.json.access, up,
    quota: async () => (await app.req("/api/quota", { headers: auth })).json.quota,
    me: async () => (await app.req("/api/me", { headers: auth })).json.profile,
    chat: (body = { model: "m" }) => app.req("/llm/v1/chat/completions", { method: "POST", body, headers: auth }),
    async close() { await app.close(); await up.close() },
  }
}

/** 往库里补一笔用量（金额精确可控），走的就是网关计量用的那个函数 */
async function spend(rigged, usd) {
  const DB = await import("../lib/db.mjs")
  DB.recordUsage(rigged.app.db, rigged.uid, { model: "m", provider: "t", cost_usd: usd })
}

// ---- 纯换算 ----
test("换算：1 积分 = $0.01，日/月两条线各自独立", () => {
  const v = Credits.quotaView({ dailyUsd: 0.3, monthlyUsd: 5, todayUsd: 0.123, monthUsd: 1.5, creditUsd: 0.01 })
  assert.equal(v.creditUsd, 0.01)
  assert.equal(v.daily.limit, 30)
  assert.equal(v.daily.used, 12.3)
  assert.equal(v.daily.remain, 17)          // floor(30 - 12.3)
  assert.equal(v.daily.pct, 41)
  assert.equal(v.monthly.limit, 500)
  assert.equal(v.monthly.remain, 350)
  assert.equal(v.monthly.unlimited, false)
})

test("取整一律朝'用户少赚'的方向：剩余下取整、已用上取整", () => {
  const l = Credits.quotaLine(1, 0.0101, 0.01)     // 上限 100 积分，已用 1.01 积分
  assert.equal(l.limit, 100)
  assert.equal(l.used, 1.1)                        // 上取整到一位小数，不显示成 1.0
  assert.equal(l.remain, 98)                       // floor(100 - 1.01)，不是 99
  // 只差一丁点就用完时必须显示 0，绝不能显示 1 —— 否则"明明还剩 1 分却被 429"
  assert.equal(Credits.quotaLine(0.3, 0.2999, 0.01).remain, 0)
})

test("已用超上限（并发轮同时收尾）也不会出现负剩余", () => {
  const l = Credits.quotaLine(0.3, 0.55, 0.01)
  assert.equal(l.remain, 0)
  assert.equal(l.pct, 100)
})

test("上限 0 = 不限：remain 给 null，不是 0（0 会被前端当成'用尽'）", () => {
  const l = Credits.quotaLine(0, 0.42, 0.01)
  assert.equal(l.unlimited, true)
  assert.equal(l.remain, null)
  assert.equal(l.limit, 0)
  assert.equal(l.used, 42)
})

test("重置时刻按 UTC，与库里 day/month 键同一口径", () => {
  const ts = Date.UTC(2026, 7, 4, 13, 30)          // 2026-08-04 13:30 UTC
  assert.equal(Credits.nextDayResetAt(ts), Date.UTC(2026, 7, 5))
  assert.equal(Credits.nextMonthResetAt(ts), Date.UTC(2026, 8, 1))
  // 跨年不能算成 13 月
  assert.equal(Credits.nextMonthResetAt(Date.UTC(2026, 11, 31, 23, 59)), Date.UTC(2027, 0, 1))
})

// ---- 接口 ----
test("/api/quota：拿得到日/月剩余积分，且随用量实时变", async (t) => {
  const r = await rig({ tier: { key: "plus", dailyUSD: 0.3, monthlyUSD: 5, model: "m" } })
  t.after(() => r.close())
  let q = await r.quota()
  assert.equal(q.creditUsd, 0.01)
  assert.equal(q.daily.limit, 30)
  assert.equal(q.daily.remain, 30)
  assert.equal(q.monthly.remain, 500)

  await spend(r, 0.05)          // 花掉 5 积分
  q = await r.quota()
  assert.equal(q.daily.remain, 25)
  assert.equal(q.daily.used, 5)
  assert.equal(q.monthly.remain, 495)
})

test("/api/quota：汇率可配（CREDIT_USD），换算只在服务端做", async (t) => {
  const r = await rig({ env: { CREDIT_USD: "0.005" }, tier: { key: "plus", dailyUSD: 0.3, model: "m" } })
  t.after(() => r.close())
  const q = await r.quota()
  assert.equal(q.creditUsd, 0.005)
  assert.equal(q.daily.limit, 60)      // $0.30 / $0.005
  assert.equal(q.daily.remain, 60)
})

test("/api/quota：没登录一律 401，不泄露任何额度信息", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const x = await r.app.req("/api/quota")
  assert.equal(x.status, 401)
  assert.equal(x.json.quota, undefined)
})

test("/api/me 的档案里带同一份积分视图（登录后第一屏就能显示）", async (t) => {
  const r = await rig({ tier: { key: "plus", dailyUSD: 0.3, monthlyUSD: 5, model: "m" } })
  t.after(() => r.close())
  await spend(r, 0.1)
  const p = await r.me()
  // 美元那两行留着不动：后台、对账、老客户端都在读
  assert.equal(p.limits.daily, 0.3)
  assert.ok(Math.abs(p.usage.today - 0.1) < 1e-9)
  // 积分视图与 /api/quota 必须完全一致，否则顶栏和账号面板会显示两个数
  assert.deepEqual(p.quota.daily, (await r.quota()).daily)
  assert.equal(p.quota.daily.remain, 20)
})

test("撞限时的 429 说的是积分，不是美元（与顶栏同一套话）", async (t) => {
  const r = await rig({ tier: { key: "plus", dailyUSD: 0.3, monthlyUSD: 5, model: "m" } })
  t.after(() => r.close())
  await spend(r, 0.3)                       // 日额度正好用尽
  const x = await r.chat()
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "QUOTA_EXCEEDED")
  assert.match(x.json.error.message, /今日积分已用尽（上限 30 积分）/)
  assert.equal(x.json.error.limitCredits, 30)
  // used/limit 仍是美元：运维脚本与既有客户端在读它们
  assert.equal(x.json.error.limit, 0.3)
})

test("月额度撞限也说积分", async (t) => {
  const r = await rig({ tier: { key: "plus", dailyUSD: 0, monthlyUSD: 5, model: "m" } })
  t.after(() => r.close())
  await spend(r, 5)
  const x = await r.chat()
  assert.equal(x.status, 429)
  assert.match(x.json.error.message, /本月积分已用尽（上限 500 积分）/)
})

test("后台总览带上换算比例：管理员填美元时要当场看见用户会看到多少积分", async (t) => {
  const r = await rig({ env: { CREDIT_USD: "0.02" } })
  t.after(() => r.close())
  const ov = await r.admin("/admin/api/overview")
  assert.equal(ov.json.creditUsd, 0.02)
})

test("管理员单独放宽某人的额度（override）后，他的积分立刻跟着变", async (t) => {
  const r = await rig({ tier: { key: "plus", dailyUSD: 0.3, model: "m" } })
  t.after(() => r.close())
  assert.equal((await r.quota()).daily.limit, 30)
  await r.admin("/admin/api/user-update", { method: "POST", body: { id: r.uid, dailyOverride: 1 } })
  assert.equal((await r.quota()).daily.limit, 100)
})
