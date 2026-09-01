// 桌面版云端账号在网关进程里的接线：/api/cloud/* 与 /cloud/* 转发。
// 三层都是真的：假上游模型 ← sci-auth（内存库）← 本机网关（不接管 opencode）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

let seq = 0
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..")   // 会话产物目录在仓库根，测试后要清掉自己建的那几个

/** 假上游模型服务 */
function fakeUpstream(handler) {
  const srv = http.createServer(handler)
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    srv, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((x) => srv.close(x)),
  })))
}

/** 起 sci-auth + 建好一个改完密的账号 */
async function cloudBackend(upstreamUrl, extraEnv = {}) {
  const prev = { ...process.env }
  Object.assign(process.env, {
    DB_FILE: ":memory:", LISTEN: "127.0.0.1:0", ADMIN_PASSWORD: "adminpw",
    KEY_SECRET: "route-" + (++seq), LLM_UPSTREAM_KEY: "up-key", LLM_UPSTREAM_URL: upstreamUrl,
    DATA_DIR: "", TEST_BYPASS_TOKEN: "t-bypass",
    ...extraEnv,
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

async function rig(upstream, beEnv = {}) {
  const up = await fakeUpstream(upstream || ((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ model: "tier-model", choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } }))
  }))
  const be = await cloudBackend(up.url, beEnv)
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

// 打包版的额度就是云端积分这条线（本机 DAILY_COST_LIMIT 通常没设）。修前：网关只把 429 原样
// 甩给 opencode 就不管了，而 opencode 把它当限流去退避重试，首输出看门狗此刻又已经撤掉了（轮内
// 触顶意味着前面已经出过字）—— 没有任何东西会来收场，用户看到的就是静默转圈到自己放弃。
test("积分用尽：网关自己认出来 → 记下封顶态、清掉额度缓存、下一条消息当场拒收", async (t) => {
  const r = await rig((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 40_000_000, completion_tokens: 0 } }))
  })
  t.after(() => r.close())
  await loginReady(r)
  const H = { authorization: "Bearer " + r.gw.cfg().apiKey }
  const call = () => r.gw.req("/cloud/v1/chat/completions", { method: "POST", body: { model: "x" }, headers: H })

  assert.equal(r.gw.mod.cloudQuotaState(), null, "还没触顶时不该有封顶态")
  assert.equal((await call()).status, 200, "这一发把 5 美元的日额度花光")
  const x = await call()
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "QUOTA_EXCEEDED", "429 与结构化错误码仍要原样透传给 opencode")

  // ★ 本次要修的核心：网关必须自己知道这件事，否则轮内触顶就只剩无限转圈
  const blk = r.gw.mod.cloudQuotaState()
  assert.ok(blk, "网关要记下这次触顶（在跑的轮据此被中止并报错）")
  assert.equal(blk.scope, "daily")
  assert.match(blk.message, /积分已用尽/)

  // 顶栏：20 秒缓存被清掉，问到的是"这条线真的用尽了"（前端据此显示剩余 0 并转红）
  const cq = (await r.gw.req("/api/quota")).json.cloud
  assert.ok(cq.daily.usedUsd >= cq.daily.limitUsd, "日线已用尽（美元口径，与云端判据一致）")
  assert.equal(cq.daily.remain, 0)

  // 下一条消息当场拒收，并把云端原话（哪条线、上限多少、何时恢复）带给用户
  const sid = "ws_quotablocktest"
  t.after(() => { for (const d of ["outputs", "uploads"]) fs.rmSync(path.join(REPO_ROOT, d, sid), { recursive: true, force: true }) })
  const s = await r.gw.req("/api/chat/start", { method: "POST", body: { q: "接着写讨论部分", sid } })
  assert.equal(s.status, 200)
  assert.equal(s.json.ok, false)
  assert.equal(s.json.sent, false, "不许再起一轮白转圈")
  assert.match(s.json.err, /积分已用尽/)
  assert.match(s.json.err, /剩余积分/, "得告诉用户去哪儿看、找谁加")
})

test("积分恢复（管理员临时加额度）：封顶态自愈，消息照常发得出去", async (t) => {
  const r = await rig((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ usage: { prompt_tokens: 40_000_000, completion_tokens: 0 } }))
  })
  t.after(() => r.close())
  await loginReady(r)
  const H = { authorization: "Bearer " + r.gw.cfg().apiKey }
  await r.gw.req("/cloud/v1/chat/completions", { method: "POST", body: { model: "x" }, headers: H })
  await r.gw.req("/cloud/v1/chat/completions", { method: "POST", body: { model: "x" }, headers: H })
  assert.ok(r.gw.mod.cloudQuotaState(), "先触顶")

  // 管理员给这个人临时加额度（dailyOverride：故意【不】吊销 key，正在干活的人不该被踢下线，
  // 见 sci-auth 那处注释）→ 起轮前那次"再问一次云端"必须能把旧判定撤掉，
  // 否则用户得干等封顶态过期（5 分钟）才发得出消息，而额度明明已经加过了。
  await r.be.admin("/admin/api/user-update", { method: "POST", body: { id: r.be.user.id, dailyOverride: 5000 } })
  const sid = "ws_quotahealtest"
  t.after(() => { for (const d of ["outputs", "uploads"]) fs.rmSync(path.join(REPO_ROOT, d, sid), { recursive: true, force: true }) })
  const s = await r.gw.req("/api/chat/start", { method: "POST", body: { q: "继续", sid } })
  assert.doesNotMatch(String(s.json.err || ""), /积分已用尽/, "额度加过了就别再拿旧判定拦人：" + s.text)
  assert.equal(r.gw.mod.cloudQuotaState(), null, "封顶态应被撤掉")
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

// ---- 云端 API 通用转发（给"以后只发界面包"留的口）----

test("通用转发：能打 /api/* 并贴上票据；凭证类接口与越界路径一律拒", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const call = (body) => r.gw.req("/api/cloud/call", { method: "POST", body })

  assert.equal((await call({ path: "/api/me" })).json.ok, false, "没登录先拒")
  await loginReady(r)

  const me = await call({ path: "/api/me" })
  assert.equal(me.status, 200)
  assert.equal(me.json.data.profile.username, "zhangsan", "转发要带上 access key，云端才认")

  // 凭证类接口不许从这里绕（登录/续期/改密各有专门处理，绕过去只会把登录态弄坏）
  for (const p of ["/api/auth/login", "/api/auth/refresh", "/api/auth/password", "/api/auth/logout"]) {
    const x = await call({ path: p, method: "POST", body: {} })
    assert.equal(x.status, 403, p)
    assert.match(x.json.err, /凭证类/)
  }
  // 越界 / 非本平台路径
  for (const p of ["/admin/api/feedback", "/llm/v1/chat/completions", "/api/../admin/api/overview", "//evil.example/api/x", "http://evil.example/api/x", ""]) {
    const x = await call({ path: p })
    assert.equal(x.status, 400, JSON.stringify(p))
  }
  // 云端返回的错误码要透出来，而不是一律 502
  const bad = await call({ path: "/api/nope" })
  assert.equal(bad.status, 404)
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
  // 积分用尽也是 429，但"稍等片刻再试"在这里是错的建议：日积分要等 UTC 0 点。云端那句话要原样透出来。
  const qe = D({ name: "APIError", data: { statusCode: 429,
    message: '{"error":{"code":"QUOTA_EXCEEDED","message":"今日积分已用尽（上限 30 积分），明日 0 点(UTC)恢复"}}' } }, "cloud")
  assert.match(qe, /今日积分已用尽（上限 30 积分）/)
  assert.doesNotMatch(qe, /稍等片刻再试/)
  // 正文被截断 / 认不出结构时也得给一句完整的话，不能只留个错误码
  assert.match(D({ name: "APIError", data: { statusCode: 429, message: "QUOTA_EXCEEDED" } }, "cloud"), /积分已用尽/)
  assert.match(D({ name: "APIError", data: { statusCode: 503, message: "" } }, "cloud"), /异常|重试/)
  assert.match(D({ name: "MessageOutputLengthError", data: {} }, "cloud"), /长度上限|截断/)
  // ---- 登录票据失效：只需用户自己重登一次，别指去找管理员 ----
  // 修前实况：这几种都落到"上游模型服务拒绝了密钥（无效或无权限）。请联系管理员…（上游原话：
  // 账号信息已变更，请重新登录）"—— 一句小白看不懂的话，指的还是错的人，真正该做的那一步没说。
  for (const raw of [
    '{"error":{"code":"KEY_REVOKED","message":"账号信息已变更，请重新登录"}}',
    '{"error":{"code":"REFRESH_INVALID","message":"登录已失效，请重新登录"}}',
    "账号信息已变更，请重新登录",              // 只剩一句原话（opencode 转手时常见）
  ]) {
    const m = D({ name: "ProviderAuthError", data: { statusCode: 401, message: raw } }, "cloud")
    assert.match(m, /退出登录/, "要直说这一步怎么做：" + m)
    assert.match(m, /重新登录|再.*登录/, m)
    assert.doesNotMatch(m, /联系管理员/, "这事管理员帮不上，别把人推过去：" + m)
    assert.doesNotMatch(m, /拒绝了密钥/, m)
  }
  // 用自己 API 的人压根没有平台票据，401 照旧指去 api-config 自查（别叫他退出重登）
  const cu = D({ name: "ProviderAuthError", data: { statusCode: 401, message: "invalid key, 请重新登录" } }, "custom")
  assert.match(cu, /api-config/)
  assert.doesNotMatch(cu, /退出登录/)
  // 兜底也必须是一句完整的话，不能是空字符串（空 = 又回到"空气泡"）
  assert.equal(D({ name: "UnknownError", data: {} }, "cloud").length > 10, true)
})

// 上游额度耗尽（火山 5 小时配额打光，实测 2026-08-07 生产）是【另一条】通往"静默转圈"的路：
// 它同样是 429，修前被当成限速 → 客户端显示"正在等待重试、请不要重发" + 看门狗无限续命。
// 对用户的话必须与限速相反，而且绝不能说成"你的积分用尽"（他一分钱没花）。
test("上游额度耗尽：与限速措辞相反、点明不是用户的积分、不指去 api-config", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const D = r.gw.mod.describeModelError
  const raw = '{"error":{"code":"UPSTREAM_QUOTA_EXCEEDED","message":"平台的上游模型额度已用尽（不是你的积分），本轮未能生成；预计 2026-08-07 14:12:52 +0800 CST 恢复。现在重试不会成功，请联系管理员充值或换一家供应商。"}}'
  const m = D({ name: "APIError", data: { statusCode: 429, message: raw } }, "cloud")
  assert.match(m, /14:12:52/, "恢复时刻要透到用户眼前，否则他只能盲试")
  assert.match(m, /不是你的积分/)
  assert.match(m, /重试不会成功/)
  assert.doesNotMatch(m, /稍等片刻再试/, "这是限速的建议，用在额度耗尽上就是让用户白等几小时")
  assert.doesNotMatch(m, /api-config/, "跟他自己的 API 配置无关")
  // 与限速那条必须分得开
  const rl = D({ name: "APIError", data: { statusCode: 429, message: '{"error":{"code":"UPSTREAM_RATE_LIMITED"}}' } }, "cloud")
  assert.match(rl, /限速/)
  assert.doesNotMatch(rl, /重试不会成功/)
  // 正文被截断只剩错误码时也要给完整一句话
  assert.match(D({ name: "APIError", data: { statusCode: 429, message: "UPSTREAM_QUOTA_EXCEEDED" } }, "cloud"), /上游模型额度已用尽/)
})

// 上游账户【订阅过期】：火山把它回成 HTTP 400，措辞里一个余额类词都没有 —— 修前落到最末
// 的通用分支，用户只收到一句读不懂的英文原话（2026-09-01 实测）。
test("上游订阅过期：说人话、点明不是用户的积分、不指去 api-config", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const D = r.gw.mod.describeModelError
  const ark = "Your account (2130613591) does not have a valid CodingPlan subscription, or your subscription has expired."
  const m = D({ name: "APIError", data: { statusCode: 400, message: ark } }, "cloud")
  assert.match(m, /订阅已过期|未开通/)
  assert.match(m, /不是你的积分/)
  assert.match(m, /重试不会成功/)
  assert.match(m, /联系管理员/)
  assert.match(m, /CodingPlan/, "上游原话要带上，管理员照着去续订")
  // 网关认出来后回的结构化码同样要认
  assert.match(D({ name: "APIError", data: { statusCode: 402, message: '{"error":{"code":"UPSTREAM_BILLING_ERROR"}}' } }, "cloud"), /订阅已过期|未开通/)
  // 用自己 API 的人该被指去 api-config（不是找管理员）
  assert.match(D({ name: "APIError", data: { statusCode: 400, message: ark } }, "custom"), /api-config/)
  // ★ 不能误伤真正的参数错：那种要原样把上游的话给出去，别改口说成计费问题
  assert.doesNotMatch(D({ name: "APIError", data: { statusCode: 400, message: "model `gpt-9` not found" } }, "cloud"), /订阅/)
})

test("上游额度耗尽：网关记的是 upstream 档封顶态，不会误报成用户积分用尽", async (t) => {
  const r = await rig((_q, res) => {
    // 假上游照火山原样回：429 + AccountQuotaExceeded，且【不带】Retry-After
    res.writeHead(429, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: {
      code: "AccountQuotaExceeded", type: "TooManyRequests",
      message: "You have exceeded the 5-hour usage quota. It will reset at 2026-08-07 14:12:52 +0800 CST.",
    } }))
  })
  t.after(() => r.close())
  await loginReady(r)
  const x = await r.gw.req("/cloud/v1/chat/completions", {
    method: "POST", body: { model: "x" }, headers: { authorization: "Bearer " + r.gw.cfg().apiKey },
  })
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "UPSTREAM_QUOTA_EXCEEDED", "sci-auth 要把它与限速分开：" + x.text)

  const blk = r.gw.mod.cloudQuotaState()
  assert.ok(blk, "本机网关也要记下来，否则 opencode 会把这个 429 当限速退避重试很久")
  assert.equal(blk.kind, "upstream", "档位要对：说成 user 就会告诉用户'你的积分用尽'")
  assert.match(blk.message, /不是你的积分/)
  assert.match(blk.message, /14:12:52/)

  // 下一条消息当场拒收，且【不去查用户积分】（他积分好得很，查了只会放行一轮必然失败的对话）
  const sid = "ws_upstreamblocktest"
  t.after(() => { for (const d of ["outputs", "uploads"]) fs.rmSync(path.join(REPO_ROOT, d, sid), { recursive: true, force: true }) })
  const s = await r.gw.req("/api/chat/start", { method: "POST", body: { q: "继续写", sid } })
  assert.equal(s.json.sent, false)
  assert.match(s.json.err, /不是你的积分/)
  assert.doesNotMatch(s.json.err, /积分已用尽（上限/, "别把上游耗尽说成用户的积分线用尽")
})

test("积分用尽的兜底措辞：云端没给 message 时也要说清哪条线、何时恢复", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const Q = r.gw.mod.quotaBlockMessage
  assert.match(Q({ code: "QUOTA_EXCEEDED", message: "今日积分已用尽（上限 30 积分），明日 0 点(UTC)恢复" }),
    /上限 30 积分/, "云端原话最准，优先用它")
  assert.match(Q({ scope: "daily" }), /今日.*用尽/)
  assert.match(Q({ scope: "daily" }), /0 点\(UTC\)/, "得告诉用户什么时候恢复")
  assert.match(Q({ scope: "monthly" }), /本月.*用尽/)
  assert.match(Q({}), /积分已用尽/, "连 scope 都没有时也不能给空话")
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
    text: "今晚 22:00 维护", level: "warn", minClientVersion: "99.0.0" } })
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
  await r.be.admin("/admin/api/notice", { method: "POST", body: { text: "第一版" } })
  await loginReady(r)
  assert.equal((await r.gw.req("/api/cloud/notice")).json.notice.text, "第一版")

  await r.be.admin("/admin/api/notice", { method: "POST", body: { text: "第二版" } })
  assert.equal((await r.gw.req("/api/cloud/notice")).json.notice.text, "第一版", "缓存内不该每次都打云端")

  await r.gw.req("/api/cloud/refresh", { method: "POST" })
  assert.equal((await r.gw.req("/api/cloud/notice")).json.notice.text, "第二版")
})

test("公告：云端拉不到时保留上一份（把已显示的维护通知抹掉比留着旧的更糟）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.be.admin("/admin/api/notice", { method: "POST", body: { text: "维护中" } })
  await loginReady(r)
  assert.equal((await r.gw.req("/api/cloud/notice")).json.notice.text, "维护中")
  await r.gw.req("/api/cloud/refresh", { method: "POST" })      // 清掉缓存
  await r.be.close()                                            // 云端没了
  const n = await r.gw.req("/api/cloud/notice")
  assert.equal(n.status, 200, "云端挂了也不该把本机接口带崩")
  assert.equal(n.json.notice.text, "维护中")
})

test("公告列表：近半年的都在（点掉就再也找不回来的解法），带正文与升级判定", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.be.admin("/admin/api/notice", { method: "POST", body: { text: "上周维护完成" } })
  await r.be.admin("/admin/api/notice", { method: "POST", body: { text: "今晚 22:00 维护", level: "urgent", minClientVersion: "99.0.0" } })
  await loginReady(r)

  const l = await r.gw.req("/api/cloud/notices")
  assert.equal(l.status, 200)
  assert.deepEqual(l.json.notices.map((x) => x.text), ["今晚 22:00 维护", "上周维护完成"], "新的在前")
  assert.equal(l.json.notices[0].level, "urgent")
  assert.equal(l.json.keepDays, 180)
  // 本机 APP_VERSION 没注入时上报 "dev" —— 认不出版本就不催升级（与单条那份同一口径）
  assert.equal(l.json.notices[0].needUpgrade, false)

  // 轮询那条只带摘要：正文不必每 5 分钟搬一遍，未读红点靠它算
  const n = await r.gw.req("/api/cloud/notice")
  assert.deepEqual(n.json.digest.map((x) => x.id), l.json.notices.map((x) => x.id))
  assert.equal(n.json.digest[0].text, undefined, "摘要里不该有正文")

  // 撤下的立刻从客户端列表消失（缓存要能被手点刷新穿透）
  await r.be.admin("/admin/api/notice", { method: "POST", body: { action: "withdraw", id: l.json.notices[0].id } })
  await r.gw.req("/api/cloud/refresh", { method: "POST" })
  assert.deepEqual((await r.gw.req("/api/cloud/notices")).json.notices.map((x) => x.text), ["上周维护完成"])
})

test("公告列表：未登录不打云端；云端拉不到时保留上一份", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const before = await r.gw.req("/api/cloud/notices")
  assert.equal(before.status, 200)
  assert.deepEqual(before.json.notices, [], "没登录就没有公告这回事，也不该往外发请求")

  await r.be.admin("/admin/api/notice", { method: "POST", body: { text: "维护中" } })
  await loginReady(r)
  assert.equal((await r.gw.req("/api/cloud/notices")).json.notices.length, 1)
  await r.gw.req("/api/cloud/refresh", { method: "POST" })   // 清缓存
  await r.be.close()                                         // 云端没了
  const n = await r.gw.req("/api/cloud/notices")
  assert.equal(n.status, 200, "云端挂了也不该把本机接口带崩")
  assert.equal(n.json.notices[0].text, "维护中", "面板已经打开时别当场变空")
})

test("公告：登出后不再下发（缓存要跟着账号切换失效）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.be.admin("/admin/api/notice", { method: "POST", body: { text: "维护中" } })
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

// ---- 剩余积分（打包版顶栏那一栏）--------------------------------------------

/** 往云端库里补一笔花费（金额精确可控，走的就是网关计量用的那个函数） */
async function spend(r, usd) {
  const DB = await import("../../server/lib/db.mjs")
  DB.recordUsage(r.be.db, r.be.user.id, { model: "m", provider: "t", cost_usd: usd })
}

test("积分：未登录时 cloud 为 null，且不往云端发请求", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.be.close()                       // 云端整个关掉，证明这条路压根没往外发
  const q = await r.gw.req("/api/quota")
  assert.equal(q.status, 200)
  assert.equal(q.json.cloud, null)
  assert.equal(q.json.limit, 0, "本机 env 额度没设 = 不限额（顶栏隐藏）")
})

test("积分：登录后拿到日/月剩余（档位 $5/天 = 500 积分，月不限）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)
  const q = await r.gw.req("/api/quota")
  assert.equal(q.json.cloud.creditUsd, 0.01)
  assert.equal(q.json.cloud.daily.limit, 500)
  assert.equal(q.json.cloud.daily.remain, 500)
  assert.equal(q.json.cloud.monthly.unlimited, true)
  assert.equal(q.json.cloud.monthly.remain, null)
  assert.equal(q.json.cloud.stale, false)
})

test("积分：本机 20 秒缓存挡住轮询，一轮结束的 fresh=1 立刻穿透", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)
  assert.equal((await r.gw.req("/api/quota")).json.cloud.daily.remain, 500)

  await spend(r, 1.23)                     // 花掉 123 积分
  assert.equal((await r.gw.req("/api/quota")).json.cloud.daily.remain, 500, "缓存内不该每次都打云端")
  const fresh = await r.gw.req("/api/quota?fresh=1")
  assert.equal(fresh.json.cloud.daily.remain, 377, "floor(500 - 123)")
  assert.equal(fresh.json.cloud.daily.used, 123)
})

test("积分：云端拉不到时保留上一份并标 stale（额度栏凭空消失会被当成'被停用'）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)
  assert.equal((await r.gw.req("/api/quota")).json.cloud.daily.remain, 500)
  await r.be.close()                       // 云端没了
  const q = await r.gw.req("/api/quota?fresh=1")
  assert.equal(q.status, 200, "云端挂了也不该把本机接口带崩")
  assert.equal(q.json.cloud.daily.remain, 500)
  assert.equal(q.json.cloud.stale, true)
})

test("积分：登出后不再下发（缓存要跟着账号切换失效）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await loginReady(r)
  assert.equal((await r.gw.req("/api/quota")).json.cloud.daily.limit, 500)
  await r.gw.req("/api/cloud/logout", { method: "POST" })
  assert.equal((await r.gw.req("/api/quota")).json.cloud, null)
})

// ---- 图片识字（/cloud/ocr/* → sci-auth /ocr/*）------------------------------
// 【为什么单独测这一条】/cloud/<rest> 默认会被套上 /llm 前缀转给云端，而识字在云端是独立
// 通道。少了这条豁免，请求会被转成 /llm/ocr/parse —— 报的是一句莫名其妙的模型路由错误，
// 而不是"识字失败"，现场根本查不到这儿。桌面版拿不到 OCR key，全靠这条路。
test("识字转发：/cloud/ocr/parse 不套 /llm，key 由服务器贴，客户端一个字节都拿不到", async (t) => {
  let seen = null
  const ocr = await fakeUpstream((q, res) => {
    const c = []
    q.on("data", (x) => c.push(x))
    q.on("end", () => {
      seen = { url: q.url, form: new URLSearchParams(Buffer.concat(c).toString()) }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ParsedResults: [{ ParsedText: "申请代码 H2701", FileParseExitCode: 1 }], IsErroredOnProcessing: false }))
    })
  })
  const r = await rig(undefined, { OCR_SPACE_API_KEY: "server-only-ocr-key", OCR_ENDPOINT: ocr.url + "/parse" })
  t.after(async () => { await r.close(); await ocr.close() })
  await loginReady(r)
  const localTok = r.gw.cfg().apiKey

  // 令牌不对 → 一个字节都不该发出去（否则同机任何程序都能白嫖云端识字额度）
  const bad = await r.gw.req("/cloud/ocr/parse", { method: "POST", body: { image: "QUJD" }, headers: { authorization: "Bearer wrong" } })
  assert.equal(bad.status, 401)
  assert.equal(seen, null)

  const x = await r.gw.req("/cloud/ocr/parse", {
    method: "POST", body: { image: "QUJD" }, headers: { authorization: "Bearer " + localTok },
  })
  assert.equal(x.status, 200, "体=" + x.text)
  assert.equal(x.json.text, "申请代码 H2701")
  assert.equal(x.json.quota.used, 1)
  assert.equal(seen.url, "/parse", "打的是识字上游本身，不是被套了 /llm 的路径")
  assert.equal(seen.form.get("apikey"), "server-only-ocr-key", "OCR key 只在服务器上")
})

test("识字：平台没配 key → 503 说清是平台的事（桌面版此前是本机报'缺 OCR_SPACE_API_KEY'）", async (t) => {
  const r = await rig(); t.after(() => r.close())     // 不给 OCR_SPACE_API_KEY
  await loginReady(r)
  const x = await r.gw.req("/cloud/ocr/parse", {
    method: "POST", body: { image: "QUJD" }, headers: { authorization: "Bearer " + r.gw.cfg().apiKey },
  })
  assert.equal(x.status, 503)
  assert.equal(x.json.error.code, "OCR_UNCONFIGURED")
  assert.match(x.json.error.message, /管理员/)
})
