// 技能资产出流指纹闸（skill-guard）：防止技能文件内容【整段】流出网关。
//
// 威胁模型与边界（与 skills.pak 金库同一哲学：抬高低成本拷贝的门槛，不是对抗边界）：
//   · 防的是"让 agent 把 SKILL.md / 技能脚本原样（或轻度改动后）复述 / 存成文件给我"这类
//     低成本整段套取——聊天正文、思考流、产物下载、打包 zip、历史回显、分享导出都要过这道闸。
//   · 不防重度改写 / 翻译 / 逐条把方法论"问懂再自己写"——那是语义级提取，逐字指纹天然管不住
//     （管它要上嵌入比对 / LLM 裁判，2026-08 决策明确不做：不给正常科研问答增加成本与误伤）。
//   · 誤伤优先级：宁可放过、不可错杀。所有扫描失败一律放行（fail-open），阈值取"只有近乎
//     逐字的整段拷贝才可能命中"的量级——我们的技能内容本身就是统计/科研方法论，正常回答
//     与技能文档【话题必然相似】，任何低阈值都会把正经回答拦下。
//
// 算法：归一化 + 滚动哈希 + winnowing（MOSS 同族）。
//   归一化：NFKC → 小写 → 去全部空白与不可见字符。挡住"加空格 / 全角化 / 零宽字符打散"这类
//   低成本绕过（AWS 系统提示防泄露指南同款预处理）。
//   指纹库：技能文件归一化后每 K 字符一个滚动哈希，winnowing 每 W 窗口取最小值入库 ——
//   任何 ≥ K+W-1 归一化字符的共享片段必至少命中一枚指纹（winnowing 保证）。
//   判定：对被扫文本每个位置查库，命中位置聚簇（相邻命中间隔 ≤ GAP）；一个簇覆盖
//   ≥ SPAN 归一化字符且命中 ≥ MIN_HITS 枚才算泄露。单行引用（一条铁律 ~50 字）不会触发；
//   触发意味着连续几百字符与技能文件近乎逐字一致。
//
// 启用判据：技能目录存在且建库成功。目录缺失 / SKILL_GUARD=0 → 全程 no-op（scanText 恒 null），
// 源码检出跑单测、极端故障时行为与从前完全一致，零风险。

import fs from "node:fs"
import path from "node:path"
import { unzip } from "./minizip.mjs"

// ---- 可调参数（env 覆盖，便于线上不发版调阈值）----
const K = 40                                                        // 指纹粒度：归一化后 40 字符
const W = 8                                                         // winnowing 窗口
const GAP = 64                                                      // 簇内相邻命中最大间隔（归一化字符）
const SPAN = Number(process.env.SKILL_GUARD_SPAN || 240)            // 簇最小覆盖跨度（归一化字符）
const MIN_HITS = Number(process.env.SKILL_GUARD_HITS || 12)         // 簇最小命中枚数
const ENABLED = process.env.SKILL_GUARD !== "0"
const MAX_SCAN_BYTES = 20 * 1024 * 1024                             // 单文件扫描上限：更大的多半是数据/媒体
const MAX_DB_FILE = 512 * 1024                                      // 入库单文件上限：技能真 IP 都是小文本

// 不入库的技能目录：vendored 第三方库（非 IP、体积巨大，金库同款豁免名单）
const SKIP_SKILL_DIRS = new Set(["ppt-master", "node_modules", "__pycache__", ".git"])
// 入库的扩展名：技能 IP 全是文本（文档 + 脚本 + 参考资料）
const DB_EXTS = new Set([".md", ".py", ".r", ".js", ".mjs", ".sh", ".ps1", ".yml", ".yaml", ".json", ".txt", ".csv", ".tex", ".bib"])
// 下载/预览通道要扫的纯文本扩展名（其余二进制不碰；Office 文档单列，见 scanFileBuffer）
const TEXT_EXTS = new Set([".md", ".txt", ".csv", ".tsv", ".json", ".yml", ".yaml", ".py", ".r", ".js", ".mjs", ".ts",
  ".sh", ".ps1", ".tex", ".bib", ".html", ".htm", ".xml", ".svg", ".log", ".rst", ".ini", ".toml"])
const OFFICE_EXTS = new Set([".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"])

// ---- 归一化：NFKC + 小写 + 去空白/不可见字符，同时记录每个归一化字符的原文偏移 ----
// ASCII 与 CJK 基本区走快路径（NFKC 恒等），其余字符才调 normalize()——1MB 级文本毫秒级完成。
const isInvisible = (c) => (c >= 0x200b && c <= 0x200f) || c === 0xfeff || c === 0x00ad || c === 0x2060
  || (c >= 0x202a && c <= 0x202e) || c === 0x2028 || c === 0x2029 || (c >= 0xfe00 && c <= 0xfe0f)
function normalize(s) {
  const codes = []          // 归一化后的 UTF-16 码元序列
  const rawAt = []          // codes[i] 对应的原文字符偏移（截断定位用）
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 128) {                                     // ASCII 快路径
      if (c <= 32 || c === 127) continue               // 空白与控制符
      codes.push(c >= 65 && c <= 90 ? c + 32 : c)      // 小写化
      rawAt.push(i)
      continue
    }
    if (c >= 0x4e00 && c <= 0x9fff) { codes.push(c); rawAt.push(i); continue }   // CJK 快路径
    if (isInvisible(c)) continue
    const t = s[i].normalize("NFKC").toLowerCase()
    for (let j = 0; j < t.length; j++) {
      const tc = t.charCodeAt(j)
      if (tc <= 32 || tc === 127 || tc === 0x3000 || isInvisible(tc)) continue   // NFKC 后再过一遍空白
      codes.push(tc)
      rawAt.push(i)
    }
  }
  return { codes, rawAt }
}

// ---- 滚动哈希（多项式，mod 2^32）----
const BASE = 0x01000193
const POW = (() => { let p = 1; for (let i = 0; i < K - 1; i++) p = Math.imul(p, BASE); return p })()   // BASE^(K-1)
// 全部位置的 K-gram 哈希；长度不足 K 回空
function grams(codes) {
  const n = codes.length - K + 1
  if (n <= 0) return new Uint32Array(0)
  const out = new Uint32Array(n)
  let h = 0
  for (let i = 0; i < K; i++) h = (Math.imul(h, BASE) + codes[i]) | 0
  out[0] = h >>> 0
  for (let i = 1; i < n; i++) {
    h = (Math.imul((h - Math.imul(codes[i - 1], POW)) | 0, BASE) + codes[i + K - 1]) | 0
    out[i] = h >>> 0
  }
  return out
}

// ---- 指纹库 ----
let db = null   // { set: Set<number>, file: Map<number, number>, names: string[], files: number, fps: number }

function addFileToDb(content, relName, acc) {
  // SKILL.md 的 frontmatter（含 description）不入库：description 是半公开的（模块界面、
  // 技能列表都在展示），agent 回答"这个技能是干嘛的"时会正当地复述它——入库必造成误伤。
  if (/(^|[\\/])skill\.md$/i.test(relName)) content = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
  const { codes } = normalize(content)
  if (codes.length < K + W - 1) return
  const g = grams(codes)
  const fileIdx = acc.names.length
  acc.names.push(relName)
  // winnowing：每个 W 窗口取最小哈希；同一个最小值连续窗口只记一次（标准做法）
  let lastPick = -1
  for (let i = 0; i + W <= g.length; i++) {
    let m = i
    for (let j = i + 1; j < i + W; j++) if (g[j] <= g[m]) m = j
    if (m === lastPick) continue
    lastPick = m
    acc.set.add(g[m])
    if (!acc.file.has(g[m])) acc.file.set(g[m], fileIdx)
  }
}

/**
 * 建库（幂等，可反复调用 = 重建）。技能目录不存在 / 一个文件都没收进来 → 闸整体停用。
 * 【必须在金库 materializeSkills 之后调】打包版启动时技能先解密还原，这里才读得到明文。
 */
export function initSkillGuard(skillsDir) {
  db = null
  if (!ENABLED) return { enabled: false, reason: "SKILL_GUARD=0" }
  try {
    if (!skillsDir || !fs.existsSync(skillsDir)) return { enabled: false, reason: "技能目录不存在" }
    const acc = { set: new Set(), file: new Map(), names: [] }
    const walk = (dir, rel) => {
      for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
        if (it.isDirectory()) {
          if (SKIP_SKILL_DIRS.has(it.name)) continue
          walk(path.join(dir, it.name), rel ? `${rel}/${it.name}` : it.name)
        } else if (DB_EXTS.has(path.extname(it.name).toLowerCase())) {
          const p = path.join(dir, it.name)
          try {
            if (fs.statSync(p).size > MAX_DB_FILE) continue
            addFileToDb(fs.readFileSync(p, "utf8"), rel ? `${rel}/${it.name}` : it.name, acc)
          } catch { /* 单个文件读不了不拖累整库 */ }
        }
      }
    }
    walk(skillsDir, "")
    if (!acc.set.size) return { enabled: false, reason: "没有可入库的技能文件" }
    db = { set: acc.set, file: acc.file, names: acc.names, files: acc.names.length, fps: acc.set.size }
    fileVerdictCache.clear()   // 库换了，旧结论作废
    return { enabled: true, files: db.files, fps: db.fps }
  } catch (e) {
    return { enabled: false, reason: e?.message || String(e) }   // 建库失败 → 停用（fail-open），别拖垮启动
  }
}

export const guardEnabled = () => !!db

/**
 * 扫一段文本。无泄露 → null；命中 → { rawStart, file, hits, span }：
 * rawStart 是簇起点在【原文】里的偏移（截断点），file 是命中的技能文件（首枚指纹归属，仅供提示）。
 */
export function scanText(text) {
  if (!db || typeof text !== "string" || text.length < K) return null
  try {
    const { codes, rawAt } = normalize(text)
    if (codes.length < K) return null
    const g = grams(codes)
    // 聚簇：一边扫一边维护当前簇，避免先收集全部命中再二次遍历
    let cStart = -1, cLast = -1, cHits = 0, cFp = 0
    for (let i = 0; i < g.length; i++) {
      if (!db.set.has(g[i])) continue
      if (cStart < 0 || i - cLast > GAP) { cStart = i; cHits = 0; cFp = g[i] }   // 新簇
      cLast = i; cHits++
      if (cHits >= MIN_HITS && (cLast + K - cStart) >= SPAN) {
        return {
          rawStart: rawAt[cStart],
          file: db.names[db.file.get(cFp)] ?? db.names[db.file.get(g[i])] ?? "（未知）",
          hits: cHits, span: cLast + K - cStart,
        }
      }
    }
    return null
  } catch { return null }   // 扫描自身出错绝不拦人（fail-open）
}

// 聊天正文命中时接在截断点后的说明（前端按 markdown 渲染）
export const LEAK_NOTE = "\n\n---\n⚠️ **安全提示**：检测到后续内容包含内部技能文件的原文，已在此处截断。" +
  "技能文档与脚本属于产品内部资产，无法整段对外提供；想了解某个技能怎么用，直接问用法即可。"

/** 截断式净化：命中则截到簇起点并接说明，未命中原样返回。历史回显 / 分享导出用。 */
export function sanitizeText(text) {
  const r = scanText(text)
  return r ? text.slice(0, r.rawStart) + LEAK_NOTE : text
}

// ---- 文件通道（下载 / 预览 / 打包 zip）----

const stripXml = (s) => s.replace(/<[^>]*>/g, " ")

/**
 * 扫一个文件 Buffer（按扩展名决定怎么读）。命中 → { file }（命中的技能文件名）；否则 null。
 * Office 文档本质是 zip：解包后扫所有 xml 的去标签文本（docx 正文在 word/document.xml、
 * xlsx 文本在 xl/sharedStrings.xml、pptx 在 slides/*.xml——不逐个点名，全量 xml 都过一遍）。
 * zip 再套一层（depth 1）也扫，防"agent 把技能目录打个包放进产物"这条最顺手的绕道。
 */
export function scanFileBuffer(buf, name, depth = 0) {
  if (!db || !Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX_SCAN_BYTES) return null
  const ext = path.extname(name || "").toLowerCase()
  try {
    if (TEXT_EXTS.has(ext) || ext === "") return scanText(buf.toString("utf8"))
    if (OFFICE_EXTS.has(ext)) {
      const parts = []
      for (const e of unzip(buf, { maxTotal: 64 * 1024 * 1024 }))
        if (/\.xml$/i.test(e.name) && e.data.length < 8 * 1024 * 1024) parts.push(stripXml(e.data.toString("utf8")))
      return scanText(parts.join("\n"))
    }
    if (ext === ".zip" && depth < 1) {
      for (const e of unzip(buf, { maxTotal: 128 * 1024 * 1024 })) {
        const r = scanFileBuffer(e.data, e.name, depth + 1)
        if (r) return r
      }
      return null
    }
    return null   // 其余二进制（pdf/图片/音视频）不扫：提取成本与误伤都不划算，已知边界
  } catch { return null }   // 解包失败（损坏 zip 等）→ 放行
}

// 磁盘文件扫描结论缓存：同一产物会被 raw 预览反复拉（流式渲染整块重绘），别每帧都重扫
const fileVerdictCache = new Map()   // abs → { key: `${mtimeMs}-${size}`, hit }
const CACHE_MAX = 500

/**
 * 扫磁盘上的一个产物文件（下载 / 预览前调）。命中 → { file }；否则 null。
 * 全程 fail-open：stat / 读盘出错回 null，绝不让扫描故障挡住正常下载。
 */
export function scanOutputFile(absPath) {
  if (!db) return null
  try {
    const st = fs.statSync(absPath)
    if (!st.isFile() || st.size === 0 || st.size > MAX_SCAN_BYTES) return null
    const ext = path.extname(absPath).toLowerCase()
    if (!TEXT_EXTS.has(ext) && !OFFICE_EXTS.has(ext) && ext !== ".zip" && ext !== "") return null   // 不扫的类型连盘都不读
    const key = `${st.mtimeMs}-${st.size}`
    const c = fileVerdictCache.get(absPath)
    if (c && c.key === key) return c.hit
    const hit = scanFileBuffer(fs.readFileSync(absPath), absPath)
    if (fileVerdictCache.size >= CACHE_MAX) fileVerdictCache.delete(fileVerdictCache.keys().next().value)
    fileVerdictCache.set(absPath, { key, hit })
    return hit
  } catch { return null }
}

// 文件通道命中时给用户的说明（403 响应体 / zip 内替代说明共用）
export const LEAK_FILE_MSG = (name) =>
  `「${path.basename(name || "该文件")}」包含产品内部技能资产的原文，已被安全网关拦截。` +
  `技能文档与脚本不能作为产物导出；如需相关方法说明，请让助手用自己的话整理一份。`
