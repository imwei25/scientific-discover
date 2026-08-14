// 界面包：把桌面客户端的【前端静态资源】（web/*.html 与图片/样式等）打成一个版本化 zip，
// 管理员在后台发布，客户端一键更新 —— 改个文案、调个样式、修个按钮不用再重发安装包。
//
// 【为什么单独一类包，而不是塞进技能包】两者的生效方式与风险完全不同：
//   · 技能包换的是 .opencode/skills，要停掉再重启 opencode 才生效；
//   · 界面包换的是网关每次请求现读的静态文件（web/server.mjs 里 readFileSync(index.html)），
//     换完用户刷新一下页面就生效，**不重启任何进程**，坏了也只是刷新回上一版。
// 混成一个包就等于把"零风险的小改动"和"要重启后台的大改动"绑在一起发。
//
// 【白名单是这层的全部意义】客户端拿到包就会往自己的应用目录里写文件，所以能写什么必须
// 在服务端先钉死：
//   · 只允许 web/ 之下；
//   · 只允许下面 SAFE_EXT 里的静态资源后缀；
//   · **.mjs 一律拒**——那些是本机网关的服务端代码（server.mjs / cloud-account.mjs …），
//     换它们要重启网关、坏了客户端直接起不来，不在本类包的能力范围内（见 docs 的说明）；
//   · .json 一律拒——web/ 下的 json 是运行时状态（sessions-meta.json）与依赖清单（package.json），
//     被包覆盖会把用户的会话归属冲掉；
//   · node_modules/ 一律拒。
// zip 层面的 ../、绝对路径、盘符、控制字符由 minizip.cleanName 统一拒绝（zip-slip 防线）。

import fs from "node:fs"
import path from "node:path"
import { unzip, zip } from "./minizip.mjs"
import { VERSION_RE } from "./skillpacks.mjs"

/** 允许随包分发的静态资源后缀（小写，含点） */
export const SAFE_EXT = new Set([".html", ".htm", ".css", ".js", ".svg", ".png", ".jpg", ".jpeg",
  ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".map", ".txt"])

/** 这个路径能不能进界面包。返回 "" = 可以，否则返回拒绝原因。 */
export function rejectReason(name) {
  const n = String(name || "")
  if (n === "pack.json") return ""
  if (!n.startsWith("web/")) return "只允许 web/ 之下的文件"
  if (n.split("/").includes("node_modules")) return "不允许 node_modules"
  const ext = path.extname(n).toLowerCase()
  if (ext === ".mjs") return "不允许 .mjs（那是本机网关的服务端代码，换它要重启网关，不走界面包）"
  if (!SAFE_EXT.has(ext)) return `不允许的后缀 ${ext || "(无)"}（只收静态资源：${[...SAFE_EXT].join(" ")}）`
  return ""
}

const BOM = 0xfeff
const MAX_ENTRY = 8 * 1024 * 1024      // 单个静态资源 8MB 顶天了，再大多半是误打包
const MAX_TOTAL = 32 * 1024 * 1024

/**
 * 发布闸：把上传的包拆开静态校验。
 * 返回 { ok:true, pack, files, names[], warnings[] } 或 { ok:false, err }。
 * 校验不过一律【整包拒绝】—— 半好半坏的界面比不发更糟。
 */
export function parseWebPack(buf) {
  let files
  try { files = unzip(buf) } catch (e) { return { ok: false, err: e.message } }
  const warnings = []

  const packEntry = files.find((f) => f.name === "pack.json")
  if (!packEntry) return { ok: false, err: "包里没有 pack.json" }
  let pack
  try {
    let s = packEntry.data.toString("utf8")
    if (s.charCodeAt(0) === BOM) s = s.slice(1)
    pack = JSON.parse(s)
  } catch { return { ok: false, err: "pack.json 不是合法 JSON" } }
  const version = String(pack.version || "").trim()
  if (!VERSION_RE.test(version)) return { ok: false, err: `pack.json 的 version=${JSON.stringify(pack.version)} 要写成点分数字（如 2026.7.31）` }

  let total = 0
  const names = []
  for (const f of files) {
    if (f.name === "pack.json") continue
    const bad = rejectReason(f.name)
    if (bad) return { ok: false, err: `包里有不该出现的条目 ${f.name}：${bad}` }
    if (f.data.length > MAX_ENTRY) return { ok: false, err: `${f.name} 有 ${(f.data.length / 1048576).toFixed(1)}MB，超过单文件上限 8MB` }
    total += f.data.length
    names.push(f.name)
  }
  if (!names.length) return { ok: false, err: "包里一个文件都没有" }
  if (total > MAX_TOTAL) return { ok: false, err: `包内容共 ${(total / 1048576).toFixed(1)}MB，超过 32MB 上限` }

  // 【index.html 缺了要提醒但不拦】只发一张图片/一个样式表是合法用法
  if (!names.includes("web/index.html"))
    warnings.push("包里没有 web/index.html —— 确认这是有意为之（只更新部分资源）")

  return {
    ok: true,
    pack: {
      version,
      changelog: String(pack.changelog || "").slice(0, 4000),
      createdAt: Number(pack.createdAt) || 0,
    },
    files, names: names.sort(), totalBytes: total, warnings,
  }
}

/**
 * 从一份仓库检出里收集前端资源，拼成界面包 zip。
 * 「后台一键从仓库发布」与命令行出包共用这段。
 *
 * 【只收 web/ 顶层与一层子目录里的白名单文件】现在 web/ 下只有两个 html，将来放
 * web/assets/logo.png 也能带上；再深的层级没有需求，不如把面收窄。
 */
export function collectWebEntries(webDir) {
  const entries = [], warnings = []
  let total = 0
  const walk = (dir, rel, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      const abs = path.join(dir, e.name), r = rel + "/" + e.name
      if (e.isDirectory()) { if (depth < 2) walk(abs, r, depth + 1); continue }
      if (!e.isFile()) continue
      if (rejectReason(r)) continue                     // 静默跳过 .mjs / package.json 这些
      const data = fs.readFileSync(abs)
      if (data.length > MAX_ENTRY) { warnings.push(`${r} 超过 8MB，已跳过`); continue }
      total += data.length
      entries.push({ name: r, data })
    }
  }
  walk(webDir, "web", 1)
  return { entries, totalBytes: total, warnings }
}

export function buildWebPack({ webDir, version, changelog = "" }) {
  const c = collectWebEntries(webDir)
  if (!c.entries.length) return { ok: false, err: `${webDir} 下没有可发布的静态资源` }
  const entries = [{
    name: "pack.json",
    data: Buffer.from(JSON.stringify({ version, changelog, createdAt: Date.now() }, null, 2), "utf8"),
  }, ...c.entries]
  return {
    ok: true, buf: zip(entries),
    names: c.entries.map((e) => e.name), totalBytes: c.totalBytes, warnings: c.warnings,
  }
}
