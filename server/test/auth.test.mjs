// M1 身份层端到端测试：管理员登录 → 分发账号 → 客户端登录换 key → 强制改密 → 续期 → 吊销
import test from "node:test"
import assert from "node:assert/strict"
import { startApp, adminLogin, asAdmin } from "./helper.mjs"
import * as A from "../lib/auth.mjs"

const STRONG = "Aa1!aaaa9"

async function setup(env) {
  const app = await startApp(env)
  const cookie = await adminLogin(app)
  return { app, admin: asAdmin(app, cookie), cookie }
}
/** 建一个账号并完成首次强制改密，返回可直接用的 access key */
async function makeReadyUser(app, admin, username = "zhangsan", displayName = "张三", extra = {}) {
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username, displayName, ...extra } })
  const pw0 = add.json.initialPassword
  const login = await app.req("/api/auth/login", { method: "POST", body: { username, password: pw0 } })
  const chg = await app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + login.json.access },
    body: { oldPassword: pw0, newPassword: STRONG },
  })
  return { id: add.json.user.id, username, access: chg.json.access, refresh: chg.json.refresh, password: STRONG }
}

test("healthz 可用", async (t) => {
  const app = await startApp(); t.after(() => app.close())
  const r = await app.req("/healthz")
  assert.equal(r.status, 200)
  assert.equal(r.json.service, "sci-auth")
})

test("未知路径 → 结构化 404", async (t) => {
  const app = await startApp(); t.after(() => app.close())
  const r = await app.req("/nope")
  assert.equal(r.status, 404)
  assert.equal(r.json.error.code, "NOT_FOUND")
})

// ---- 管理台登录 ----
test("管理台：验证码错则拒；口令错则拒；旁路只免验证码不免口令", async (t) => {
  const app = await startApp(); t.after(() => app.close())
  let r = await app.req("/admin/api/login", { method: "POST", body: { password: "adminpw", captcha: "XXXX", captchaId: "no" } })
  assert.equal(r.status, 401)
  assert.match(r.json.err, /验证码/)

  r = await app.req("/admin/api/login", { method: "POST", body: { password: "wrong" }, headers: { "x-test-bypass": "t-bypass" } })
  assert.equal(r.status, 401, "旁路只免验证码，口令仍要对")
  assert.match(r.json.err, /口令/)

  r = await app.req("/admin/api/login", { method: "POST", body: { password: "adminpw" }, headers: { "x-test-bypass": "wrong-token" } })
  assert.equal(r.status, 401, "旁路令牌不对就得走验证码")

  r = await app.req("/admin/api/login", { method: "POST", body: { password: "adminpw" }, headers: { "x-test-bypass": "t-bypass" } })
  assert.equal(r.status, 200)
  assert.match(r.headers["set-cookie"] || "", /admin_auth=.*HttpOnly.*Secure/)
})

test("管理台：没登录一律 401", async (t) => {
  const app = await startApp(); t.after(() => app.close())
  const r = await app.req("/admin/api/overview")
  assert.equal(r.status, 401)
})

test("管理台：未设 ADMIN_PASSWORD 则整个后台 404（线上默认关的兜底）", async (t) => {
  const app = await startApp({ ADMIN_PASSWORD: "" }); t.after(() => app.close())
  assert.equal((await app.req("/admin")).status, 404)
  assert.equal((await app.req("/admin/api/login", { method: "POST", body: {} })).status, 404)
})

test("验证码：一次性，答对也只能用一次", async (t) => {
  const app = await startApp(); t.after(() => app.close())
  const c = A.newCaptcha()
  assert.equal(A.verifyCaptcha(c.id, c.code), true)
  assert.equal(A.verifyCaptcha(c.id, c.code), false, "重放必须失败")
  const c2 = A.newCaptcha()
  assert.equal(A.verifyCaptcha(c2.id, "zzzz"), false)
  assert.equal(A.verifyCaptcha(c2.id, c2.code), false, "答错后该 id 也作废")
  const svg = A.captchaSvg("AB12")
  assert.match(svg, /^<svg/)
})

// ---- 建号与初始口令 ----
test("建号：返回强随机初始口令，库里只存哈希", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const r = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三", hospital: "协和医院", tier: "plus" } })
  assert.equal(r.status, 200)
  const pw = r.json.initialPassword
  assert.equal(pw.length, 12)
  assert.equal(A.checkPasswordStrength(pw), null, "初始口令必须满足复杂度")
  assert.equal(r.json.user.displayName, "张三")
  assert.equal(r.json.user.surname, "张")
  assert.equal(r.json.user.tier, "plus")
  assert.equal(r.json.user.mustChangePw, true)

  const row = app.db.prepare("SELECT * FROM users WHERE username='zhangsan'").get()
  assert.notEqual(row.pass_hash, pw)
  assert.ok(row.pass_salt.length >= 16)
  assert.equal(JSON.stringify(r.json).includes(row.pass_hash), false, "响应里不该出现哈希")
})

test("建号：登录名格式/重名/缺姓名/档位不存在 都拒", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const bad = async (body, re) => {
    const r = await admin("/admin/api/user-add", { method: "POST", body })
    assert.equal(r.status, 400)
    assert.match(r.json.err, re)
  }
  await bad({ username: "A", displayName: "张三" }, /登录名/)
  await bad({ username: "1abc", displayName: "张三" }, /登录名/)
  await bad({ username: "ab", displayName: "" }, /姓名/)
  await bad({ username: "ab", displayName: "张三", tier: "ghost" }, /档位/)
  await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三" } })
  await bad({ username: "zhangsan", displayName: "李四" }, /已存在/)
})

// ---- 客户端登录 ----
test("登录：初始口令能登，但只拿到 pwchange 票据，进不了业务接口", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三" } })
  const pw0 = add.json.initialPassword

  const r = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: pw0 } })
  assert.equal(r.status, 200)
  assert.equal(r.json.mustChangePassword, true)
  assert.equal(r.json.scope, "pwchange")
  assert.ok(r.json.access && r.json.refresh)

  const me = await app.req("/api/me", { headers: { authorization: "Bearer " + r.json.access } })
  assert.equal(me.status, 403)
  assert.equal(me.json.error.code, "PASSWORD_CHANGE_REQUIRED")
})

test("登录：账号不存在与口令错返回同一个码（不泄露账号是否存在）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三" } })
  const a = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: "nope" } })
  const b = await app.req("/api/auth/login", { method: "POST", body: { username: "ghost", password: "nope" } })
  assert.equal(a.status, 401); assert.equal(b.status, 401)
  assert.equal(a.json.error.code, "BAD_CREDENTIALS")
  assert.deepEqual(a.json.error, b.json.error)
})

test("改密：校验原口令与复杂度，改完换新票据且旧票据立即失效", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三" } })
  const pw0 = add.json.initialPassword
  const login = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: pw0 } })
  const H = { authorization: "Bearer " + login.json.access }

  let r = await app.req("/api/auth/password", { method: "POST", headers: H, body: { oldPassword: "wrong", newPassword: STRONG } })
  assert.equal(r.json.error.code, "BAD_CREDENTIALS")
  for (const weak of ["short1!", "alllowercase1!", "ALLUPPER1!", "NoDigits!!", "NoSymbol123"]) {
    r = await app.req("/api/auth/password", { method: "POST", headers: H, body: { oldPassword: pw0, newPassword: weak } })
    assert.equal(r.json.error.code, "WEAK_PASSWORD", `${weak} 应被拒`)
  }
  r = await app.req("/api/auth/password", { method: "POST", headers: H, body: { oldPassword: pw0, newPassword: pw0 } })
  assert.equal(r.json.error.code, "WEAK_PASSWORD", "新口令不能与原口令相同")

  r = await app.req("/api/auth/password", { method: "POST", headers: H, body: { oldPassword: pw0, newPassword: STRONG } })
  assert.equal(r.status, 200)
  assert.equal(r.json.scope, "full")
  assert.equal(r.json.mustChangePassword, false)

  const old = await app.req("/api/me", { headers: H })
  assert.equal(old.json.error.code, "KEY_REVOKED", "改密后旧票据必须立刻失效")
  const now = await app.req("/api/me", { headers: { authorization: "Bearer " + r.json.access } })
  assert.equal(now.status, 200)
  assert.equal(now.json.profile.username, "zhangsan")
})

test("/api/me：返回档位、模型、技能与用量", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 1.5, monthlyUSD: 30, model: "deepseek-v4-pro", skills: "write-paper,search-lit" } })
  const u = await makeReadyUser(app, admin, "zhangsan", "张三", { tier: "plus" })
  const me = await app.req("/api/me", { headers: { authorization: "Bearer " + u.access } })
  assert.equal(me.json.profile.tier, "plus")
  assert.equal(me.json.profile.model, "deepseek-v4-pro")
  assert.deepEqual(me.json.profile.skills, ["write-paper", "search-lit"])
  assert.equal(me.json.profile.limits.daily, 1.5)
  assert.equal(me.json.profile.usage.today, 0)
})

// ---- key 生命周期 ----
test("key：伪造/篡改/过期 都认不出来", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await makeReadyUser(app, admin)
  const bad = async (tok, code) => {
    const r = await app.req("/api/me", { headers: { authorization: "Bearer " + tok } })
    assert.equal(r.json.error.code, code, `token=${String(tok).slice(0, 24)}…`)
  }
  await bad("", "KEY_MISSING")
  await bad("garbage", "KEY_INVALID")
  await bad("v1.a.b", "KEY_INVALID")
  await bad(u.access.slice(0, -2) + "xy", "KEY_INVALID")             // 改签名
  const [pfx, payload, sig] = u.access.split(".")
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), tier: "admin" })).toString("base64url")
  await bad(`${pfx}.${tampered}.${sig}`, "KEY_INVALID")              // 改载荷
  // 过期
  const expired = A.signAccessKey("test-secret-x", { u: "x", uid: 1, ep: 1, sc: "full" }, -1000)
  await bad(expired, "KEY_INVALID")   // 签名密钥都不同 → 先在签名这关就挂
})

test("key：过期票据报 KEY_EXPIRED（签名对、时间过）", async (t) => {
  const { app, admin } = await setup({ ACCESS_TTL_MS: "-1000" }); t.after(() => app.close())
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三" } })
  const login = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: add.json.initialPassword } })
  const r = await app.req("/api/me", { headers: { authorization: "Bearer " + login.json.access } })
  assert.equal(r.json.error.code, "KEY_EXPIRED")
})

test("refresh：可换新票据，且一把只能用一次（轮换）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await makeReadyUser(app, admin)
  const r1 = await app.req("/api/auth/refresh", { method: "POST", body: { refresh: u.refresh } })
  assert.equal(r1.status, 200)
  assert.ok(r1.json.access && r1.json.refresh)
  const again = await app.req("/api/auth/refresh", { method: "POST", body: { refresh: u.refresh } })
  assert.equal(again.status, 401, "旧 refresh 用过即废")
  assert.equal(again.json.error.code, "REFRESH_INVALID")
  const ok = await app.req("/api/me", { headers: { authorization: "Bearer " + r1.json.access } })
  assert.equal(ok.status, 200)
})

test("logout：作废 refresh", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await makeReadyUser(app, admin)
  await app.req("/api/auth/logout", { method: "POST", body: { refresh: u.refresh } })
  const r = await app.req("/api/auth/refresh", { method: "POST", body: { refresh: u.refresh } })
  assert.equal(r.status, 401)
})

// ---- 管控点：停用 / 改档 / 重置 立刻生效 ----
test("停用：已签发的 key 立刻失效（不等下次登录），恢复后可重新登录", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await makeReadyUser(app, admin)
  assert.equal((await app.req("/api/me", { headers: { authorization: "Bearer " + u.access } })).status, 200)

  await admin("/admin/api/suspend", { method: "POST", body: { id: u.id, suspended: true } })
  const r = await app.req("/api/me", { headers: { authorization: "Bearer " + u.access } })
  assert.equal(r.status, 403)
  assert.equal(r.json.error.code, "ACCOUNT_SUSPENDED")

  const li = await app.req("/api/auth/login", { method: "POST", body: { username: u.username, password: STRONG } })
  assert.equal(li.json.error.code, "ACCOUNT_SUSPENDED", "停用期间连登录都不给")
  const rf = await app.req("/api/auth/refresh", { method: "POST", body: { refresh: u.refresh } })
  assert.equal(rf.status, 401, "停用同时作废 refresh")

  await admin("/admin/api/suspend", { method: "POST", body: { id: u.id, suspended: false } })
  const li2 = await app.req("/api/auth/login", { method: "POST", body: { username: u.username, password: STRONG } })
  assert.equal(li2.status, 200)
})

test("改档：立刻吊销 key，新 key 带新档位权限", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  await admin("/admin/api/tier", { method: "POST", body: { key: "plus", dailyUSD: 1.5, model: "m-plus" } })
  const u = await makeReadyUser(app, admin)
  const upd = await admin("/admin/api/user-update", { method: "POST", body: { id: u.id, tier: "plus" } })
  assert.equal(upd.json.keyRevoked, true)
  const r = await app.req("/api/me", { headers: { authorization: "Bearer " + u.access } })
  assert.equal(r.json.error.code, "KEY_REVOKED")

  const li = await app.req("/api/auth/login", { method: "POST", body: { username: u.username, password: STRONG } })
  assert.equal(li.json.profile.tier, "plus")
  assert.equal(li.json.profile.model, "m-plus")
})

test("改档位定义：该档全体用户的 key 一起吊销", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const a = await makeReadyUser(app, admin, "ua", "张三")
  const b = await makeReadyUser(app, admin, "ub", "李四")
  const r = await admin("/admin/api/tier", { method: "POST", body: { key: "free", dailyUSD: 9, model: "m2" } })
  assert.equal(r.json.affected, 2)
  for (const u of [a, b])
    assert.equal((await app.req("/api/me", { headers: { authorization: "Bearer " + u.access } })).json.error.code, "KEY_REVOKED")
})

test("重置口令 / 重置 key", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await makeReadyUser(app, admin)
  const rk = await admin("/admin/api/reset-key", { method: "POST", body: { id: u.id } })
  assert.equal(rk.json.epoch > 1, true)
  assert.equal((await app.req("/api/me", { headers: { authorization: "Bearer " + u.access } })).json.error.code, "KEY_REVOKED")

  const rp = await admin("/admin/api/reset-password", { method: "POST", body: { id: u.id } })
  assert.equal(A.checkPasswordStrength(rp.json.initialPassword), null)
  const old = await app.req("/api/auth/login", { method: "POST", body: { username: u.username, password: STRONG } })
  assert.equal(old.status, 401, "旧口令作废")
  const nw = await app.req("/api/auth/login", { method: "POST", body: { username: u.username, password: rp.json.initialPassword } })
  assert.equal(nw.json.mustChangePassword, true, "重置后必须再次强制改密")
})

test("删号：要输登录名确认；删完 key 失效", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await makeReadyUser(app, admin)
  let r = await admin("/admin/api/user-del", { method: "POST", body: { id: u.id, confirm: "wrong" } })
  assert.equal(r.status, 400)
  r = await admin("/admin/api/user-del", { method: "POST", body: { id: u.id, confirm: u.username } })
  assert.equal(r.status, 200)
  assert.equal((await app.req("/api/me", { headers: { authorization: "Bearer " + u.access } })).json.error.code, "KEY_REVOKED")
})

// ---- 限流 ----
test("登录限流：连错到阈值就锁一段时间", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  A._resetLoginFails()
  await makeReadyUser(app, admin, "zhangsan", "张三")
  let last
  for (let i = 0; i < A.LOGIN_MAX_FAILS + 1; i++)
    last = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: "wrong" } })
  assert.equal(last.status, 429)
  assert.equal(last.json.error.code, "RATE_LIMITED")
  const good = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: STRONG } })
  assert.equal(good.status, 429, "锁定期内口令对也不放行")
  A._resetLoginFails()
})

// ---- 客户端版本上报 ----
test("客户端版本随请求上报", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await makeReadyUser(app, admin)
  await app.req("/api/me", { headers: { authorization: "Bearer " + u.access, "x-client-version": "1.4.2" } })
  const row = app.db.prepare("SELECT client_version, last_seen_at FROM users WHERE id=?").get(u.id)
  assert.equal(row.client_version, "1.4.2")
  assert.ok(row.last_seen_at > 0)
})

// ---- 后台检索（本次需求重点）----
test("后台检索：按姓名单/双字过滤，优先姓", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  for (const [un, dn] of [["u1", "王小明"], ["u2", "小龙女"], ["u3", "李小龙"], ["u4", "欧阳锋"], ["u5", "赵四"]])
    await admin("/admin/api/user-add", { method: "POST", body: { username: un, displayName: dn } })

  let r = await admin("/admin/api/overview?q=" + encodeURIComponent("小"))
  assert.equal(r.json.matched, 3)
  assert.equal(r.json.users[0].displayName, "小龙女", "姓=小 排第一")

  r = await admin("/admin/api/overview?q=" + encodeURIComponent("欧阳"))
  assert.equal(r.json.users[0].displayName, "欧阳锋")

  r = await admin("/admin/api/overview?q=" + encodeURIComponent("明"))
  assert.equal(r.json.matched, 1)

  r = await admin("/admin/api/overview")
  assert.equal(r.json.total, 5)
  assert.equal(r.json.users.length, 5)
  assert.ok(r.json.tiers.length >= 3)
  assert.ok(Array.isArray(r.json.skills))
})

test("后台：改姓名后姓自动重切，检索排序跟着变", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "u1", displayName: "张三" } })
  await admin("/admin/api/user-update", { method: "POST", body: { id: add.json.user.id, displayName: "欧阳锋" } })
  const r = await admin("/admin/api/overview?q=" + encodeURIComponent("欧阳"))
  assert.equal(r.json.users[0].surname, "欧阳")
})

test("后台：额度覆盖校验；单用户用量明细接口", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await makeReadyUser(app, admin)
  let r = await admin("/admin/api/user-update", { method: "POST", body: { id: u.id, dailyOverride: -1 } })
  assert.equal(r.status, 400)
  r = await admin("/admin/api/user-update", { method: "POST", body: { id: u.id, dailyOverride: 2.5 } })
  assert.equal(r.json.user.limits.daily, 2.5)
  r = await admin("/admin/api/user-update", { method: "POST", body: { id: u.id, dailyOverride: "" } })
  assert.equal(r.json.user.limits.daily, 0.3, "留空 = 回到档位值")

  const d = await admin("/admin/api/user-usage?id=" + u.id)
  assert.equal(d.status, 200)
  assert.deepEqual(d.json.detail, [])
})

test("后台页面：自包含、无外部资源、带上界面依赖的挂载点", async (t) => {
  const { app } = await setup(); t.after(() => app.close())
  const r = await app.req("/admin")
  assert.equal(r.status, 200)
  assert.match(r.headers["content-type"], /text\/html/)
  // 页面必须完全自包含：CSP 严格环境与离线运维都指望这一点
  assert.equal(/<script[^>]+src=/.test(r.text), false, "不许有外链脚本")
  assert.equal(/<link[^>]+stylesheet/.test(r.text), false, "不许有外链样式")
  assert.equal(/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(r.text.replace(/xmlns="[^"]*"/g, "")), false, "不许有外部 URL")
  // 界面靠这些 id/接口工作，改名要连着改，这里钉住
  for (const hook of ["id=\"q\"", "id=\"add\"", "id=\"msg\"", "id=\"dlg\"", "data-a=\"edit\"", "data-a=\"usage\"", "data-a=\"susp\"", "data-a=\"more\""])
    assert.ok(r.text.includes(hook), `缺少界面挂载点 ${hook}`)
  for (const ep of ["overview?q=", "user-add", "user-update", "suspend", "reset-password", "reset-key", "user-del", "user-usage?id=", "tier", "audit", "login", "logout"])
    assert.ok(r.text.includes(ep), `界面引用了不存在的接口路径 ${ep}`)
  // 提示条必须在 #app 之外，否则一刷新列表就被冲掉、用户看不到"已保存"
  const msgAt = r.text.indexOf('class="msg" id="msg"'), appAt = r.text.indexOf('<main id="app">')
  assert.ok(msgAt >= 0 && appAt >= 0 && msgAt < appAt, "提示条要在 #app 之前、之外")
})

test("后台：默认列表按最近活跃倒序（中文码点序对运维没意义）", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  for (const [un, dn] of [["ua", "张三"], ["ub", "李四"], ["uc", "王五"]])
    await admin("/admin/api/user-add", { method: "POST", body: { username: un, displayName: dn } })
  const ids = Object.fromEntries(app.db.prepare("SELECT username,id FROM users").all().map((r) => [r.username, r.id]))
  app.db.prepare("UPDATE users SET last_seen_at=? WHERE id=?").run(Date.now() - 5000, ids.ua)
  app.db.prepare("UPDATE users SET last_seen_at=? WHERE id=?").run(Date.now(), ids.uc)
  const r = await admin("/admin/api/overview")
  assert.deepEqual(r.json.users.map((u) => u.username), ["uc", "ua", "ub"])
})

test("后台：审计留痕", async (t) => {
  const { app, admin } = await setup(); t.after(() => app.close())
  const u = await makeReadyUser(app, admin)
  await admin("/admin/api/suspend", { method: "POST", body: { id: u.id, suspended: true } })
  const r = await admin("/admin/api/audit")
  const events = r.json.rows.map((x) => x.event)
  assert.ok(events.includes("user.suspend"))
  assert.ok(events.includes("user.add"))
  assert.ok(events.includes("admin.login.ok"))
})
