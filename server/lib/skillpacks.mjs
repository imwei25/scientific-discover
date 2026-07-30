// 技能包：整套 .opencode/skills（+ AGENTS.md）打成一个版本化 zip，由管理员在后台发布，
// 桌面客户端在线更新 —— 前提是【不引入新依赖】（新 pip 包 / 新二进制要重新打包客户端分发）。
//
// 这里是发布闸：上传时把包拆开做静态校验，把"发出去客户端才炸"的问题拦在服务器上：
//   · zip-slip / 越界条目（minizip 读取层统一拒绝）
//   · 布局：只许 pack.json / AGENTS.md / skills/<名>/**，每个技能必须有 SKILL.md
//   · SKILL.md 带 UTF-8 BOM —— opencode 不认（真机踩过），发布时直接拒
//   · Python import 依赖 lint：技能脚本 import 了打包客户端 .venv 里没有的库 → 提示
//     "此更新引入新依赖，走不了在线更新"。这是【信号不是判决】：动态 import、别名导入
//     识别不全，管理员确认无误可强制发布（?force=1）。
//
// 包格式（scripts/make-skill-pack.mjs 产出）：
//   pack.json    { version, changelog, changedSkills[], venvPackages[], createdAt }
//   AGENTS.md    顶层路由（可选但强烈建议——新技能要进路由表才会被流水线调度）
//   skills/<技能名>/SKILL.md + 其余文件

import fs from "node:fs"
import path from "node:path"
import { unzip, zip } from "./minizip.mjs"

/** 版本号规则与 cmpVersion 一致：点分数字。别的写法两端都没法比大小。 */
export const VERSION_RE = /^\d+(\.\d+)*$/

/**
 * 比较点分数字版本。返回 -1 / 0 / 1，任一边不是纯点分数字（如打包脚本没注入版本时的
 * "dev"）就返回 null —— 调用方据此【不催升级】。
 *
 * 【为什么"认不出来就不催"】开发机与自建构建报的就是 dev/git-sha 这类字符串，把它们当成
 * "比谁都旧"会让每个开发者每次打开都被弹一次升级提示，而那条提示对他们毫无意义。
 */
export function cmpVersion(a, b) {
  const parse = (s) => {
    const t = String(s || "").trim()
    if (!VERSION_RE.test(t)) return null
    return t.split(".").map(Number)
  }
  const x = parse(a), y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

// Python 标准库顶层模块（常用面；lint 用白名单，漏了顶多误报、由 force 兜底）
const PY_STDLIB = new Set(("abc argparse array ast asyncio base64 bisect binascii builtins calendar cmath codecs " +
  "collections colorsys concurrent configparser contextlib copy cProfile csv ctypes dataclasses datetime decimal " +
  "difflib dis doctest email encodings enum errno filecmp fnmatch fractions functools gc getpass gettext glob " +
  "graphlib gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json keyword locale logging " +
  "lzma math mimetypes multiprocessing numbers operator os pathlib pdb pickle pkgutil platform posixpath pprint " +
  "profile queue random re secrets selectors shlex shutil signal site socket sqlite3 ssl stat statistics string " +
  "struct subprocess sys sysconfig tarfile tempfile textwrap threading time timeit token tokenize traceback types " +
  "typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser xml zipfile zlib zoneinfo " +
  "__future__ ntpath copyreg atexit").split(" "))

/** 从 .py 源码提取顶层 import 的包名（import X / from X import ...；相对导入跳过） */
export function pyImports(src) {
  const out = new Set()
  for (const line of String(src).split("\n")) {
    const m = /^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/.exec(line)
    if (m) out.add(m[1].split(".")[0])
  }
  return [...out]
}

// pip 包名归一：大小写不敏感、- 与 _ 等价（PEP 503）。import 名与 pip 名不完全一一对应
// （如 pip 装 Pillow import PIL），常见错位在下表补齐；覆盖不全由 force 兜底。
const norm = (s) => String(s).toLowerCase().replace(/-/g, "_")
const IMPORT_TO_PIP = {
  pil: "pillow", cv2: "opencv_python", sklearn: "scikit_learn", skimage: "scikit_image",
  bs4: "beautifulsoup4", yaml: "pyyaml", docx: "python_docx", pptx: "python_pptx",
  fitz: "pymupdf", dateutil: "python_dateutil", dotenv: "python_dotenv", lifelines: "lifelines",
}

/**
 * 依赖 lint：包内每个 .py 的顶层 import，必须落在
 * 标准库 ∪ 客户端 .venv 包清单 ∪ 本技能目录内的本地模块。
 * venvPackages 为空（打包脚本没嵌入）→ 跳过，返回 { skipped: true }。
 */
export function lintImports(files, venvPackages) {
  if (!Array.isArray(venvPackages) || !venvPackages.length) return { skipped: true, issues: [] }
  const venv = new Set(venvPackages.map(norm))
  // 本地模块：同一技能目录下的 .py 文件名与子目录名都算（import 邻居脚本是技能里的常态）
  const localBySkill = new Map()
  for (const f of files) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(f.name)
    if (!m) continue
    const [, skill, rest] = m
    if (!localBySkill.has(skill)) localBySkill.set(skill, new Set())
    const parts = rest.split("/")
    for (const p of parts.slice(0, -1)) localBySkill.get(skill).add(norm(p))
    if (parts[parts.length - 1].endsWith(".py")) localBySkill.get(skill).add(norm(parts[parts.length - 1].slice(0, -3)))
  }
  const issues = []
  for (const f of files) {
    const m = /^skills\/([^/]+)\/.*\.py$/.exec(f.name)
    if (!m) continue
    const local = localBySkill.get(m[1]) || new Set()
    for (const imp of pyImports(f.data.toString("utf8"))) {
      const n = norm(imp)
      if (PY_STDLIB.has(imp) || PY_STDLIB.has(n)) continue
      if (venv.has(n) || venv.has(IMPORT_TO_PIP[n] || "")) continue
      if (local.has(n)) continue
      issues.push({ skill: m[1], file: f.name, module: imp })
    }
  }
  return { skipped: false, issues }
}

const BOM = 0xfeff

/**
 * 解包并校验。返回：
 *   { ok:true, pack, skills[], files[], warnings[], lint }   或
 *   { ok:false, err }
 * 校验失败一律整包拒绝 —— 发出去一半好一半坏的技能套件比不发更糟。
 */
export function parsePack(buf) {
  let files
  try { files = unzip(buf) } catch (e) { return { ok: false, err: e.message } }
  const warnings = []

  const packEntry = files.find((f) => f.name === "pack.json")
  if (!packEntry) return { ok: false, err: "包里没有 pack.json —— 请用 scripts/make-skill-pack.mjs 出包" }
  let pack
  try {
    let s = packEntry.data.toString("utf8")
    if (s.charCodeAt(0) === BOM) s = s.slice(1)
    pack = JSON.parse(s)
  } catch { return { ok: false, err: "pack.json 不是合法 JSON" } }
  const version = String(pack.version || "").trim()
  if (!VERSION_RE.test(version)) return { ok: false, err: `pack.json 的 version=${JSON.stringify(pack.version)} 要写成点分数字（如 2026.7.30）` }

  // 布局：除 pack.json / AGENTS.md 外，一切都得在 skills/<名>/ 之下
  const skillSet = new Set()
  for (const f of files) {
    if (f.name === "pack.json" || f.name === "AGENTS.md") continue
    const m = /^skills\/([^/]+)\//.exec(f.name)
    if (!m) return { ok: false, err: `包里有不认识的条目：${f.name}（只允许 pack.json / AGENTS.md / skills/<技能名>/**）` }
    skillSet.add(m[1])
  }
  if (!skillSet.size) return { ok: false, err: "包里一个技能都没有（skills/ 目录为空）" }

  for (const s of skillSet) {
    const md = files.find((f) => f.name === `skills/${s}/SKILL.md`)
    if (!md) return { ok: false, err: `技能 ${s} 缺 SKILL.md —— 没有它 opencode 不会把该目录当技能` }
    // BOM 会让 opencode 认不出 SKILL.md 的 frontmatter（真机踩过），发布闸直接拒，别指望客户端兜
    if (md.data.length >= 3 && md.data[0] === 0xef && md.data[1] === 0xbb && md.data[2] === 0xbf)
      return { ok: false, err: `技能 ${s} 的 SKILL.md 带 UTF-8 BOM（opencode 不认）——用打包脚本重新出包` }
  }

  if (!files.some((f) => f.name === "AGENTS.md"))
    warnings.push("包里没有 AGENTS.md：客户端更新后顶层路由表不变，新技能进不了流水线编排（只能靠 SKILL.md 描述自触发）")

  const changedSkills = Array.isArray(pack.changedSkills) ? pack.changedSkills.map(String).filter(Boolean) : []
  const unknown = changedSkills.filter((s) => !skillSet.has(s))
  if (unknown.length) warnings.push(`changedSkills 里有包内不存在的技能：${unknown.join(", ")}`)

  // 包外保留：故意不随包分发的超大稳定技能（客户端换版时自留平移，见 web/skill-update.mjs）
  const preserved = Array.isArray(pack.preserved) ? pack.preserved.map(String).filter(Boolean) : []
  const overlap = preserved.filter((s) => skillSet.has(s))
  if (overlap.length) warnings.push(`preserved 里的技能包里也带了（客户端将以包内为准）：${overlap.join(", ")}`)

  const lint = lintImports(files, pack.venvPackages)
  if (lint.skipped) warnings.push("pack.json 未嵌入 venvPackages（打包机没找到 .venv？）——依赖 lint 已跳过，请人工确认没有新增 pip 依赖")

  return {
    ok: true,
    pack: {
      version,
      changelog: String(pack.changelog || "").slice(0, 4000),
      changedSkills, preserved,
      venvPackages: Array.isArray(pack.venvPackages) ? pack.venvPackages.map(String) : [],
      createdAt: Number(pack.createdAt) || 0,
    },
    skills: [...skillSet].sort(),
    files, warnings, lint,
  }
}

// ==== 从技能目录树出包（服务端"从仓库发布"与 scripts/make-skill-pack.mjs 共用）========

const JUNK = new Set(["__pycache__", "node_modules", ".DS_Store", "outputs", ".pytest_cache"])

/**
 * 走一遍技能目录，收成 zip 条目。exclude = 不随包分发的技能（写进 preserved）。
 * 顺手就地剥 SKILL.md 的 BOM（opencode 不认，发布闸也会拒——在源头治）。
 */
export function collectSkillEntries(skillsDir, { exclude = new Set() } = {}) {
  const entries = [], warnings = [], bigFiles = []
  let totalBytes = 0
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (JUNK.has(e.name) || e.name.endsWith(".pyc")) continue
      const abs = path.join(dir, e.name)
      const r = rel + "/" + e.name
      if (e.isDirectory()) { walk(abs, r); continue }
      if (!e.isFile()) continue
      let data = fs.readFileSync(abs)
      if (e.name === "SKILL.md" && data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
        data = data.subarray(3)
        warnings.push(`已剥去 BOM：${r}`)
      }
      if (data.length > 5 * 1024 * 1024) bigFiles.push(`${r}（${(data.length / 1048576).toFixed(1)}MB）`)
      totalBytes += data.length
      entries.push({ name: r, data })
    }
  }
  const names = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name).sort()
  const packed = names.filter((s) => !exclude.has(s))
  const preserved = names.filter((s) => exclude.has(s))
  for (const s of packed) walk(path.join(skillsDir, s), `skills/${s}`)
  if (bigFiles.length) warnings.push(`包里有大文件（考虑加进排除清单？）：${bigFiles.join("、")}`)
  return { entries, packed, preserved, totalBytes, warnings }
}

/**
 * 从磁盘上的技能树拼出一个完整技能包 zip。
 * rootDir 下若有 AGENTS.md 一并带上（路由表随包走）。
 */
export function buildPack({ skillsDir, rootDir, version, changelog = "", changedSkills = [], exclude = new Set(), venvPackages = [] }) {
  const c = collectSkillEntries(skillsDir, { exclude })
  const entries = [{
    name: "pack.json",
    data: Buffer.from(JSON.stringify({
      version, changelog, changedSkills, preserved: c.preserved, venvPackages, createdAt: Date.now(),
    }, null, 2), "utf8"),
  }, ...c.entries]
  const agents = rootDir && path.join(rootDir, "AGENTS.md")
  if (agents && fs.existsSync(agents)) entries.push({ name: "AGENTS.md", data: fs.readFileSync(agents) })
  else c.warnings.push("源树里没有 AGENTS.md——包里不带路由表，客户端沿用旧的")
  return { buf: zip(entries), skills: c.packed, preserved: c.preserved, warnings: c.warnings, totalBytes: c.totalBytes }
}
