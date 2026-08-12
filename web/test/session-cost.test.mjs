// 会话列表里的「本会话共消耗多少积分」（侧栏悬停提示的数据源）—— 服务端契约的回归测试。
//
// 【为什么值得一个测试文件】这个数字唯一容易错的地方就是【子会话】：子代理（task 工具）跑在
// 子会话里，花费记在子会话的 cost 上，opencode 【不会】把它滚进父会话（实测一条父会话 $0.271、
// 其子会话另有 $0.134）。少加这一笔的话，恰恰是最贵、用了子代理的那几条会话显示得最不准 ——
// 而"显示得偏小"没有任何人会来报错，只会让人对这个数字失去信任。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

let seq = 0

/** 假 opencode：只需要会话列表（带 cost / parentID）与单会话查询。fail 用来模拟某个口坏掉。 */
async function fakeOpencode(sessions, fail = {}) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x")
    res.setHeader("content-type", "application/json")
    if (u.pathname === "/session" && req.method === "GET") {
      if (fail.list) { res.statusCode = 500; return res.end(JSON.stringify({ error: "boom" })) }
      return res.end(JSON.stringify(sessions))
    }
    const m = /^\/session\/([^/]+)$/.exec(u.pathname)
    if (m && req.method === "GET") {
      const s = sessions.find((x) => x.id === m[1])
      if (!s) { res.statusCode = 404; return res.end(JSON.stringify({ error: "no such session" })) }
      return res.end(JSON.stringify(s))
    }
    res.end(JSON.stringify({}))
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }
}

async function gateway(ocUrl, dir) {
  const over = {
    MANAGE_OC: "0", PORT: "0", AUTH_ENABLED: "", OC_URL: ocUrl,
    HOME: dir, USERPROFILE: dir,
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
    ALLOWED_SKILLS: "", ALLOWED_MODULES: "", SUGGEST_ENABLED: "0",
    BASE_PATH: "", SCI_FS_SCOPE: "",
  }
  const saved = {}
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  let mod
  try { mod = await import(`../server.mjs?cost=${++seq}`) } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来")
  const base = `http://127.0.0.1:${port}`
  return {
    mod,
    close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())),
    async get(p) { const r = await fetch(base + p); return { status: r.status, json: await r.json().catch(() => null) } },
  }
}

const S = (id, cost, parentID) => ({ id, title: id, cost, ...(parentID ? { parentID } : {}), time: { updated: 1_700_000_000_000 } })

test("会话消耗：自己 + 所有子会话（子代理的花费不会滚进父会话）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-"))
  const oc = await fakeOpencode([
    S("ses_a", 0.2713),
    S("ses_a_kid", 0.1338, "ses_a"),          // 子代理
    S("ses_a_grand", 0.01, "ses_a_kid"),      // 子代理自己又开的子代理
    S("ses_b", 0),                            // 没跑过模型
    S("ses_c", 0.005),                        // 不到 0.1 积分
  ])
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const r = await gw.get("/api/sessions")
  assert.equal(r.status, 200)
  const by = Object.fromEntries(r.json.sessions.map((s) => [s.id, s]))

  assert.ok(!by.ses_a_kid, "子会话不该出现在侧栏列表里（它是父会话的一部分）")
  assert.equal(r.json.creditUsd, 0.01, "没登云端账号时用缺省汇率")

  assert.ok(Math.abs(by.ses_a.costUsd - (0.2713 + 0.1338 + 0.01)) < 1e-9, "父会话 = 自己 + 子 + 孙")
  assert.ok(Math.abs(by.ses_a.credits - 41.51) < 1e-6, "积分 = 美元 / 汇率，且不在服务端取整")
  assert.equal(by.ses_b.credits, 0, "没跑过模型的会话就是 0，不是 undefined")
  assert.ok(by.ses_c.credits > 0 && by.ses_c.credits < 1, "不足 1 积分的会话要留住小数（前端才有得四舍五入）")
})

// ---- 每日额度结算用的同一个口径 ----
// 【为什么这几条比列表那几条更要紧】列表那边算错只是显示难看；这边算错是【真金白银漏账】：
// 每轮的入账额 = sessionCostTotal(轮末) - sessionCostTotal(轮前)，少算子会话就等于子代理白跑。
test("结算口径：sessionCostTotal = 自己 + 全部后代（每日额度按它算增量）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-"))
  const oc = await fakeOpencode([
    S("ses_a", 0.2713),
    S("ses_a_kid", 0.1338, "ses_a"),
    S("ses_a_grand", 0.01, "ses_a_kid"),
    S("ses_other", 99, "ses_zzz"),      // 别人家的子会话：一分钱都不该算进来
  ])
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const total = await gw.mod.sessionCostTotal("ses_a")
  assert.ok(Math.abs(total - (0.2713 + 0.1338 + 0.01)) < 1e-9, "父 + 子 + 孙")
  assert.equal(await gw.mod.sessionCostTotal("ses_a_kid"), 0.1338 + 0.01, "从子会话看也是一棵子树")
  assert.equal(await gw.mod.sessionCostTotal("ses_nobody"), 0, "不存在的会话按 0，别抛")
})

test("结算口径：列不出全表时降级成「只算自己」，别把已经拿到的那份也丢掉", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-"))
  const oc = await fakeOpencode([S("ses_a", 0.2713), S("ses_a_kid", 0.1338, "ses_a")], { list: true })
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  assert.equal(await gw.mod.sessionCostTotal("ses_a"), 0.2713, "全表列不出来，至少把自己这份记上")
})

test("结算口径：超时包装（停机路径）不改变结果形状", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-"))
  const oc = await fakeOpencode([S("ses_a", 0.2), S("ses_a_kid", 0.1, "ses_a")])
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  // gracefulExit 传进来的 race：只管超时，不许顺手把响应剥一层（剥两次会拿错东西）
  const race = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("settle timeout")), 5000))])
  assert.ok(Math.abs((await gw.mod.sessionCostTotal("ses_a", race)) - 0.3) < 1e-9)
})

test("会话消耗：opencode 压根没有 cost 字段时，宁可不给数（别把跑过的会话说成 0）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-"))
  // 老版 opencode / 异常返回：会话对象里压根没有 cost 字段
  const oc = await fakeOpencode([{ id: "ses_x", title: "x", time: { updated: 1 } }])
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const r = await gw.get("/api/sessions")
  assert.equal(r.status, 200)
  assert.equal(r.json.sessions[0].credits, undefined, "没有 cost 就别给 credits（前端见 undefined 不挂提示）")
  assert.equal(r.json.sessions[0].costUsd, undefined)
})
