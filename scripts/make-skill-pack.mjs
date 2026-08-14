#!/usr/bin/env node
// 出技能包：把整套 .opencode/skills + AGENTS.md 打成一个版本化 zip，
// 拿到运营后台「技能包」页上传即发布，客户端在线更新（不强制、可回退）。
//
//   node scripts/make-skill-pack.mjs --version 2026.7.30 --changelog "修了 X，加了 Y"
//
// 参数（都可省）：
//   --version   点分数字（默认今天：YYYY.M.D；同一天发两版请手动加一段，如 2026.7.30.2）
//   --changelog 更新说明（显示在客户端横幅与后台列表）
//   --changed   本次实际变更的技能，逗号分隔（决定"提示谁"：与用户技能授权无交集就不打扰）
//   --since     git 引用（如上次发包的 commit/tag）——自动从 git diff 算 --changed，二选一
//   --exclude   不随包分发的技能，逗号分隔。默认 ppt-master（85MB 的 vendored 上游技能，
//               基本不变；写进 pack.json.preserved，客户端换版时自留平移，见 web/skill-update.mjs）
//   --out       输出目录（默认 dist/）
//
// pack.json 里还嵌了 venvPackages（打包机 .venv 的 pip 包清单）：服务端上传时据此 lint
// 技能脚本的 import，把"引入了客户端没有的新依赖"的更新拦在发布口（那种要重新打包客户端）。

import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { zip } from "../server/lib/minizip.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SKILLS = path.join(ROOT, ".opencode", "skills")

// ---- 参数 ----
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith("--")) args[a.slice(2)] = (process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) ? process.argv[++i] : "1"
}
const today = new Date()
const version = String(args.version || `${today.getFullYear()}.${today.getMonth() + 1}.${today.getDate()}`)
if (!/^\d+(\.\d+)*$/.test(version)) { console.error(`✗ 版本号要是点分数字：${version}`); process.exit(1) }
const changelog = String(args.changelog || "")
const exclude = new Set(String(args.exclude ?? "ppt-master").split(",").map((s) => s.trim()).filter(Boolean))
const outDir = path.resolve(ROOT, String(args.out || "dist"))

// ---- changedSkills：--changed 优先，其次 --since 从 git 算 ----
let changedSkills = String(args.changed || "").split(",").map((s) => s.trim()).filter(Boolean)
if (!changedSkills.length && args.since) {
  try {
    const diff = execSync(`git diff --name-only ${args.since} -- .opencode/skills AGENTS.md`, { cwd: ROOT, encoding: "utf8" })
    changedSkills = [...new Set(diff.split("\n").map((l) => /^\.opencode\/skills\/([^/]+)\//.exec(l.trim())?.[1]).filter(Boolean))]
    console.log(`· 从 git diff ${args.since} 算得变更技能：${changedSkills.join(", ") || "（无）"}`)
  } catch (e) { console.warn(`⚠ git diff 失败（${e.message.split("\n")[0]}），changedSkills 留空 = 提示所有人`) }
}

// ---- venvPackages：打包机 .venv 的 pip 清单（服务端依赖 lint 用）----
let venvPackages = []
const pyCandidates = [process.env.SCI_PYTHON, path.join(ROOT, ".venv", "Scripts", "python.exe"), path.join(ROOT, ".venv", "bin", "python")].filter(Boolean)
for (const py of pyCandidates) {
  if (!fs.existsSync(py)) continue
  try {
    const out = execSync(`"${py}" -m pip list --format=freeze --disable-pip-version-check`, { encoding: "utf8", timeout: 120_000 })
    venvPackages = out.split("\n").map((l) => l.split("==")[0].split(" @ ")[0].trim()).filter(Boolean)
    console.log(`· 依赖清单来自 ${py}（${venvPackages.length} 个包）`)
    break
  } catch { /* 换下一个候选 */ }
}
if (!venvPackages.length) console.warn("⚠ 没找到 .venv 的 pip 清单——服务端将跳过依赖 lint，请人工确认技能没有引入新 pip 依赖")

// ---- 收集文件 ----
const JUNK = new Set(["__pycache__", "node_modules", ".DS_Store", "outputs", ".pytest_cache"])
const entries = []
let totalBytes = 0
const bigFiles = []
function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (JUNK.has(e.name) || e.name.endsWith(".pyc")) continue
    const abs = path.join(dir, e.name)
    const r = rel + "/" + e.name
    if (e.isDirectory()) { walk(abs, r); continue }
    if (!e.isFile()) continue
    let data = fs.readFileSync(abs)
    // SKILL.md 的 BOM 在这儿就地剥掉（opencode 不认 BOM，服务端发布闸也会拒）
    if (e.name === "SKILL.md" && data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
      data = data.subarray(3)
      console.warn(`⚠ 已剥去 BOM：${r}`)
    }
    if (data.length > 5 * 1024 * 1024) bigFiles.push(`${r}（${(data.length / 1048576).toFixed(1)}MB）`)
    totalBytes += data.length
    entries.push({ name: r, data })
  }
}

const skillNames = fs.readdirSync(SKILLS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS, e.name, "SKILL.md")))
  .map((e) => e.name).sort()
const packed = skillNames.filter((s) => !exclude.has(s))
const preserved = skillNames.filter((s) => exclude.has(s))
for (const s of packed) walk(path.join(SKILLS, s), `skills/${s}`)

if (fs.existsSync(path.join(ROOT, "AGENTS.md"))) {
  entries.push({ name: "AGENTS.md", data: fs.readFileSync(path.join(ROOT, "AGENTS.md")) })
} else {
  console.warn("⚠ 仓库根没有 AGENTS.md——包里不带路由表，客户端将沿用旧的")
}

entries.unshift({
  name: "pack.json",
  data: Buffer.from(JSON.stringify({ version, changelog, changedSkills, preserved, venvPackages, createdAt: Date.now() }, null, 2), "utf8"),
})

// ---- 出包 ----
if (bigFiles.length) console.warn(`⚠ 包里有大文件（考虑加进 --exclude？）：\n    ${bigFiles.join("\n    ")}`)
const buf = zip(entries)
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `sci-skillpack-${version}.zip`)
fs.writeFileSync(outFile, buf)
console.log(`\n✅ ${outFile}`)
console.log(`   版本 ${version} · ${packed.length} 个技能（${(totalBytes / 1048576).toFixed(1)}MB → 压后 ${(buf.length / 1048576).toFixed(1)}MB）` +
  (preserved.length ? ` · 包外保留：${preserved.join(", ")}` : ""))
console.log(`   变更技能：${changedSkills.join(", ") || "（未标注 = 所有人都会收到提示）"}`)
console.log(`\n下一步：打开运营后台 →「技能包」页 → 上传这个 zip 即发布。`)
