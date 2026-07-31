// 界面包的本机安装 / 回退 / 版本留存（桌面版专用；纯文件系统操作，不发网络请求）。
//
// 换的是【前端静态资源】——网关每次请求都从磁盘现读 index.html，所以换完文件用户刷新一下
// 页面就生效，**不重启任何进程**。这也是它与技能包最大的区别（那个要停掉再重启 opencode）。
//
// 目录约定（ROOT = 应用目录 bundle/app，与 skill-update.mjs 同一个）：
//   ROOT/web/index.html …          现用前端资源（网关就从这里读）
//   ROOT/web-packs/
//     installed.json               { current, history:[{version,at}] }；current 空串 = 出厂版
//     <版本号>/web/**              该版本【生效前】那套受管文件的完整快照（回退用）
//     .staging/                    解压暂存（成型后才动现用文件）
//
// 【归档存的是全量快照，不是"这次改了哪几个"】包可以只带一个 index.html（只改界面），
// 若归档也只存被覆盖的那几个，回退链就得按顺序逐层回放，错一层就成了一半新一半旧。
// 全量快照下"回退到某版"永远是一个确定的结果。前端资源一共几百 KB，留 5 份也不心疼。
//
// 【只碰受管文件】受管 = web/ 下白名单后缀（见 MANAGED_EXT）的静态资源，且**永不包含 .mjs**
// （那是网关自己的服务端代码）与 .json（sessions-meta.json 是用户的会话归属，package.json 是
// 依赖清单，冲掉哪个都是事故）。服务端发布闸也拦同一套规则，这里是第二道。

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { unzip } from "./minizip.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// env 可覆盖：自动化测试要在临时目录里演练整套换版流程，绝不能动开发机真正的 web/ 目录
const ROOT = () => process.env.WEB_ROOT_DIR || path.resolve(__dirname, "..")
const WEB = () => path.join(ROOT(), "web")
const STORE = () => process.env.WEB_STORE_DIR || path.join(ROOT(), "web-packs")
const STATE = () => path.join(STORE(), "installed.json")
const STAGING = () => path.join(STORE(), ".staging")

export const FACTORY = "factory"
const KEEP = 5                     // 归档最多留几个版本（不含出厂版）
const MAX_DEPTH = 2                // web/ 顶层 + 一层子目录（与服务端出包口径一致）

/** 受管后缀：与 server/lib/webpacks.mjs 的 SAFE_EXT 必须一致 */
export const MANAGED_EXT = new Set([".html", ".htm", ".css", ".js", ".svg", ".png", ".jpg", ".jpeg",
  ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".map", ".txt"])

/** 这个相对路径（相对 ROOT，形如 web/index.html）归不归界面包管 */
export function managed(rel) {
  const n = String(rel || "").replace(/\\/g, "/")
  if (!n.startsWith("web/")) return false
  const parts = n.split("/")
  if (parts.includes("node_modules") || parts.some((p) => p.startsWith("."))) return false
  if (parts.length - 1 > MAX_DEPTH) return false
  return MANAGED_EXT.has(path.extname(n).toLowerCase())
}

// ---- 状态 ----
export function state() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE(), "utf8"))
    return { current: String(s.current || ""), history: Array.isArray(s.history) ? s.history : [] }
  } catch { return { current: "", history: [] } }
}
function saveState(s) {
  fs.mkdirSync(STORE(), { recursive: true })
  const tmp = STATE() + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, STATE())
}
/** 现用版本；空串 = 出厂版（安装器自带、没有在线更新过） */
export const currentVersion = () => state().current

/** 本机留存的可回退版本（含出厂版），新的在前 */
export function listLocal() {
  let names = []
  try { names = fs.readdirSync(STORE(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch {}
  return names
    .filter((n) => !n.startsWith(".") && fs.existsSync(path.join(STORE(), n, "web")))
    .map((n) => {
      let at = 0
      try { at = fs.statSync(path.join(STORE(), n)).mtimeMs } catch {}
      return { version: n, at, factory: n === FACTORY }
    })
    .sort((a, b) => (a.factory ? 1 : b.factory ? -1 : b.at - a.at))
}

// ---- 文件操作 ----
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }) } catch {} }

/**
 * 换版前的保险丝：**开发检出里不许换版**。
 *
 * 真事（写这个模块的当天就撞上了）：测试脚手架把 WEB_ROOT_DIR 设完就把 process.env 还原了，
 * 而本模块是【调用时】现读 env 的 —— 于是 ROOT() 回落成 path.resolve(__dirname,"..")，
 * 一次 installBuffer 直接把开发机仓库里的 web/index.html 覆盖成了测试用的假内容。
 * 打包安装的应用目录里永远没有 .git，所以这条闸对真实用户零影响，只挡住开发机上的误伤。
 */
function assertInstallable() {
  if (process.env.WEB_ROOT_DIR) return          // 显式指定了根目录（测试/特殊部署）：听它的
  if (fs.existsSync(path.join(ROOT(), ".git")))
    throw new Error(`拒绝在开发检出里换版（${ROOT()} 下有 .git）——界面包只在打包安装的客户端里生效`)
}

/** 列出现用 web/ 下所有受管文件（相对 ROOT 的路径，用 / 分隔） */
export function listManaged(webDir = WEB()) {
  const out = []
  const walk = (dir, rel, depth) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      const r = rel + "/" + e.name
      if (e.isDirectory()) { if (depth < MAX_DEPTH) walk(path.join(dir, e.name), r, depth + 1); continue }
      if (e.isFile() && managed(r)) out.push(r)
    }
  }
  walk(webDir, "web", 1)
  return out.sort()
}

/** 把现用受管文件整套拷进 dir（全量快照） */
function snapshotInto(dir) {
  rmrf(dir)
  for (const rel of listManaged()) {
    const dst = path.join(dir, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(path.join(ROOT(), rel), dst)
  }
}

/**
 * 把 srcDir 里的文件搬成"现用"。
 *   mode="merge"   ：只覆盖 srcDir 里有的（安装新包：包可以只带 index.html）
 *   mode="replace" ：受管文件与 srcDir 完全一致（回退：多出来的受管文件要删掉）
 *
 * 【先备份再覆盖，失败逐条撤销】前端资源是用户唯一的界面，换到一半又撤不回来，
 * 用户下次刷新看到的就是半新半旧的页面。
 */
function applyFiles(srcDir, mode) {
  const wanted = listManaged(path.join(srcDir, "web")).map((r) => r)   // 形如 web/index.html
  const undo = []
  const bak = path.join(STAGING(), ".bak")
  rmrf(bak)
  const backup = (rel) => {
    const cur = path.join(ROOT(), rel)
    if (!fs.existsSync(cur)) return null
    const b = path.join(bak, rel)
    fs.mkdirSync(path.dirname(b), { recursive: true })
    fs.copyFileSync(cur, b)
    return b
  }
  try {
    for (const rel of wanted) {
      const b = backup(rel)
      const dst = path.join(ROOT(), rel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(path.join(srcDir, rel), dst)
      undo.push(() => { if (b) fs.copyFileSync(b, dst); else { try { fs.unlinkSync(dst) } catch {} } })
    }
    if (mode === "replace") {
      const keep = new Set(wanted)
      for (const rel of listManaged()) {
        if (keep.has(rel)) continue
        const b = backup(rel)
        fs.unlinkSync(path.join(ROOT(), rel))
        undo.push(() => { if (b) fs.copyFileSync(b, path.join(ROOT(), rel)) })
      }
    }
  } catch (e) {
    for (const u of undo.reverse()) { try { u() } catch {} }
    throw new Error(`换版失败（已撤销，现用界面未动）：${e.message}。多半是有文件被占用或磁盘满了——请稍后重试`)
  } finally { rmrf(bak) }
  return wanted
}

/** 归档瘦身：出厂版永远留，其余按归档时间留最近 KEEP 个 */
function prune() {
  const extra = listLocal().filter((v) => !v.factory).sort((a, b) => b.at - a.at).slice(KEEP)
  const s = state()
  for (const v of extra) {
    rmrf(path.join(STORE(), v.version))
    s.history = s.history.filter((h) => h.version !== v.version)
  }
  if (extra.length) saveState(s)
}

function recordSwitch(newVersion) {
  const curName = state().current || FACTORY
  const s = state()
  s.history = [{ version: curName, at: Date.now() }, ...s.history.filter((h) => h.version !== curName && h.version !== newVersion)]
  s.current = newVersion === FACTORY ? "" : newVersion
  saveState(s)
  prune()
}

/**
 * 安装一个已下载的界面包。buf = zip 内容；sha256 = 服务端声明的摘要（必须先核）。
 * 先解到暂存、把现用整套快照进归档，最后才动现用文件。
 */
export function installBuffer(buf, { version, sha256 }) {
  assertInstallable()
  if (!/^\d+(\.\d+)*$/.test(String(version))) throw new Error(`版本号不合法：${version}`)
  const got = crypto.createHash("sha256").update(buf).digest("hex")
  if (sha256 && got !== String(sha256).toLowerCase())
    throw new Error("下载的界面包校验失败（sha256 不符）——传输损坏或内容被改动，已放弃安装")
  const entries = unzip(buf)
  // 服务端发布时校验过，这里再核一遍：**客户端不能信任下发内容**，未知条目一律不落盘
  const files = entries.filter((e) => e.name !== "pack.json" && managed(e.name))
  const rejected = entries.filter((e) => e.name !== "pack.json" && !managed(e.name)).map((e) => e.name)
  if (rejected.length) throw new Error(`包里有不该出现的条目（已放弃安装）：${rejected.slice(0, 5).join("、")}`)
  if (!files.length) throw new Error("包里没有任何可安装的界面文件，已放弃安装")

  rmrf(STAGING())
  try {
    for (const e of files) {
      const dst = path.join(STAGING(), e.name)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.writeFileSync(dst, e.data)
    }
    // 归档【现用】那套，取名当前版本（第一次更新时就是 factory —— 回退链的最后一环，永不清理）
    const archiveName = state().current || FACTORY
    const archive = path.join(STORE(), archiveName)
    snapshotInto(archive)
    try {
      applyFiles(STAGING(), "merge")
    } catch (e) {
      // 换版失败：applyFiles 已把现用撤回原样。刚照的那张快照除非是【出厂版】（回退链的最后
      // 一环，留着有用且无害），否则清掉 —— 否则归档里会多出一个与现用同名的版本，
      // 回退列表里看着像个可选项，点了却是原地踏步。
      if (archiveName !== FACTORY) rmrf(archive)
      throw e
    }
    recordSwitch(String(version))
  } finally { rmrf(STAGING()) }
  return files.map((f) => f.name)
}

/** 回退到本机留存的某个版本（含 "factory" = 出厂版）。 */
export function rollback(version) {
  assertInstallable()
  const v = String(version)
  const cur = state().current || FACTORY
  // 先判"就是当前版"再判"留存在不在"：当前版的快照本来就不在归档里（转正时被消耗掉了），
  // 顺序反了会把"你已经在用它了"误报成"本机没有留存"。
  if (v === cur) throw new Error(`当前用的就是${v === FACTORY ? "出厂版" : "版本 " + v}`)
  const src = path.join(STORE(), v)
  if (!fs.existsSync(path.join(src, "web"))) throw new Error(`本机没有留存版本 ${v}，无法回退`)
  const archive = path.join(STORE(), cur)
  snapshotInto(archive)                 // 先把现在这套存成"当前版"，回退之后还能再回来
  rmrf(STAGING())
  try {
    applyFiles(src, "replace")          // 回退要的是"和那一版完全一致"，多出来的受管文件删掉
    recordSwitch(v)
  } finally { rmrf(STAGING()) }
  rmrf(src)                             // 它现在是"现用"，不再算归档
}
