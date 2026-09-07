// 企业版 coding plan 席位：管理员建席位 → 分给 VIP 用户 → 该用户从 /api/seat 拿到完整凭证直连，
// 网关这边的额度压到 free 档一半；收回/停用/删除 → 凭证不再下发、额度恢复。
import test from "node:test"
import assert from "node:assert/strict"
import { startApp, adminLogin, asAdmin } from "./helper.mjs"

async function setup() {
  const app = await startApp()
  const cookie = await adminLogin(app)
  const admin = asAdmin(app, cookie)
  return { app, admin }
}

/** 建一个改完密的账号，返回 {id, username, access} */
async function user(app, admin, username, tier = "free") {
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username, displayName: "张" + username, tier } })
  assert.equal(add.status, 200, add.text)
  const lo = await app.req("/api/auth/login", { method: "POST", body: { username, password: add.json.initialPassword } })
  assert.equal(lo.status, 200, lo.text)
  const ch = await app.req("/api/auth/password", { method: "POST", headers: { authorization: "Bearer " + lo.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: "Seat!test2026" } })
  assert.equal(ch.status, 200, ch.text)
  return { id: add.json.user.id, username, access: ch.json.access }
}
const asUser = (app, u) => (p) => app.req(p, { headers: { authorization: "Bearer " + u.access } })

test("席位：新增 / 列表不回显 key / 编辑留空不改 key / 删除", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  let r = await admin("/admin/api/seat", { method: "POST", body: { name: "火山 #1", baseURL: "https://ark.example/api/coding/v3", apiKey: "sk-seat-secret-0001", models: "m-pro\nm-flash", note: "到期 2026-12" } })
  assert.equal(r.status, 200, r.text)
  const id = r.json.id
  r = await admin("/admin/api/seats")
  assert.equal(r.json.seats.length, 1)
  const s = r.json.seats[0]
  assert.equal(s.name, "火山 #1")
  assert.deepEqual(s.models, ["m-pro", "m-flash"])
  assert.equal(s.hasKey, true)
  assert.equal(s.user, null)
  assert.ok(!JSON.stringify(r.json).includes("sk-seat-secret"), "后台列表绝不回显 key")
  // 缺地址 / 缺 key / 缺模型 都拒
  assert.equal((await admin("/admin/api/seat", { method: "POST", body: { name: "x", apiKey: "k", models: "m" } })).status, 400)
  assert.equal((await admin("/admin/api/seat", { method: "POST", body: { name: "x", baseURL: "https://a", models: "m" } })).status, 400)
  assert.equal((await admin("/admin/api/seat", { method: "POST", body: { name: "x", baseURL: "https://a", apiKey: "k" } })).status, 400)
  // 编辑：key 留空 = 不改；模型变了 updated_at 要推
  const before = app.db.prepare("SELECT * FROM seats WHERE id=?").get(id)
  await new Promise((x) => setTimeout(x, 5))
  r = await admin("/admin/api/seat", { method: "POST", body: { id, name: "火山 #1b", models: ["m-pro"] } })
  assert.equal(r.status, 200, r.text)
  const after = app.db.prepare("SELECT * FROM seats WHERE id=?").get(id)
  assert.equal(after.api_key, "sk-seat-secret-0001", "留空不改 key")
  assert.equal(after.name, "火山 #1b")
  assert.equal(after.models, "m-pro")
  assert.ok(after.updated_at > before.updated_at, "模型清单变了要推 updated_at")
  // 只改名不推 updated_at（客户端不必白拉一次）
  r = await admin("/admin/api/seat", { method: "POST", body: { id, name: "火山 #1c" } })
  assert.equal(app.db.prepare("SELECT updated_at FROM seats WHERE id=?").get(id).updated_at, after.updated_at)
  r = await admin("/admin/api/seat", { method: "POST", body: { id, remove: true } })
  assert.equal(r.status, 200)
  assert.equal((await admin("/admin/api/seats")).json.seats.length, 0)
})

test("分配：凭证只发给持席本人；额度压到 free 一半；档案与 /api/quota 带席位摘要（无 key）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  // free 档 0.3/5 → 持席者 0.15/2.5；plus 档的人拿了席位也按 free 一半算
  const vip = await user(app, admin, "vip", "plus")
  const other = await user(app, admin, "other", "free")
  const seat = (await admin("/admin/api/seat", { method: "POST", body: { name: "火山 #1", baseURL: "https://ark.example/v3", apiKey: "sk-seat-secret-0001", models: "m-pro,m-flash" } })).json.id

  // 分配前：plus 档额度、没席位、/api/seat 回 null
  let me = await asUser(app, vip)("/api/me")
  assert.equal(me.json.profile.limits.daily, 1.5)
  assert.equal(me.json.profile.seat, null)
  assert.equal((await asUser(app, vip)("/api/seat")).json.seat, null)

  let r = await admin("/admin/api/seat-assign", { method: "POST", body: { seatId: seat, userId: vip.id } })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.user.seat.name, "火山 #1")

  // 分配后：不吊销 key（同一把 access 仍可用），额度 = free 一半，档案里有摘要但没有 key
  me = await asUser(app, vip)("/api/me")
  assert.equal(me.status, 200, "分配席位不该吊销已签发的 key")
  assert.equal(me.json.profile.limits.daily, 0.15)
  assert.equal(me.json.profile.limits.monthly, 2.5)
  assert.equal(me.json.profile.seat.id, seat)
  assert.equal(me.json.profile.seat.baseURL, "https://ark.example/v3")
  assert.deepEqual(me.json.profile.seat.models, ["m-pro", "m-flash"])
  assert.ok(!JSON.stringify(me.json).includes("sk-seat-secret"), "档案里不能有 key")
  // 积分视图跟着变（0.15 USD = 15 积分）
  assert.equal(me.json.profile.quota.daily.limit, 15)
  const q = await asUser(app, vip)("/api/quota")
  assert.equal(q.json.seat.id, seat)
  assert.equal(typeof q.json.seat.rev, "number")
  assert.ok(!JSON.stringify(q.json).includes("sk-seat-secret"))
  // 完整凭证只从 /api/seat 下发、只给本人
  const full = await asUser(app, vip)("/api/seat")
  assert.equal(full.json.seat.apiKey, "sk-seat-secret-0001")
  assert.equal(full.json.seat.baseURL, "https://ark.example/v3")
  assert.equal(full.json.seat.model, "m-pro")
  assert.equal((await asUser(app, other)("/api/seat")).json.seat, null, "别人拿不到")
  assert.equal((await asUser(app, other)("/api/me")).json.profile.limits.daily, 0.3, "别人的额度不受影响")
  // 显式额度覆盖在持席期间也被压住
  await admin("/admin/api/user-update", { method: "POST", body: { id: vip.id, dailyOverride: 9 } })
  assert.equal((await asUser(app, vip)("/api/me")).json.profile.limits.daily, 0.15)
  // 后台用户列表带席位标签；审计有记录
  const ov = await admin("/admin/api/overview")
  assert.equal(ov.json.users.find((u) => u.username === "vip").seat.name, "火山 #1")
  const au = await admin("/admin/api/audit?limit=50")
  assert.ok(au.json.rows.some((x) => x.event === "seat.assign" && x.target === "vip"))
  assert.ok(au.json.rows.some((x) => x.event === "seat.fetch" && x.actor === "vip"))

  // 一席一人 / 一人一席
  const seat2 = (await admin("/admin/api/seat", { method: "POST", body: { name: "火山 #2", baseURL: "https://ark.example/v3", apiKey: "sk-2", models: "m-pro" } })).json.id
  r = await admin("/admin/api/seat-assign", { method: "POST", body: { seatId: seat, userId: other.id } })
  assert.equal(r.status, 400, "已分出去的席位不能再分给别人")
  r = await admin("/admin/api/seat-assign", { method: "POST", body: { seatId: seat2, userId: vip.id } })
  assert.equal(r.status, 400, "一个人只能拿一份")
  // 重复分给同一人 = 幂等
  assert.equal((await admin("/admin/api/seat-assign", { method: "POST", body: { seatId: seat, userId: vip.id } })).status, 200)

  // 释放：凭证不再下发、额度恢复（覆盖值 9 此时才生效）
  r = await admin("/admin/api/seat-assign", { method: "POST", body: { seatId: seat, release: true } })
  assert.equal(r.status, 200)
  assert.equal((await asUser(app, vip)("/api/seat")).json.seat, null)
  assert.equal((await asUser(app, vip)("/api/me")).json.profile.limits.daily, 9)
  assert.equal((await asUser(app, vip)("/api/quota")).json.seat, null)
  assert.equal((await admin("/admin/api/seats")).json.seats.find((s) => s.id === seat).user, null)
})

test("停用席位 = 视同未分配；删席位 / 删用户都把关系收干净", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const vip = await user(app, admin, "vip")
  const seat = (await admin("/admin/api/seat", { method: "POST", body: { name: "S", baseURL: "https://ark.example/v3", apiKey: "sk-1", models: "m" } })).json.id
  await admin("/admin/api/seat-assign", { method: "POST", body: { seatId: seat, userId: vip.id } })
  assert.equal((await asUser(app, vip)("/api/me")).json.profile.limits.daily, 0.15)

  await admin("/admin/api/seat", { method: "POST", body: { id: seat, status: "disabled" } })
  assert.equal((await asUser(app, vip)("/api/seat")).json.seat, null, "停用后不下发")
  assert.equal((await asUser(app, vip)("/api/me")).json.profile.limits.daily, 0.3, "停用后额度恢复")
  assert.equal((await admin("/admin/api/seats")).json.seats[0].user.username, "vip", "停用不解除分配关系（重新启用即恢复）")
  await admin("/admin/api/seat", { method: "POST", body: { id: seat, status: "active" } })
  assert.equal((await asUser(app, vip)("/api/seat")).json.seat.id, seat)

  // 删席位（还分着人）→ 用户侧立刻没了
  await admin("/admin/api/seat", { method: "POST", body: { id: seat, remove: true } })
  assert.equal((await asUser(app, vip)("/api/seat")).json.seat, null)
  assert.equal((await asUser(app, vip)("/api/me")).json.profile.limits.daily, 0.3)

  // 删用户 → 席位回池子
  const seat2 = (await admin("/admin/api/seat", { method: "POST", body: { name: "S2", baseURL: "https://ark.example/v3", apiKey: "sk-2", models: "m" } })).json.id
  await admin("/admin/api/seat-assign", { method: "POST", body: { seatId: seat2, userId: vip.id } })
  await admin("/admin/api/user-del", { method: "POST", body: { id: vip.id, confirm: "vip" } })
  assert.equal((await admin("/admin/api/seats")).json.seats.find((s) => s.id === seat2).user, null)
})

test("席位接口需要管理员登录；用户接口需要 access key", async (t) => {
  const { app } = await setup(); t.after(() => app.close())
  assert.equal((await app.req("/admin/api/seats")).status, 401)
  assert.equal((await app.req("/admin/api/seat", { method: "POST", body: {} })).status, 401)
  assert.equal((await app.req("/admin/api/seat-assign", { method: "POST", body: {} })).status, 401)
  assert.equal((await app.req("/api/seat")).status, 401)
})
