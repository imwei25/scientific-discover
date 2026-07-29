// 上游通道管理：对着一个假 one-api 验，不打真服务。
import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import * as OneAPI from "../lib/oneapi.mjs"
import { startApp, adminLogin, asAdmin } from "./helper.mjs"

/** 假 one-api：记录收到的请求，按脚本回响应 */
function fakeOneApi(channels, opts = {}) {
  const seen = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "null") } catch {}
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      const send = (obj, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)) }
      if (opts.brokenJson) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>登录页</html>") }
      if (opts.reject) return send({ success: false, message: "无权限" })
      if (req.method === "GET" && req.url.startsWith("/api/channel/test/")) return send({ success: true, message: "", data: { time: 0.42 } })
      if (req.method === "GET" && req.url.startsWith("/api/channel/")) return send({ success: true, data: channels })
      if (req.method === "PUT" && req.url === "/api/channel/") {
        const c = channels.find((x) => x.id === body.id)
        if (c) Object.assign(c, body)
        return send({ success: true, data: c })
      }
      send({ success: false, message: "没这个接口" }, 404)
    })
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    srv, seen, channels,
    cfg: { url: `http://127.0.0.1:${srv.address().port}`, token: "sys-token" },
    close: () => new Promise((x) => srv.close(x)),
  })))
}

const CH = () => ([
  { id: 1, name: "DeepSeek", type: 1, status: 1, priority: 0, weight: 1, group: "default", base_url: "https://api.deepseek.com", models: "deepseek-v4-pro" },
  { id: 2, name: "硅基流动", type: 1, status: 1, priority: 0, weight: 1, group: "default", base_url: "https://api.siliconflow.cn/v1", models: "deepseek-v4-pro,deepseek-ai/DeepSeek-V4-Flash" },
  { id: 3, name: "备用停用的", type: 1, status: 2, priority: 5, weight: 1, group: "default", base_url: "", models: "deepseek-v4-pro" },
])

test("enabled：地址与令牌缺一不可", () => {
  assert.equal(OneAPI.enabled({ url: "http://x", token: "t" }), true)
  assert.equal(OneAPI.enabled({ url: "http://x", token: "" }), false)
  assert.equal(OneAPI.enabled({ url: "", token: "t" }), false)
  assert.equal(OneAPI.enabled(null), false)
})

test("listChannels：解析通道，并按模型名整理出默认/备用次序", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  const r = await OneAPI.listChannels(f.cfg)
  assert.equal(r.ok, true)
  assert.equal(r.channels.length, 3)
  assert.deepEqual(r.channels[1].models, ["deepseek-v4-pro", "deepseek-ai/DeepSeek-V4-Flash"])
  assert.equal(r.channels[2].statusText, "已停用")
  // deepseek-v4-pro 下三条都挂了，按优先级倒序
  const list = r.byModel["deepseek-v4-pro"]
  assert.equal(list.length, 3)
  assert.equal(list[0].name, "备用停用的", "优先级 5 排最前（虽然它是停用的，前端另按 status 过滤）")
  // 只有 2 号挂了 Flash
  assert.deepEqual(r.byModel["deepseek-ai/DeepSeek-V4-Flash"].map((x) => x.id), [2])
  // 带上了管理令牌
  assert.equal(f.seen[0].headers.authorization, "Bearer sys-token")
  assert.equal(f.seen[0].headers["new-api-user"], "1")
})

test("updateChannel：只发允许改的字段，绝不碰 key / base_url", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  const r = await OneAPI.updateChannel(f.cfg, { id: 1, priority: 7, status: 1 })
  assert.equal(r.ok, true)
  const put = f.seen.find((x) => x.method === "PUT")
  assert.deepEqual(Object.keys(put.body).sort(), ["id", "priority", "status"])
  assert.equal(put.body.priority, 7)
  assert.equal("key" in put.body, false, "绝不能把 key 一起 PUT 上去（会被清空）")
  assert.equal("base_url" in put.body, false)
})

test("updateChannel：status 只认 1/2，别的一律当停用", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  await OneAPI.updateChannel(f.cfg, { id: 1, status: 99 })
  assert.equal(f.seen.find((x) => x.method === "PUT").body.status, 2)
})

test("updateChannel：通道不存在时明确报错", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  const r = await OneAPI.updateChannel(f.cfg, { id: 999, priority: 1 })
  assert.equal(r.ok, false)
  assert.match(r.err, /不存在/)
})

test("makeDefault：把自己抬到同模型的最高优先级之上", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  // deepseek-v4-pro 下最高是 5（3 号），把 1 号设为默认应得 6
  const r = await OneAPI.makeDefault(f.cfg, 1, "deepseek-v4-pro")
  assert.equal(r.ok, true)
  assert.equal(r.priority, 6)
  assert.equal(f.channels.find((c) => c.id === 1).priority, 6)
  // 别人的优先级不该被动
  assert.equal(f.channels.find((c) => c.id === 3).priority, 5)
  assert.equal(f.channels.find((c) => c.id === 2).priority, 0)
})

test("makeDefault：已经是最高就不做无谓的写入", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  const r = await OneAPI.makeDefault(f.cfg, 3, "deepseek-v4-pro")
  assert.equal(r.ok, true)
  assert.equal(r.unchanged, true)
  assert.equal(f.seen.some((x) => x.method === "PUT"), false, "不该发 PUT")
})

test("makeDefault：该模型只有自己时也能设（优先级抬到 1）", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  const r = await OneAPI.makeDefault(f.cfg, 2, "deepseek-ai/DeepSeek-V4-Flash")
  assert.equal(r.ok, true)
  assert.equal(r.priority, 1)
})

test("testChannel：走 one-api 自己的实测接口", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  const r = await OneAPI.testChannel(f.cfg, 2)
  assert.equal(r.ok, true)
  assert.match(f.seen.at(-1).url, /\/api\/channel\/test\/2$/)
})

test("one-api 拒绝 / 返回非 JSON / 连不上：都给人话错误而不是抛异常", async (t) => {
  const rej = await fakeOneApi(CH(), { reject: true }); t.after(() => rej.close())
  let r = await OneAPI.listChannels(rej.cfg)
  assert.equal(r.ok, false); assert.match(r.err, /无权限/)

  const bad = await fakeOneApi(CH(), { brokenJson: true }); t.after(() => bad.close())
  r = await OneAPI.listChannels(bad.cfg)
  assert.equal(r.ok, false); assert.match(r.err, /不是 JSON/)

  r = await OneAPI.listChannels({ url: "http://127.0.0.1:1", token: "t" })
  assert.equal(r.ok, false); assert.match(r.err, /连不上/)

  r = await OneAPI.listChannels({ url: "不是地址", token: "t" })
  assert.equal(r.ok, false); assert.match(r.err, /地址配置有误/)
})

// ---- 后台接口 ----
test("后台：没配 one-api 时明确说未接入，而不是报错", async (t) => {
  const app = await startApp(); t.after(() => app.close())
  const admin = asAdmin(app, await adminLogin(app))
  const r = await admin("/admin/api/channels")
  assert.equal(r.status, 200)
  assert.equal(r.json.enabled, false)
  assert.match(r.json.err, /ONEAPI_URL/)
})

test("后台：列通道时带上各档位在用的模型名与单价（供运营判断谁能兜底）", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  const app = await startApp({ ONEAPI_URL: f.cfg.url, ONEAPI_TOKEN: "sys-token" })
  t.after(() => app.close())
  const admin = asAdmin(app, await adminLogin(app))
  await admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 1, model: "deepseek-v4-pro" } })

  const r = await admin("/admin/api/channels")
  assert.equal(r.json.enabled, true)
  assert.equal(r.json.channels.length, 3)
  assert.ok(r.json.byModel["deepseek-v4-pro"])
  assert.ok(r.json.tierModels.some((t) => t.key === "plus" && t.model === "deepseek-v4-pro"))
  assert.equal(typeof r.json.priceNote.input, "number")
})

test("后台：设默认 / 改优先级 / 停用 / 实测 都能打通并留审计", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  const app = await startApp({ ONEAPI_URL: f.cfg.url, ONEAPI_TOKEN: "sys-token" })
  t.after(() => app.close())
  const admin = asAdmin(app, await adminLogin(app))

  let r = await admin("/admin/api/channel", { method: "POST", body: { action: "default", id: 1, model: "deepseek-v4-pro" } })
  assert.equal(r.json.ok, true)
  assert.equal(f.channels.find((c) => c.id === 1).priority, 6)

  r = await admin("/admin/api/channel", { method: "POST", body: { id: 2, priority: 3 } })
  assert.equal(r.json.ok, true)
  assert.equal(f.channels.find((c) => c.id === 2).priority, 3)

  r = await admin("/admin/api/channel", { method: "POST", body: { id: 2, status: 2 } })
  assert.equal(r.json.ok, true)
  assert.equal(f.channels.find((c) => c.id === 2).status, 2)

  r = await admin("/admin/api/channel", { method: "POST", body: { action: "test", id: 1 } })
  assert.equal(r.json.ok, true)

  const ev = (await admin("/admin/api/audit")).json.rows.map((x) => x.event)
  assert.ok(ev.includes("channel.default"))
  assert.ok(ev.includes("channel.update"))
  assert.ok(ev.includes("channel.test"))
})

test("后台：未登录不能碰通道", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  const app = await startApp({ ONEAPI_URL: f.cfg.url, ONEAPI_TOKEN: "sys-token" })
  t.after(() => app.close())
  assert.equal((await app.req("/admin/api/channels")).status, 401)
  assert.equal((await app.req("/admin/api/channel", { method: "POST", body: { id: 1, priority: 9 } })).status, 401)
  assert.equal(f.seen.length, 0)
})

// ---- 让通道兜底某模型（"默认不通走备用"真正成立的那一步）----
// 专供 serveModel：2 号【只】挂 Flash，即现网的真实形态（两条通道互不兜底）
const CH2 = () => CH().map((c) => (c.id === 2 ? { ...c, models: "deepseek-ai/DeepSeek-V4-Flash" } : c))

test("serveModel：给通道挂上目标模型名 + 改名规则，并挂成备用", async (t) => {
  const f = await fakeOneApi(CH2()); t.after(() => f.close())
  // 2 号（硅基流动）目前不挂 deepseek-v4-pro，所以它对该模型根本不构成备用
  const r = await OneAPI.serveModel(f.cfg, { id: 2, model: "deepseek-v4-pro", mapTo: "deepseek-ai/DeepSeek-V4-Flash" })
  assert.equal(r.ok, true)
  assert.ok(r.models.includes("deepseek-v4-pro"))
  assert.equal(r.mapping["deepseek-v4-pro"], "deepseek-ai/DeepSeek-V4-Flash")
  const put = f.seen.filter((x) => x.method === "PUT").at(-1)
  assert.equal(JSON.parse(put.body.model_mapping)["deepseek-v4-pro"], "deepseek-ai/DeepSeek-V4-Flash")
  // 现有最高是 3 号的 5 → 备用取 4，严格低于默认
  assert.equal(r.priority, 4)
})

test("serveModel：现任默认优先级为 0 时，先把它抬到 1，自己留 0（否则变成随机分流）", async (t) => {
  const chans = CH2().filter((c) => c.id !== 3)   // 只剩 1 号(0) 与 2 号(0)，且 2 号不挂目标模型
  const f = await fakeOneApi(chans); t.after(() => f.close())
  const r = await OneAPI.serveModel(f.cfg, { id: 2, model: "deepseek-v4-pro" })
  assert.equal(r.ok, true)
  assert.equal(r.priority, 0, "自己当备用")
  assert.equal(chans.find((c) => c.id === 1).priority, 1, "现任默认被抬到 1")
})

test("serveModel：已经挂了就明确拒绝；模型名为空也拒绝", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  let r = await OneAPI.serveModel(f.cfg, { id: 1, model: "deepseek-v4-pro" })
  assert.equal(r.ok, false); assert.match(r.err, /已经挂了/)
  r = await OneAPI.serveModel(f.cfg, { id: 1, model: "  " })
  assert.equal(r.ok, false); assert.match(r.err, /模型名/)
})

test("serveModel：不传 mapTo 就不写改名规则（表示同名）", async (t) => {
  const f = await fakeOneApi(CH()); t.after(() => f.close())
  const r = await OneAPI.serveModel(f.cfg, { id: 2, model: "some-model" })
  assert.equal(r.ok, true)
  assert.deepEqual(r.mapping, {}, "原本没有 mapping，也不该凭空造一条")
})

test("后台：serve 动作打通并留审计", async (t) => {
  const f = await fakeOneApi(CH2()); t.after(() => f.close())
  const app = await startApp({ ONEAPI_URL: f.cfg.url, ONEAPI_TOKEN: "sys-token" })
  t.after(() => app.close())
  const admin = asAdmin(app, await adminLogin(app))
  const r = await admin("/admin/api/channel", { method: "POST", body: { action: "serve", id: 2, model: "deepseek-v4-pro", mapTo: "deepseek-ai/DeepSeek-V4-Flash" } })
  assert.equal(r.json.ok, true)
  assert.ok(f.channels.find((c) => c.id === 2).models.includes("deepseek-v4-pro"))
  assert.ok((await admin("/admin/api/audit")).json.rows.some((x) => x.event === "channel.serve"))
})
