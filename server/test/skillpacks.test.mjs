// 技能包：minizip 读写、发布闸（布局/BOM/依赖 lint）、发布/撤下/下载端点、按授权算 relevant。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { startApp, adminLogin, asAdmin } from "./helper.mjs"
import { zip, unzip } from "../lib/minizip.mjs"
import { parsePack, pyImports, lintImports } from "../lib/skillpacks.mjs"

const STRONG = "Aa1!aaaa9"

/** 造一个最小合法包（可覆盖 pack.json 字段、增删条目） */
function makePack({ version = "1.0.0", changedSkills = [], venvPackages, preserved, extraEntries = [], skills = { "search-lit": "# 检索" } } = {}) {
  const entries = [{ name: "pack.json", data: JSON.stringify({ version, changelog: "测试包", changedSkills, venvPackages, preserved, createdAt: 1 }) }]
  for (const [name, md] of Object.entries(skills)) entries.push({ name: `skills/${name}/SKILL.md`, data: md })
  entries.push({ name: "AGENTS.md", data: "# 路由" })
  return zip([...entries, ...extraEntries])
}

// ---- minizip ----
test("minizip：写读往返，含子目录/中文名/大小混合", () => {
  const entries = [
    { name: "pack.json", data: '{"a":1}' },
    { name: "skills/检索/SKILL.md", data: "内容 with 中文" },
    { name: "skills/a/deep/x.py", data: Buffer.alloc(70000, 7) },   // 大到必然走 deflate
  ]
  const out = unzip(zip(entries))
  assert.equal(out.length, 3)
  for (const e of entries) {
    const got = out.find((o) => o.name === e.name)
    assert.ok(got, e.name)
    assert.deepEqual(got.data, Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data))
  }
})

test("minizip：zip-slip 条目名一律拒绝", () => {
  assert.throws(() => zip([{ name: "../evil.txt", data: "x" }]), /非法/)
  assert.throws(() => zip([{ name: "/abs.txt", data: "x" }]), /非法/)
  assert.throws(() => zip([{ name: "C:/win.txt", data: "x" }]), /非法/)
})

test("minizip：反斜杠条目名归一成正斜杠（Compress-Archive 兼容）", () => {
  const out = unzip(zip([{ name: "skills\\a\\SKILL.md", data: "x" }]))
  assert.equal(out[0].name, "skills/a/SKILL.md")
})

// ---- 依赖 lint ----
test("pyImports：抓 import/from，跳过相对导入", () => {
  const src = "import numpy as np\nfrom pandas.core import x\nfrom . import sibling\n  import os\nprint('import fake')"
  const got = pyImports(src)
  assert.deepEqual(got.sort(), ["numpy", "os", "pandas"])
})

test("lintImports：标准库/venv/本地模块放行，未知的报出来", () => {
  const files = [
    { name: "skills/a/run.py", data: Buffer.from("import os\nimport numpy\nimport helper\nimport scipy") },
    { name: "skills/a/helper.py", data: Buffer.from("import json") },
  ]
  const r = lintImports(files, ["numpy", "pandas"])
  assert.equal(r.issues.length, 1)
  assert.equal(r.issues[0].module, "scipy")
  // 清单缺失 → 跳过
  assert.equal(lintImports(files, []).skipped, true)
})

// ---- parsePack 发布闸 ----
test("parsePack：合法包通过；各类坏包给出人话错误", () => {
  const ok = parsePack(makePack({}))
  assert.equal(ok.ok, true)
  assert.equal(ok.pack.version, "1.0.0")
  assert.deepEqual(ok.skills, ["search-lit"])

  assert.match(parsePack(zip([{ name: "skills/a/SKILL.md", data: "x" }])).err, /pack\.json/)
  assert.match(parsePack(makePack({ version: "v1-beta" })).err, /点分数字/)
  assert.match(parsePack(makePack({ extraEntries: [{ name: "evil.sh", data: "x" }] })).err, /不认识的条目/)
  assert.match(parsePack(zip([{ name: "pack.json", data: '{"version":"1.0"}' }])).err, /一个技能都没有/)
  // 技能目录缺 SKILL.md
  assert.match(parsePack(zip([
    { name: "pack.json", data: '{"version":"1.0"}' },
    { name: "skills/a/other.md", data: "x" },
  ])).err, /缺 SKILL\.md/)
  // SKILL.md 带 BOM
  assert.match(parsePack(zip([
    { name: "pack.json", data: '{"version":"1.0"}' },
    { name: "skills/a/SKILL.md", data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# x")]) },
  ])).err, /BOM/)
})

test("parsePack：依赖 lint 与 preserved 告警", () => {
  const r = parsePack(makePack({
    venvPackages: ["numpy"],
    preserved: ["ppt-master", "search-lit"],
    extraEntries: [{ name: "skills/search-lit/run.py", data: "import scipy" }],
  }))
  assert.equal(r.ok, true)
  assert.equal(r.lint.issues.length, 1)
  assert.equal(r.lint.issues[0].module, "scipy")
  assert.ok(r.warnings.some((w) => w.includes("search-lit")), "preserved 与包内重叠要告警")
})

// ---- 端点 ----
async function rigPacks(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sci-packs-"))
  const app = await startApp({ DATA_DIR: dataDir, ...env })
  const cookie = await adminLogin(app)
  const admin = asAdmin(app, cookie)
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三" } })
  const login = async () => {
    // 初始密码只在 user-add / reset-password 响应里有；改档后重登用改好的强口令
    const li = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: STRONG } })
    return li.json.access
  }
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: STRONG },
  })
  const upload = (buf, force) => admin("/admin/api/skill-pack-upload" + (force ? "?force=1" : ""), {
    method: "POST", body: buf, raw: true, headers: { "content-type": "application/zip" },
  })
  return {
    app, admin, upload, login, uid: add.json.user.id, access: chg.json.access, dataDir,
    async close() { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }) },
  }
}

test("发布→latest→下载→撤下 全链路", async () => {
  const r = await rigPacks()
  try {
    // 未发布时：latest 为空
    let res = await r.app.req("/api/skills/latest", { headers: { authorization: "Bearer " + r.access } })
    assert.equal(res.json.latest, null)

    const p1 = makePack({ version: "1.0.0" })
    const up1 = await r.upload(p1)
    assert.equal(up1.status, 200, up1.text)
    assert.equal(up1.json.version, "1.0.0")

    // 同版本重发要拒
    assert.equal((await r.upload(makePack({ version: "1.0.0" }))).status, 400)

    const p2 = makePack({ version: "1.1.0", changedSkills: ["search-lit"] })
    assert.equal((await r.upload(p2)).status, 200)

    // latest = 版本号最大的 active；顺手带 X-Skills-Version 让服务端记下本机版本
    res = await r.app.req("/api/skills/latest", { headers: { authorization: "Bearer " + r.access, "x-skills-version": "1.0.0" } })
    assert.equal(res.json.latest.version, "1.1.0")
    assert.equal(res.json.latest.relevant, true)
    assert.equal(r.app.db.prepare("SELECT skills_version FROM users WHERE id=?").get(r.uid).skills_version, "1.0.0")

    // 下载：字节一致、sha 头一致
    const dl = await fetch(r.app.base + "/api/skills/pack?version=1.1.0", { headers: { authorization: "Bearer " + r.access } })
    assert.equal(dl.status, 200)
    const body = Buffer.from(await dl.arrayBuffer())
    assert.deepEqual(body, p2)
    assert.equal(dl.headers.get("x-pack-sha256"), crypto.createHash("sha256").update(p2).digest("hex"))

    // 撤下 1.1.0 → latest 退回 1.0.0，且 1.1.0 不可再下载
    assert.equal((await r.admin("/admin/api/skill-pack", { method: "POST", body: { version: "1.1.0", action: "disable" } })).json.current, "1.0.0")
    res = await r.app.req("/api/skills/latest", { headers: { authorization: "Bearer " + r.access } })
    assert.equal(res.json.latest.version, "1.0.0")
    assert.equal((await r.app.req("/api/skills/pack?version=1.1.0", { headers: { authorization: "Bearer " + r.access } })).status, 404)

    // 管理列表
    const list = await r.admin("/admin/api/skill-packs")
    assert.equal(list.json.packs.length, 2)
    assert.ok(list.json.versions.some((v) => v.v === "1.0.0"))
  } finally { await r.close() }
})

test("依赖 lint 拦发布，force 放行并留痕", async () => {
  const r = await rigPacks()
  try {
    const bad = makePack({
      version: "2.0.0", venvPackages: ["numpy"],
      extraEntries: [{ name: "skills/search-lit/run.py", data: "import scipy" }],
    })
    const first = await r.upload(bad)
    assert.equal(first.status, 400)
    assert.equal(first.json.needForce, true)
    assert.equal(first.json.lint[0].module, "scipy")
    // 拦下的包不该落库/落盘
    assert.equal((await r.admin("/admin/api/skill-packs")).json.packs.length, 0)

    const forced = await r.upload(bad, true)
    assert.equal(forced.status, 200, forced.text)
    assert.equal(forced.json.forced, true)
  } finally { await r.close() }
})

test("relevant：变更技能与用户白名单无交集就不提示", async () => {
  const r = await rigPacks()
  try {
    assert.equal((await r.upload(makePack({
      version: "3.0.0", changedSkills: ["nature-figure"],
      skills: { "search-lit": "# a", "nature-figure": "# b" },
    }))).status, 200)
    // 把用户白名单改成只有 search-lit（会 bumpEpoch 吊销旧 key → 重新登录）
    await r.admin("/admin/api/user-update", { method: "POST", body: { id: r.uid, skillsOverride: "search-lit" } })
    const access = await r.login()
    const res = await r.app.req("/api/skills/latest", { headers: { authorization: "Bearer " + access } })
    assert.equal(res.json.latest.version, "3.0.0")
    assert.equal(res.json.latest.relevant, false)
    // 白名单含变更技能 → relevant
    await r.admin("/admin/api/user-update", { method: "POST", body: { id: r.uid, skillsOverride: "nature-figure" } })
    const access2 = await r.login()
    assert.equal((await r.app.req("/api/skills/latest", { headers: { authorization: "Bearer " + access2 } })).json.latest.relevant, true)
  } finally { await r.close() }
})
