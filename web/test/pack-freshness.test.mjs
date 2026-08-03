// "服务器上的包比我新吗" 的判定（web/pack-freshness.mjs）。
//
// 要钉死的是这条真实事故：**刚打的安装包比线上最后一次发布还新**（技能改完先出了安装包、
// 还没发技能包），客户端却弹"有新版技能"——点下去把技能换旧。老逻辑只比 "版本号 ≠ 本机版本"，
// 而出厂版根本没有版本号，于是恒为真。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cmpVersion, shouldOfferUpdate } from "../pack-freshness.mjs"

const DAY = 86400_000
const t2026_7_30 = Date.parse("2026-07-30T12:00:00Z")
const t2026_8_03 = Date.parse("2026-08-03T12:00:00Z")

test("cmpVersion：按段比数值，不是文本序", () => {
  assert.equal(cmpVersion("2026.7.30", "2026.7.9"), 1)      // 文本序会判反
  assert.equal(cmpVersion("2026.7.30", "2026.7.30"), 0)
  assert.equal(cmpVersion("2026.7.30", "2026.7.30.1"), -1)  // 缺的段按 0
  assert.equal(cmpVersion("2026.10.1", "2026.9.1"), 1)
})

test("装过在线版：只有更高版本号才提示（同版/更旧都不提示）", () => {
  const cur = { current: "2026.7.30" }
  assert.equal(shouldOfferUpdate({ version: "2026.8.3" }, cur), true)
  assert.equal(shouldOfferUpdate({ version: "2026.7.30" }, cur), false)
  assert.equal(shouldOfferUpdate({ version: "2026.7.29" }, cur), false)   // 服务端撤下新版后
})

test("出厂版：包的发布时间早于安装包打包时间 → 不提示（本次要修的事故）", () => {
  const installed = { current: "", factoryAt: t2026_8_03 }
  // 线上最后一次发布是 7.30，而安装包是 8.3 打的：安装器里的技能已经更新了
  assert.equal(shouldOfferUpdate({ version: "2026.7.30", publishedAt: t2026_7_30 }, installed), false)
  // 打完包之后才发布的，才是真的新
  assert.equal(shouldOfferUpdate({ version: "2026.8.4", publishedAt: t2026_8_03 + DAY }, installed), true)
})

test("出厂版：同一时刻不算新（发布与打包同秒，内容以安装器为准）", () => {
  assert.equal(shouldOfferUpdate({ version: "2026.8.3", publishedAt: t2026_8_03 },
    { current: "", factoryAt: t2026_8_03 }), false)
})

test("老客户端（没有 factoryAt）保持原行为：照常提示，不能让存量机器再也收不到更新", () => {
  assert.equal(shouldOfferUpdate({ version: "2026.7.30", publishedAt: t2026_7_30 },
    { current: "", factoryAt: 0 }), true)
  // 服务端没给发布时间（老服务端）时同理
  assert.equal(shouldOfferUpdate({ version: "2026.7.30" }, { current: "", factoryAt: t2026_8_03 }), true)
})

test("没有包 / 包没有版本号 → 不提示", () => {
  assert.equal(shouldOfferUpdate(null, { current: "" }), false)
  assert.equal(shouldOfferUpdate({ version: "" }, { current: "" }), false)
})

// ---- factoryAt 必须一路留在 installed.json 里 ----
// 它只在打包时写一次，之后每次换版/回退都要原样带着；掉了的话客户端立刻退回
// "出厂版没时间戳"的老行为，事故复发且很难发现（现象是"偶尔提示一个旧包"）。
let seq = 0
async function rig(t, mod) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freshness-"))
  fs.mkdirSync(path.join(root, ".opencode", "skills", "demo"), { recursive: true })
  fs.writeFileSync(path.join(root, ".opencode", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n")
  fs.mkdirSync(path.join(root, "web"), { recursive: true })
  fs.writeFileSync(path.join(root, "web", "index.html"), "FACTORY")
  const store = path.join(root, mod === "skill" ? "skill-packs" : "web-packs")
  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(path.join(store, "installed.json"),
    JSON.stringify({ current: "", history: [], factoryAt: t2026_8_03 }))
  const prev = { ...process.env }
  if (mod === "skill") { process.env.SKILL_ROOT_DIR = root; process.env.SKILL_STORE_DIR = store }
  else { process.env.WEB_ROOT_DIR = root; process.env.WEB_STORE_DIR = store }
  const m = await import(`../${mod}-update.mjs?t=${++seq}`)
  t.after(() => { process.env = prev; fs.rmSync(root, { recursive: true, force: true }) })
  return { root, store, m }
}

for (const kind of ["skill", "web"]) {
  test(`${kind}-update：读得出 factoryAt`, async (t) => {
    const { m } = await rig(t, kind)
    assert.equal(m.factoryAt(), t2026_8_03)
    assert.equal(m.currentVersion(), "")
  })
}

test("skill-update：装过一版之后 factoryAt 仍在（换版不许把它写没）", async (t) => {
  const { store, m } = await rig(t, "skill")
  const { zip } = await import("../minizip.mjs")
  const buf = zip([
    { name: "pack.json", data: Buffer.from(JSON.stringify({ version: "2026.8.9" })) },
    { name: "skills/demo/SKILL.md", data: Buffer.from("---\nname: demo\n---\nNEW\n") },
  ])
  m.installBuffer(buf, { version: "2026.8.9" })
  assert.equal(m.currentVersion(), "2026.8.9")
  assert.equal(m.factoryAt(), t2026_8_03, "换版后 factoryAt 丢了")
  assert.equal(JSON.parse(fs.readFileSync(path.join(store, "installed.json"), "utf8")).factoryAt, t2026_8_03)
  // 装过在线版之后就按版本号判新，与出厂时间无关
  assert.equal(shouldOfferUpdate({ version: "2026.8.9", publishedAt: Date.now() },
    { current: m.currentVersion(), factoryAt: m.factoryAt() }), false)
})
