// 界面包（前端静态资源在线更新）的服务端测试。
//
// 这一层的核心是【白名单】：客户端拿到包就往自己的应用目录里写文件，所以"能写什么"必须在
// 服务端先钉死。下面把每一种越界写法都钉一条用例——它们一旦漏过去，就是"管理员能远程覆盖
// 客户端任意文件"。
import test from "node:test"
import assert from "node:assert/strict"
import { startApp, adminLogin, asAdmin } from "./helper.mjs"
import { parseWebPack, buildWebPack, rejectReason, collectWebEntries } from "../lib/webpacks.mjs"
import { zip } from "../lib/minizip.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const STRONG = "Aa1!aaaa9"
const mkzip = (entries) => zip(entries.map(([name, data]) => ({ name, data: Buffer.from(data) })))
const pack = (version, extra = {}) => JSON.stringify({ version, changelog: "改了个文案", ...extra })

// ---- 白名单 ----
test("白名单：只收 web/ 下的静态资源，.mjs 与 .json 一律拒", () => {
  assert.equal(rejectReason("web/index.html"), "")
  assert.equal(rejectReason("web/login.html"), "")
  assert.equal(rejectReason("web/assets/logo.png"), "")
  assert.equal(rejectReason("pack.json"), "")
  assert.match(rejectReason("web/server.mjs"), /\.mjs/, "网关服务端代码不能靠界面包换")
  assert.match(rejectReason("web/cloud-account.mjs"), /\.mjs/)
  assert.match(rejectReason("web/sessions-meta.json"), /后缀/, "会话归属是用户数据，别被包冲掉")
  assert.match(rejectReason("web/package.json"), /后缀/)
  assert.match(rejectReason("web/node_modules/x/a.js"), /node_modules/)
  assert.match(rejectReason(".opencode/skills/a/SKILL.md"), /只允许 web\//)
  assert.match(rejectReason("AGENTS.md"), /只允许 web\//)
  assert.match(rejectReason("web/run.exe"), /后缀/)
})

test("发布闸：含 .mjs / 越界路径 / 无 pack.json / 版本号非法的包整包拒绝", () => {
  assert.match(parseWebPack(mkzip([["web/index.html", "<h1>hi</h1>"]])).err, /pack\.json/)
  assert.match(parseWebPack(mkzip([["pack.json", pack("v1.2")], ["web/index.html", "x"]])).err, /点分数字/)
  assert.match(parseWebPack(mkzip([["pack.json", pack("1.0")], ["web/server.mjs", "x"]])).err, /\.mjs/)
  assert.match(parseWebPack(mkzip([["pack.json", pack("1.0")], ["skills/a/SKILL.md", "x"]])).err, /只允许 web\//)
  assert.match(parseWebPack(mkzip([["pack.json", pack("1.0")]])).err, /一个文件都没有/)
  // zip 层的 zip-slip 防线（minizip.cleanName）：越界路径连解压都过不去
  assert.throws(() => mkzip([["../evil.html", "x"]]))
})

test("发布闸：合法包过关，缺 index.html 只告警不拦（可以只发一张图）", () => {
  const good = parseWebPack(mkzip([["pack.json", pack("2026.7.31")], ["web/index.html", "<h1>hi</h1>"], ["web/assets/a.png", "x"]]))
  assert.equal(good.ok, true)
  assert.equal(good.pack.version, "2026.7.31")
  assert.equal(good.pack.changelog, "改了个文案")
  assert.deepEqual(good.names, ["web/assets/a.png", "web/index.html"])
  assert.equal(good.warnings.length, 0)

  const partial = parseWebPack(mkzip([["pack.json", pack("1.0")], ["web/assets/a.css", "b{}"]]))
  assert.equal(partial.ok, true)
  assert.match(partial.warnings.join(), /没有 web\/index\.html/)
})

test("从目录出包：跳过 .mjs / node_modules / 隐藏文件，只带静态资源", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webpack-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const web = path.join(dir, "web")
  fs.mkdirSync(path.join(web, "assets"), { recursive: true })
  fs.mkdirSync(path.join(web, "node_modules", "x"), { recursive: true })
  fs.writeFileSync(path.join(web, "index.html"), "<h1>hi</h1>")
  fs.writeFileSync(path.join(web, "server.mjs"), "export const x=1")
  fs.writeFileSync(path.join(web, "package.json"), "{}")
  fs.writeFileSync(path.join(web, "sessions-meta.json"), '{"a":1}')
  fs.writeFileSync(path.join(web, "assets", "logo.png"), "png")
  fs.writeFileSync(path.join(web, "node_modules", "x", "a.js"), "junk")

  const c = collectWebEntries(web)
  assert.deepEqual(c.entries.map((e) => e.name), ["web/assets/logo.png", "web/index.html"])

  const built = buildWebPack({ webDir: web, version: "2026.7.31", changelog: "x" })
  assert.equal(built.ok, true)
  const re = parseWebPack(built.buf)
  assert.equal(re.ok, true, re.err)
  assert.deepEqual(re.names, ["web/assets/logo.png", "web/index.html"])
})

// ---- 接口 ----
async function rig() {
  const app = await startApp({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "wp-data-")) })
  const cookie = await adminLogin(app)
  const admin = asAdmin(app, cookie)
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三" } })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: STRONG },
  })
  return { app, admin, token: chg.json.access, close: () => app.close() }
}

test("发布 → 客户端问到最新版 → 下载 → 撤下后下不到", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const buf = mkzip([["pack.json", pack("2026.7.31")], ["web/index.html", "<h1>new</h1>"]])

  const up = await r.app.req("/admin/api/web-pack-upload", {
    method: "POST", raw: true, body: buf,
    headers: { cookie: (await adminLogin(r.app)), "content-type": "application/zip" },
  })
  assert.equal(up.status, 200, up.text)
  assert.equal(up.json.version, "2026.7.31")

  const H = { authorization: "Bearer " + r.token }
  const latest = await r.app.req("/api/web/latest", { headers: { ...H, "x-web-version": "" } })
  assert.equal(latest.json.latest.version, "2026.7.31")
  assert.equal(latest.json.latest.sha256, up.json.sha256)
  assert.deepEqual(latest.json.latest.files, ["web/index.html"])

  const dl = await fetch(r.app.base + "/api/web/pack?version=2026.7.31", { headers: H })
  assert.equal(dl.status, 200)
  assert.equal(dl.headers.get("x-pack-sha256"), up.json.sha256)
  assert.equal((await dl.arrayBuffer()).byteLength, buf.length)

  // 撤下 → 客户端既问不到也下不到（这就是服务端侧的"紧急止血"）
  await r.admin("/admin/api/web-pack", { method: "POST", body: { version: "2026.7.31", action: "disable" } })
  assert.equal((await r.app.req("/api/web/latest", { headers: H })).json.latest, null)
  assert.equal((await r.app.req("/api/web/pack?version=2026.7.31", { headers: H })).status, 404)
})

test("同一版本号不许重发；未登录拿不到包；版本号格式不对直接 400", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const cookie = await adminLogin(r.app)
  const post = (v) => r.app.req("/admin/api/web-pack-upload", {
    method: "POST", raw: true, body: mkzip([["pack.json", pack(v)], ["web/index.html", "x"]]),
    headers: { cookie, "content-type": "application/zip" },
  })
  assert.equal((await post("1.0")).status, 200)
  const again = await post("1.0")
  assert.equal(again.status, 400)
  assert.match(again.json.err, /已发布过/)

  assert.equal((await r.app.req("/api/web/latest")).status, 401, "未登录不该看到平台在发什么")
  assert.equal((await r.app.req("/api/web/pack?version=1.0")).status, 401)
  assert.equal((await r.app.req("/api/web/pack?version=../../etc/passwd", { headers: { authorization: "Bearer " + r.token } })).status, 400)
})

test("客户端上报的界面版本进后台版本分布（谁还停在旧版）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.app.req("/api/web/latest", { headers: { authorization: "Bearer " + r.token, "x-web-version": "2026.7.30" } })
  const list = await r.admin("/admin/api/web-packs")
  assert.equal(list.status, 200)
  assert.ok(list.json.versions.some((v) => v.v === "2026.7.30"), JSON.stringify(list.json.versions))
})
