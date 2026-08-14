// 文献管理模块的服务端半边：台账（library.json）的读写、Excel 重出、按分类归档。
//
// 【为什么服务端也要有一份，而不是每次都让模型去做】"把第 3 篇挪到另一个类""按分类归档"
// 都是【确定性操作】：结果唯一、不需要判断。绕一圈交给模型意味着几十秒等待、一次额度消耗，
// 还可能它顺手把别的字段也改了。所以界面上这两个动作直接走本模块，不经过对话。
//
// 【与技能里 python 脚本的分工 / 必须保持的一致性】
//   · 初版 library.xlsx 由 .opencode/skills/literature-manage/scripts/build_workbook.py 生成；
//     用户改完分类后的重出走这里（xlsx-lite.mjs）。两者产出必须同构 —— 同表头、同列宽、
//     表头加粗填色、首行冻结。
//   · 归档在 archive_library.py 里也有一份（模型在对话里被要求做归档时走那条）。
//     **两份实现必须写出格式完全一致的 archive_log.json**，否则一边归档、另一边撤销就会失败。
//     改动任何一边都要同步另一边（与 minizip.mjs 两端同源同理）。
//
// 【安全边界】本模块只在【会话工作目录】里活动，路径一律经 safeUnder 校验：
// 台账里的 file 字段来自模型写的 json，属于不可信输入，绝不允许 ../ 逃出目录。

import fs from "node:fs"
import path from "node:path"
import { writeXlsx } from "./xlsx-lite.mjs"

export const LIB_JSON = "library.json"
export const LIB_XLSX = "library.xlsx"
export const ARCHIVE_LOG = "archive_log.json"
const UNCLASSIFIED = "未分类"
const DEFAULT_COLUMNS = ["文件名", "标题", "年份", "作者", "杂志", "核心观点"]
const DEFAULT_FIELDS = ["file", "title", "year", "authors", "journal", "point"]
// 与 build_workbook.py 的 WIDTHS 一一对应（含非文献文件用的「主要内容」等列）
const WIDTHS = { "文件名": 34, "标题": 42, "年份": 8, "作者": 22, "杂志": 22, "核心观点": 72,
  "主要内容": 72, "类型": 12, "日期": 12, "备注": 30 }

/** 目录内安全路径：拒绝绝对路径、盘符、.. 与空字节（台账里的 file 来自模型，按不可信输入处理） */
export function inDir(root, rel) {
  const s = String(rel || "").replace(/\\/g, "/")
  if (!s || s.includes("\0") || s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.split("/").includes("..")) return null
  const base = path.resolve(root)
  const p = path.resolve(base, s)
  return p === base || p.startsWith(base + path.sep) ? p : null
}

/** 分类名 → 子目录名（与 archive_library.py 的 safe_dir 同规则） */
export function safeDirName(raw) {
  const name = String(raw == null ? "" : raw).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim()
    .replace(/[. ]+$/, "").trim()
  return (name || UNCLASSIFIED).slice(0, 80)
}

export function loadLibrary(dir) {
  const p = path.join(dir, LIB_JSON)
  if (!fs.existsSync(p)) return null
  const lib = JSON.parse(fs.readFileSync(p, "utf8"))
  if (!lib || !Array.isArray(lib.records)) throw new Error(`${LIB_JSON} 里没有 records 数组`)
  return lib
}

export function saveLibrary(dir, lib) {
  fs.writeFileSync(path.join(dir, LIB_JSON), JSON.stringify(lib, null, 2), "utf8")
}

/** 台账里出现过的分类，按 categories 指定的顺序优先，其余按首次出现顺序补在后面 */
export function categoriesOf(lib) {
  const seen = []
  for (const r of lib.records) {
    const c = String(r.category || "").trim() || UNCLASSIFIED
    if (!seen.includes(c)) seen.push(c)
  }
  const want = (lib.categories || []).filter((c) => seen.includes(c))
  return want.concat(seen.filter((c) => !want.includes(c)))
}

/** 按当前 library.json 重出 library.xlsx（与 build_workbook.py 同构） */
export function rebuildWorkbook(dir, lib) {
  const columns = lib.columns?.length ? lib.columns : DEFAULT_COLUMNS
  const fields = lib.fields?.length ? lib.fields : DEFAULT_FIELDS
  if (columns.length !== fields.length) throw new Error("library.json 的 columns 与 fields 长度对不上")
  const classified = lib.classified !== false
  const groups = new Map()
  for (const r of lib.records) {
    const cat = classified ? (String(r.category || "").trim() || UNCLASSIFIED) : "全部文件"
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat).push(r)
  }
  let order = [...groups.keys()]
  if (classified && lib.categories?.length) {
    const want = lib.categories.filter((c) => groups.has(c))
    order = want.concat(order.filter((c) => !want.includes(c)))
  }
  const widths = columns.map((c) => WIDTHS[c] || 20)
  const sheets = order.map((cat) => ({
    name: cat, widths,
    rows: [columns, ...groups.get(cat).map((r) => fields.map((k) => String(r[k] == null ? "" : r[k])))],
  }))
  fs.writeFileSync(path.join(dir, LIB_XLSX), writeXlsx(sheets))
  return { sheets: order.length, rows: lib.records.length }
}

/**
 * 把某一篇改到别的分类。file 是台账里的 file 字段（唯一标识）。
 * 新类名可以是一个还不存在的类 —— 那就顺手建一个新 sheet（用户"新建分类"就是这么走的）。
 */
export function moveRecord(dir, file, toCategory) {
  const lib = loadLibrary(dir)
  if (!lib) throw new Error(`当前会话目录里没有 ${LIB_JSON}`)
  if (lib.classified === false) throw new Error("这份台账是「不分类」的，没有分类可改")
  const cat = String(toCategory || "").trim()
  if (!cat) throw new Error("没给新的分类名")
  if (cat.length > 60) throw new Error("分类名太长了（最多 60 字）")
  const rec = lib.records.find((r) => String(r.file) === String(file))
  if (!rec) throw new Error(`台账里没有这一篇：${file}`)
  const from = String(rec.category || "").trim() || UNCLASSIFIED
  rec.category = cat
  if (!Array.isArray(lib.categories)) lib.categories = []
  if (!lib.categories.includes(cat)) lib.categories.push(cat)
  // 某一类被搬空了就从 categories 里摘掉，免得 Excel 里留一个空 sheet
  lib.categories = lib.categories.filter((c) => lib.records.some((r) => (String(r.category || "").trim() || UNCLASSIFIED) === c))
  saveLibrary(dir, lib)
  const built = rebuildWorkbook(dir, lib)
  return { from, to: cat, ...built }
}

// ---- 按分类归档 ----

function planMoves(dir, lib) {
  const plan = [], missing = [], stay = []
  for (const r of lib.records) {
    const rel = String(r.file || "").replace(/\\/g, "/")
    if (!rel) continue
    const src = inDir(dir, rel)
    if (!src || !fs.existsSync(src)) { missing.push(rel); continue }
    const to = `${safeDirName(r.category || UNCLASSIFIED)}/${path.basename(rel)}`
    if (to === rel) { stay.push(rel); continue }
    plan.push({ from: rel, to })
  }
  return { plan, missing, stay }
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p
  const ext = path.extname(p), stem = p.slice(0, p.length - ext.length)
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem} (${i})${ext}`
    if (!fs.existsSync(cand)) return cand
  }
  throw new Error("同名文件太多，放不下了")
}

/** 预演：不动任何文件，只回"哪些会移到哪儿" */
export function archivePlan(dir) {
  const lib = loadLibrary(dir)
  if (!lib) throw new Error(`当前会话目录里没有 ${LIB_JSON}`)
  if (lib.classified === false) throw new Error("这份台账是「不分类」的，没有可归档的类别")
  const { plan, missing, stay } = planMoves(dir, lib)
  return { plan, missing, stay: stay.length, canUndo: fs.existsSync(path.join(dir, ARCHIVE_LOG)) }
}

/** 执行归档。copy=true 时复制（原件留在原地），否则移动并把台账里的 file 同步成新路径 */
export function archiveApply(dir, { copy = false } = {}) {
  const lib = loadLibrary(dir)
  if (!lib) throw new Error(`当前会话目录里没有 ${LIB_JSON}`)
  if (lib.classified === false) throw new Error("这份台账是「不分类」的，没有可归档的类别")
  const { plan, missing } = planMoves(dir, lib)
  const moves = [], failed = []
  for (const p of plan) {
    const src = inDir(dir, p.from), dstRaw = inDir(dir, p.to)
    if (!src || !dstRaw) { failed.push({ file: p.from, err: "路径不合法" }); continue }
    try {
      fs.mkdirSync(path.dirname(dstRaw), { recursive: true })
      const dst = uniquePath(dstRaw)
      if (copy) fs.copyFileSync(src, dst)
      else {
        // 跨盘/跨卷时 rename 会 EXDEV（会话目录与文献目录同盘时不会发生，但别赌）
        try { fs.renameSync(src, dst) } catch (e) {
          if (e.code !== "EXDEV") throw e
          fs.copyFileSync(src, dst); fs.unlinkSync(src)
        }
      }
      const relTo = path.relative(dir, dst).replace(/\\/g, "/")
      moves.push({ from: p.from, to: relTo })
      if (!copy) {
        const rec = lib.records.find((r) => String(r.file).replace(/\\/g, "/") === p.from)
        if (rec) rec.file = relTo
      }
    } catch (e) {
      failed.push({ file: p.from, err: String(e.code || e.message) })
    }
  }
  // ★ 移动之后必须把 Excel 也重出一遍：台账里的 file 已经变成「类名/文件名」，
  //   而 Excel 的「文件名」列还是旧路径 —— 两边一漂，预览里每一行都会判成"台账里没有这一篇"，
  //   改分类的下拉当场全部失效（实测踩到）。复制归档不改路径，自然也不用重出。
  if (!copy && moves.length) { saveLibrary(dir, lib); rebuildWorkbook(dir, lib) }
  // archive_log.json 的字段与 archive_library.py 逐字一致（撤销要两边通用）
  fs.writeFileSync(path.join(dir, ARCHIVE_LOG), JSON.stringify({
    at: new Date().toISOString().slice(0, 19).replace("T", " "),
    dir, mode: copy ? "copy" : "move", json: LIB_JSON, moves,
  }, null, 2), "utf8")
  const cats = [...new Set(moves.map((m) => path.posix.dirname(m.to)))].sort()
  return { moved: moves.length, cats, missing, failed, copy }
}

/** 撤销上一次归档（只能撤 move，copy 没动过原件） */
export function archiveUndo(dir) {
  const logp = path.join(dir, ARCHIVE_LOG)
  if (!fs.existsSync(logp)) throw new Error("没有归档记录，无从撤销")
  const log = JSON.parse(fs.readFileSync(logp, "utf8"))
  if (log.mode === "copy") throw new Error("上一次是「复制」归档，原文件没被动过——不需要撤销")
  const moves = log.moves || []
  let ok = 0, miss = 0
  for (const m of [...moves].reverse()) {
    const src = inDir(dir, m.to), dst = inDir(dir, m.from)
    if (!src || !dst || !fs.existsSync(src)) { miss++; continue }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    try { fs.renameSync(src, uniquePath(dst)) } catch (e) {
      if (e.code !== "EXDEV") throw e
      const d = uniquePath(dst); fs.copyFileSync(src, d); fs.unlinkSync(src)
    }
    ok++
  }
  for (const cat of new Set(moves.map((m) => path.posix.dirname(m.to)).filter((d) => d && d !== "."))) {
    const d = inDir(dir, cat)
    try { if (d && fs.existsSync(d) && !fs.readdirSync(d).length) fs.rmdirSync(d) } catch { /* 里面还有别的东西就留着 */ }
  }
  const lib = loadLibrary(dir)
  if (lib) {
    const back = new Map(moves.map((m) => [m.to, m.from]))
    for (const r of lib.records) if (back.has(String(r.file))) r.file = back.get(String(r.file))
    saveLibrary(dir, lib)
    rebuildWorkbook(dir, lib)          // 同 archiveApply：路径搬回去了，Excel 的文件名列也要跟着回来
  }
  fs.unlinkSync(logp)
  return { restored: ok, missing: miss }
}
