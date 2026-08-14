// 后台的「按条件筛人 → 勾一批 → 批量调授权」这条路。
// 关注点全在"管理员看到的和实际改的是不是同一批人"：
//   · 列筛选（Excel 式）必须在全集上算，且列之间 AND、同列多选 OR
//   · matchedIds 是批量操作的点名依据，不能被分页截断成"只改了这一页"
//   · 批量与单人编辑的三态语义必须一致（null=跟随档位 / ''=全部放行 / 'a,b'=白名单）
//   · 改完要吊销 key，否则用户手上的旧票据还按老权限跑
//   · 手滑保护：超过上限直接报错、不存在的 id 跳过而不是整批失败
import test from "node:test"
import assert from "node:assert/strict"
import { startApp, adminLogin, asAdmin } from "./helper.mjs"
import * as DB from "../lib/db.mjs"

async function setup(env = {}) {
  const app = await startApp(env)
  const cookie = await adminLogin(app)
  const admin = asAdmin(app, cookie)
  await admin("/admin/api/tier", { method: "POST", body: { key: "free", dailyUSD: 1, model: "m1" } })
  await admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 5, model: "m1", skills: "write-paper,search-lit" } })
  return { app, admin }
}
/** 建一批账号，返回 name → user */
async function mkUsers(admin, list) {
  const out = {}
  for (const u of list) {
    const r = await admin("/admin/api/user-add", { method: "POST", body: { displayName: u.dn, username: u.un, tier: u.tier, hospital: u.hos || "" } })
    assert.equal(r.status, 200, r.text)
    out[u.un] = r.json.user
  }
  return out
}
const overview = (admin, qs = "") => admin("/admin/api/overview" + (qs ? "?" + qs : ""))
const namesOf = (r) => r.json.users.map((u) => u.username).sort()
const F = (o) => "f=" + encodeURIComponent(JSON.stringify(o))

test("列筛选：档位多选是 OR，与状态列之间是 AND", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await mkUsers(admin, [
    { dn: "张三", un: "zhangsan", tier: "plus" },
    { dn: "李四", un: "lisi", tier: "free" },
    { dn: "王五", un: "wangwu", tier: "plus" },
  ])
  await admin("/admin/api/suspend", { method: "POST", body: { id: u.wangwu.id, suspended: true } })

  assert.deepEqual(namesOf(await overview(admin, F({ tiers: ["plus"] }))), ["wangwu", "zhangsan"])
  assert.deepEqual(namesOf(await overview(admin, F({ tiers: ["plus", "free"] }))), ["lisi", "wangwu", "zhangsan"])
  // 档位 plus 且 状态正常 → 只剩张三
  assert.deepEqual(namesOf(await overview(admin, F({ tiers: ["plus"], status: ["active"] }))), ["zhangsan"])
  assert.deepEqual(namesOf(await overview(admin, F({ status: ["suspended"] }))), ["wangwu"])
})

test("列筛选：技能授权形态 + 「能用这些技能」", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await mkUsers(admin, [
    { dn: "张三", un: "zhangsan", tier: "plus" },   // 跟随档位 → 白名单 write-paper,search-lit
    { dn: "李四", un: "lisi", tier: "free" },       // 跟随档位 → free 档不限技能
    { dn: "王五", un: "wangwu", tier: "plus" },
    { dn: "赵六", un: "zhaoliu", tier: "plus" },
  ])
  await admin("/admin/api/user-update", { method: "POST", body: { id: u.wangwu.id, skillsOverride: "" } })            // any
  await admin("/admin/api/user-update", { method: "POST", body: { id: u.zhaoliu.id, skillsOverride: "grant-proposal" } }) // pick

  assert.deepEqual(namesOf(await overview(admin, F({ skillMode: ["follow"] }))), ["lisi", "zhangsan"])
  assert.deepEqual(namesOf(await overview(admin, F({ skillMode: ["any"] }))), ["wangwu"])
  assert.deepEqual(namesOf(await overview(admin, F({ skillMode: ["pick"] }))), ["zhaoliu"])
  assert.deepEqual(namesOf(await overview(admin, F({ skillMode: ["any", "pick"] }))), ["wangwu", "zhaoliu"])
  // 能用 write-paper 的人：跟随 plus 档的张三、不限的李四与王五（空白名单=不限）
  assert.deepEqual(namesOf(await overview(admin, F({ hasSkill: ["write-paper"] }))), ["lisi", "wangwu", "zhangsan"])
  // 多选取 AND：既能写标书又能写论文的只有"不限"的那两个
  assert.deepEqual(namesOf(await overview(admin, F({ hasSkill: ["write-paper", "grant-proposal"] }))), ["lisi", "wangwu"])
})

test("列筛选：医院包含 + 与姓名搜索叠加；坏 JSON 当没传（不能 500）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await mkUsers(admin, [
    { dn: "张三", un: "zhangsan", tier: "free", hos: "协和医院" },
    { dn: "张伟", un: "zhangwei", tier: "free", hos: "华西医院" },
    { dn: "李四", un: "lisi", tier: "free", hos: "协和医院" },
  ])
  assert.deepEqual(namesOf(await overview(admin, F({ hospital: "协和" }))), ["lisi", "zhangsan"])
  assert.deepEqual(namesOf(await overview(admin, "q=" + encodeURIComponent("张") + "&" + F({ hospital: "协和" }))), ["zhangsan"])
  const bad = await overview(admin, "f=%7Bnot-json")
  assert.equal(bad.status, 200)
  assert.equal(bad.json.users.length, 3, "参数写坏了要退化成不筛，而不是整页打不开")
})

test("matchedIds 覆盖全部命中（不被分页截断），是批量点名的依据", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const list = []
  for (let i = 0; i < 7; i++) list.push({ dn: "医生" + i, un: "doc" + i, tier: i % 2 ? "plus" : "free" })
  await mkUsers(admin, list)
  const r = await overview(admin, "limit=2&" + F({ tiers: ["free"] }))
  assert.equal(r.json.users.length, 2, "这一页只回 2 条")
  assert.equal(r.json.matched, 4)
  assert.equal(r.json.matchedIds.length, 4, "matchedIds 要是全部命中，否则'选中全部命中'只会勾到这一页")
  // 没有任何筛选时也要给（"全选"在无筛选状态同样要能用）
  const all = await overview(admin, "limit=2")
  assert.equal(all.json.matchedIds.length, 7)
  assert.ok(all.json.maxBulk > 0)
})

test("批量技能授权：三态语义与单人编辑一致，且吊销 key", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await mkUsers(admin, [
    { dn: "张三", un: "zhangsan", tier: "plus" },
    { dn: "李四", un: "lisi", tier: "plus" },
  ])
  const ep0 = app.db.prepare("SELECT key_epoch FROM users WHERE id=?").get(u.zhangsan.id).key_epoch
  const ids = [u.zhangsan.id, u.lisi.id]

  // 白名单
  let r = await admin("/admin/api/users-bulk", { method: "POST", body: { ids, skillsOverride: "grant-proposal,ocr" } })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.changed, 2)
  for (const id of ids) {
    assert.equal(DB.getUserById(app.db, id).skills_override, "grant-proposal,ocr")
    assert.deepEqual(DB.resolveEntitlement(app.db, DB.getUserById(app.db, id)).skills, ["grant-proposal", "ocr"])
  }
  assert.ok(app.db.prepare("SELECT key_epoch FROM users WHERE id=?").get(u.zhangsan.id).key_epoch > ep0, "改技能必须吊销 key")

  // 全部放行（覆盖档位）
  r = await admin("/admin/api/users-bulk", { method: "POST", body: { ids, skillsOverride: "" } })
  assert.equal(r.json.changed, 2)
  assert.equal(DB.getUserById(app.db, u.lisi.id).skills_override, "")
  assert.deepEqual(DB.resolveEntitlement(app.db, DB.getUserById(app.db, u.lisi.id)).skills, [])

  // 跟随档位（清掉个人覆盖）
  r = await admin("/admin/api/users-bulk", { method: "POST", body: { ids, skillsOverride: null } })
  assert.equal(r.json.changed, 2)
  assert.equal(DB.getUserById(app.db, u.lisi.id).skills_override, null)
  assert.deepEqual(DB.resolveEntitlement(app.db, DB.getUserById(app.db, u.lisi.id)).skills, ["write-paper", "search-lit"])
})

test("批量改档位 / 批量停用；逐人审计 + 一条汇总", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await mkUsers(admin, [
    { dn: "张三", un: "zhangsan", tier: "free" },
    { dn: "李四", un: "lisi", tier: "free" },
  ])
  const ids = [u.zhangsan.id, u.lisi.id]
  let r = await admin("/admin/api/users-bulk", { method: "POST", body: { ids, tier: "plus" } })
  assert.equal(r.json.changed, 2)
  assert.equal(DB.getUserById(app.db, u.zhangsan.id).tier, "plus")

  r = await admin("/admin/api/users-bulk", { method: "POST", body: { ids, suspended: true } })
  assert.equal(r.json.changed, 2)
  assert.equal(DB.getUserById(app.db, u.lisi.id).status, "suspended")

  const perUser = app.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='user.update' AND target=?").get("zhangsan").n
  assert.ok(perUser >= 2, "按人查历史时，批量改的那几次也必须在场")
  const sum = app.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='user.bulk_update'").get().n
  assert.equal(sum, 2)
})

test("批量的手滑保护：没选人 / 没改项 / 超上限 / 档位不存在 都要拦下", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await mkUsers(admin, [{ dn: "张三", un: "zhangsan", tier: "free" }])
  const bad = [
    [{ ids: [], tier: "plus" }, /没有选中/],
    [{ ids: [u.zhangsan.id] }, /没有要改的项/],
    [{ ids: Array.from({ length: 501 }, (_, i) => i + 1), tier: "plus" }, /最多批量/],
    [{ ids: [u.zhangsan.id], tier: "nope" }, /档位不存在/],
  ]
  for (const [body, re] of bad) {
    const r = await admin("/admin/api/users-bulk", { method: "POST", body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.match(r.json.err, re)
  }
  assert.equal(DB.getUserById(app.db, u.zhangsan.id).tier, "free", "被拦下的请求不许留下任何改动")
})

test("批量里混进了已删除的 id：其余照常改，缺的如实报回", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await mkUsers(admin, [{ dn: "张三", un: "zhangsan", tier: "free" }])
  const r = await admin("/admin/api/users-bulk", { method: "POST", body: { ids: [u.zhangsan.id, 99999], tier: "plus" } })
  assert.equal(r.json.changed, 1)
  assert.deepEqual(r.json.missing, [99999])
  assert.equal(DB.getUserById(app.db, u.zhangsan.id).tier, "plus")
})

test("批量口也归管理员门禁（没登录一律 401）", async (t) => {
  const app = await startApp(); t.after(() => app.close())
  const r = await app.req("/admin/api/users-bulk", { method: "POST", body: { ids: [1], tier: "plus" } })
  assert.equal(r.status, 401)
})
