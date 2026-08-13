// 技能包的本机安装 / 回退 / 版本留存（桌面版专用；纯文件系统操作，不发网络请求）。
//
// 目录约定（ROOT = 应用目录 bundle/app）：
//   ROOT/.opencode/skills/        现用技能（opencode 只认这里）
//   ROOT/AGENTS.md                顶层路由（随包更新）
//   ROOT/skill-packs/
//     installed.json              { current, history:[{version,at}] }；current 空串 = 出厂版
//     <版本号>/skills/** + AGENTS.md   归档的旧版（回退用；最多留 KEEP 个，出厂版永不清）
//     .staging/                   解压暂存（换名前先在这里成型，失败不碰现用目录）
//
// 【换版本用 rename 而不是拷贝】同盘 rename 是一步到位的目录级操作：要么整个换过去，
// 要么在第一步就失败（此时现用目录原封未动）。中途状态只有"归档已挪走、新版还没就位"
// 一小段，出错时按记录逆序撤销。调用方（server.mjs）负责先停掉 opencode 再进来 ——
// Windows 上正被进程占着的文件是 rename 不动的（EPERM/EBUSY）。
//
// 【出厂版（factory）永不清理】它是打包进安装器的那套技能，是回退链的最后一环：
// 无论在线更新出什么问题，用户永远能退回"重装刚装完"的状态。

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { unzip } from "./minizip.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// env 可覆盖：自动化测试要在临时目录里演练整套换版流程，绝不能动开发机真正的技能目录
const ROOT = () => process.env.SKILL_ROOT_DIR || path.resolve(__dirname, "..")
const SKILLS = () => path.join(ROOT(), ".opencode", "skills")
const AGENTS = () => path.join(ROOT(), "AGENTS.md")
const STORE = () => process.env.SKILL_STORE_DIR || path.join(ROOT(), "skill-packs")
const STATE = () => path.join(STORE(), "installed.json")
const STAGING = () => path.join(STORE(), ".staging")

export const FACTORY = "factory"
const KEEP = 5   // 归档最多留几个版本（不含出厂版）

// ---- 状态 ----
export function state() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE(), "utf8"))
    return {
      current: String(s.current || ""),
      history: Array.isArray(s.history) ? s.history : [],
      // 安装器打包时刻（bundle.ps1 写入）。出厂版没有版本号可比，判"服务端的包是不是
      // 真的比我新"只能靠它，见 pack-freshness.mjs
      factoryAt: Number(s.factoryAt) || 0,
    }
  } catch { return { current: "", history: [], factoryAt: 0 } }
}
function saveState(s) {
  fs.mkdirSync(STORE(), { recursive: true })
  const tmp = STATE() + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, STATE())
}
/** 现用版本；空串 = 出厂版（安装器自带、没有在线更新过） */
export const currentVersion = () => state().current
/** 安装器的打包时刻（ms）；0 = 不知道（0.1.5 及更早的安装器没写这一项） */
export const factoryAt = () => state().factoryAt

/** 本机留存的可回退版本（含出厂版），新的在前 */
export function listLocal() {
  let names = []
  try { names = fs.readdirSync(STORE(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch {}
  return names
    // 金库模式下归档以 archive.pak 加密留存（明文 skills\ 被删），两者有其一即可回退
    .filter((n) => !n.startsWith(".") &&
      (fs.existsSync(path.join(STORE(), n, "skills")) || fs.existsSync(path.join(STORE(), n, "archive.pak"))))
    .map((n) => {
      let at = 0
      try { at = fs.statSync(path.join(STORE(), n)).mtimeMs } catch {}
      return { version: n, at, factory: n === FACTORY }
    })
    .sort((a, b) => (a.factory ? 1 : b.factory ? -1 : b.at - a.at))   // 出厂版沉底
}

// ---- 换版核心 ----
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }) } catch {} }

/**
 * 把"现用"整体挪进归档、再把 newDir 里的内容挪成"现用"。
 * newDir 布局：newDir/skills/**（必有）+ newDir/AGENTS.md（可无）。
 * 失败时按已完成的步骤逆序撤销，尽力回到进来时的样子。
 *
 * 【包外保留（preserved）】超大且基本不变的技能（如 85MB 的 vendored ppt-master）
 * 不随包分发（否则每次更新都背着它下载 + 每份归档都存一份）。换版后把这些技能从
 * 刚归档的旧目录【平移】进新现用目录 —— 同盘 rename，零拷贝。
 *   · 安装：保留名单来自包内 pack.json 的 preserved（包没带的技能默认视为"被删除"，
 *     所以发布方要显式声明"这几个是故意不带、客户端自留的"）。
 *   · 回退（carryAll）：凡目标版本里没有、现用里有的技能一律平移过去 ——
 *     归档从不含 preserved 技能，不这么做回退一次 ppt-master 就没了。
 *     代价是"回退撤不掉已删除的技能"，无害（授权闸照常管它）。
 */
function swapIn(newDir, newVersion, { preserved = [], carryAll = false } = {}) {
  const curName = state().current || FACTORY
  const archive = path.join(STORE(), curName)
  rmrf(archive)                       // 同名残留（此前失败的半次归档）清掉再用
  fs.mkdirSync(archive, { recursive: true })
  const undo = []
  const mv = (from, to) => { fs.renameSync(from, to); undo.push(() => fs.renameSync(to, from)) }
  try {
    mv(SKILLS(), path.join(archive, "skills"))
    if (fs.existsSync(AGENTS())) mv(AGENTS(), path.join(archive, "AGENTS.md"))
    mv(path.join(newDir, "skills"), SKILLS())
    if (fs.existsSync(path.join(newDir, "AGENTS.md"))) {
      mv(path.join(newDir, "AGENTS.md"), AGENTS())
    } else if (fs.existsSync(path.join(archive, "AGENTS.md"))) {
      // 新包没带路由表：把旧的拷回来（不是挪——归档里也要留，回退时才配套）
      fs.copyFileSync(path.join(archive, "AGENTS.md"), AGENTS())
    }
    // 包外保留的技能：从刚归档的旧现用里平移过来
    let carry = preserved
    if (carryAll) {
      try { carry = fs.readdirSync(path.join(archive, "skills")) } catch { carry = [] }
    }
    for (const name of carry) {
      const from = path.join(archive, "skills", String(name))
      const to = path.join(SKILLS(), String(name))
      if (fs.existsSync(from) && !fs.existsSync(to)) mv(from, to)
    }
  } catch (e) {
    for (const u of undo.reverse()) { try { u() } catch {} }
    rmrf(archive)
    throw new Error(`换版失败（已撤销，现用技能未动）：${e.message}。多半是有文件正被占用——请稍后重试`)
  }
  const s = state()
  s.history = [{ version: curName, at: Date.now() }, ...s.history.filter((h) => h.version !== curName && h.version !== newVersion)]
  s.current = newVersion === FACTORY ? "" : newVersion
  saveState(s)
  prune()
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

/**
 * 安装一个已下载的技能包。buf = zip 内容；sha256 = 服务端声明的摘要（必须先核）。
 * 解压到暂存目录成型后才动现用目录。
 */
export function installBuffer(buf, { version, sha256 }) {
  if (!/^\d+(\.\d+)*$/.test(String(version))) throw new Error(`版本号不合法：${version}`)
  const got = crypto.createHash("sha256").update(buf).digest("hex")
  if (sha256 && got !== String(sha256).toLowerCase())
    throw new Error("下载的技能包校验失败（sha256 不符）——传输损坏或内容被改动，已放弃安装")
  const entries = unzip(buf)
  // 服务端发布时校验过布局，这里再核最低限：得真有技能，别把一个空包换进去
  if (!entries.some((e) => /^skills\/[^/]+\/SKILL\.md$/.test(e.name)))
    throw new Error("包里没有任何技能（skills/<名>/SKILL.md），已放弃安装")
  // 包外保留名单（见 swapIn 注释）：打包脚本把故意不带的超大技能写在 pack.json.preserved
  let preserved = []
  const pj = entries.find((e) => e.name === "pack.json")
  if (pj) { try { const p = JSON.parse(pj.data.toString("utf8").replace(/^﻿/, "")); if (Array.isArray(p.preserved)) preserved = p.preserved.map(String) } catch {} }
  rmrf(STAGING())
  for (const e of entries) {
    if (e.name === "pack.json") continue
    if (e.name !== "AGENTS.md" && !e.name.startsWith("skills/")) continue   // 未知条目不落盘
    const dst = path.join(STAGING(), e.name)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, e.data)
  }
  try { swapIn(STAGING(), version, { preserved }) } finally { rmrf(STAGING()) }
}

/** 回退到本机留存的某个版本（含 "factory" = 出厂版）。 */
export function rollback(version) {
  const v = String(version)
  const cur = state().current || FACTORY
  // 先判"就是当前版"再判"留存在不在"：当前版的目录本来就不在归档里（转正时被消耗掉了），
  // 顺序反了会把"你已经在用它了"误报成"本机没有留存"。
  if (v === cur) throw new Error(`当前用的就是 ${v === FACTORY ? "出厂版" : v}`)
  const src = path.join(STORE(), v)
  if (!fs.existsSync(path.join(src, "skills"))) throw new Error(`本机没有留存版本 ${v}，无法回退`)
  // 归档目录会在 swapIn 里被"现用"顶掉名字吗？不会：src 名与 cur 名不同（上面刚判过）。
  swapIn(src, v, { carryAll: true })
  rmrf(src)   // skills/AGENTS.md 已被挪走，清掉空壳；该版本现在就是"现用"，不再算归档
}
