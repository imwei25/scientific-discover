// 生图代理：成功图按模型价格记入与 LLM token 共用的积分账；不再有独立的按张数配额。
import test from "node:test"
import assert from "node:assert/strict"
import { startApp, adminLogin, asAdmin, startFakeUpstream } from "./helper.mjs"
import { extractImageUrls, imageCost } from "../lib/imagegen.mjs"
import * as DB from "../lib/db.mjs"

const STRONG = "Aa1!aaaa9"
const IMG = "/img/generate"
const okBody = (url = "https://dash.example/img/abc.png") => JSON.stringify({
  output: { choices: [{ message: { content: [{ image: url }] } }] },
})

async function rig({ upstream, dailyUSD = 5, monthlyUSD = 0, env = {} } = {}) {
  const up = await startFakeUpstream(upstream || ((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" }); res.end(okBody())
  }))
  const app = await startApp({ QWEN_API_KEY: "img-key", QWEN_IMAGE_ENDPOINT: up.url + "/gen", ...env })
  const admin = asAdmin(app, await adminLogin(app))
  await admin("/admin/api/tier", { method: "POST", body: { key: "t1", dailyUSD, monthlyUSD, model: "m" } })
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三", tier: "t1" } })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", { method: "POST", headers: { authorization: "Bearer " + li.json.access }, body: { oldPassword: add.json.initialPassword, newPassword: STRONG } })
  const gen = (body = { prompt: "a diagram" }) => app.req(IMG, { method: "POST", body, headers: { authorization: "Bearer " + chg.json.access } })
  return { up, app, gen, uid: add.json.user.id, async close() { await app.close(); await up.close() } }
}

test("extractImageUrls：两种响应结构都要认，认不出返回空数组", () => {
  assert.deepEqual(extractImageUrls(JSON.parse(okBody("u1"))), ["u1"])
  assert.deepEqual(extractImageUrls({ output: { results: [{ url: "u2" }] } }), ["u2"])
  assert.deepEqual(extractImageUrls({ output: {} }), [])
})

test("四个 Qwen Image 型号按约定价格折算，未知型号默认拒绝", () => {
  assert.equal(imageCost("qwen-image-2.0"), 0.2)
  assert.equal(imageCost("qwen-image-2.0-pro"), 0.5)
  assert.equal(imageCost("qwen-image-3.0"), 0.2)
  assert.equal(imageCost("qwen-image-3.0-pro"), 0.5)
  assert.equal(imageCost("unknown"), 0)
  assert.equal(imageCost("unknown", 0.4), 0.4)
})

test("成功生图：按 ¥0.2 记进 token 共用总账，并返回等效积分", async (t) => {
  let seen = null
  const r = await rig({ upstream: (q, res) => {
    const chunks = []; q.on("data", (c) => chunks.push(c)); q.on("end", () => {
      seen = { auth: q.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) }
      res.writeHead(200, { "content-type": "application/json" }); res.end(okBody("https://dash.example/a.png"))
    })
  } }); t.after(() => r.close())
  const x = await r.gen({ prompt: "四栏通路图", negative_prompt: "bad", size: "2048*2048" })
  assert.equal(x.status, 200); assert.deepEqual(x.json.images, ["https://dash.example/a.png"])
  assert.equal(x.json.cost, 0.2); assert.equal(x.json.credits, 20)
  assert.equal(DB.todayCost(r.app.db, r.uid), 0.2, "图片消费必须进入与 token 相同的 daily cost")
  assert.equal(r.app.db.prepare("SELECT model FROM usage_log WHERE user_id=?").get(r.uid).model, "qwen-image-2.0")
  assert.equal(seen.auth, "Bearer img-key")
  assert.equal(seen.body.parameters.prompt_extend, false)
})

test("2.0 Pro / 3.0 / 3.0 Pro 分别按对应模型价格记账", async (t) => {
  for (const [model, cost] of [["qwen-image-2.0-pro", 0.5], ["qwen-image-3.0", 0.2], ["qwen-image-3.0-pro", 0.5]]) {
    const r = await rig({ env: { QWEN_MODEL: model } }); t.after(() => r.close())
    const x = await r.gen()
    assert.equal(x.status, 200, model); assert.equal(x.json.cost, cost, model)
    assert.equal(DB.todayCost(r.app.db, r.uid), cost, model)
  }
})

test("图片与 token 共用日额度：token 已耗尽时生图被同一 QUOTA_EXCEEDED 拦住", async (t) => {
  const r = await rig({ dailyUSD: 0.2 }); t.after(() => r.close())
  DB.recordUsage(r.app.db, r.uid, { model: "m", provider: "test", cost_usd: 0.2 })
  const x = await r.gen()
  assert.equal(x.status, 429); assert.equal(x.json.error.code, "QUOTA_EXCEEDED")
  assert.equal(DB.todayCost(r.app.db, r.uid), 0.2, "被拦截的图片不能再扣费")
})

test("图片吃掉日额度后，下一次图片同样被总额度拦住（不看原 imgDaily）", async (t) => {
  const r = await rig({ dailyUSD: 0.2 }); t.after(() => r.close())
  assert.equal((await r.gen()).status, 200)
  const x = await r.gen()
  assert.equal(x.status, 429); assert.equal(x.json.error.code, "QUOTA_EXCEEDED")
})

test("上游失败或没有图片都不计入总积分", async (t) => {
  let fail = true
  const r = await rig({ upstream: (_q, res) => {
    res.writeHead(fail ? 500 : 200, { "content-type": "application/json" }); res.end(fail ? '{"message":"boom"}' : '{"output":{}}')
  } }); t.after(() => r.close())
  assert.equal((await r.gen()).json.error.code, "IMAGE_UPSTREAM_ERROR")
  assert.equal(DB.todayCost(r.app.db, r.uid), 0)
  fail = false
  assert.equal((await r.gen()).json.error.code, "IMAGE_NO_RESULT")
  assert.equal(DB.todayCost(r.app.db, r.uid), 0)
})

test("未知生图型号没有价格配置时拒绝，不能绕过总额度", async (t) => {
  const r = await rig({ env: { QWEN_MODEL: "qwen-image-future" } }); t.after(() => r.close())
  const x = await r.gen()
  assert.equal(x.status, 503); assert.equal(x.json.error.code, "IMAGE_PRICE_UNCONFIGURED")
  assert.equal(DB.todayCost(r.app.db, r.uid), 0)
})

test("QWEN_IMAGE_COST 可在供应商调价后覆盖型号内置价", async (t) => {
  const r = await rig({ env: { QWEN_MODEL: "qwen-image-future", QWEN_IMAGE_COST: "0.4" } }); t.after(() => r.close())
  const x = await r.gen()
  assert.equal(x.status, 200); assert.equal(x.json.cost, 0.4)
  assert.equal(DB.todayCost(r.app.db, r.uid), 0.4)
})
