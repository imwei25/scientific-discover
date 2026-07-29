// 运营后台本身的行为。上一版后台踩出来的一批坑都钉在这里，每条都对应一个真实的
// "管理员看到的和实际发生的不是一回事"：
//   · 批量接入模型把手工填好的真实单价洗回默认价 → 账静默偏
//   · 删模型/删供应商不清档位清单 → 授权在重建同名模型时凭空复活
//   · 编辑用户时"姓留空"被当成"清空姓" → 此后按姓搜不到这个人
//   · "命中 N"其实是被 limit 截断后的条数 → 管理员被误导
//   · 匿名请求能往审计表写任意长文本 → 审计页可被打爆
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { startApp, adminLogin, asAdmin } from "./helper.mjs"
import * as DB from "../lib/db.mjs"

async function setup(env = {}) {
  const app = await startApp(env)
  const cookie = await adminLogin(app)
  return { app, admin: asAdmin(app, cookie), cookie }
}
const addProvider = (admin, key, extra = {}) =>
  admin("/admin/api/provider", { method: "POST", body: { key, name: key, baseURL: "http://127.0.0.1:1/v1", apiKey: "sk-x", ...extra } })

// ---- 模型目录：批量接入不许覆盖已填好的单价 ----------------------------------

test("批量接入：勾中【已接入】的模型不覆盖它的单价/中文名/上游真实名", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await addProvider(admin, "px")
  // 手工建一行并填上这家的真实单价
  await admin("/admin/api/model", { method: "POST", body: {
    model: "mm", provider: "px", upstream: "real-mm", label: "深度思考",
    priceIn: 9.9, priceOut: 19.9, priceCached: 1.1, sort: 3 } })
  // 再走一次「+ 模型」批量勾选，勾中同一个 mm（批量项只带模型名）
  const r = await admin("/admin/api/model", { method: "POST", body: { bulk: true, items: [{ model: "mm", provider: "px" }] } })
  assert.equal(r.status, 200)
  assert.equal(r.json.saved, 0)
  assert.equal(r.json.skipped, 1, "已接入的应当被跳过，而不是被覆盖")

  const row = app.db.prepare("SELECT * FROM models WHERE model='mm' AND provider='px'").get()
  assert.equal(row.price_in, 9.9, "单价被洗掉就意味着账会静默偏")
  assert.equal(row.price_out, 19.9)
  assert.equal(row.label, "深度思考")
  assert.equal(row.upstream, "real-mm")
  assert.equal(row.sort, 3)
})

test("批量接入：没接入过的照常落库，单价用 env 兜底价", async (t) => {
  const { app, admin } = await setup({ COST_INPUT: "0.5", COST_OUTPUT: "2" }); t.after(() => app.close())
  await addProvider(admin, "px")
  const r = await admin("/admin/api/model", { method: "POST", body: { bulk: true, items: [{ model: "a", provider: "px" }, { model: "b", provider: "px" }] } })
  assert.equal(r.json.saved, 2)
  const a = app.db.prepare("SELECT * FROM models WHERE model='a'").get()
  assert.equal(a.price_in, 0.5)
  assert.equal(a.price_out, 2)
})

test("编辑模型：改名撞上同供应商下的重名 → 400 说人话，不是 500", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await addProvider(admin, "px")
  await admin("/admin/api/model", { method: "POST", body: { model: "aaa", provider: "px" } })
  await admin("/admin/api/model", { method: "POST", body: { model: "bbb", provider: "px" } })
  const id = app.db.prepare("SELECT id FROM models WHERE model='bbb'").get().id
  const r = await admin("/admin/api/model", { method: "POST", body: { id, model: "aaa", provider: "px" } })
  assert.equal(r.status, 400)
  assert.match(r.json.err, /不能重复/)
  assert.equal(app.db.prepare("SELECT model FROM models WHERE id=?").get(id).model, "bbb", "撞了就不该改动原行")
})

// ---- 删除要连带清理档位的允许清单 --------------------------------------------

test("删模型：档位允许清单里的引用一并摘掉（否则重建同名模型会让授权自动复活）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await addProvider(admin, "px")
  await admin("/admin/api/model", { method: "POST", body: { model: "mm", provider: "px" } })
  await admin("/admin/api/tier", { method: "POST", body: { key: "free", model: "d0", models: "mm", dailyUSD: 1 } })
  assert.equal(DB.getTier(app.db, "free").models, "mm")

  const id = app.db.prepare("SELECT id FROM models WHERE model='mm'").get().id
  const del = await admin("/admin/api/model", { method: "POST", body: { id, remove: true } })
  assert.deepEqual(del.json.droppedFromTiers, { free: ["mm"] })
  assert.equal(DB.getTier(app.db, "free").models, "", "库里不该再留着这个死引用")

  // 关键：重新接入一个同名模型，档位【不该】自动重新获得授权
  await admin("/admin/api/model", { method: "POST", body: { model: "mm", provider: "px" } })
  const u = DB.createUser(app.db, { username: "z", display_name: "张三", pass_hash: "h", pass_salt: "s", tier: "free" })
  assert.deepEqual(DB.resolveEntitlement(app.db, u).models, ["d0"], "授权不该凭空复活")
})

test("删供应商：它名下模型在各档位清单里的引用也一并摘掉", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await addProvider(admin, "px")
  await admin("/admin/api/model", { method: "POST", body: { model: "m1", provider: "px" } })
  await admin("/admin/api/model", { method: "POST", body: { model: "m2", provider: "px" } })
  await admin("/admin/api/tier", { method: "POST", body: { key: "plus", model: "d0", models: "m1,m2", dailyUSD: 1 } })
  const r = await admin("/admin/api/provider", { method: "POST", body: { key: "px", remove: true } })
  assert.equal(r.json.removedModels, 2)
  assert.deepEqual(r.json.droppedFromTiers, { plus: ["m1", "m2"] })
  assert.equal(DB.getTier(app.db, "plus").models, "")
})

test("同名模型还有别家提供时，删掉其中一家不摘档位清单", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await addProvider(admin, "px"); await addProvider(admin, "py")
  await admin("/admin/api/model", { method: "POST", body: { model: "mm", provider: "px", sort: 1 } })
  await admin("/admin/api/model", { method: "POST", body: { model: "mm", provider: "py", sort: 2 } })
  await admin("/admin/api/tier", { method: "POST", body: { key: "free", model: "d0", models: "mm", dailyUSD: 1 } })
  const id = app.db.prepare("SELECT id FROM models WHERE model='mm' AND provider='px'").get().id
  await admin("/admin/api/model", { method: "POST", body: { id, remove: true } })
  assert.equal(DB.getTier(app.db, "free").models, "mm", "还有 py 撑着，清单不该被摘")
})

// ---- 用户编辑 ----------------------------------------------------------------

test("编辑用户：姓留空 = 按姓名自动识别（不是把姓清空）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "u1", displayName: "张三" } })
  const id = add.json.user.id
  // 前端总是无条件发 surname:''（框里留空）—— 照字面存就是空姓
  await admin("/admin/api/user-update", { method: "POST", body: { id, displayName: "李四", surname: "" } })
  const row = app.db.prepare("SELECT surname FROM users WHERE id=?").get(id)
  assert.equal(row.surname, "李")
  // 按姓检索时该排在最前（rank 0），空姓会让这条路彻底失效
  const r = await admin("/admin/api/overview?q=" + encodeURIComponent("李"))
  assert.equal(r.json.users[0].surname, "李")
  // 显式给了姓就照给的存
  await admin("/admin/api/user-update", { method: "POST", body: { id, surname: "欧阳" } })
  assert.equal(app.db.prepare("SELECT surname FROM users WHERE id=?").get(id).surname, "欧阳")
})

// ---- 列表：真实命中数、分页、档位人数、筛选 ----------------------------------

test("overview：命中数是真实计数，不是被 limit 截断后的条数；且能翻页", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  for (let i = 0; i < 12; i++)
    await admin("/admin/api/user-add", { method: "POST", body: { username: "u" + i, displayName: "王小明" } })

  const r = await admin("/admin/api/overview?q=" + encodeURIComponent("王") + "&limit=5")
  assert.equal(r.json.users.length, 5)
  assert.equal(r.json.matched, 12, "命中数不该被 limit 截断")
  const p2 = await admin("/admin/api/overview?q=" + encodeURIComponent("王") + "&limit=5&offset=10")
  assert.equal(p2.json.users.length, 2)
  assert.equal(p2.json.offset, 10)
})

test("overview：档位人数按全库 GROUP BY，不受当前搜索/分页影响", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await admin("/admin/api/user-add", { method: "POST", body: { username: "a1", displayName: "张三", tier: "free" } })
  await admin("/admin/api/user-add", { method: "POST", body: { username: "a2", displayName: "李四", tier: "free" } })
  await admin("/admin/api/user-add", { method: "POST", body: { username: "a3", displayName: "王五", tier: "plus" } })
  const r = await admin("/admin/api/overview?q=" + encodeURIComponent("张"))
  assert.equal(r.json.users.length, 1, "列表被搜索词过滤了")
  assert.deepEqual(r.json.tierCounts, { free: 2, plus: 1 }, "人数不该跟着搜索词变")
})

test("overview：筛选器在全集上算（已停用 / 待改密 / 本月触顶）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const ids = {}
  for (const [un, dn] of [["a1", "张三"], ["a2", "李四"], ["a3", "王五"]]) {
    const r = await admin("/admin/api/user-add", { method: "POST", body: { username: un, displayName: dn } })
    ids[un] = r.json.user.id
  }
  await admin("/admin/api/suspend", { method: "POST", body: { id: ids.a2, suspended: true } })
  let r = await admin("/admin/api/overview?filter=suspended")
  assert.equal(r.json.matched, 1)
  assert.equal(r.json.users[0].username, "a2")

  // 全员都是"待改密"（新建号必然如此）
  r = await admin("/admin/api/overview?filter=pwchange")
  assert.equal(r.json.matched, 3)

  // 把 a3 的月用量顶到上限之上
  await admin("/admin/api/user-update", { method: "POST", body: { id: ids.a3, monthlyOverride: 1 } })
  DB.recordUsage(app.db, ids.a3, { cost_usd: 2, model: "m" })
  r = await admin("/admin/api/overview?filter=overmonth")
  assert.equal(r.json.matched, 1)
  assert.equal(r.json.users[0].username, "a3")
})

// ---- 对账 --------------------------------------------------------------------

test("对账：按模型/供应商/用户聚合，且 CSV 导出带 BOM", async (t) => {
  const { app, admin, cookie } = await setup(); t.after(() => app.close())
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "u1", displayName: "张三" } })
  const uid = add.json.user.id
  DB.recordUsage(app.db, uid, { model: "fast", provider: "px", skill: "write-paper", cost_usd: 1, prompt_tokens: 10, completion_tokens: 5 })
  DB.recordUsage(app.db, uid, { model: "fast", provider: "py", skill: "", cost_usd: 2, prompt_tokens: 20, completion_tokens: 1 })
  DB.recordUsage(app.db, uid, { model: "slow", provider: "px", skill: "", cost_usd: 4, prompt_tokens: 1, completion_tokens: 1 })

  const s = await admin("/admin/api/usage-summary")
  assert.equal(s.status, 200)
  assert.deepEqual(s.json.byModel.map((x) => [x.model, x.calls, x.cost]), [["slow", 1, 4], ["fast", 2, 3]])
  assert.deepEqual(s.json.byProvider.map((x) => [x.provider, x.cost]), [["px", 5], ["py", 2]])
  assert.equal(s.json.byUser[0].username, "u1")
  assert.equal(s.json.byUser[0].cost, 7)

  const csv = await admin("/admin/api/usage-export?by=model")
  assert.match(csv.headers["content-type"], /text\/csv/)
  assert.match(csv.headers["content-disposition"], /attachment/)
  assert.match(csv.text, /模型,调用数/)
  assert.match(csv.text, /fast,2,3/)
  // 【BOM 要按字节验】Response.text() 按 WHATWG 规范会把前导 BOM 吃掉，用它断言永远看不见 ——
  // 而 Excel 恰恰只认那三个字节，不带就是满屏乱码。
  const bytes = Buffer.from(await (await fetch(app.base + "/admin/api/usage-export?by=model", { headers: { cookie } })).arrayBuffer())
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "不带 BOM 的话 Excel 打开中文全是乱码")

  const bad = await admin("/admin/api/usage-export?from=2026-13")
  assert.equal(bad.status, 400)
})

test("对账：CSV 里的逗号与引号被正确转义", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "u1", displayName: '张,三"' } })
  DB.recordUsage(app.db, add.json.user.id, { model: "a,b", cost_usd: 1 })
  const csv = await admin("/admin/api/usage-export?by=detail")
  assert.match(csv.text, /"a,b"/)
  assert.match(csv.text, /"张,三"""/)
})

// ---- 审计 --------------------------------------------------------------------

test("审计：字段入库前截断（匿名登录名是可写口子，不设限就能把审计页打爆）", async (t) => {
  const { app } = await setup(); t.after(() => app.close())
  await app.req("/api/auth/login", { method: "POST", body: { username: "A".repeat(5000), password: "x" } })
  const row = app.db.prepare("SELECT actor FROM audit ORDER BY id DESC LIMIT 1").get()
  assert.ok(!row || row.actor.length <= 66, "actor 长度=" + (row && row.actor.length))
})

test("审计：可按事件前缀与操作人筛，并翻页", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  for (let i = 0; i < 5; i++)
    await admin("/admin/api/user-add", { method: "POST", body: { username: "u" + i, displayName: "张三" } })
  const all = await admin("/admin/api/audit")
  assert.ok(all.json.total >= 6)
  assert.ok(all.json.events.some((e) => e.event === "user.add"))

  const only = await admin("/admin/api/audit?event=user.")
  assert.equal(only.json.rows.length, 5)
  assert.ok(only.json.rows.every((r) => r.event.startsWith("user.")))

  const page = await admin("/admin/api/audit?event=user.&limit=2&offset=2")
  assert.equal(page.json.rows.length, 2)
  assert.equal(page.json.total, 5)

  const byActor = await admin("/admin/api/audit?actor=nobody")
  assert.equal(byActor.json.rows.length, 0)
})

test("审计：保留策略会清掉过老的行", async () => {
  const db = DB.openDb(":memory:")
  DB.addAudit(db, { event: "old" })
  db.prepare("UPDATE audit SET ts=?").run(Date.now() - 400 * 86400_000)
  DB.addAudit(db, { event: "new" })
  assert.equal(DB.purgeAudit(db, 180), 1)
  assert.deepEqual(DB.listAudit(db).map((r) => r.event), ["new"])
})

// ---- CSRF --------------------------------------------------------------------

test("后台写接口：跨站来源一律拒绝（换成自有域名部署后 SameSite=Lax 就挡不住子域）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const cookie = (await app.req("/admin/api/login", { method: "POST", body: { password: "adminpw" }, headers: { "x-test-bypass": "t-bypass" } })).headers["set-cookie"].split(";")[0]

  const cross = await app.req("/admin/api/user-add", {
    method: "POST", body: { username: "evil", displayName: "坏人" },
    headers: { cookie, "sec-fetch-site": "cross-site" },
  })
  assert.equal(cross.status, 403)
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username='evil'").get().n, 0)

  const byOrigin = await app.req("/admin/api/user-add", {
    method: "POST", body: { username: "evil2", displayName: "坏人" },
    headers: { cookie, origin: "http://attacker.example" },
  })
  assert.equal(byOrigin.status, 403)

  // 同源、以及"两个头都没有"（curl / ops 脚本）必须照常放行
  const same = await admin("/admin/api/user-add", {
    method: "POST", body: { username: "good", displayName: "张三" }, headers: { "sec-fetch-site": "same-origin" },
  })
  assert.equal(same.status, 200)
  assert.equal((await admin("/admin/api/user-add", { method: "POST", body: { username: "good2", displayName: "李四" } })).status, 200)
})

// ---- 老库形状 ----------------------------------------------------------------

test("升级：meta 表在、但没有 schema_version 行的老库也要补齐列（别拿版本号当前置条件）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sci-mig-"))
  const file = path.join(dir, "sci.db")
  // 手搓一个 v1 形状：tiers 无 models 列、usage_log 无 provider 列，meta 里也没有版本行
  const raw = new DatabaseSync(file)
  raw.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
            CREATE TABLE tiers (key TEXT PRIMARY KEY, daily_usd REAL NOT NULL DEFAULT 0,
              monthly_usd REAL NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '',
              skills TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
              ts INTEGER NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
              skill TEXT NOT NULL DEFAULT '', prompt_tokens INTEGER NOT NULL DEFAULT 0,
              completion_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0,
              cost_usd REAL NOT NULL DEFAULT 0);
            INSERT INTO meta(k,v) VALUES('key_secret','s');
            INSERT INTO tiers(key,model) VALUES('free','m');`)
  raw.close()

  const db = DB.openDb(file)
  assert.ok(DB.listTiers(db).every((t) => t.models !== undefined), "tiers.models 必须补上")
  assert.equal(DB.getTier(db, "free").model, "m", "老数据不能丢")
  assert.ok(db.prepare("PRAGMA table_info(usage_log)").all().some((c) => c.name === "provider"))
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
