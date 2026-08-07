// 图片识字代理（/ocr）：认 key、按次限额（每人 + 全平台两层）、成功才计数、
// 上游故障不冤枉用户的次数。
//
// 全程用假的 OCR.space（本机 http server），不打真实识字服务、不花额度。
import test from "node:test"
import assert from "node:assert/strict"
import { startApp, adminLogin, asAdmin, startFakeUpstream } from "./helper.mjs"
import { extractText } from "../lib/ocrspace.mjs"

const STRONG = "Aa1!aaaa9"
const OCR = "/ocr/parse"
// 一张"图"（内容无所谓，假上游不解码）。base64 后仍远小于 1MB。
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64")

/** 假 OCR.space 的正常应答 */
const okBody = (text = "国家自然科学基金申请代码") => JSON.stringify({
  ParsedResults: [{ ParsedText: text, FileParseExitCode: 1, ErrorMessage: "" }],
  IsErroredOnProcessing: false, OCRExitCode: 1,
})

/** 收下 form-urlencoded 请求体 */
function body(q) {
  return new Promise((r) => {
    const c = []
    q.on("data", (x) => c.push(x))
    q.on("end", () => r(new URLSearchParams(Buffer.concat(c).toString())))
  })
}

/** 起假上游 + app + 一个改完密的账号；ocrDaily 可指定 */
async function rig({ upstream, ocrDaily = 2, env = {} } = {}) {
  const up = await startFakeUpstream(upstream || ((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(okBody())
  }))
  const app = await startApp({ OCR_SPACE_API_KEY: "ocr-key", OCR_ENDPOINT: up.url + "/parse", ...env })
  const cookie = await adminLogin(app)
  const admin = asAdmin(app, cookie)
  await admin("/admin/api/tier", { method: "POST", body: { key: "t1", dailyUSD: 5, model: "m", ocrDaily } })
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三", tier: "t1" } })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: STRONG },
  })
  const access = chg.json.access
  const parse = (b = { image: PNG }) =>
    app.req(OCR, { method: "POST", body: b, headers: { authorization: "Bearer " + access } })
  return { up, app, admin, access, parse, uid: add.json.user.id, async close() { await app.close(); await up.close() } }
}

test("extractText：成功取文本，上游明说失败时把原因带出来", () => {
  assert.deepEqual(extractText(JSON.parse(okBody("甲乙丙"))), { text: "甲乙丙" })
  // 整体失败（ErrorMessage 可能是数组）
  assert.match(extractText({ IsErroredOnProcessing: true, ErrorMessage: ["file too large"] }).err, /file too large/)
  // 单张失败：ParsedResults 在、但 FileParseExitCode 不是 1 —— 这种最容易被当成"识别出空白"
  assert.match(extractText({ ParsedResults: [{ FileParseExitCode: -10, ErrorMessage: "corrupt" }] }).err, /corrupt/)
  assert.ok(extractText(null).err)
  // 真的识别出空白（成功但没字）不是错误，别把它变成报错
  assert.deepEqual(extractText({ ParsedResults: [{ ParsedText: "", FileParseExitCode: 1 }] }), { text: "" })
})

test("没 key 一律挡在门外（识字跟 /llm 同一把 access key）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const x = await r.app.req(OCR, { method: "POST", body: { image: PNG } })
  assert.equal(x.status, 401)
  assert.equal(x.json.error.code, "KEY_MISSING")
})

test("平台没配 OCR key → 503，且【不扣次数】（别让用户以为是自己用完了）", async (t) => {
  const r = await rig({ env: { OCR_SPACE_API_KEY: "" } }); t.after(() => r.close())
  const x = await r.parse()
  assert.equal(x.status, 503)
  assert.equal(x.json.error.code, "OCR_UNCONFIGURED")
  assert.match(x.json.error.message, /管理员/)
  const q = await r.parse()
  assert.equal(q.json.error.code, "OCR_UNCONFIGURED", "还是同一个原因，不该变成'次数用完'")
})

test("识别成功：贴服务器的 key 转发，客户端拿到文本，次数 +1", async (t) => {
  let seen = null
  const r = await rig({
    upstream: async (q, res) => {
      seen = await body(q)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(okBody("申请代码 H2701"))
    },
  })
  t.after(() => r.close())
  const x = await r.parse({ image: PNG, filename: "code.jpg" })
  assert.equal(x.status, 200)
  assert.equal(x.json.text, "申请代码 H2701")
  assert.deepEqual(x.json.quota, { used: 1, limit: 2, remain: 1, unlimited: false })

  assert.equal(seen.get("apikey"), "ocr-key", "上游拿到的是服务器的 key")
  assert.equal(seen.get("base64Image"), `data:image/jpeg;base64,${PNG}`, "要带 data URI 前缀，上游按它判类型")
  assert.equal(seen.get("OCREngine"), "3", "中文/表格默认走 Engine3")
  assert.equal(seen.get("language"), "chs")
  assert.equal(seen.get("isTable"), "true")
})

test("客户端点名引擎无效：各引擎免费额度差一个量级，放任点名等于让它自选烧哪个池子", async (t) => {
  let seen = null
  const r = await rig({
    upstream: async (q, res) => {
      seen = await body(q)
      res.writeHead(200, { "content-type": "application/json" }); res.end(okBody())
    },
  })
  t.after(() => r.close())
  await r.parse({ image: PNG, OCREngine: "1", engine: "1" })
  assert.equal(seen.get("OCREngine"), "3", "以服务器配置为准")
})

test("客户端传 data URI 也认（两端各拼一次会拼出双层前缀）", async (t) => {
  let seen = null
  const r = await rig({
    upstream: async (q, res) => {
      seen = await body(q)
      res.writeHead(200, { "content-type": "application/json" }); res.end(okBody())
    },
  })
  t.after(() => r.close())
  const x = await r.parse({ image: `data:image/png;base64,${PNG}` })
  assert.equal(x.status, 200)
  assert.equal(seen.get("base64Image"), `data:image/png;base64,${PNG}`, "剥掉再按原 mime 拼回去，只有一层")
})

test("次数闸：2 次/天，第 3 次被拦，且带上 used/limit", async (t) => {
  const r = await rig({ ocrDaily: 2 }); t.after(() => r.close())
  assert.equal((await r.parse()).json.quota.used, 1)
  assert.equal((await r.parse()).json.quota.used, 2)
  const x = await r.parse()
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "OCR_QUOTA_EXCEEDED")
  assert.equal(x.json.error.used, 2)
  assert.equal(x.json.error.limit, 2)
  assert.match(x.json.error.message, /0 点\(UTC\)/, "要说清什么时候恢复")
})

test("ocrDaily=0 = 不限（与 daily_usd 同口径）", async (t) => {
  const r = await rig({ ocrDaily: 0 }); t.after(() => r.close())
  for (let i = 0; i < 5; i++) assert.equal((await r.parse()).status, 200)
  const x = await r.parse()
  assert.equal(x.json.quota.unlimited, true)
  assert.equal(x.json.quota.remain, null, "不限时 remain 给 null 而不是 0（0 会被前端当成用尽）")
})

test("全平台闸：额度是按 key+出口 IP 算的，个人还有余量也要拦，并说清不是他的次数", async (t) => {
  // 每人不限，但全平台今天只给 2 次
  const r = await rig({ ocrDaily: 0, env: { OCR_DAILY_CAP: "2" } }); t.after(() => r.close())
  assert.equal((await r.parse()).status, 200)
  assert.equal((await r.parse()).status, 200)
  const x = await r.parse()
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "OCR_PLATFORM_QUOTA")
  assert.equal(x.json.error.scope, "platform-daily")
  assert.match(x.json.error.message, /不是你的次数/, "否则用户会去要更高档位，而调档位根本解决不了")
})

test("全平台月闸同理，且与日闸分得开", async (t) => {
  const r = await rig({ ocrDaily: 0, env: { OCR_DAILY_CAP: "0", OCR_MONTHLY_CAP: "1" } }); t.after(() => r.close())
  assert.equal((await r.parse()).status, 200)
  const x = await r.parse()
  assert.equal(x.json.error.code, "OCR_PLATFORM_QUOTA")
  assert.equal(x.json.error.scope, "platform-monthly")
})

test("上游报错【不扣次数】——一次抖动不该白吃掉用户当天的一次", async (t) => {
  let fail = true
  const r = await rig({
    upstream: (_q, res) => {
      if (fail) { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"ErrorMessage":"boom"}') }
      res.writeHead(200, { "content-type": "application/json" }); res.end(okBody())
    },
  })
  t.after(() => r.close())
  const bad = await r.parse()
  assert.equal(bad.status, 502)
  assert.equal(bad.json.error.code, "OCR_UPSTREAM_ERROR")
  assert.match(bad.json.error.message, /不计入/)
  fail = false
  assert.equal((await r.parse()).json.quota.used, 1, "刚才那次失败不该计数")
})

test("上游 200 但这张没识别成 → 不扣次数，并明说'本次不计入'", async (t) => {
  const r = await rig({
    upstream: (_q, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"ParsedResults":[{"FileParseExitCode":-10,"ErrorMessage":"Unable to recognize"}]}')
    },
  })
  t.after(() => r.close())
  const x = await r.parse()
  assert.equal(x.json.error.code, "OCR_NO_RESULT")
  assert.match(x.json.error.message, /不计入/)
})

test("上游限速（403 + 一句英文纯文本，OCR.space 的真实行为）→ 说清是平台的事", async (t) => {
  const r = await rig({
    upstream: (_q, res) => {
      res.writeHead(403, { "content-type": "text/plain" })
      res.end("You may only perform this action upto maximum 500 number of times within 86400 seconds")
    },
  })
  t.after(() => r.close())
  const x = await r.parse()
  assert.equal(x.status, 429)
  assert.equal(x.json.error.code, "OCR_UPSTREAM_QUOTA")
  assert.match(x.json.error.message, /不是你的次数/)
  assert.match(x.json.error.message, /没有被扣/)
})

test("只认 POST /ocr/parse，别的路径老实回 404/405", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const a = await r.app.req("/ocr/other", { method: "POST", body: {}, headers: { authorization: "Bearer " + r.access } })
  assert.equal(a.status, 404)
  const b = await r.app.req(OCR, { method: "GET", headers: { authorization: "Bearer " + r.access } })
  assert.equal(b.status, 405)
})

test("缺 image / 不是合法 base64 → 400（在闸之后、转发之前拦住，不浪费一次）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  assert.equal((await r.parse({ image: "  " })).status, 400)
  assert.equal((await r.parse({ image: "这不是 base64!!" })).status, 400)
  assert.equal((await r.parse()).json.quota.used, 1, "刚才两次没扣次数")
})

test("超过 1MB 的图在本地就拦下，并说人话（别让用户拿到上游一句英文）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const big = "A".repeat(1_400_000)          // 解码后约 1.05MB
  const x = await r.parse({ image: big })
  assert.equal(x.status, 413)
  assert.equal(x.json.error.code, "IMAGE_TOO_LARGE")
  assert.match(x.json.error.message, /1MB/)
  assert.equal((await r.parse()).json.quota.used, 1, "被拦下的那次没扣")
})

test("次数按用户各算各的，互不影响", async (t) => {
  const r = await rig({ ocrDaily: 2 }); t.after(() => r.close())
  await r.parse(); await r.parse()
  assert.equal((await r.parse()).json.error.code, "OCR_QUOTA_EXCEEDED")

  const add = await r.admin("/admin/api/user-add", { method: "POST", body: { username: "lisi", displayName: "李四", tier: "t1" } })
  const li = await r.app.req("/api/auth/login", { method: "POST", body: { username: "lisi", password: add.json.initialPassword } })
  const chg = await r.app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: STRONG },
  })
  const x = await r.app.req(OCR, { method: "POST", body: { image: PNG }, headers: { authorization: "Bearer " + chg.json.access } })
  assert.equal(x.status, 200, "另一个人的额度是干净的")
  assert.equal(x.json.quota.used, 1)
})

test("改档位的次数立刻生效（现查库，不进 access key、不用重登）", async (t) => {
  const r = await rig({ ocrDaily: 1 }); t.after(() => r.close())
  assert.equal((await r.parse()).status, 200)
  assert.equal((await r.parse()).json.error.code, "OCR_QUOTA_EXCEEDED")
  await r.admin("/admin/api/tier", { method: "POST", body: { key: "t1", dailyUSD: 5, model: "m", ocrDaily: 3 } })
  assert.equal((await r.parse()).status, 200, "同一把 key，下一次调用就按新次数判")
})

test("后台改档位时【不传】ocrDaily → 保留原值，不许静默变成不限", async (t) => {
  const r = await rig({ ocrDaily: 2 }); t.after(() => r.close())
  // 只改备注，不带 ocrDaily（管理台的档位表单就没有这一栏）。其余字段必须原样带回，
  // 否则 bumpEpoch 会吊销该档全体用户的 key，下面就成了测 401 而不是测次数闸。
  await r.admin("/admin/api/tier", { method: "POST", body: { key: "t1", dailyUSD: 5, model: "m", note: "改个备注" } })
  await r.parse(); await r.parse()
  const x = await r.parse()
  assert.equal(x.json.error.code, "OCR_QUOTA_EXCEEDED", "漏传字段就把限额抹成 0，等于让一个人能吃穿全平台的公共池")
})
