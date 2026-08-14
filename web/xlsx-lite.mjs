// 极简 xlsx 读写 —— 零外部依赖（复用 minizip.mjs 的 zip/unzip + 手写 XML）。
//
// 【为什么自己写】本网关的立身之本是"只有 Node 内置模块"（见 minizip.mjs 头注），
// 而这里要的东西非常窄：
//   · 读：把多 sheet 的 xlsx 摊成 {name, rows[][]} 给前端画预览表格（SheetJS 那种全功能库
//     为此拖进 1MB+ 的依赖，且大部分能力我们永远用不到）；
//   · 写：用户在预览里把某篇文献改到别的分类之后，就地把 library.xlsx 重出一遍。
//
// 【与 build_workbook.py（openpyxl）的关系】初版 Excel 由技能的 python 脚本生成，
// 用户改分类后的重出走这里。两边必须产出【同构】的文件：一类一个 sheet、同一套表头、
// 表头加粗填色、首行冻结、列宽一致、正文自动换行。改任何一边都要同步另一边。
//
// 支持范围（超出即忽略或明确报错，不静默给错数）：
//   · 读：sharedStrings / inlineStr / 数字 / 布尔 / 公式结果值；不解析样式、图表、合并单元格
//   · 写：inlineStr（不建 sharedStrings，省一整块索引逻辑）、三种单元格样式、冻结首行、列宽
//   · 不支持日期序列号还原（读到的是原始数字）——本模块的表格全是文本列，用不到

import { unzip, zip } from "./minizip.mjs"

// ---- XML 小工具 ----
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
export function xmlUnescape(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return e in ENT ? ENT[e] : m
  })
}
export function xmlEscape(s) {
  // 控制字符在 xlsx 里是非法的（Excel 会直接判定文件损坏），先剔掉再转义
  return String(s == null ? "" : s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}
/** 列引用 → 0 基下标："A"→0, "Z"→25, "AA"→26 */
export function colIndex(ref) {
  let n = 0
  for (const ch of String(ref).toUpperCase()) {
    const c = ch.charCodeAt(0)
    if (c < 65 || c > 90) break
    n = n * 26 + (c - 64)
  }
  return n - 1
}
/** 0 基下标 → 列引用 */
export function colName(i) {
  let n = i + 1, s = ""
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26 }
  return s
}

// ---- 读 ----

/** 取一个 XML 元素的全部文本（<t> 可能被 <r> 富文本切成好几段） */
function textOf(xml) {
  let out = ""
  for (const m of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) out += xmlUnescape(m[1])
  return out
}

function parseSharedStrings(xml) {
  if (!xml) return []
  const out = []
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) out.push(textOf(m[1]))
  return out
}

function parseSheet(xml, shared, { maxRows, maxCols, maxCell }) {
  const rows = []
  let truncated = false
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows) { truncated = true; break }
    // r="12" 是真实行号：中间的空行在 xml 里根本不存在，不补的话整表会往上错位
    const rn = Number((rm[1].match(/\br="(\d+)"/) || [])[1] || rows.length + 1)
    while (rows.length < rn - 1 && rows.length < maxRows) rows.push([])
    const cells = []
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || ""
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1]
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "n"
      let val = ""
      if (type === "inlineStr") val = textOf(body)
      else {
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1]
        if (v != null) {
          if (type === "s") val = shared[Number(v)] ?? ""
          else if (type === "b") val = v === "1" ? "TRUE" : "FALSE"
          else val = xmlUnescape(v)
        } else if (type === "str") val = textOf(body)
      }
      const at = ref ? colIndex(ref) : cells.length
      if (at >= maxCols) { truncated = true; continue }
      while (cells.length < at) cells.push("")
      cells[at] = val.length > maxCell ? val.slice(0, maxCell) + "…" : val
    }
    rows.push(cells)
  }
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop()   // 去掉尾部空行
  return { rows, truncated }
}

/**
 * 读一个 xlsx（Buffer）→ { sheets: [{ name, rows }], truncated }
 * rows 是二维字符串数组，第一行就是表头（不做任何"第一行是不是表头"的猜测）。
 */
export function readXlsx(buf, { maxSheets = 60, maxRows = 5000, maxCols = 60, maxCell = 4000 } = {}) {
  const entries = unzip(buf)
  const byName = new Map(entries.map((e) => [e.name, e.data]))
  const txt = (n) => { const d = byName.get(n); return d ? d.toString("utf8") : "" }
  const wb = txt("xl/workbook.xml")
  if (!wb) throw new Error("这不是一个有效的 xlsx（缺 xl/workbook.xml）")
  // rId → 目标路径
  const rels = new Map()
  for (const m of txt("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = (m[1].match(/\bId="([^"]+)"/) || [])[1]
    let t = (m[1].match(/\bTarget="([^"]+)"/) || [])[1] || ""
    if (!id || !t) continue
    t = t.replace(/^\//, "").replace(/^\.\.\//, "")
    rels.set(id, t.startsWith("xl/") ? t : "xl/" + t)
  }
  const shared = parseSharedStrings(txt("xl/sharedStrings.xml"))
  const sheets = []
  let truncated = false
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/>/g)) {
    if (sheets.length >= maxSheets) { truncated = true; break }
    const name = xmlUnescape((m[1].match(/\bname="([^"]*)"/) || [])[1] || `Sheet${sheets.length + 1}`)
    const rid = (m[1].match(/r:id="([^"]+)"/) || [])[1]
    const target = rels.get(rid)
    const xml = target ? txt(target) : ""
    if (!xml) { sheets.push({ name, rows: [], missing: true }); continue }
    const p = parseSheet(xml, shared, { maxRows, maxCols, maxCell })
    truncated = truncated || p.truncated
    sheets.push({ name, rows: p.rows })
  }
  return { sheets, truncated }
}

// ---- 写 ----

const CONTENT_TYPES = (n) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
  + `<Default Extension="xml" ContentType="application/xml"/>`
  + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
  + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
  + Array.from({ length: n }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
  + `</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
  + `</Relationships>`

// 三个样式：0=默认，1=表头（白字加粗 + 蓝底 + 居中垂直），2=正文（顶对齐 + 自动换行）
// 与 build_workbook.py 里 openpyxl 那套逐项对应，改一边要同步另一边。
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>`
  + `<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>`
  + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FF3B6FD4"/><bgColor indexed="64"/></patternFill></fill></fills>`
  + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="3">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`
  + `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

function sheetXml(rows, widths) {
  const cols = widths && widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : ""
  const body = rows.map((cells, r) => {
    const style = r === 0 ? 1 : 2
    const cs = cells.map((v, c) => {
      const s = v == null ? "" : String(v)
      if (!s) return `<c r="${colName(c)}${r + 1}" s="${style}"/>`
      // 全部按文本写（inlineStr）：年份"2021"当数字写会让 Excel 右对齐并给它加千分位的可能，
      // 而"原文未标注"这种同列混排的文本又必须是字符串——统一成文本，列的观感才一致。
      return `<c r="${colName(c)}${r + 1}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`
    }).join("")
    return `<row r="${r + 1}">${cs}</row>`
  }).join("")
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheetViews><sheetView workbookViewId="0">`
    + `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
    + `</sheetView></sheetViews>`
    + cols + `<sheetData>${body}</sheetData></worksheet>`
}

/** sheet 名消毒：Excel 的硬规矩（≤31 字符、不能含 []:*?/\、不能重名、不能为空） */
export function safeSheetName(raw, used) {
  let name = String(raw == null ? "" : raw).replace(/[[\]:*?/\\]/g, "_").trim().slice(0, 31) || "未分类"
  if (used.has(name.toLowerCase())) {
    for (let i = 2; i < 1000; i++) {
      const cand = `${name.slice(0, 28)}(${i})`
      if (!used.has(cand.toLowerCase())) { name = cand; break }
    }
  }
  used.add(name.toLowerCase())
  return name
}

/**
 * 写一个 xlsx：sheets = [{ name, rows: [[...]], widths?: [number] }] → Buffer
 * 第一行按表头样式渲染（与 build_workbook.py 一致）。
 */
export function writeXlsx(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error("至少要有一个 sheet")
  const used = new Set()
  const named = sheets.map((s) => ({ ...s, name: safeSheetName(s.name, used) }))
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${named.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    + `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `</Relationships>`
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES(named.length), "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(wb, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(STYLES, "utf8") },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(s.rows || [], s.widths), "utf8") })),
  ]
  return zip(entries)
}
