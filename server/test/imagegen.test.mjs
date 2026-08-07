// 生图代理（/img）：认 key、按张限额、成功才计数、上游故障不冤枉用户的张数。
//
// 全程用假的 DashScope（本机 http server），不打真实生图服务、不花钱。
import test from "node:test"
import assert from "node:assert/strict"
import { startApp, adminLogin, asAdmin, startFakeUpstream } from "./helper.mjs"
import { extractImageUrls } from "../lib/imagegen.mjs"

const STRONG = "Aa1!aaaa9"
const IMG = "/img/generate"

/** 假 DashScope 的正常应答 */
const okBody = (url = "https://dash.example/img/abc.png") => JSON.stringify({
  output: { choices: [{ message: { content: [{ image: url }] } }] },
})

/** 起假上游 + app + 一个改完密的账号；imgDaily 可指定 */
async function rig({ upstream, imgDaily = 2, env = {} } = {}) {
  const up = await startFakeUpstream(upstream || ((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(okBody())
  }))
  const app = await startApp({ QWEN_API_KEY: "img-key", QWEN_IMAGE_ENDPOINT: up.url + "/gen", ...env })
  const cookie = await adminLogin(app)
  const admin = asAdmin(app, cookie)
  await admin("/admin/api/tier", { method: "POST", body: { key: "t1", dailyUSD: 5, model: "m", imgDaily } })
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三", tier: "t1" } })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: STRONG },
  })
  const access = chg.json.access
  const gen = (body = { prompt: "a diagram" }) =>
    app.req(IMG, { method: "POST", body, headers: { authorization: "Bearer " + access } })
  return { up, app, admin, access, gen, uid: add.json.user.id, async close() { await app.close(); await up.close() } }
}

test("extractImageUrls：两种响应结构都要认，认不出返回空数组", () => {
  assert.deepEqual(extractImageUrls(JSON.parse(okBody("u1"))), ["u1"])
  assert.deepEqual(extractImageUrls({ output: { results: [{ url: "u2" }] } }), ["u2"])
  assert.deepEqual(extractImageUrls({ output: {} }), [])
  assert.deepEqual(extractImageUrls(null), [])
})

test("没 key 一律挡在门外（生图跟 /llm 同一把 access key）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const x = await r.app.req(IMG, { method: "POST", body: { prompt: "x" } })
  assert.equal(x.status, 401)
  assert.equal(x.json.error.code, "KEY_MISSING")
})

test("平台没配生图 key → 503，且【不扣张数】（别让用户以为是自己画完了）", async (t) => {
  const r = await rig({ env: { QWEN_API_KEY: "" } }); t.after(() => r.close())
  const x = await r.gen()
  assert.equal(x.status, 503)
  assert.equal(x.json.error.code, "IMAGE_UNCONFIGURED")
  assert.match(x.json.error.message, /管理员/)
  // 再问一次额度：一张都不该被扣掉
  const q = await r.gen()
  assert.equal(q.json.error.code, "IMAGE_UNCONFIGURED", "还是同一个原因，不该变成'张数用完'")
})

test("出图成功：贴服务器的 key 转发，客户端拿到 URL，张数 +1", async (t) => {
  let seen = null
  const r = await rig({
    upstream: (q, res) => {
      const chunks = []
      q.on("data", (c) => chunks.push(c))
      q.on("end", () => {
        seen = { auth: q.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(okBody("https://dash.example/a.png"))
      })
    },
  })
  t.after(() => r.close())
  const x = await r.gen({ prompt: "四栏通路图", negative_prompt: "giant vertical cell on left", size: "2048*2048" })
  assert.equal(x.status, 200)
  assert.deepEqual(x.json.images, ["https://dash.example/a.png"])
  assert.deepEqual(x.json.quota, { used: 1, limit: 2, remain: 1, unlimited: false })

  assert.equal(seen.auth, "Bearer img-key", "上游拿到的是服务器的 key")
  assert.equal(seen.body.parameters.negative_prompt, "giant vertical cell on left", "负面词要透传（排版可靠性全靠它）")
  assert.equal(seen.body.parameters.prompt_extend, false, "必须关：开着会往图里加没有的分子，等于绕开反编造闸")
  assert.equal(seen.body.parameters.watermark, false)
})

test("客户端点名模型无效：单价按模型差很多，放任点名等于让它自选价格", async (t) => {
  let seen = null
  const r = await rig({
    upstream: (q, res) => {
      const chunks = []
      q.on("data", (c) => chunks.push(c))
      q.on("end", () => {
        seen = JSON.parse(Buffer.concat(chunks).toString())
        res.writeHead(200, { "content-type": "application/json" }); res.end(okBody())
      })
    },
    env: { QWEN_MODEL: "qwen-image-2.0" },
  })
  t.after(() => r.close())
  await r.gen({ prompt: "x", model: "某个更贵的模型" })
  assert.equal(seen.model, "qwen-image-2.0", "以服务器配置为准")
})

test("张数闸：free 档 2 张/天，第 3 张被拦，且带上 used/limit", async (t) => {
  const r = await rig({ imgDaily: 2 }); t.after(() => r.close())
  assert.equal((await r.gen()).json.quota.used, 1)
  assert.equal((await r.gen()).json.quota.used, 2)
  const x = await r.gen()
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "IMAGE_QUOTA_EXCEEDED")
  assert.equal(x.json.error.used, 2)
  assert.equal(x.json.error.limit, 2)
  assert.match(x.json.error.message, /2\/2/)
  assert.match(x.json.error.message, /0 点\(UTC\)/, "要说清什么时候恢复")
})

test("imgDaily=0 = 不限（与 daily_usd 同口径，别让运营记两套规则）", async (t) => {
  const r = await rig({ imgDaily: 0 }); t.after(() => r.close())
  for (let i = 0; i < 5; i++) assert.equal((await r.gen()).status, 200)
  const x = await r.gen()
  assert.equal(x.json.quota.unlimited, true)
  assert.equal(x.json.quota.remain, null, "不限时 remain 给 null 而不是 0（0 会被前端当成用尽）")
})

test("上游报错【不扣张数】——一次抖动不该白吃掉用户当天 2 张里的 1 张", async (t) => {
  let fail = true
  const r = await rig({
    upstream: (_q, res) => {
      if (fail) { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"message":"boom"}') }
      res.writeHead(200, { "content-type": "application/json" }); res.end(okBody())
    },
    imgDaily: 2,
  })
  t.after(() => r.close())
  const bad = await r.gen()
  assert.equal(bad.status, 502)
  assert.equal(bad.json.error.code, "IMAGE_UPSTREAM_ERROR")
  fail = false
  const good = await r.gen()
  assert.equal(good.json.quota.used, 1, "刚才那次失败不该计数")
})

test("上游 200 但没有图 → 不扣张数，并明说'本次不计入'", async (t) => {
  const r = await rig({
    upstream: (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"output":{}}') },
  })
  t.after(() => r.close())
  const x = await r.gen()
  assert.equal(x.json.error.code, "IMAGE_NO_RESULT")
  assert.match(x.json.error.message, /不计入/)
})

test("上游自己额度耗尽 → 说清是平台的事，别让用户以为自己张数没了", async (t) => {
  const r = await rig({
    upstream: (_q, res) => {
      res.writeHead(429, { "content-type": "application/json" })
      res.end('{"message":"Allocated quota exceeded"}')
    },
  })
  t.after(() => r.close())
  const x = await r.gen()
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "IMAGE_UPSTREAM_QUOTA")
  assert.match(x.json.error.message, /不是你的张数/)
  assert.match(x.json.error.message, /没有被扣/)
})

test("只认 POST /img/generate，别的路径老实回 404/405", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const a = await r.app.req("/img/other", { method: "POST", body: {}, headers: { authorization: "Bearer " + r.access } })
  assert.equal(a.status, 404)
  const b = await r.app.req(IMG, { method: "GET", headers: { authorization: "Bearer " + r.access } })
  assert.equal(b.status, 405)
})

test("缺 prompt → 400（在闸之后、转发之前拦住，不浪费一张）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const x = await r.gen({ prompt: "   " })
  assert.equal(x.status, 400)
  const ok = await r.gen()
  assert.equal(ok.json.quota.used, 1, "刚才那次没扣张数")
})

test("张数按用户各算各的，互不影响", async (t) => {
  const r = await rig({ imgDaily: 2 }); t.after(() => r.close())
  await r.gen(); await r.gen()
  assert.equal((await r.gen()).json.error.code, "IMAGE_QUOTA_EXCEEDED")

  const add = await r.admin("/admin/api/user-add", { method: "POST", body: { username: "lisi", displayName: "李四", tier: "t1" } })
  const li = await r.app.req("/api/auth/login", { method: "POST", body: { username: "lisi", password: add.json.initialPassword } })
  const chg = await r.app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: STRONG },
  })
  const x = await r.app.req(IMG, { method: "POST", body: { prompt: "x" }, headers: { authorization: "Bearer " + chg.json.access } })
  assert.equal(x.status, 200, "另一个人的额度是干净的")
  assert.equal(x.json.quota.used, 1)
})

test("改档位的张数立刻生效（现查库，不进 access key、不用重登）", async (t) => {
  const r = await rig({ imgDaily: 1 }); t.after(() => r.close())
  assert.equal((await r.gen()).status, 200)
  assert.equal((await r.gen()).json.error.code, "IMAGE_QUOTA_EXCEEDED")
  await r.admin("/admin/api/tier", { method: "POST", body: { key: "t1", dailyUSD: 5, model: "m", imgDaily: 3 } })
  assert.equal((await r.gen()).status, 200, "同一把 key，下一次调用就按新张数判")
})

test("后台改档位时【不传】imgDaily → 保留原值，不许静默变成不限", async (t) => {
  const r = await rig({ imgDaily: 2 }); t.after(() => r.close())
  // 只改备注，不带 imgDaily（老版本管理台/脚本就是这么发的）。
  // 【其余字段必须原样带回】改动 daily_usd/model/skills 任一项都会 bumpEpoch 吊销该档全体
  // 用户的 key，下面的调用就会 401 而不是走到张数闸——那样测的就不是本用例要测的东西了。
  await r.admin("/admin/api/tier", { method: "POST", body: { key: "t1", dailyUSD: 5, model: "m", note: "改个备注" } })
  await r.gen(); await r.gen()
  const x = await r.gen()
  assert.equal(x.json.error.code, "IMAGE_QUOTA_EXCEEDED", "漏传字段就把限额抹成 0，是个纯靠疏忽产生的烧钱洞")
})
