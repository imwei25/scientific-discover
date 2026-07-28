import test from "node:test"
import assert from "node:assert/strict"
import {
  openDb, guessSurname, createUser, getUserByName, updateUser, deleteUser, bumpEpoch,
  searchUsers, listTiers, getTier, upsertTier, deleteTier, resolveEntitlement,
  recordUsage, todayCost, monthCost, usageDetail, usageTotalSeries,
  saveRefresh, findRefresh, revokeRefresh, purgeExpiredRefresh,
  addAudit, listAudit, dayOf, monthOf,
} from "../lib/db.mjs"

const mk = () => openDb(":memory:")
const addUser = (db, username, display, extra = {}) =>
  createUser(db, { username, display_name: display, pass_hash: "h", pass_salt: "s", ...extra })

test("guessSurname：单姓取首字，复姓整体，英文取空格前", () => {
  assert.equal(guessSurname("张三"), "张")
  assert.equal(guessSurname("王小明"), "王")
  assert.equal(guessSurname("欧阳锋"), "欧阳")
  assert.equal(guessSurname("司马相如"), "司马")
  assert.equal(guessSurname("Li Wei"), "Li")
  assert.equal(guessSurname(""), "")
  assert.equal(guessSurname(null), "")
})

test("建库：schema 播种三个默认档位", () => {
  const db = mk()
  const tiers = listTiers(db)
  assert.deepEqual(tiers.map((t) => t.key), ["free", "plus", "admin"])
  assert.equal(getTier(db, "free").daily_usd, 0.3)
  assert.equal(getTier(db, "nope"), null)
})

test("建用户：自动切姓、默认档位与 epoch", () => {
  const db = mk()
  const u = addUser(db, "zhangsan", "张三")
  assert.equal(u.surname, "张")
  assert.equal(u.tier, "free")
  assert.equal(u.status, "active")
  assert.equal(u.key_epoch, 1)
  assert.equal(u.must_change_pw, 1)
  assert.equal(getUserByName(db, "nobody"), null)
})

test("建用户：显式传姓时不覆盖（复姓切不准可人工纠正）", () => {
  const db = mk()
  const u = addUser(db, "u1", "长孙无忌", { surname: "长孙" })
  assert.equal(u.surname, "长孙")
})

test("用户名唯一", () => {
  const db = mk()
  addUser(db, "dup", "张三")
  assert.throws(() => addUser(db, "dup", "李四"), /UNIQUE|constraint/i)
})

test("bumpEpoch：epoch 自增且把该用户 refresh 全作废", () => {
  const db = mk()
  const u = addUser(db, "u1", "张三")
  saveRefresh(db, u.id, "hash-a", u.key_epoch, Date.now() + 1e6)
  assert.equal(findRefresh(db, "hash-a").revoked, 0)
  const ep = bumpEpoch(db, u.id)
  assert.equal(ep, 2)
  assert.equal(findRefresh(db, "hash-a").revoked, 1)
})

test("updateUser：只认白名单字段，防注入乱改", () => {
  const db = mk()
  const u = addUser(db, "u1", "张三")
  const after = updateUser(db, u.id, { tier: "plus", status: "suspended", id: 999, key_epoch: 77 })
  assert.equal(after.tier, "plus")
  assert.equal(after.status, "suspended")
  assert.equal(after.id, u.id)        // id 没被改
  assert.equal(after.key_epoch, 1)    // key_epoch 不在白名单，只能走 bumpEpoch
})

// ---- 姓名检索：本次需求的核心 ----
test("检索：单字命中姓 → 排最前（优先姓）", () => {
  const db = mk()
  addUser(db, "u1", "王小明")     // 名里有「小」
  addUser(db, "u2", "小龙女")     // 姓就是「小」
  addUser(db, "u3", "李小龙")     // 名里有「小」
  const r = searchUsers(db, "小")
  assert.equal(r.length, 3)
  assert.equal(r[0].display_name, "小龙女", "姓=小 的必须排第一")
  assert.deepEqual(r.slice(1).map((x) => x.display_name).sort(), ["李小龙", "王小明"])
})

test("检索：两个字同样支持，复姓优先", () => {
  const db = mk()
  addUser(db, "u1", "欧阳锋")
  addUser(db, "u2", "陈欧阳")     // 「欧阳」在名里
  const r = searchUsers(db, "欧阳")
  assert.equal(r[0].display_name, "欧阳锋")
  assert.equal(r[1].display_name, "陈欧阳")
})

test("检索：复姓用单字也能优先命中（姓包含关键词）", () => {
  const db = mk()
  addUser(db, "u1", "诸葛亮")
  addUser(db, "u2", "王诸葛")
  const r = searchUsers(db, "诸")
  assert.equal(r[0].display_name, "诸葛亮")
})

test("检索：名字中间/末尾的字也能命中", () => {
  const db = mk()
  addUser(db, "u1", "王小明")
  assert.equal(searchUsers(db, "明").length, 1)
  assert.equal(searchUsers(db, "小明").length, 1)
  assert.equal(searchUsers(db, "王小").length, 1)
})

test("检索：也能按登录名/手机号/医院找人，但排在姓名命中之后", () => {
  const db = mk()
  addUser(db, "zhang", "李四")            // 登录名含 zhang
  addUser(db, "u2", "张三")               // 姓名含 张
  const byName = searchUsers(db, "张")
  assert.equal(byName[0].display_name, "张三")
  const byLogin = searchUsers(db, "zhang")
  assert.equal(byLogin.length, 1)
  assert.equal(byLogin[0].username, "zhang")

  addUser(db, "u3", "赵六", { phone: "13800001111", hospital: "协和医院" })
  assert.equal(searchUsers(db, "13800").length, 1)
  assert.equal(searchUsers(db, "协和").length, 1)
})

test("检索：空关键词列全部；LIKE 通配符被转义（输 % 不该捞出全表）", () => {
  const db = mk()
  addUser(db, "u1", "张三")
  addUser(db, "u2", "李四")
  assert.equal(searchUsers(db, "").length, 2)
  assert.equal(searchUsers(db, "   ").length, 2)
  assert.equal(searchUsers(db, "%").length, 0, "% 必须当字面量")
  assert.equal(searchUsers(db, "_").length, 0, "_ 必须当字面量")
  addUser(db, "u3", "百分%号")
  assert.equal(searchUsers(db, "%").length, 1, "真的含 % 的姓名才该命中")
})

test("检索：分页", () => {
  const db = mk()
  for (let i = 0; i < 5; i++) addUser(db, "u" + i, "张" + i)
  assert.equal(searchUsers(db, "张", { limit: 2 }).length, 2)
  assert.equal(searchUsers(db, "张", { limit: 2, offset: 4 }).length, 1)
})

// ---- 档位与生效额度 ----
test("resolveEntitlement：显式覆盖 > 档位；0 = 不限", () => {
  const db = mk()
  upsertTier(db, { key: "gold", daily_usd: 9, monthly_usd: 99, model: "m-gold", skills: "a,b" })
  const u = addUser(db, "u1", "张三", { tier: "gold" })
  let e = resolveEntitlement(db, u)
  assert.equal(e.daily, 9)
  assert.equal(e.model, "m-gold")
  assert.deepEqual(e.skills, ["a", "b"])

  const u2 = updateUser(db, u.id, { daily_override: 1.25, skills_override: "c" })
  e = resolveEntitlement(db, u2)
  assert.equal(e.daily, 1.25)
  assert.deepEqual(e.skills, ["c"])

  // '' 覆盖 = 一个技能都不给（与 NULL=随档位 区分开）
  e = resolveEntitlement(db, updateUser(db, u.id, { skills_override: "" }))
  assert.deepEqual(e.skills, [])
  // 0 覆盖 = 不限
  e = resolveEntitlement(db, updateUser(db, u.id, { daily_override: 0 }))
  assert.equal(e.daily, 0)
})

test("resolveEntitlement：档位不存在 → 全 0/空，不抛", () => {
  const db = mk()
  const u = addUser(db, "u1", "张三", { tier: "ghost" })
  const e = resolveEntitlement(db, u)
  assert.equal(e.daily, 0)
  assert.equal(e.model, "")
  assert.deepEqual(e.skills, [])
})

test("deleteTier：还有人在用就不许删", () => {
  const db = mk()
  upsertTier(db, { key: "gold", daily_usd: 1 })
  addUser(db, "u1", "张三", { tier: "gold" })
  assert.equal(deleteTier(db, "gold").ok, false)
  updateUser(db, getUserByName(db, "u1").id, { tier: "free" })
  assert.equal(deleteTier(db, "gold").ok, true)
})

// ---- 用量 ----
test("recordUsage：明细与汇总同步，today/month 口径正确", () => {
  const db = mk()
  const u = addUser(db, "u1", "张三")
  recordUsage(db, u.id, { model: "m", skill: "write-paper", prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.1 })
  recordUsage(db, u.id, { model: "m", cost_usd: 0.25 })
  assert.equal(Math.round(todayCost(db, u.id) * 100) / 100, 0.35)
  assert.equal(Math.round(monthCost(db, u.id) * 100) / 100, 0.35)
  const det = usageDetail(db, u.id)
  assert.equal(det.length, 2)
  assert.equal(det[1].skill, "write-paper")
  const daily = db.prepare("SELECT * FROM usage_daily WHERE user_id=?").get(u.id)
  assert.equal(daily.calls, 2)
})

test("recordUsage：跨日不串账（UTC 日切）", () => {
  const db = mk()
  const u = addUser(db, "u1", "张三")
  const yesterday = Date.now() - 24 * 3600 * 1000
  recordUsage(db, u.id, { cost_usd: 5, ts: yesterday })
  recordUsage(db, u.id, { cost_usd: 1 })
  assert.equal(todayCost(db, u.id), 1, "今日只算今日")
  assert.equal(dayOf(yesterday) !== dayOf(), true)
})

test("usageTotalSeries：全站按天汇总", () => {
  const db = mk()
  const a = addUser(db, "a", "张三"), b = addUser(db, "b", "李四")
  recordUsage(db, a.id, { cost_usd: 1 })
  recordUsage(db, b.id, { cost_usd: 2 })
  const s = usageTotalSeries(db, 7)
  assert.equal(s.length, 1)
  assert.equal(s[0].cost, 3)
  assert.equal(s[0].calls, 2)
})

test("deleteUser：连带清掉用量与 refresh", () => {
  const db = mk()
  const u = addUser(db, "u1", "张三")
  recordUsage(db, u.id, { cost_usd: 1 })
  saveRefresh(db, u.id, "h", 1, Date.now() + 1e6)
  deleteUser(db, u.id)
  assert.equal(getUserByName(db, "u1"), null)
  assert.equal(usageDetail(db, u.id).length, 0)
  assert.equal(findRefresh(db, "h"), null)
})

// ---- refresh / 审计 ----
test("refresh：保存/查找/吊销/清理过期", () => {
  const db = mk()
  const u = addUser(db, "u1", "张三")
  saveRefresh(db, u.id, "live", 1, Date.now() + 1e6)
  saveRefresh(db, u.id, "dead", 1, Date.now() - 1)
  revokeRefresh(db, "live")
  assert.equal(findRefresh(db, "live").revoked, 1)
  purgeExpiredRefresh(db)
  assert.equal(findRefresh(db, "dead"), null)
  assert.equal(findRefresh(db, "live"), null, "已吊销的也会被清")
})

test("审计：按时间倒序", () => {
  const db = mk()
  addAudit(db, { actor: "admin", event: "user.add", target: "zhangsan" })
  addAudit(db, { actor: "admin", event: "user.suspend", target: "zhangsan", detail: "违规" })
  const l = listAudit(db)
  assert.equal(l.length, 2)
  assert.equal(l[0].event, "user.suspend")
  assert.equal(l[0].detail, "违规")
})

test("dayOf/monthOf 用 UTC", () => {
  const ts = Date.parse("2026-03-15T23:30:00Z")
  assert.equal(dayOf(ts), "2026-03-15")
  assert.equal(monthOf(ts), "2026-03")
})
