// "从仓库发布"：真 git 仓演练——check 预览（sha/变更技能/版本号）→ publish；
// 陈旧 sha 409；同日连发版本号自动进位；本地检出通道；依赖 lint 用留存清单拦发布。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { startApp, adminLogin, asAdmin } from "./helper.mjs"
import { zip } from "../lib/minizip.mjs"
import { nextVersion } from "../lib/skillsrc.mjs"

const g = (cwd, ...args) => execFileSync("git",
  ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
  { cwd, encoding: "utf8", windowsHide: true }).trim()

/** 造一个当"主项目仓"的临时 git 仓：.opencode/skills/search-lit + AGENTS.md，一个初始提交 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sci-repo-"))
  g(dir, "init", "-b", "main")
  const write = (rel, body) => {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  write(".opencode/skills/search-lit/SKILL.md", "# 检索 v1")
  write("AGENTS.md", "# 路由 v1")
  g(dir, "add", "-A"); g(dir, "commit", "-m", "初始技能")
  return { dir, write, commit: (msg) => { g(dir, "add", "-A"); g(dir, "commit", "-m", msg); return g(dir, "rev-parse", "HEAD") } }
}

async function rigSrc(extraEnv = {}) {
  const repo = makeRepo()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sci-src-"))
  const app = await startApp({ DATA_DIR: dataDir, SKILL_REPO_URL: repo.dir, SKILL_REPO_REF: "main", ...extraEnv })
  const cookie = await adminLogin(app)
  const admin = asAdmin(app, cookie)
  const src = (body) => admin("/admin/api/skill-src", { method: "POST", body })
  return {
    repo, app, admin, src, dataDir,
    async close() { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }) },
  }
}

test("nextVersion：日期领先用日期，否则在最新版上进位，占用的号跳过", () => {
  const d = new Date(2026, 6, 30)   // 2026.7.30
  assert.equal(nextVersion("", () => false, d), "2026.7.30")
  assert.equal(nextVersion("2026.7.1", () => false, d), "2026.7.30")
  assert.equal(nextVersion("2026.7.30", () => false, d), "2026.7.30.1")
  assert.equal(nextVersion("2026.7.30.3", () => false, d), "2026.7.30.4")
  assert.equal(nextVersion("2026.8.1", () => false, d), "2026.8.1.1", "手动发过未来号也只往上走，不倒退")
  const taken = new Set(["2026.7.30", "2026.7.30.1"])
  assert.equal(nextVersion("2026.7.1", (v) => taken.has(v), d), "2026.7.30.2")
})

test("check→publish→再提交→409 陈旧 sha→重查再发 全链路", async () => {
  const r = await rigSrc()
  try {
    // 状态口
    const st = await r.admin("/admin/api/skill-src")
    assert.equal(st.json.remote.configured, true)
    assert.equal(st.json.lastPublished, null)

    // 首查：clone + 预览
    let pv = (await r.src({ action: "check", source: "remote" })).json
    assert.equal(pv.ok, true, JSON.stringify(pv))
    assert.equal(pv.sha.length, 40)
    assert.equal(pv.skills, 1)
    assert.equal(pv.upToDate, false)

    // 发布
    let pub = (await r.src({ action: "publish", source: "remote", sha: pv.sha })).json
    assert.equal(pub.ok, true, JSON.stringify(pub))
    assert.equal(pub.commitSha, pv.sha)
    const v1 = pub.version

    // 再查 → 已是最新
    pv = (await r.src({ action: "check", source: "remote" })).json
    assert.equal(pv.upToDate, true)

    // 仓里再动：改 search-lit + 加新技能
    r.repo.write(".opencode/skills/search-lit/SKILL.md", "# 检索 v2")
    r.repo.write(".opencode/skills/nature-figure/SKILL.md", "# 作图")
    const c2 = r.repo.commit("检索改进 + 新增作图")

    // 拿旧 sha 直接发 → 409 打回
    const stale = await r.src({ action: "publish", source: "remote", sha: pv.sha })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.staleSha, true)

    // 重查：变更技能算出来了、版本号在 v1 上进位、提交说明进了预览
    pv = (await r.src({ action: "check", source: "remote" })).json
    assert.equal(pv.sha, c2)
    assert.deepEqual(pv.changedSkills.sort(), ["nature-figure", "search-lit"])
    assert.ok(pv.commits.some((c) => c.includes("检索改进")), JSON.stringify(pv.commits))
    assert.notEqual(pv.nextVersion, v1)

    pub = (await r.src({ action: "publish", source: "remote", sha: c2, changelog: "手填的说明" })).json
    assert.equal(pub.ok, true, JSON.stringify(pub))
    assert.deepEqual(pub.changedSkills.sort(), ["nature-figure", "search-lit"])

    // 落库正确：changelog 用手填的、commit 记了、客户端能看到最新版
    const list = (await r.admin("/admin/api/skill-packs")).json
    const row = list.packs.find((p) => p.version === pub.version)
    assert.equal(row.changelog, "手填的说明")
    assert.equal(list.current, pub.version)
  } finally { await r.close() }
})

test("本地检出通道：不碰远程也能发布", async () => {
  const repo = makeRepo()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sci-srcl-"))
  // SKILLS_DIR 指进仓库工作树 → localRoot 即该仓
  const app = await startApp({ DATA_DIR: dataDir, SKILLS_DIR: path.join(repo.dir, ".opencode", "skills") })
  try {
    const admin = asAdmin(app, await adminLogin(app))
    const pv = (await admin("/admin/api/skill-src", { method: "POST", body: { action: "check", source: "local" } })).json
    assert.equal(pv.ok, true, JSON.stringify(pv))
    assert.equal(pv.sha.length, 40)
    const pub = (await admin("/admin/api/skill-src", { method: "POST", body: { action: "publish", source: "local", sha: pv.sha } })).json
    assert.equal(pub.ok, true, JSON.stringify(pub))
    // 未配 SKILL_REPO_URL 时远程要报人话错
    const rem = (await admin("/admin/api/skill-src", { method: "POST", body: { action: "check", source: "remote" } })).json
    assert.equal(rem.ok, false)
    assert.match(rem.err, /SKILL_REPO_URL/)
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true }) }
})

test("依赖 lint：清单靠上次整包留存，仓里冒出新依赖会被拦、可强制", async () => {
  const r = await rigSrc()
  try {
    // 先手动上传一个嵌了 venvPackages 的整包 → 清单留存
    const seed = zip([
      { name: "pack.json", data: JSON.stringify({ version: "0.0.1", venvPackages: ["numpy"] }) },
      { name: "skills/search-lit/SKILL.md", data: "# x" },
    ])
    const up = await r.admin("/admin/api/skill-pack-upload", {
      method: "POST", body: seed, raw: true, headers: { "content-type": "application/zip" },
    })
    assert.equal(up.status, 200, up.text)
    assert.equal((await r.admin("/admin/api/skill-src")).json.venvLint, true)

    // 仓里加一个 import scipy 的脚本
    r.repo.write(".opencode/skills/search-lit/run.py", "import scipy")
    const c = r.repo.commit("引入了新依赖的改动")
    const pv = (await r.src({ action: "check", source: "remote" })).json
    const blocked = await r.src({ action: "publish", source: "remote", sha: c })
    assert.equal(blocked.status, 400)
    assert.equal(blocked.json.needForce, true)
    assert.equal(blocked.json.lint[0].module, "scipy")

    const forced = (await r.src({ action: "publish", source: "remote", sha: c, force: true })).json
    assert.equal(forced.ok, true, JSON.stringify(forced))
    assert.equal(forced.forced, true)
    assert.equal(forced.version, pv.nextVersion)
  } finally { await r.close() }
})
