// 桌面版云端账号在网关进程里的接线：/api/cloud/* 与 /cloud/* 转发。
// 三层都是真的：假上游模型 ← sci-auth（内存库）← 本机网关（不接管 opencode）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

let seq = 0

/** 假上游模型服务 */
function fakeUpstream(handler) {
  const srv = http.createServer(handler)
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    srv, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((x) => srv.close(x)),
  })))
}

/** 起 sci-auth + 建好一个改完密的账号 */
async function cloudBackend(upstreamUrl) {
  const prev = { ...process.env }
  Object.assign(process.env, {
    DB_FILE: ":memory:", LISTEN: "127.0.0.1:0", ADMIN_PASSWORD: "adminpw",
    KEY_SECRET: "route-" + (++seq), LLM_UPSTREAM_KEY: "up-key", LLM_UPSTREAM_URL: upstreamUrl,
    DATA_DIR: "", TEST_BYPASS_TOKEN: "t-bypass",
  })
  const mod = await import(`../../server/sci-auth.mjs?r=${seq}`)
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
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三", tier: "plus" } })
  return { base, req, admin, db: mod.db, user: { id: add.json.user.id, username: "zhangsan", pw0: add.json.initialPassword, pw: "Route!test2026" }, close: () => new Promise((r) => mod.server.close(r)) }
}

/** 起本机网关进程（不接管 opencode，配置文件都落临时目录） */
async function gateway(cloudUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webgw-"))
  const prev = { ...process.env }
  Object.assign(process.env, {
    MANAGE_OC: "0", PORT: "0", AUTH_ENABLED: "",
    OC_URL: "http://127.0.0.1:1",                 // 不会去连
    SCI_CLOUD_URL: cloudUrl,
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),   // 别读到开发机真实的 cloud.json
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    // 不设这个的话，测试实例会读写【开发机真实的】web/sessions-meta.json（它还在版本控制里），
    // 跑一次测试就把本机的会话→项目归属清空。server.mjs 那边的注释早就提醒过，这里漏了。
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
  })
  const mod = await import(`../server.mjs?g=${++seq}`)
  // server.mjs 自己会 listen(PORT)，PORT=0 时端口由系统分配；等它真的绑上再往下走
  let port
  for (let i = 0; i < 200; i++) {
    port = mod.server?.address()?.port
    if (port) break
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!port) throw new Error("网关没起来（10 秒内没绑上端口）")
  process.env = prev
  // 供运行时读取
  process.env.SCI_CLOUD_URL = cloudUrl
  process.env.CLOUD_STATE_PATH = path.join(dir, "cloud-state.json")
  process.env.CLOUD_CFG_PATH = path.join(dir, "no-such-cloud.json")
  process.env.MODEL_CFG_PATH = path.join(dir, "model-config.json")
  process.env.OC_CONFIG_PATH = path.join(dir, "opencode.json")
  const base = `http://127.0.0.1:${port}`
  return {
    base, dir, mod,
    close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())),
    cfg: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "model-config.json"), "utf8")) } catch { return null } },
    async req(p, { method = "GET", body, headers = {} } = {}) {
      const h = { ...headers }; if (body !== undefined) h["content-type"] = "application/json"
      const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await r.text()
      let js = null; try { js = JSON.parse(text) } catch {}
      return { status: r.status, json: js, text }
    },
  }
}

async function rig(upstream) {
  const up = await fakeUpstream(upstream || ((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ model: "tier-model", choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } }))
  }))
  const be = await cloudBackend(up.url)
  const gw = await gateway(be.base)
  return { up, be, gw, close: async () => { await gw.close(); await be.close(); await up.close() } }
}

/** 登录 + 改密，让网关进入 cloud 路由 */
async function loginReady(r) {
  await r.gw.req("/api/cloud/login", { method: "POST", body: { username: r.be.user.username, password: r.be.user.pw0 } })
  return r.gw.req("/api/cloud/password", { method: "POST", body: { oldPassword: r.be.user.pw0, newPassword: r.be.user.pw } })
}

test("未登录：status 报未登录，route=none", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const s = await r.gw.req("/api/cloud/status")
  assert.equal(s.json.loggedIn, false)
  assert.equal(s.json.configured, true)
  assert.equal(s.json.route, "none")
})

test("登录 → 强制改密 → 进入 cloud 路由，provider 指向本机代理", async (t) => {
  const r = await rig(); t.after(() => r.close())
  let x = await r.gw.req("/api/cloud/login", { method: "POST", body: { username: "zhangsan", password: r.be.user.pw0 } })
  assert.equal(x.status, 200)
  assert.equal(x.json.loggedIn, true)
  assert.equal(x.json.mustChangePassword, true)

  x = await loginReady(r)
  assert.equal(x.json.mustChangePassword, false)
  assert.equal(x.json.route, "cloud")

  const cfg = r.gw.cfg()
  assert.equal(cfg.route, "cloud")
  assert.match(cfg.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/cloud\/v1$/, "opencode 该指向本机代理")
  assert.equal(cfg.modelID, "tier-model", "模型名取自云端档位")
  assert.match(cfg.apiKey, /^local-/, "provider 里放的是本机占位令牌，不是真 access key")
})

test("登录失败：给结构化错误，不进 cloud 路由", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const x = await r.gw.req("/api/cloud/login", { method: "POST", body: { username: "zhangsan", password: "wrong" } })
  assert.equal(x.json.ok, false)
  assert.equal(x.json.code, "BAD_CREDENTIALS")
  assert.equal((await r.gw.req("/api/cloud/status")).json.route, "none")
})

test("/cloud 转发：本机占位令牌不对就拒；对了才转，并贴上真 access key", async (t) => {
  let seen = null
  const r = await rig((q, res) => {
    seen = { auth: q.headers.authorization, url: q.url }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ model: "tier-model", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }))
  })
  t.after(() => r.close())
  await loginReady(r)
  const localTok = r.gw.cfg().apiKey

  let x = await r.gw.req("/cloud/v1/chat/completions", { method: "POST", body: { model: "x" }, headers: { authorization: "Bearer wrong" } })
  assert.equal(x.status, 401)
  assert.equal(seen, null, "令牌不对时一个字节都不该发出去")

  x = await r.gw.req("/cloud/v1/chat/completions", {
    method: "POST", body: { model: "客户端乱传", messages: [] },
    headers: { authorization: "Bearer " + localTok, "x-skill": "write-paper" },
  })
  assert.equal(x.status, 200)
  assert.equal(seen.url, "/v1/chat/completions", "sci-auth 把 /llm 剥掉后转给上游")
  assert.equal(seen.auth, "Bearer up-key", "上游拿到的是 sci-auth 的上游 key")

  // 计量落到了云端账号头上
  const usage = await r.be.admin("/admin/api/user-usage?id=" + r.be.user.id)
  assert.equal(usage.json.detail.length, 1)
  assert.equal(usage.json.detail[0].skill, "write-paper")
})

test("access key 过期：转发时自动续一次并重试，调用方无感", async (t) => {
  let hits = 0
  const r = await rig((_q, res) => {
    hits++
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  t.after(() => r.close())
  await loginReady(r)
  const localTok = r.gw.cfg().apiKey

  // 把本地缓存的 access 换成一把【已过期】的：转发会拿到 401 KEY_EXPIRED → 强制续期 → 重试
  const statePath = process.env.CLOUD_STATE_PATH
  const st = JSON.parse(fs.readFileSync(statePath, "utf8"))
  const bad = { ...st, access: st.access.slice(0, -3) + "xxx", accessExp: Date.now() + 3600_000 }
  fs.writeFileSync(statePath, JSON.stringify(bad))

  const x = await r.gw.req("/cloud/v1/chat/completions", {
    method: "POST", body: { model: "x" }, headers: { authorization: "Bearer " + localTok },
  })
  assert.equal(x.status, 200, "应当续期后重试成功：" + x.text)
  assert.equal(hits, 1, "上游只该真正被调用一次")
  const after = JSON.parse(fs.readFileSync(statePath, "utf8"))
  assert.notEqual(after.access, bad.access, "access 已换新")
})

test("账号被停用：转发回 403，本地照实报错而不是装作没事", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)
  const localTok = r.gw.cfg().apiKey
  await r.be.admin("/admin/api/suspend", { method: "POST", body: { id: r.be.user.id, suspended: true } })

  const x = await r.gw.req("/cloud/v1/chat/completions", {
    method: "POST", body: { model: "x" }, headers: { authorization: "Bearer " + localTok },
  })
  assert.equal([401, 403].includes(x.status), true, "状态码=" + x.status + " 体=" + x.text)
  assert.match(x.text, /停用|重新登录|失效/)
})

test("额度用尽：429 与结构化错误码原样透传给客户端", async (t) => {
  const r = await rig((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 40_000_000, completion_tokens: 0 } }))
  })
  t.after(() => r.close())
  await loginReady(r)
  const localTok = r.gw.cfg().apiKey
  const H = { authorization: "Bearer " + localTok }
  assert.equal((await r.gw.req("/cloud/v1/chat/completions", { method: "POST", body: { model: "x" }, headers: H })).status, 200)
  const x = await r.gw.req("/cloud/v1/chat/completions", { method: "POST", body: { model: "x" }, headers: H })
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "QUOTA_EXCEEDED")
  assert.equal(x.json.error.scope, "daily")
})

test("流式：SSE 原样透传", async (t) => {
  const body = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n" +
               "data: {\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n"
  const r = await rig((_q, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(body) })
  t.after(() => r.close())
  await loginReady(r)
  const x = await r.gw.req("/cloud/v1/chat/completions", {
    method: "POST", body: { model: "x", stream: true }, headers: { authorization: "Bearer " + r.gw.cfg().apiKey },
  })
  assert.equal(x.status, 200)
  assert.equal(x.text, body, "逐字节一致")
})

test("登出：回到 none 路由，provider 被清掉", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)
  assert.equal((await r.gw.req("/api/cloud/status")).json.route, "cloud")

  const x = await r.gw.req("/api/cloud/logout", { method: "POST", body: {} })
  assert.equal(x.json.ok, true)
  assert.equal(x.json.loggedIn, false)
  assert.equal(x.json.route, "none")
  assert.equal(r.gw.cfg(), null, "自设配置应被清掉")
})

test("自设 API 优先于云端账号；切回后又回到 cloud", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)

  let x = await r.gw.req("/api/model", { method: "POST", body: { baseURL: "https://my.api.com", apiKey: "sk-mine", modelID: "my-model" } })
  assert.equal(x.json.ok, true)
  assert.equal(r.gw.cfg().route, "custom")
  assert.equal((await r.gw.req("/api/model")).json.route, "custom")

  x = await r.gw.req("/api/model/reset", { method: "POST", body: {} })
  assert.equal(x.json.route, "cloud", "切回应回到云端账号，而不是内置默认")
  assert.match(r.gw.cfg().baseURL, /\/cloud\/v1$/)
})

// ---- 模型清单与切换（管理员在后台加了模型，打包版不用重装就能选到）----

/** 给后端挂一家供应商 + 一个模型，并勾进 plus 档位的允许清单 */
async function offerModel(be, { model = "fast", label = "快模型", provider = "sf", providerName = "硅基流动" } = {}) {
  await be.admin("/admin/api/provider", { method: "POST", body: { key: provider, name: providerName, baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-x" } })
  await be.admin("/admin/api/model", { method: "POST", body: { items: [{ model, provider, label, priceIn: 0.5, priceOut: 1, priceCached: 0.1 }] } })
  await be.admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 5, model: "tier-model", models: model } })
}

test("模型清单来自服务器：后台加了模型 → 刷新档案就能选到（不用重装、也不用重新登录）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)

  let m = await r.gw.req("/api/models")
  assert.equal(m.json.route, "cloud")
  assert.deepEqual(m.json.models.map((x) => x.model), ["tier-model"], "一开始只有档位默认模型")

  await offerModel(r.be)
  // 客户端主动刷一次档案（界面上就是账号面板的「刷新」）
  const rf = await r.gw.req("/api/cloud/refresh", { method: "POST", body: {} })
  assert.equal(rf.json.ok, true, JSON.stringify(rf.json))

  m = await r.gw.req("/api/models")
  assert.deepEqual(m.json.models.map((x) => x.model), ["tier-model", "fast"])
  assert.equal(m.json.models[1].label, "快模型")
  assert.equal(m.json.models[1].provider, "硅基流动")
})

test("切模型：云端账号形态下能切，选中的模型跨重启保住", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)
  await offerModel(r.be)
  await r.gw.req("/api/cloud/refresh", { method: "POST", body: {} })

  const x = await r.gw.req("/api/model/pick", { method: "POST", body: { model: "fast" } })
  assert.equal(x.json.ok, true, JSON.stringify(x.json))
  assert.equal(x.json.modelID, "fast")

  const cfg = r.gw.cfg()
  assert.equal(cfg.route, "cloud", "切模型不该把路由掰成 custom —— 那会变成不计平台额度")
  assert.match(cfg.baseURL, /\/cloud\/v1$/, "仍然经本机代理走平台，key 还是本机占位令牌")
  assert.equal(cfg.modelID, "fast")
  assert.equal(cfg.picked, "fast", "选择要落盘，否则一重启就跳回默认模型")
  assert.equal((await r.gw.req("/api/models")).json.current, "fast")
})

test("切模型：档位没开通的模型当场拒绝，并说清原因", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)
  const x = await r.gw.req("/api/model/pick", { method: "POST", body: { model: "gpt-9" } })
  assert.equal(x.status, 400)
  assert.equal(x.json.ok, false)
  assert.match(x.json.err, /没有开通|联系管理员/)
})

test("管理员撤掉某模型：刷新档案后本机自动落回默认模型，不会一直请求一个已被撤销的模型", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)
  await offerModel(r.be)
  await r.gw.req("/api/cloud/refresh", { method: "POST", body: {} })
  await r.gw.req("/api/model/pick", { method: "POST", body: { model: "fast" } })
  assert.equal(r.gw.cfg().modelID, "fast")

  // 后台把它从档位允许清单里去掉
  await r.be.admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 5, model: "tier-model", models: "" } })
  const rf = await r.gw.req("/api/cloud/refresh", { method: "POST", body: {} })
  assert.equal(rf.json.ok, true)
  assert.equal(r.gw.cfg().modelID, "tier-model", "应当自动落回默认模型")
  assert.deepEqual((await r.gw.req("/api/models")).json.models.map((x) => x.model), ["tier-model"])
})

// ---- 云端排队（并发满时前端要能显示"等一下、你排第几"）----

test("云端并发满：排队期间能问到自己的位次；等超时回结构化 503", async (t) => {
  const gate = []                       // 每个元素 = 放这一单过去的函数
  const r = await rig((req, res) => {
    req.resume()
    req.on("end", () => gate.push(() => {
      if (res.writableEnded) return
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    }))
  })
  t.after(async () => { gate.forEach((f) => f()); await r.close() })
  await loginReady(r)
  // 后台把全站并发压到 1、最长等待 4 秒
  const lim = await r.be.admin("/admin/api/limits", { method: "POST", body: { maxConcurrent: 1, maxWaitMs: 4000 } })
  assert.equal(lim.status, 200)

  const CHAT = "/cloud/v1/chat/completions"
  const H = { authorization: "Bearer " + r.gw.cfg().apiKey }
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((x) => setTimeout(x, 25)) }
    return false
  }
  const p1 = r.gw.req(CHAT, { method: "POST", body: { model: "x" }, headers: H })
  assert.ok(await until(() => gate.length === 1), "第一单该直接到上游")

  const p2 = r.gw.req(CHAT, { method: "POST", body: { model: "x" }, headers: H })
  // 这就是前端"正在排队，前面还有 N 个"的数据来源（本机网关每两秒问一次同一个口）
  const Cloud = await import("../cloud-account.mjs")
  assert.ok(await until(async () => {
    const q = await Cloud.fetchQueue()
    return q.ok && q.queue && q.queue.waitingMine === 1
  }), "排队中应当问得到自己在队里")
  const snap = (await Cloud.fetchQueue()).queue
  assert.equal(snap.position, 1)
  assert.equal(snap.running, 1)
  assert.equal(snap.limit, 1)
  assert.equal(gate.length, 1, "排队期间一个字节都不该到上游")

  // 本机网关自己的探测器也该已经认出"在排队"：它据此给前端推 queue 事件、给首输出看门狗续命
  // （不续命的话排队超过 180 秒会被误判成"模型服务不可达"而中止本轮）
  assert.ok(await until(() => {
    const st = r.gw.mod.cloudQueueState()
    return st.blocking && st.last && st.last.queued
  }), "本机探测器应当探到排队状态：" + JSON.stringify(r.gw.mod.cloudQueueState()))
  assert.equal(r.gw.mod.cloudQueueState().last.position, 1)

  const x2 = await p2                    // 等不到位子 → 明确失败，而不是无声地悬着
  assert.equal(x2.status, 503)
  assert.equal(x2.json.error.code, "QUEUE_TIMEOUT")
  gate[0]()
  assert.equal((await p1).status, 200)
})

// ---- 上游报错要说人话（此前是"空气泡"）----

test("上游错误翻成人话：余额不足/密钥失效/限流各给各的下一步动作", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const D = r.gw.mod.describeModelError
  // opencode 把 provider 错误挂在助手消息的 error 上（APIError.data.statusCode/message）
  const balance = D({ name: "APIError", data: { statusCode: 402, message: "Insufficient Balance" } }, "cloud")
  assert.match(balance, /余额不足|欠费/)
  assert.match(balance, /联系管理员/, "走平台的用户改不了上游，只能找管理员")
  assert.match(balance, /Insufficient Balance/, "上游原话要带上，便于排查")

  // 有些家不给 statusCode，只在正文里说 —— 也要认出来
  assert.match(D({ name: "UnknownError", data: { message: "account balance is not enough" } }, "cloud"), /余额不足|欠费/)

  assert.match(D({ name: "ProviderAuthError", data: { message: "invalid api key" } }, "custom"), /密钥/)
  assert.match(D({ name: "ProviderAuthError", data: { message: "invalid api key" } }, "custom"), /api-config/, "用自己 API 的用户该被指到自查入口")
  assert.match(D({ name: "APIError", data: { statusCode: 429, message: "rate limit" } }, "cloud"), /限流|额度/)
  // 云端排队排不上、上游限速：既不是配置问题也不是故障，别把人指去 api-config 白折腾
  const qt = D({ name: "APIError", data: { statusCode: 503, message: '{"error":{"code":"QUEUE_TIMEOUT"}}' } }, "custom")
  assert.match(qt, /排队/)
  assert.doesNotMatch(qt, /api-config/)
  assert.match(D({ name: "APIError", data: { statusCode: 503, message: '{"error":{"code":"QUEUE_FULL"}}' } }, "cloud"), /排队|人太多/)
  assert.match(D({ name: "APIError", data: { statusCode: 429, message: '{"error":{"code":"UPSTREAM_RATE_LIMITED"}}' } }, "cloud"), /限速/)
  assert.match(D({ name: "APIError", data: { statusCode: 503, message: "" } }, "cloud"), /异常|重试/)
  assert.match(D({ name: "MessageOutputLengthError", data: {} }, "cloud"), /长度上限|截断/)
  // 兜底也必须是一句完整的话，不能是空字符串（空 = 又回到"空气泡"）
  assert.equal(D({ name: "UnknownError", data: {} }, "cloud").length > 10, true)
})

// ---- 平台公告 ----------------------------------------------------------------

test("公告：未登录不打云端、直接回空", async (t) => {
  const r = await rig(); t.after(() => r.close())
  // 把云端整个关掉，证明这条路径压根没往外发请求
  await r.be.close()
  const n = await r.gw.req("/api/cloud/notice")
  assert.equal(n.status, 200)
  assert.equal(n.json.ok, true)
  assert.equal(n.json.notice, null)
})

test("公告：登录后拿到站长发布的那条，含最低版本判定", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.be.admin("/admin/api/notice", { method: "POST", body: {
    enabled: true, text: "今晚 22:00 维护", level: "warn", minClientVersion: "99.0.0" } })
  await loginReady(r)
  const n = await r.gw.req("/api/cloud/notice")
  assert.equal(n.json.notice.text, "今晚 22:00 维护")
  assert.equal(n.json.notice.level, "warn")
  // 本机 APP_VERSION 没注入时上报的是 "dev" —— 认不出版本就不催升级
  assert.equal(n.json.needUpgrade, false)
  assert.equal(n.json.clientVersion, "dev")
})

test("公告：本机 60 秒缓存，手点「刷新」立刻穿透", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.be.admin("/admin/api/notice", { method: "POST", body: { enabled: true, text: "第一版" } })
  await loginReady(r)
  assert.equal((await r.gw.req("/api/cloud/notice")).json.notice.text, "第一版")

  await r.be.admin("/admin/api/notice", { method: "POST", body: { enabled: true, text: "第二版" } })
  assert.equal((await r.gw.req("/api/cloud/notice")).json.notice.text, "第一版", "缓存内不该每次都打云端")

  await r.gw.req("/api/cloud/refresh", { method: "POST" })
  assert.equal((await r.gw.req("/api/cloud/notice")).json.notice.text, "第二版")
})

test("公告：云端拉不到时保留上一份（把已显示的维护通知抹掉比留着旧的更糟）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.be.admin("/admin/api/notice", { method: "POST", body: { enabled: true, text: "维护中" } })
  await loginReady(r)
  assert.equal((await r.gw.req("/api/cloud/notice")).json.notice.text, "维护中")
  await r.gw.req("/api/cloud/refresh", { method: "POST" })      // 清掉缓存
  await r.be.close()                                            // 云端没了
  const n = await r.gw.req("/api/cloud/notice")
  assert.equal(n.status, 200, "云端挂了也不该把本机接口带崩")
  assert.equal(n.json.notice.text, "维护中")
})

test("公告：登出后不再下发（缓存要跟着账号切换失效）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.be.admin("/admin/api/notice", { method: "POST", body: { enabled: true, text: "维护中" } })
  await loginReady(r)
  assert.equal((await r.gw.req("/api/cloud/notice")).json.notice.text, "维护中")
  await r.gw.req("/api/cloud/logout", { method: "POST" })
  assert.equal((await r.gw.req("/api/cloud/notice")).json.notice, null)
})

test("/api/model 的 cloud 摘要不含凭证", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)
  const m = await r.gw.req("/api/model")
  assert.equal(m.json.cloud.loggedIn, true)
  assert.equal(m.json.cloud.username, "zhangsan")
  const st = JSON.parse(fs.readFileSync(process.env.CLOUD_STATE_PATH, "utf8"))
  const dump = JSON.stringify(m.json)
  assert.equal(dump.includes(st.access), false)
  assert.equal(dump.includes(st.refresh), false)
})
