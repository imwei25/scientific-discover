// 「下一步输入建议」接线：/api/suggest 只是一次独立的小模型请求 —— 上游是假的，网关是真的。
// 覆盖：正常出建议、脏输出的清洗、上游各种翻车都不许把错误抛给前端、成本要入账、并发封顶、模块上下文。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

let seq = 0

/** 假的 OpenAI 兼容上游：把收到的请求体记下来，回包由 handler 决定 */
function fakeUpstream(handler) {
  const seen = []
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
    seen.push({ url: req.url, auth: req.headers.authorization, body })
    await handler(req, res, seen.length)
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    seen, url: `http://127.0.0.1:${srv.address().port}/v1`,
    close: () => new Promise((x) => srv.close(x)),
  })))
}

/** 一句话回包：content 原样塞进 choices[0].message.content */
const reply = (content, usage) => (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ choices: [{ message: { content } }], usage: usage || { prompt_tokens: 800, completion_tokens: 60 } }))
}

/**
 * 起一个本机网关：不接管 opencode，模型走 route=custom 指向假上游，
 * HOME/USERPROFILE 也改到临时目录 —— 否则 addCost 会写到开发机真实的 ~/.local/share/opencode/quota.json。
 */
async function gateway({ upstream, env = {}, modelCfg, moduleMap } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugtest-"))
  if (moduleMap) {
    const md = path.join(dir, ".local", "share", "opencode")
    fs.mkdirSync(md, { recursive: true })
    fs.writeFileSync(path.join(md, "module-map.json"), JSON.stringify(moduleMap))
  }
  const cfgPath = path.join(dir, "model-config.json")
  if (modelCfg !== null) {
    fs.writeFileSync(cfgPath, JSON.stringify(modelCfg || { route: "custom", baseURL: upstream, apiKey: "sk-test", modelID: "test-model" }))
  }
  const over = {
    MANAGE_OC: "0", PORT: "0",
    OC_URL: "http://127.0.0.1:1",                 // 不会去连
    HOME: dir, USERPROFILE: dir,                  // quota.json / module-map.json 落到临时目录
    MODEL_CFG_PATH: cfgPath,
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),   // 不设它会读写【开发机真实的】web/sessions-meta.json，把本机会话元数据清空
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
    DAILY_COST_LIMIT: "", SUGGEST_ENABLED: "", SUGGEST_MODEL: "", SUGGEST_TIMEOUT_MS: "",
    ...env,
  }
  // 【逐个存取、不要 `process.env = prev`】后者会把 process.env 换成一个普通对象，
  // 真实（native）环境变量并不会跟着回滚 —— 于是 os.homedir() 永远停在第一次设的那个 HOME，
  // 各用例的 quota.json / module-map.json 全共用一份，测出来的记账与模块上下文全是串的。
  const saved = {}
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
  let mod
  try { mod = await import(`../server.mjs?s=${++seq}`) } finally { restore() }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来（10 秒内没绑上端口）")
  const base = `http://127.0.0.1:${port}`
  return {
    base, dir,
    close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())),
    async suggest(body) {
      const r = await fetch(base + "/api/suggest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      return { status: r.status, json: await r.json().catch(() => null) }
    },
    async quotaUsed() { return (await (await fetch(base + "/api/quota")).json()).used },
  }
}

const ROUND = { q: "帮我把这批数据做一下基线表", a: "已生成 table1.csv，含 3 组共 210 例，年龄与性别组间无差异。" }

test("正常回包 → 出 3 条建议，且请求带上了对话上下文", async (t) => {
  const up = await fakeUpstream(reply(JSON.stringify(["把基线表导出成三线表", "继续做生存分析", "核对一下缺失值比例"])))
  const gw = await gateway({ upstream: up.url })
  t.after(async () => { await gw.close(); await up.close() })

  const r = await gw.suggest(ROUND)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.suggestions, ["把基线表导出成三线表", "继续做生存分析", "核对一下缺失值比例"])

  // 上游确实收到了这一问一答 + 配置里的模型与 key
  assert.equal(up.seen.length, 1)
  assert.equal(up.seen[0].url, "/v1/chat/completions")
  assert.equal(up.seen[0].auth, "Bearer sk-test")
  assert.equal(up.seen[0].body.model, "test-model")
  assert.equal(up.seen[0].body.stream, false)
  // 思考模型（火山 deepseek/doubao 系）不关思考会把 max_tokens 全花在 reasoning_content 上，
  // content 空着回来 → 前端气泡闪两秒就没。请求必须显式带上「关思考」。
  assert.deepEqual(up.seen[0].body.thinking, { type: "disabled" })
  const userMsg = up.seen[0].body.messages.at(-1).content
  assert.match(userMsg, /基线表/)
  assert.match(userMsg, /table1\.csv/)
})

test("严格供应商不认 thinking 字段回 400 → 去掉该字段重试一次，建议照出", async (t) => {
  const up = await fakeUpstream((req, res, n) => {
    const hasThinking = "thinking" in (up.seen[n - 1].body || {})
    if (hasThinking) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: thinking" } })) }
    return reply(JSON.stringify(["继续做生存分析", "核对缺失值比例"]))(req, res)
  })
  const gw = await gateway({ upstream: up.url })
  t.after(async () => { await gw.close(); await up.close() })

  const r = await gw.suggest(ROUND)
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.suggestions, ["继续做生存分析", "核对缺失值比例"])
  assert.equal(up.seen.length, 2, "应该恰好重试一次")
  assert.ok(!("thinking" in up.seen[1].body), "重试那次不该再带 thinking")
})

test("上游没关掉思考、content 空着回来 → 200 + 空数组（前端静默不画）", async (t) => {
  // 真实翻车现场：思考模型把 max_tokens 全花在 reasoning_content 上，finish=length、content=""
  const up = await fakeUpstream(reply(""))
  const gw = await gateway({ upstream: up.url })
  t.after(async () => { await gw.close(); await up.close() })

  const r = await gw.suggest(ROUND)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, false)
  assert.deepEqual(r.json.suggestions, [])
})

test("脏输出照样能用：代码块 + 编号 + 引号 + 重复 + 超长，清洗后最多 3 条", async (t) => {
  const dirty = '```json\n[\n"1. 继续做生存分析",\n"继续做生存分析",\n"“核对缺失值比例”",\n' +
    `"${"太长的一条".repeat(12)}",\n"把图导成 300dpi",\n"再多给一条"\n]\n\`\`\``
  const up = await fakeUpstream(reply(dirty))
  const gw = await gateway({ upstream: up.url })
  t.after(async () => { await gw.close(); await up.close() })

  const r = await gw.suggest(ROUND)
  assert.deepEqual(r.json.suggestions, ["继续做生存分析", "核对缺失值比例", "把图导成 300dpi"])
})

test("模型没按 JSON 回，按行拆也能救回来", async (t) => {
  const up = await fakeUpstream(reply("- 继续做生存分析\n- 核对缺失值比例\n- 把图导成 300dpi"))
  const gw = await gateway({ upstream: up.url })
  t.after(async () => { await gw.close(); await up.close() })

  assert.deepEqual((await gw.suggest(ROUND)).json.suggestions, ["继续做生存分析", "核对缺失值比例", "把图导成 300dpi"])
})

test("上游 500 / 超时 / 没配模型：一律 200 + 空数组，绝不把错误抛到前端", async (t) => {
  const boom = await fakeUpstream((req, res) => { res.writeHead(500); res.end("upstream down") })
  const hang = await fakeUpstream(() => new Promise(() => {}))   // 永不回包
  const gwBoom = await gateway({ upstream: boom.url })
  const gwHang = await gateway({ upstream: hang.url, env: { SUGGEST_TIMEOUT_MS: "300" } })
  const gwNone = await gateway({ modelCfg: null })               // 既没自设模型也没平台 → route=none
  t.after(async () => {
    await Promise.all([gwBoom.close(), gwHang.close(), gwNone.close()])
    await Promise.all([boom.close(), hang.close()])
  })

  for (const [name, gw] of [["500", gwBoom], ["超时", gwHang], ["没配模型", gwNone]]) {
    const r = await gw.suggest(ROUND)
    assert.equal(r.status, 200, name)
    assert.equal(r.json.ok, false, name)
    assert.deepEqual(r.json.suggestions, [], name)
  }
})

test("空上下文不发请求；SUGGEST_ENABLED=0 整功能关掉", async (t) => {
  const up = await fakeUpstream(reply('["不该被调用"]'))
  const gw = await gateway({ upstream: up.url })
  const off = await gateway({ upstream: up.url, env: { SUGGEST_ENABLED: "0" } })
  t.after(async () => { await gw.close(); await off.close(); await up.close() })

  assert.deepEqual((await gw.suggest({ q: "  ", a: "" })).json.suggestions, [])
  assert.equal((await off.suggest(ROUND)).json.err, "disabled")
  assert.equal(up.seen.length, 0, "这两种情况都不该打上游")
})

test("成本按 usage 入账（不然点建议＝不花钱地绕开每日额度）", async (t) => {
  const up = await fakeUpstream(reply('["继续做生存分析"]', { prompt_tokens: 10000, completion_tokens: 1000 }))
  const gw = await gateway({ upstream: up.url })
  t.after(async () => { await gw.close(); await up.close() })

  assert.equal(await gw.quotaUsed(), 0)
  await gw.suggest(ROUND)
  // 默认单价 in 0.27 / out 1.10（USD 每百万 token）→ 10000*0.27/1e6 + 1000*1.10/1e6
  const used = await gw.quotaUsed()
  assert.ok(Math.abs(used - (0.0027 + 0.0011)) < 1e-9, `记账不对：${used}`)
})

test("额度用尽后不再要建议", async (t) => {
  const up = await fakeUpstream(reply('["继续做生存分析"]', { prompt_tokens: 10000, completion_tokens: 1000 }))
  const gw = await gateway({ upstream: up.url, env: { DAILY_COST_LIMIT: "0.003" } })
  t.after(async () => { await gw.close(); await up.close() })

  assert.equal((await gw.suggest(ROUND)).json.ok, true)      // 第一次把额度打满（0.0038 > 0.003）
  const r = await gw.suggest(ROUND)
  assert.equal(r.json.err, "quota")
  assert.equal(up.seen.length, 1, "超额后不该再打上游")
})

test("并发封顶：在途超过 3 个就直接回空，不排队烧钱", async (t) => {
  let release
  const gate = new Promise((r) => (release = r))
  const up = await fakeUpstream(async (req, res) => {
    await gate
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { content: '["继续做生存分析"]' } }] }))
  })
  const gw = await gateway({ upstream: up.url })
  t.after(async () => { release(); await gw.close(); await up.close() })

  const inflight = [gw.suggest(ROUND), gw.suggest(ROUND), gw.suggest(ROUND)]
  for (let i = 0; i < 200 && up.seen.length < 3; i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal(up.seen.length, 3, "前 3 个应该都打到上游")
  const fourth = await gw.suggest(ROUND)                     // 第 4 个在途时到达
  assert.equal(fourth.json.err, "busy")
  assert.equal(up.seen.length, 3, "第 4 个不该打上游")
  release()
  for (const p of inflight) assert.equal((await p).json.ok, true)
})

test("受限模块的会话：建议要被圈在该模块范围内", async (t) => {
  const up = await fakeUpstream(reply('["核对这 12 条参考文献的 DOI"]'))
  const gw = await gateway({ upstream: up.url, moduleMap: { ses123: "refcheck" } })
  t.after(async () => { await gw.close(); await up.close() })

  await gw.suggest({ ...ROUND, sid: "ses123" })
  const userMsg = up.seen[0].body.messages.at(-1).content
  assert.match(userMsg, /文稿核查与审校/)
  assert.match(userMsg, /只做这一类事/)
})

test("SUGGEST_MODEL 可以把建议换到更便宜的模型上", async (t) => {
  const up = await fakeUpstream(reply('["继续做生存分析"]'))
  const gw = await gateway({ upstream: up.url, env: { SUGGEST_MODEL: "cheap-mini" } })
  t.after(async () => { await gw.close(); await up.close() })

  await gw.suggest(ROUND)
  assert.equal(up.seen[0].body.model, "cheap-mini")
})
