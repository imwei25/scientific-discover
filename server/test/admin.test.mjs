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

// ---- 公告 --------------------------------------------------------------------

test("公告：发布 → 随 /api/me、/api/notice、/api/notices 下发；撤下后客户端不再看到", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const empty = await admin("/admin/api/notice")
  assert.deepEqual(empty.json.notices, [])

  const set = await admin("/admin/api/notice", { method: "POST", body: { text: "今晚 22:00 维护", level: "warn" } })
  assert.equal(set.status, 200)
  assert.equal(set.json.notice.id, 1)
  assert.equal(set.json.notice.status, "active")

  // 客户端侧：/api/notice（最新一条 + 摘要）与 /api/me 都要带上
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "u1", displayName: "张三" } })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "u1", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", { method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: "Aa1!aaaa9" } })
  const tok = { authorization: "Bearer " + chg.json.access }

  const n = await app.req("/api/notice", { headers: tok })
  assert.equal(n.json.notice.text, "今晚 22:00 维护")
  assert.equal(n.json.notice.level, "warn")
  assert.equal(n.json.needUpgrade, false, "没设最低版本就不该催升级")
  assert.equal(chg.json.profile.notice.text, "今晚 22:00 维护")
  // digest 只给 id/级别/时间：未读红点要的就这些，正文不必每 5 分钟搬一遍
  assert.deepEqual(Object.keys(n.json.digest[0]).sort(), ["createdAt", "id", "level"])
  assert.equal(n.json.keepDays, 180)

  // 列表（面板里那份，带正文）
  const list = await app.req("/api/notices", { headers: tok })
  assert.equal(list.json.notices.length, 1)
  assert.equal(list.json.notices[0].text, "今晚 22:00 维护")

  const off = await admin("/admin/api/notice", { method: "POST", body: { action: "withdraw", id: 1 } })
  assert.equal(off.status, 200)
  assert.equal((await app.req("/api/notice", { headers: tok })).json.notice, null)
  assert.deepEqual((await app.req("/api/notices", { headers: tok })).json.notices, [])
  assert.equal(off.json.notices[0].status, "withdrawn", "后台仍要看得到自己发过什么")
})

test("公告：发多条留历史（这就是「点掉就再也找不回来」的解法）；改错别字不换 id", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const a = await admin("/admin/api/notice", { method: "POST", body: { text: "第一条", level: "info" } })
  const b = await admin("/admin/api/notice", { method: "POST", body: { text: "第二条", level: "urgent" } })
  assert.equal(a.json.notice.id, 1)
  assert.equal(b.json.notice.id, 2)

  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "u1", displayName: "张三" } })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "u1", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", { method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: "Aa1!aaaa9" } })
  const tok = { authorization: "Bearer " + chg.json.access }

  const list = await app.req("/api/notices", { headers: tok })
  assert.deepEqual(list.json.notices.map((x) => x.text), ["第二条", "第一条"], "新的在前")
  assert.equal((await app.req("/api/notice", { headers: tok })).json.notice.text, "第二条", "老客户端只认最新一条")

  // 改错别字：id 不变 —— 客户端的"已读到哪儿"是按 id 记的，换 id = 所有人重新未读一遍
  const ed = await admin("/admin/api/notice", { method: "POST", body: { action: "edit", id: 1, text: "第一条（改）", level: "info" } })
  assert.equal(ed.json.notice.id, 1)
  assert.equal(ed.json.notice.text, "第一条（改）")
  assert.equal((await app.req("/api/notices", { headers: tok })).json.notices.find((x) => x.id === 1).text, "第一条（改）")

  // 删除是真删；撤下只是标记（上一条用例已验）
  const del = await admin("/admin/api/notice", { method: "POST", body: { action: "remove", id: 1 } })
  assert.deepEqual(del.json.notices.map((x) => x.id), [2])
  assert.equal((await admin("/admin/api/notice", { method: "POST", body: { action: "remove", id: 999 } })).status, 400)
})

test("公告：超过保留期的自动清掉，客户端与后台都不再看到", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await admin("/admin/api/notice", { method: "POST", body: { text: "半年前那条" } })
  await admin("/admin/api/notice", { method: "POST", body: { text: "昨天那条" } })
  app.db.prepare("UPDATE notices SET created_at=? WHERE id=1").run(Date.now() - 200 * 86400_000)
  // 列表按天数过滤（清理是每天一次的后台任务，两者口径必须一致，否则会出现
  // "后台列着、客户端翻不到"）
  assert.deepEqual(DB.publicNotices(app.db).map((x) => x.text), ["昨天那条"])
  assert.equal(DB.purgeNotices(app.db), 1)
  assert.deepEqual((await admin("/admin/api/notice")).json.notices.map((x) => x.text), ["昨天那条"])
})

test("公告：老库里 meta 那一条要搬进表，且只搬一次（升级当天挂着的公告不能凭空消失）", async (t) => {
  const { app } = await setup(); t.after(() => app.close())
  const db = app.db
  db.prepare("DELETE FROM notices").run()
  db.prepare("DELETE FROM meta WHERE k='notice_migrated'").run()
  const when = Date.now() - 3 * 86400_000
  db.prepare("INSERT INTO meta(k,v) VALUES('notice',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .run(JSON.stringify({ enabled: true, text: "老公告", level: "warn", minClientVersion: "1.2.0", downloadUrl: "", id: 7, updatedAt: when }))

  const moved = DB.migrateLegacyNotice(db)
  assert.equal(moved.text, "老公告")
  // 【id 必须越过老 id】老客户端判"要不要弹"用的是 已读id >= notice.id；新公告 id 低于
  // 老游标就会被静默吞掉 —— 管理员以为发出去了，老用户永远看不到
  assert.ok(moved.id > 7, "搬过来的那条 id 要大于老 meta 里的 id=7，实际 " + moved.id)
  assert.equal(moved.level, "warn")
  assert.equal(moved.minClientVersion, "1.2.0")
  assert.equal(moved.createdAt, when, "时间要用老记录的，否则升级当天所有老公告都变成「刚刚发布」")
  assert.equal(DB.migrateLegacyNotice(db), null, "幂等：再跑一次不该复制一份")
  assert.equal(DB.listNotices(db, { all: true }).length, 1)
  assert.ok(DB.publishNotice(db, { text: "升级后新发" }).id > 7, "升级后新发的也要越过老游标")

  // 停发状态的那条不搬（它本来就不该出现在用户眼前）
  db.prepare("DELETE FROM notices").run()
  db.prepare("DELETE FROM meta WHERE k='notice_migrated'").run()
  db.prepare("UPDATE meta SET v=? WHERE k='notice'").run(JSON.stringify({ enabled: false, text: "停发的", id: 12, updatedAt: when }))
  assert.equal(DB.migrateLegacyNotice(db), null)
  assert.equal(DB.listNotices(db, { all: true }).length, 0)
  // 停发的那条不搬内容，但用户照样点过它 —— id 序列同样要抬过去
  assert.ok(DB.publishNotice(db, { text: "之后新发的" }).id > 12)
})

test("公告：最低客户端版本按 X-Client-Version 判，认不出版本的构建一律不催", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await admin("/admin/api/notice", { method: "POST", body: {
    enabled: true, text: "有新版了", minClientVersion: "1.2.0", downloadUrl: "https://example.invalid/dl" } })
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "u1", displayName: "张三" } })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "u1", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", { method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: "Aa1!aaaa9" } })
  const ask = (v) => app.req("/api/notice", { headers: { authorization: "Bearer " + chg.json.access, ...(v ? { "x-client-version": v } : {}) } })

  assert.equal((await ask("1.1.9")).json.needUpgrade, true)
  assert.equal((await ask("1.2.0")).json.needUpgrade, false)
  assert.equal((await ask("1.10.0")).json.needUpgrade, false, "1.10 > 1.2，别按字符串比")
  assert.equal((await ask("2")).json.needUpgrade, false)
  assert.equal((await ask("dev")).json.needUpgrade, false, "开发机每次打开都被弹升级提示毫无意义")
  assert.equal((await ask(null)).json.needUpgrade, false, "老客户端不发这个头，也不该被催")
})

test("公告：非法的最低版本与下载地址被拒（下载地址会被渲染成链接）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  for (const body of [{ minClientVersion: "v1.2" }, { minClientVersion: "1.2.0-beta" }]) {
    const r = await admin("/admin/api/notice", { method: "POST", body: { enabled: true, text: "x", ...body } })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.match(r.json.err, /点分数字/)
  }
  for (const url of ["javascript:alert(1)", "ftp://x/y", "example.com/dl"]) {
    const r = await admin("/admin/api/notice", { method: "POST", body: { enabled: true, text: "x", downloadUrl: url } })
    assert.equal(r.status, 400, url)
    assert.match(r.json.err, /http/)
  }
  // 内容与最低版本都空 = 发出去用户什么也看不到
  const blank = await admin("/admin/api/notice", { method: "POST", body: { text: "   " } })
  assert.equal(blank.status, 400)
  assert.equal(DB.listNotices(app.db, { all: true }).length, 0, "被拒的请求不该留下任何痕迹")
})

test("公告：/api/notices 也要凭 access key（未登录看不到平台在发什么）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await admin("/admin/api/notice", { method: "POST", body: { text: "维护中" } })
  assert.equal((await app.req("/api/notices")).status, 401)
  assert.equal((await app.req("/api/notices", { headers: { authorization: "Bearer bogus" } })).status, 401)
})

test("公告：/api/notice 要凭 access key，且还没改初始口令的人也看得到（维护通知对他们同样有效）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await admin("/admin/api/notice", { method: "POST", body: { enabled: true, text: "维护中" } })
  assert.equal((await app.req("/api/notice")).status, 401)
  assert.equal((await app.req("/api/notice", { headers: { authorization: "Bearer bogus" } })).status, 401)

  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "u1", displayName: "张三" } })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "u1", password: add.json.initialPassword } })
  assert.equal(li.json.scope, "pwchange")
  const r = await app.req("/api/notice", { headers: { authorization: "Bearer " + li.json.access } })
  assert.equal(r.status, 200)
  assert.equal(r.json.notice.text, "维护中")
})

test("cmpVersion：点分数字按段比，认不出来的返回 null", async (t) => {
  const { app } = await setup(); t.after(() => app.close())
  const { cmpVersion } = app.mod
  assert.equal(cmpVersion("1.2.0", "1.2.0"), 0)
  assert.equal(cmpVersion("1.10.0", "1.9.9"), 1)
  assert.equal(cmpVersion("1.2", "1.2.0"), 0, "缺的段补 0")
  assert.equal(cmpVersion("1.2", "1.2.1"), -1)
  assert.equal(cmpVersion("dev", "1.0.0"), null)
  assert.equal(cmpVersion("1.0.0", ""), null)
  assert.equal(cmpVersion("1.0.0-rc1", "1.0.0"), null)
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
