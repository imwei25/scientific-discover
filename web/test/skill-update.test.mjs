// 技能包本机换版：安装 / sha 校验 / 包外保留平移 / 回退（含出厂版）/ 归档瘦身。
// 全程在临时目录演练（SKILL_ROOT_DIR / SKILL_STORE_DIR 覆盖），不碰真技能目录。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { zip } from "../minizip.mjs"
import * as SkillUp from "../skill-update.mjs"

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")
const read = (...p) => fs.readFileSync(path.join(...p), "utf8")

/** 造一个临时"应用目录"：出厂技能两只（其中 big-skill 模拟不随包分发的大块头） */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sci-skup-"))
  for (const [skill, body] of [["search-lit", "factory-search"], ["big-skill", "factory-big"]]) {
    fs.mkdirSync(path.join(root, ".opencode", "skills", skill), { recursive: true })
    fs.writeFileSync(path.join(root, ".opencode", "skills", skill, "SKILL.md"), body)
  }
  fs.writeFileSync(path.join(root, "AGENTS.md"), "factory-agents")
  process.env.SKILL_ROOT_DIR = root
  process.env.SKILL_STORE_DIR = path.join(root, "skill-packs")
  return root
}

function pack(version, { searchBody = "v" + version, preserved = ["big-skill"], agents = "agents-" + version } = {}) {
  const entries = [
    { name: "pack.json", data: JSON.stringify({ version, preserved }) },
    { name: "skills/search-lit/SKILL.md", data: searchBody },
  ]
  if (agents !== null) entries.push({ name: "AGENTS.md", data: agents })
  return zip(entries)
}

test("安装：校验 sha、换入新版、包外保留技能平移过来", () => {
  const root = setup()
  const p1 = pack("1.0.0")

  // sha 不对 → 拒装且现用目录纹丝不动
  assert.throws(() => SkillUp.installBuffer(p1, { version: "1.0.0", sha256: "0".repeat(64) }), /sha256/)
  assert.equal(read(root, ".opencode", "skills", "search-lit", "SKILL.md"), "factory-search")

  SkillUp.installBuffer(p1, { version: "1.0.0", sha256: sha(p1) })
  assert.equal(SkillUp.currentVersion(), "1.0.0")
  assert.equal(read(root, ".opencode", "skills", "search-lit", "SKILL.md"), "v1.0.0")
  assert.equal(read(root, "AGENTS.md"), "agents-1.0.0")
  // 包里没带的 big-skill 从旧现用平移过来了，没有丢
  assert.equal(read(root, ".opencode", "skills", "big-skill", "SKILL.md"), "factory-big")
  // 出厂版进了归档，可回退
  assert.deepEqual(SkillUp.listLocal().map((v) => v.version), ["factory"])
  fs.rmSync(root, { recursive: true, force: true })
})

test("回退：到上一版与出厂版都行，大技能一路跟着走", () => {
  const root = setup()
  const p1 = pack("1.0.0"), p2 = pack("2.0.0")
  SkillUp.installBuffer(p1, { version: "1.0.0", sha256: sha(p1) })
  SkillUp.installBuffer(p2, { version: "2.0.0", sha256: sha(p2) })
  assert.equal(SkillUp.currentVersion(), "2.0.0")
  assert.deepEqual(SkillUp.listLocal().map((v) => v.version).sort(), ["1.0.0", "factory"])

  SkillUp.rollback("1.0.0")
  assert.equal(SkillUp.currentVersion(), "1.0.0")
  assert.equal(read(root, ".opencode", "skills", "search-lit", "SKILL.md"), "v1.0.0")
  assert.equal(read(root, "AGENTS.md"), "agents-1.0.0")
  assert.equal(read(root, ".opencode", "skills", "big-skill", "SKILL.md"), "factory-big")
  // 2.0.0 变成了归档、1.0.0 从归档转正
  assert.deepEqual(SkillUp.listLocal().map((v) => v.version).sort(), ["2.0.0", "factory"])

  SkillUp.rollback("factory")
  assert.equal(SkillUp.currentVersion(), "")   // '' = 出厂版
  assert.equal(read(root, ".opencode", "skills", "search-lit", "SKILL.md"), "factory-search")
  assert.equal(read(root, ".opencode", "skills", "big-skill", "SKILL.md"), "factory-big")
  // 回退到当前版本要报人话错
  assert.throws(() => SkillUp.rollback("factory"), /当前用的就是/)
  fs.rmSync(root, { recursive: true, force: true })
})

test("归档瘦身：最多留 5 个旧版，出厂版永不清", () => {
  const root = setup()
  for (let i = 1; i <= 7; i++) {
    const p = pack(`${i}.0.0`)
    SkillUp.installBuffer(p, { version: `${i}.0.0`, sha256: sha(p) })
  }
  const names = SkillUp.listLocal().map((v) => v.version)
  assert.ok(names.includes("factory"), "出厂版必须还在")
  assert.equal(names.filter((n) => n !== "factory").length, 5, "非出厂归档恰留 5 个：" + names.join(","))
  // 留下的是最近的 5 个（2..6；7 是现用、1 被清）
  for (const keep of ["2.0.0", "3.0.0", "4.0.0", "5.0.0", "6.0.0"]) assert.ok(names.includes(keep), keep)
  fs.rmSync(root, { recursive: true, force: true })
})

test("坏包拒装：没有任何技能的 zip", () => {
  const root = setup()
  const empty = zip([{ name: "pack.json", data: '{"version":"9.0.0"}' }])
  assert.throws(() => SkillUp.installBuffer(empty, { version: "9.0.0", sha256: sha(empty) }), /没有任何技能/)
  assert.equal(SkillUp.currentVersion(), "")
  fs.rmSync(root, { recursive: true, force: true })
})
