// 界面包在本机的安装 / 回退（web/web-update.mjs）。全程在临时目录里演练，绝不碰真实 web/。
//
// 要钉死的三件事：
//   ① 只碰受管文件 —— server.mjs 这类 .mjs 与 sessions-meta.json 这类用户数据，换多少次都不许动；
//   ② 回退链一直通到出厂版（factory 永不清理），且回退后是"和那一版完全一致"，不是叠加；
//   ③ 装坏了要能撤回来，撤不回来的话用户下次刷新看到的就是半新半旧的界面。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { zip } from "../minizip.mjs"

let seq = 0
/** 造一个"装好的应用目录"：web/ 里有出厂界面 + 网关代码 + 用户数据 */
async function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webup-"))
  fs.mkdirSync(path.join(root, "web", "assets"), { recursive: true })
  fs.writeFileSync(path.join(root, "web", "index.html"), "FACTORY-INDEX")
  fs.writeFileSync(path.join(root, "web", "login.html"), "FACTORY-LOGIN")
  fs.writeFileSync(path.join(root, "web", "server.mjs"), "GATEWAY-CODE")          // 不受管
  fs.writeFileSync(path.join(root, "web", "sessions-meta.json"), '{"user":"data"}') // 不受管
  fs.writeFileSync(path.join(root, "web", "assets", "logo.png"), "FACTORY-PNG")
  // 【env 必须在整个用例期间都设着，不能"import 完就还原"】本模块是【调用时】现读 env 的
  // （见 ROOT()），还原早了 ROOT() 就回落成开发机的真实仓库目录 —— 写这个测试时就这么把
  // 仓库里的 web/index.html 覆盖成了假内容。模块里另有一道 .git 保险丝，这里是第一道。
  const prev = { ...process.env }
  process.env.WEB_ROOT_DIR = root
  process.env.WEB_STORE_DIR = path.join(root, "web-packs")
  const mod = await import(`../web-update.mjs?t=${++seq}`)
  t.after(() => { process.env = prev; fs.rmSync(root, { recursive: true, force: true }) })
  const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), "utf8") } catch { return null } }
  return { root, mod, read }
}
const mkpack = (version, files) => {
  const buf = zip([
    { name: "pack.json", data: Buffer.from(JSON.stringify({ version, changelog: "x" })) },
    ...files.map(([name, data]) => ({ name, data: Buffer.from(data) })),
  ])
  return { buf, sha256: crypto.createHash("sha256").update(buf).digest("hex"), version }
}

test("安装：只换包里带的那几个文件，网关代码与用户数据一个字节都不动", async (t) => {
  const r = await rig(t)
  const p = mkpack("2026.7.31", [["web/index.html", "NEW-INDEX"]])
  r.mod.installBuffer(p.buf, { version: p.version, sha256: p.sha256 })

  assert.equal(r.read("web/index.html"), "NEW-INDEX")
  assert.equal(r.read("web/login.html"), "FACTORY-LOGIN", "包里没带的受管文件保持原样（合并语义）")
  assert.equal(r.read("web/server.mjs"), "GATEWAY-CODE", "本机网关代码不归界面包管")
  assert.equal(r.read("web/sessions-meta.json"), '{"user":"data"}', "用户的会话归属不能被包冲掉")
  assert.equal(r.mod.currentVersion(), "2026.7.31")
  // 出厂那套被完整存了下来（回退链的最后一环）
  assert.equal(r.read("web-packs/factory/web/index.html"), "FACTORY-INDEX")
  assert.equal(r.read("web-packs/factory/web/login.html"), "FACTORY-LOGIN")
  assert.equal(r.read("web-packs/factory/web/server.mjs"), null, "快照也只存受管文件")
})

test("回退：退回出厂版是「和那一版完全一致」，新包多带的文件要清掉", async (t) => {
  const r = await rig(t)
  const p1 = mkpack("1.0", [["web/index.html", "V1"], ["web/assets/new.css", "b{}"]])
  r.mod.installBuffer(p1.buf, { version: p1.version, sha256: p1.sha256 })
  assert.equal(r.read("web/assets/new.css"), "b{}")

  r.mod.rollback("factory")
  assert.equal(r.read("web/index.html"), "FACTORY-INDEX")
  assert.equal(r.read("web/assets/new.css"), null, "出厂版里没有它 —— 回退要回到干净状态，不是叠加")
  assert.equal(r.read("web/server.mjs"), "GATEWAY-CODE", "回退同样不碰不受管的文件")
  assert.equal(r.mod.currentVersion(), "", "空串 = 出厂版")
  // 退回去之后还能再往前走
  assert.deepEqual(r.mod.listLocal().map((v) => v.version), ["1.0"])
  r.mod.rollback("1.0")
  assert.equal(r.read("web/index.html"), "V1")
  assert.equal(r.read("web/assets/new.css"), "b{}")
})

test("多版本：留存最近 5 个，出厂版永不清理", async (t) => {
  const r = await rig(t)
  for (let i = 1; i <= 7; i++) {
    const p = mkpack(`1.${i}`, [["web/index.html", "V" + i]])
    r.mod.installBuffer(p.buf, { version: p.version, sha256: p.sha256 })
  }
  const local = r.mod.listLocal().map((v) => v.version)
  assert.equal(r.mod.currentVersion(), "1.7")
  assert.ok(local.includes("factory"), "出厂版必须一直在：它是回退链的最后一环。实际：" + local.join(","))
  assert.ok(local.length <= 6, "最多 5 个归档 + 出厂版，实际：" + local.join(","))
  // 最老的那几个被清掉了，最近的还在
  assert.ok(local.includes("1.6"))
  assert.ok(!local.includes("1.1"))
  r.mod.rollback("factory")
  assert.equal(r.read("web/index.html"), "FACTORY-INDEX")
})

test("坏包一律拒收：sha 不符 / 带 .mjs / 带越界条目 / 空包，且现用界面不受影响", async (t) => {
  const r = await rig(t)
  const good = mkpack("1.0", [["web/index.html", "NEW"]])
  assert.throws(() => r.mod.installBuffer(good.buf, { version: "1.0", sha256: "0".repeat(64) }), /校验失败/)
  const evil = mkpack("1.1", [["web/index.html", "NEW"], ["web/server.mjs", "PWNED"]])
  assert.throws(() => r.mod.installBuffer(evil.buf, { version: evil.version, sha256: evil.sha256 }), /不该出现的条目/)
  const empty = mkpack("1.2", [])
  assert.throws(() => r.mod.installBuffer(empty.buf, { version: empty.version, sha256: empty.sha256 }), /没有任何可安装/)
  assert.throws(() => r.mod.installBuffer(good.buf, { version: "dev", sha256: good.sha256 }), /版本号不合法/)

  assert.equal(r.read("web/index.html"), "FACTORY-INDEX", "拒收的包一个字节都不该落地")
  assert.equal(r.read("web/server.mjs"), "GATEWAY-CODE")
  assert.equal(r.mod.currentVersion(), "")
  assert.deepEqual(r.mod.listLocal().map((v) => v.version), [], "失败也不该留下半个归档")
})

test("回退到不存在 / 当前版本：给的是人话，不是异常堆栈", async (t) => {
  const r = await rig(t)
  assert.throws(() => r.mod.rollback("factory"), /当前用的就是出厂版/)
  assert.throws(() => r.mod.rollback("9.9"), /本机没有留存版本/)
})

test("保险丝：没指定根目录时，开发检出里一律拒绝换版（别覆盖开发机的真文件）", async () => {
  const prev = { ...process.env }
  delete process.env.WEB_ROOT_DIR; delete process.env.WEB_STORE_DIR
  try {
    const m = await import(`../web-update.mjs?guard=${++seq}`)
    assert.throws(() => m.installBuffer(Buffer.from("x"), { version: "1.0", sha256: "" }), /开发检出/)
    assert.throws(() => m.rollback("factory"), /开发检出/)
  } finally { process.env = prev }
})

test("managed()：受管判定与服务端白名单同一口径", async (t) => {
  const r = await rig(t)
  assert.equal(r.mod.managed("web/index.html"), true)
  assert.equal(r.mod.managed("web/assets/a.png"), true)
  assert.equal(r.mod.managed("web/server.mjs"), false)
  assert.equal(r.mod.managed("web/package.json"), false)
  assert.equal(r.mod.managed("web/node_modules/x/a.js"), false)
  assert.equal(r.mod.managed("AGENTS.md"), false)
  assert.equal(r.mod.managed("web/a/b/c/deep.html"), false, "太深的层级不收（与服务端出包口径一致）")
})
