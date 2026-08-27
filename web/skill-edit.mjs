// 技能说明书在线编辑（内部版专属）：让不懂命令行的人在界面里改技能，而不是去安装目录翻 SKILL.md。
//
// 【为什么只有内部版有】技能是否可编辑，取决于它在磁盘上是不是明文——而这正是 skill-vault 的开关：
//   · 对外版（bundle.ps1 默认）：技能封在 skills.pak 里，运行期才解密到原路径、退出即擦除。
//     那种形态下"编辑"是个陷阱——用户改完关掉软件，改动连同明文一起被擦掉，还找不到人说理。
//   · 内部版（bundle.ps1 -PlainSkills）：没有 pak，技能全程明文、改了就算数。
//   所以本模块的可用性判据就是 `!SkillVault.hasVault(skillsDir)`，由 server.mjs 在路由处把关，
//   不在这里重复判断（省得两处判据漂移）。
//
// 【只让改 SKILL.md，不让改脚本】SKILL.md 是"这个技能该怎么干活"的指令，是用户不满意时真正想动的
// 东西；同目录下的 .py/.sh 是工具实现，改坏了是运行时报错、且没有任何界面能帮小白看懂 traceback。
// 所以编辑面只开说明书这一层，脚本仍然只能由开发侧改。
//
// 【出厂底稿与恢复】用户第一次保存某个技能前，先把当时的原文另存为底稿（baseline），"恢复出厂"
// 就是把它写回去。底稿按【技能包版本】记：技能包一旦在线换版/回退，整个技能目录被替换，旧底稿
// 对新版本没有意义（写回去等于把新版技能退回老文本），此时视为无底稿、界面上不给恢复入口。
import fs from "node:fs"
import path from "node:path"

// 技能加载器对 SKILL.md 有 ~51.5KB 的字节截断线（含约 1.5KB 包装头），超过部分被静默切掉 ——
// 技能会以"指令读了一半"的状态运行，比报错更难查。所以保存时硬拦，别让用户踩进去。
export const MAX_BYTES = 50000
// 接近上限时先提醒（保存仍放行）：给用户留出精简的余地，而不是等他一头撞上硬拦。
export const WARN_BYTES = 46000

/** 底稿目录：<app>/skill-edits/<技能id>/ 下存 baseline.md + meta.json（版本戳）。 */
const editsDir = (root) => path.join(root, "skill-edits")
const baseDir = (root, id) => path.join(editsDir(root), id)

/** 技能 id 只允许目录名字符——挡住 ../ 与绝对路径（这几个接口的入参直接来自网页）。 */
export function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(id) && id !== "." && id !== ".."
}

const skillMdPath = (skillsDir, id) => path.join(skillsDir, id, "SKILL.md")

/** 从 SKILL.md 的 YAML frontmatter 里取 name / description（只做够用的行解析，不引 YAML 依赖）。 */
function parseFront(text) {
  const out = { name: "", description: "" }
  if (!text.startsWith("---")) return out
  const end = text.indexOf("\n---", 3)
  if (end < 0) return out
  const head = text.slice(0, end)
  for (const key of ["name", "description"]) {
    const m = head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
    if (m) out[key] = m[1].trim().replace(/^["']|["']$/g, "")
  }
  return out
}

/**
 * 让新文本跟着原文的行尾走。
 * 【为什么必须做】仓库里的技能文件是 CRLF，而网页 textarea 按 HTML 规范把内容规范成 LF ——
 * 用户在界面上只改了一行，回写时却把整份文件的行尾全换了一遍。后果不是功能性的，而是
 * 【日后没人查得清这个技能到底被改了什么】：diff 显示"149 行全改"，真正那一行淹没在里面。
 */
function matchEol(original, text) {
  const lf = text.replace(/\r\n/g, "\n")
  const crlfLines = (original.match(/\r\n/g) || []).length
  const lfLines = (original.match(/\n/g) || []).length
  // 原文以 CRLF 为主（半数以上换行是 CRLF）才转回去；LF 文件与空文件保持 LF
  return crlfLines > 0 && crlfLines * 2 >= lfLines ? lf.replace(/\n/g, "\r\n") : lf
}

/**
 * 保存前的体检。返回 { ok, err } —— err 非空即拒绝保存。
 * 【为什么要拦 frontmatter】description 是技能的触发条件，顶层主控靠它决定什么时候派这个技能；
 * 被误删的话技能仍在目录里、却永远不会被调用，表现为"这个功能突然没了"，极难自查。
 */
export function validate(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, err: "内容是空的，没保存" }
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > MAX_BYTES)
    return { ok: false, err: `太长了（${bytes} 字节，上限 ${MAX_BYTES}）——技能加载器会把超出部分直接截掉，技能会"指令只读了一半"地跑。请先精简。` }
  const f = parseFront(text)
  if (!text.startsWith("---") || !f.name || !f.description)
    return { ok: false, err: "开头那段 --- 包起来的 name / description 不能删或留空：description 是这个技能的触发条件，没有它主控永远不会调用这个技能。" }
  return { ok: true, warn: bytes > WARN_BYTES ? `已接近长度上限（${bytes}/${MAX_BYTES} 字节），再长会被截断` : "" }
}

/** 读底稿的版本戳；与当前技能包版本不一致 → 视为无底稿（见头注）。 */
function baselineOf(root, id, packVersion) {
  const f = path.join(baseDir(root, id), "baseline.md")
  const mf = path.join(baseDir(root, id), "meta.json")
  if (!fs.existsSync(f)) return null
  let meta = {}
  try { meta = JSON.parse(fs.readFileSync(mf, "utf8")) } catch {}
  if ((meta.packVersion || "") !== (packVersion || "")) return null
  return { file: f, savedAt: meta.savedAt || 0 }
}

/** 列出可编辑的技能（目录里有 SKILL.md 的才算）。edited = 有对应版本的底稿，即被本机改过。 */
export function list(skillsDir, root, packVersion) {
  if (!fs.existsSync(skillsDir)) return []
  const out = []
  for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const md = skillMdPath(skillsDir, e.name)
    let st
    try { st = fs.statSync(md) } catch { continue }        // 没有 SKILL.md 的目录不是技能
    let front = { name: "", description: "" }
    try { front = parseFront(fs.readFileSync(md, "utf8").slice(0, 4000)) } catch {}
    out.push({
      id: e.name,
      name: front.name || e.name,
      description: front.description || "",
      bytes: st.size,
      modified: st.mtimeMs,
      edited: !!baselineOf(root, e.name, packVersion),
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** 读一个技能的 SKILL.md 全文（附带"能不能恢复出厂"）。 */
export function read(skillsDir, root, packVersion, id) {
  const md = skillMdPath(skillsDir, id)
  if (!fs.existsSync(md)) return { ok: false, err: "这个技能不存在，或它没有 SKILL.md" }
  const text = fs.readFileSync(md, "utf8")
  const b = baselineOf(root, id, packVersion)
  return {
    ok: true, id, text,
    bytes: Buffer.byteLength(text, "utf8"),
    edited: !!b,
    editedAt: b?.savedAt || 0,
    maxBytes: MAX_BYTES,
  }
}

/**
 * 保存。首次保存前先把原文存成底稿（同一版本只存一次，保证"恢复出厂"永远回到最初那份，
 * 而不是回到上一次编辑）。原子写：先写临时文件再 rename，避免写到一半断电留下半截 SKILL.md。
 */
export function save(skillsDir, root, packVersion, id, text) {
  const md = skillMdPath(skillsDir, id)
  if (!fs.existsSync(md)) return { ok: false, err: "这个技能不存在，或它没有 SKILL.md" }
  text = matchEol(fs.readFileSync(md, "utf8"), String(text ?? ""))
  const v = validate(text)   // 放在行尾还原【之后】：字节数上限按真正落盘的那份算
  if (!v.ok) return v

  if (!baselineOf(root, id, packVersion)) {
    const d = baseDir(root, id)
    fs.mkdirSync(d, { recursive: true })
    fs.copyFileSync(md, path.join(d, "baseline.md"))
    fs.writeFileSync(path.join(d, "meta.json"),
      JSON.stringify({ packVersion: packVersion || "", savedAt: Date.now() }, null, 2))
  } else {
    // 底稿保留不动，只更新"最后编辑时间"
    const mf = path.join(baseDir(root, id), "meta.json")
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(mf, "utf8")) } catch {}
    meta.savedAt = Date.now()
    try { fs.writeFileSync(mf, JSON.stringify(meta, null, 2)) } catch {}
  }

  const tmp = md + ".tmp"
  fs.writeFileSync(tmp, text, "utf8")
  fs.renameSync(tmp, md)
  return { ok: true, bytes: Buffer.byteLength(text, "utf8"), warn: v.warn || "" }
}

/**
 * 导出「本机改过的技能」，给内部用户把成果交回开发侧用。返回 zip 的 entries（由调用方打包）。
 *
 * 【为什么连出厂底稿一起导出】只给改后的文件，收件人拿到的是一份 15KB 的 SKILL.md，看不出
 * 到底动了哪几句——而这正是他要判断"能不能合进主线"的唯一依据。带上底稿，一条 diff 命令就够了。
 * 【为什么不在这里生成 diff】收件人手上有仓库，`git diff --no-index` 出来的差异比我们自造的更
 * 可信、也带语法高亮；自己实现一套行差分只是多一处会出错的代码。
 * 【与出流闸的关系】技能原文本来被 SkillGuard 禁止导出，这里是内部版专属的例外：这种包里的
 * 技能本就是明文平铺的，不存在"从产物里泄漏"这回事。路由处已用同一道 available 闸挡住对外版。
 */
export function exportEdited(skillsDir, root, packVersion) {
  const edited = list(skillsDir, root, packVersion).filter((s) => s.edited)
  if (!edited.length) return { ok: false, err: "还没有改过任何技能，没什么可导出的" }
  const entries = []
  const lines = [
    "这是内部版「编辑技能」导出的改动包。",
    "",
    `导出时间：${new Date().toLocaleString("zh-CN")}`,
    `技能包版本：${packVersion || "出厂版（安装包自带）"}`,
    `改过的技能：${edited.length} 个`,
    "",
    "每个技能两份文件：",
    "  <技能名>/SKILL.md        改之后（正在用的这份）",
    "  <技能名>/SKILL.md.orig   改之前（这一版技能包的出厂原文）",
    "",
    "看改了什么（在收件人自己的机器上跑）：",
    "  git diff --no-index <技能名>/SKILL.md.orig <技能名>/SKILL.md",
    "",
    "改动清单：",
  ]
  for (const s of edited) {
    const cur = fs.readFileSync(skillMdPath(skillsDir, s.id))
    const orig = fs.readFileSync(path.join(baseDir(root, s.id), "baseline.md"))
    entries.push({ name: `${s.id}/SKILL.md`, data: cur })
    entries.push({ name: `${s.id}/SKILL.md.orig`, data: orig })
    const when = s.edited && baselineOf(root, s.id, packVersion)?.savedAt
    lines.push(`  · ${s.id}：${orig.length} → ${cur.length} 字节` +
      (when ? `，最后改于 ${new Date(when).toLocaleString("zh-CN")}` : ""))
  }
  entries.push({ name: "说明.txt", data: Buffer.from(lines.join("\n") + "\n", "utf8") })
  return { ok: true, entries, count: edited.length }
}

/** 恢复出厂：把底稿写回去并删掉底稿（技能回到"没被改过"的状态）。 */
export function revert(skillsDir, root, packVersion, id) {
  const b = baselineOf(root, id, packVersion)
  if (!b) return { ok: false, err: "没有可恢复的出厂底稿（这个技能没被改过，或技能包换过版）" }
  const md = skillMdPath(skillsDir, id)
  const text = fs.readFileSync(b.file, "utf8")
  const tmp = md + ".tmp"
  fs.writeFileSync(tmp, text, "utf8")
  fs.renameSync(tmp, md)
  fs.rmSync(baseDir(root, id), { recursive: true, force: true })
  return { ok: true, text, bytes: Buffer.byteLength(text, "utf8") }
}
