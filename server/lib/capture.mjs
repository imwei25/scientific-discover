// 按用户抓取 LLM 请求（调试用）：管理员对某个用户打开开关后，该用户打到 /llm 网关的
// 每一条请求体（= opencode 发给模型的完整 messages，含系统提示、技能内容、工具结果）
// 原样落盘，用来核"模型这一轮到底吃到了什么"——比如验证 SKILL.md 内容有没有真进上下文。
//
// 【定位：临时诊断工具，不是审计】所以：
//   · 开关按用户名点名，默认全关；重启后沿用上次的名单（config.json）。
//   · 抓到的是用户会话的完整明文（可能含患者数据、稿件全文），文件只留在服务器
//     DATA_DIR/captures/ 下，只有管理台能列/下载；用完就该关掉并删目录。
//   · 全程 fail-open：抓包路径上任何 fs 报错都只记日志，绝不影响正常转发——诊断工具
//     把生产请求弄挂是本末倒置。
//
// 目录布局：
//   DATA_DIR/captures/config.json          { users: ["名字", ...] }
//   DATA_DIR/captures/<用户名>/<ts>-<序号>.json   单条请求（含元信息 + 完整 body）

import fs from "node:fs"
import path from "node:path"

const MAX_BODY = 25 * 1024 * 1024   // 单条上限：再大的多半是异常体，跳过并记一条占位
const KEEP_FILES = 300              // 每用户最多留这么多条，超了删最旧的（一轮长任务几十条，够回看几轮）
const MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000   // 抓包文件最多留 10 天（含会话明文，别让它无限期躺着）

// 用户名直接当目录名用，必须先掐死路径注入；档案里的用户名本就是受限字符集，这里再兜一层
const safeSeg = (s) => String(s || "").replace(/[^\w.@-]/g, "_").slice(0, 64)

export function initCapture(dataDir, log = () => {}) {
  const root = path.join(dataDir || ".", "captures")
  const cfgFile = path.join(root, "config.json")
  let users = new Set()
  try { users = new Set((JSON.parse(fs.readFileSync(cfgFile, "utf8")).users || []).map(String)) } catch {}
  let seq = 0

  const persist = () => {
    fs.mkdirSync(root, { recursive: true })
    const tmp = cfgFile + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify({ users: [...users] }, null, 2))
    fs.renameSync(tmp, cfgFile)
  }

  /** 该用户是否在抓 */
  const isOn = (username) => users.has(String(username || ""))

  /** 开/关某个用户的抓包。返回 {ok} 或 {ok:false, err} */
  const toggle = (username, on) => {
    const u = String(username || "").trim()
    if (!u) return { ok: false, err: "用户名为空" }
    try {
      if (on) users.add(u); else users.delete(u)
      persist()
      return { ok: true }
    } catch (e) { return { ok: false, err: "写入开关文件失败：" + e.message } }
  }

  /** 抓一条（fire-and-forget，绝不抛）。meta: {path, model, skill} */
  const record = (username, meta, rawBuf) => {
    if (!isOn(username)) return
    try {
      const dir = path.join(root, safeSeg(username))
      fs.mkdirSync(dir, { recursive: true })
      const entry = {
        ts: new Date().toISOString(),
        user: String(username),
        path: String(meta?.path || ""),
        model: String(meta?.model || ""),
        skill: String(meta?.skill || ""),
        bytes: rawBuf ? rawBuf.length : 0,
      }
      if (rawBuf && rawBuf.length > MAX_BODY) {
        entry.body = `（体积 ${rawBuf.length} 字节超过抓包上限 ${MAX_BODY}，未保存）`
      } else {
        // 能解析就存结构化 JSON（回看时能直接展开 messages），解不开存原文
        const text = rawBuf ? rawBuf.toString("utf8") : ""
        try { entry.body = JSON.parse(text) } catch { entry.body = text }
      }
      const file = path.join(dir, `${Date.now()}-${++seq}.json`)
      fs.writeFile(file, JSON.stringify(entry, null, 1), (e) => {
        if (e) return log(`[capture] ${username} 落盘失败：${e.message}`)
        prune(dir)
      })
    } catch (e) { log(`[capture] ${username} 抓包失败：${e.message}`) }
  }

  /** 清理某目录：先删过 10 天的，再按条数上限删最旧的（文件名以毫秒时间戳开头，字典序即时间序） */
  const prune = (dir, now = Date.now()) => {
    try {
      let names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
      // ① 过期：文件名前缀就是落盘毫秒时间戳，解出来判龄，省一次 stat
      const fresh = []
      for (const n of names) {
        const born = Number(String(n).split("-")[0])
        if (Number.isFinite(born) && now - born > MAX_AGE_MS) fs.rmSync(path.join(dir, n), { force: true })
        else fresh.push(n)
      }
      // ② 条数上限：删最旧的
      for (const n of fresh.slice(0, Math.max(0, fresh.length - KEEP_FILES)))
        fs.rmSync(path.join(dir, n), { force: true })
    } catch { /* 清理失败无所谓，下次再清 */ }
  }

  /** 扫所有用户目录清一遍过期/超量（启动时与看后台时各扫一次，不额外起定时器） */
  const sweep = (now = Date.now()) => {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true }))
        if (e.isDirectory()) prune(path.join(root, e.name), now)
    } catch { /* 还没建 captures 目录，无事可清 */ }
  }
  sweep()   // init 即清一次：进程长期不重启时，靠后台访问触发的 sweep 兜底

  /** 后台状态：开着的用户 + 已抓文件清单（新的在前）。顺带清一遍过期/超量。 */
  const status = () => {
    sweep()
    const files = []
    try {
      for (const u of fs.readdirSync(root, { withFileTypes: true })) {
        if (!u.isDirectory()) continue
        for (const n of fs.readdirSync(path.join(root, u.name))) {
          if (!n.endsWith(".json")) continue
          try {
            const st = fs.statSync(path.join(root, u.name, n))
            files.push({ user: u.name, name: `${u.name}/${n}`, size: st.size, ts: st.mtimeMs })
          } catch {}
        }
      }
    } catch {}
    files.sort((a, b) => b.ts - a.ts)
    return { users: [...users], files: files.slice(0, 500) }
  }

  /** 按 status() 里的 name 读一条抓包文件；越界/不存在返回 null */
  const readFile = (name) => {
    const parts = String(name || "").split("/")
    if (parts.length !== 2) return null
    const p = path.join(root, safeSeg(parts[0]), path.basename(parts[1]))
    if (!p.endsWith(".json")) return null
    try { return fs.readFileSync(p) } catch { return null }
  }

  /** 按 status() 里的 name 批量删几条（管理台折叠分组的"删除整组"）。返回 {ok, n:删掉几条} */
  const deleteFiles = (names) => {
    if (!Array.isArray(names) || !names.length) return { ok: false, err: "没给要删的文件" }
    let n = 0
    try {
      for (const name of names) {
        const parts = String(name || "").split("/")
        if (parts.length !== 2) continue                    // 与 readFile 同一套越界防线
        const p = path.join(root, safeSeg(parts[0]), path.basename(parts[1]))
        if (!p.endsWith(".json") || path.basename(p) === "config.json") continue
        if (!fs.existsSync(p)) continue
        fs.rmSync(p, { force: true }); n++
      }
      return { ok: true, n }
    } catch (e) { return { ok: false, err: e.message, n } }
  }

  /** 删掉某个用户已抓的全部文件（目录整个移除；开关状态不动） */
  const clearUser = (username) => {
    try { fs.rmSync(path.join(root, safeSeg(username)), { recursive: true, force: true }); return { ok: true } }
    catch (e) { return { ok: false, err: e.message } }
  }

  return { isOn, toggle, record, status, readFile, deleteFiles, clearUser }
}
