// 分享导出：把一次会话渲染成【单个自包含 HTML 文件】。
//
// 三条约束决定了这个文件的写法，改之前先看懂：
//   ① 分享件要能双击打开、脱离本项目与网络存在 —— 所以样式内联、不引任何外部资源，
//      折叠靠原生 <details>【不写一行 JS】。没有脚本 = 会话正文里再离谱的内容也变不成可执行代码。
//   ② 产出文件一概不进分享（用户明确要求）—— 这里连「文件」这个概念都不接：
//      renderShareHtml 的入参里没有任何文件字段，想塞也塞不进来。
//   ③ 会话正文里遍地是绝对路径（agent 就是拿绝对路径跑脚本的）与偶发的 key，
//      分享出去就是泄露 —— scrubShare 在入库前统一洗一遍，见其注释。

/** HTML 转义。分享件没有脚本，但正文照样会被当 HTML 解析，所有文本必须先过这里。 */
export const escHtml = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const REDACT = "「已隐去」"
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// 路径前缀匹配：同一个根在会话里有 `D:\a\b` 与 `D:/a/b` 两种写法（agent 给 bash 用正斜杠、
// 给 Windows 工具用反斜杠），所以分隔符要两种都认；Windows 盘符大小写也不稳，故 i 标志。
const pathRe = (root, tail) => new RegExp(reEsc(root).replace(/\\\\|\//g, "[\\\\/]") + tail, "gi")

/**
 * 分享前的脱敏。**只对分享件做**，不影响界面与历史接口。
 *
 * 洗掉三类东西：
 *   - 工作区/家目录绝对路径 → 相对路径。分享件会流到项目外，`D:\projects\...\outputs\ws_xxx`
 *     既暴露本机结构也暴露会话 id；而路径的【相对部分】（outputs/table1.csv）恰恰是读者理解
 *     「它在做什么」所必需的，所以是剥前缀而不是整条抹掉。
 *   - 回环/内网地址（网关、opencode 端口）—— 对外没有意义，只会暴露部署形态。
 *   - key 形态的串。这条是**兜底不是保证**：真正的 key 从来不在对话里，
 *     但用户手抖把 key 粘进提问、或报错回显里带出来，都发生过。
 */
export function scrubShare(text, opts = {}) {
  let s = String(text == null ? "" : text)
  const roots = [opts.root, opts.home].filter(Boolean)
  for (const r of roots) {
    const rel = r === opts.home ? "~/" : ""
    s = s.replace(pathRe(r, "[\\\\/]"), rel)      // 根 + 分隔符 → 剥成相对路径
    s = s.replace(pathRe(r, "(?![\\w])"), REDACT)  // 光秃秃一个根（后面不是单词字符）→ 整个抹掉
  }
  s = s.replace(/\bhttps?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?/gi, REDACT)
  s = s.replace(/\b(?:sk|pk|ak)-[A-Za-z0-9_-]{16,}/g, REDACT)
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer " + REDACT)
  s = s.replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"'&,;]{8,}\3/gi,
    (_m, k, sep) => k + sep + REDACT)
  return s
}

// ---- 极简 markdown → HTML ----
// 为什么不复用前端那份：前端那份依赖 DOM 与代码高亮增强，且分享件不许带脚本。
// 这里只覆盖助手回答实际会用到的语法子集，遇到不认识的写法就原样当正文——
// 宁可少渲染，也不要在分享件里生成半截标签。
const inline = (s) => s
  .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer noopener">$1</a>')
  .replace(/`([^`\n]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")

const cells = (line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim())

export function mdToHtml(src) {
  const lines = escHtml(src).split(/\r?\n/)
  const out = []
  let para = []
  const flushPara = () => { if (para.length) { out.push("<p>" + inline(para.join("<br>")) + "</p>"); para = [] } }
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (/^\s*```/.test(ln)) {                       // 围栏代码块：内部一律原样，不做任何行内解析
      flushPara()
      const buf = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) buf.push(lines[i])
      out.push("<pre><code>" + buf.join("\n") + "</code></pre>")
      continue
    }
    if (!ln.trim()) { flushPara(); continue }
    const h = ln.match(/^(#{1,6})\s+(.*)$/)
    if (h) { flushPara(); const n = h[1].length; out.push(`<h${n}>` + inline(h[2].trim()) + `</h${n}>`); continue }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(ln)) { flushPara(); out.push("<hr>"); continue }
    // 表格：本行像表格行、且下一行是分隔行，才当表格 —— 只看本行会把正文里的竖线误判成表格
    if (/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flushPara()
      const head = cells(ln)
      const rows = []
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]))
      i--
      // 数字列右对齐：临床结果表里左对齐的数字几乎没法竖着比大小。整列都是数字才算，
      // 混了「参照」「N/A」这类词就保持左对齐（与界面 renderMarkdown 同口径）。
      const isNum = (v) => /^[-+]?[\d.,%]+(\s*[-–~]\s*[-+]?[\d.,%]+)?$/.test(String(v || "").trim())
      const numCol = head.map((_, x) => rows.length > 0 && rows.every((r) => {
        const v = String(r[x] ?? "").trim()
        return v === "" || isNum(v)
      }))
      const cell = (tag, v, x) => "<" + tag + (numCol[x] ? ' class="num"' : "") + ">" + inline(v) + "</" + tag + ">"
      out.push('<div class="tblw"><table><thead><tr>' + head.map((c, x) => cell("th", c, x)).join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c, x) => cell("td", c, x)).join("") + "</tr>").join("") + "</tbody></table></div>")
      continue
    }
    if (/^\s*&gt;\s?/.test(ln)) {                    // 引用（> 已被转义成 &gt;）
      flushPara()
      const buf = []
      for (; i < lines.length && /^\s*&gt;\s?/.test(lines[i]); i++) buf.push(lines[i].replace(/^\s*&gt;\s?/, ""))
      i--
      out.push("<blockquote>" + inline(buf.join("<br>")) + "</blockquote>")
      continue
    }
    const li = ln.match(/^\s*(?:[-*+]|\d+[.)])\s+/)
    if (li) {
      flushPara()
      const ordered = /\d/.test(li[0])
      const items = []
      for (; i < lines.length; i++) {
        const m = lines[i].match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/)
        if (!m) break
        items.push(m[1])
      }
      i--
      const tag = ordered ? "ol" : "ul"
      out.push(`<${tag}>` + items.map((t) => "<li>" + inline(t) + "</li>").join("") + `</${tag}>`)
      continue
    }
    para.push(ln)
  }
  flushPara()
  return out.join("\n")
}

const STI = { pending: "○", running: "○", completed: "✓", error: "✕" }

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c2430;--dim:#6b7686;--line:#e3e7ec;--ask:#eef3fb;--accent:#2f6bd6;--code:#f3f5f8}
@media (prefers-color-scheme:dark){:root{--bg:#14181d;--card:#1b2027;--fg:#dfe5ec;--dim:#98a3b2;--line:#2a323c;--ask:#1f2a38;--accent:#7aa7f0;--code:#232a33}}
*{box-sizing:border-box}
body{margin:0;padding:28px 16px 64px;background:var(--bg);color:var(--fg);
  font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:860px;margin:0 auto}
.doc-head{margin-bottom:22px}
.doc-head h1{margin:0 0 6px;font-size:22px;line-height:1.4}
.doc-meta{color:var(--dim);font-size:13px}
.nofiles{margin:14px 0 0;padding:9px 12px;border:1px dashed var(--line);border-radius:8px;
  color:var(--dim);font-size:13px;background:var(--card)}
.flow{margin:18px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.flow h2{margin:0 0 8px;font-size:14px;letter-spacing:.04em;color:var(--dim);font-weight:600}
.flowwarn{margin:0 0 8px;font-size:13px;color:#b03a34}
.flowlist{margin:0;padding:0;list-style:none;font-size:13px}
.flowlist li{padding:3px 0;color:var(--dim)}
.flowlist li b{display:inline-block;width:1.2em;font-weight:700}
.flowlist li.ok{color:#1f7a52}
.flowlist li.bad{color:#b03a34}
.flowlist li.warn{color:#8a5a12}
.flowlist .sy{color:var(--dim);font-size:12px;margin-left:6px}
.flowlist .gt{font-size:11px;border:1px solid var(--line);border-radius:3px;padding:0 3px;color:var(--dim)}
.turn{margin:22px 0;padding-top:20px;border-top:1px solid var(--line)}
.turn:first-of-type{border-top:0;padding-top:0}
.who{font-size:12px;letter-spacing:.06em;color:var(--dim);margin-bottom:6px}
.ask{background:var(--ask);border-radius:10px;padding:12px 14px;margin-bottom:14px}
.ask .body{white-space:pre-wrap;word-break:break-word}
.reply{padding-left:2px}
.skills{margin:0 0 10px;display:flex;flex-wrap:wrap;gap:6px}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--line);
  background:var(--card);color:var(--accent);font-size:12px}
details{margin:0 0 10px;background:var(--card);border:1px solid var(--line);border-radius:9px}
summary{cursor:pointer;padding:8px 12px;font-size:13px;color:var(--dim);user-select:none}
summary::marker{color:var(--dim)}
details>div,details>ol{margin:0;padding:2px 14px 12px}
.think .body{white-space:pre-wrap;word-break:break-word;color:var(--dim);font-size:14px}
.tools ol{padding-left:32px}
.tools li{font-size:13px;color:var(--dim);word-break:break-all;margin:2px 0}
.tools .st{display:inline-block;width:1.2em;color:var(--accent)}
.tools .st.err{color:#c0392b}
.answer{word-break:break-word}
.answer>:first-child{margin-top:0}
.answer h1,.answer h2,.answer h3,.answer h4{line-height:1.4;margin:1.2em 0 .5em}
.answer h1{font-size:20px}.answer h2{font-size:18px}.answer h3{font-size:16px}.answer h4{font-size:15px}
.answer p{margin:.6em 0}
.answer ul,.answer ol{margin:.6em 0;padding-left:26px}
.answer blockquote{margin:.6em 0;padding:2px 12px;border-left:3px solid var(--line);color:var(--dim)}
/* 三线表，与界面口径一致：只有顶线/表头下线/底线，无竖线。宽表由外层 .tblw 滚动接住，
   表格本身若 display:block 会丢掉列宽自适应（老写法的毛病）。 */
.answer .tblw{max-width:100%;overflow-x:auto;margin:.8em 0}
.answer table{border-collapse:collapse;width:max-content;min-width:100%;font-size:14px;background:var(--card)}
.answer th{padding:9px 14px;text-align:left;font-weight:600;color:var(--fg);background:var(--code);white-space:nowrap;
  border:0;border-top:1.6px solid var(--dim);border-bottom:1.2px solid var(--dim)}
.answer td{padding:8px 14px;text-align:left;vertical-align:top;max-width:46ch;border:0;border-bottom:1px solid var(--line)}
.answer tbody tr:last-child td{border-bottom:1.6px solid var(--dim)}
.answer th.num,.answer td.num{text-align:right;font-variant-numeric:tabular-nums}
.answer th{background:var(--code)}
code{background:var(--code);border-radius:4px;padding:1px 5px;font-size:.9em;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
pre{background:var(--code);border-radius:8px;padding:11px 13px;overflow-x:auto}
pre code{background:none;padding:0}
a{color:var(--accent)}
.note{color:#c0392b;font-size:13px;margin:6px 0}
footer{margin-top:34px;padding-top:14px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
`

/**
 * 渲染分享件。turns 由调用方（server.mjs 的 shareTurns）从会话消息里提取好，
 * 结构：{ ask, answer, reasoning, tools:[{tool,title,status}], skills:[], error }。
 *
 * 思考与工具调用的 <details> **一律不带 open**：用户要的是「保留过程但默认折叠」。
 * 谁要是顺手加了 open，分享件一打开就是几屏推理，正文反而找不到。
 */
/** 流程状态块：把步骤链与闸的结论一并存进导出件。
 *
 * ★ 为什么必须有：导出件此前【完全没有流程与闸的概念】—— 一份"闸没过、用户点了「仍要出件」
 *   才产出"的稿子导出去，看的人看不出闸没过。放行警告是 notice（不落盘）、拦截解释在
 *   _lasterror.json（下一轮就被清），被中止那轮在导出件里只剩一个 `⚠ aborted`。
 *   收件人（导师 / 合作者 / 期刊编辑）拿到的是一份看起来一切正常的记录。
 * ★ 这不违反"产出文件一概不进分享"：它是**状态**，不是文件内容。
 */
function flowBlock(flow) {
  if (!flow || !Array.isArray(flow.steps) || !flow.steps.length) return ""
  const dn = new Set(flow.done || []), fl = new Set(flow.failed || [])
  const im = new Set(flow.implied || []), sl = new Set(flow.stale || [])
  const rows = flow.steps.map((s, i) => {
    const mark = fl.has(s.id) ? "×" : sl.has(s.id) ? "⟳" : im.has(s.id) ? "·" : dn.has(s.id) ? "✓" : "○"
    const say = fl.has(s.id) ? "未通过" : sl.has(s.id) ? "已过期，未重做" : im.has(s.id) ? "无产物"
      : dn.has(s.id) ? "已完成" : "未进行"
    const cls = fl.has(s.id) ? "bad" : sl.has(s.id) || im.has(s.id) ? "warn" : dn.has(s.id) ? "ok" : ""
    return `<li class="${cls}"><b>${mark}</b> ${i + 1}. ${escHtml(s.name || s.id)}`
      + (s.gate ? ' <span class="gt">把关</span>' : "") + ` <span class="sy">${say}</span></li>`
  }).join("")
  const warn = fl.size
    ? `<p class="flowwarn">⚠ 有 ${fl.size} 道质量闸判定未通过${flow.bypass ? "，且本会话已被手动放行——下面的送审件是在闸未过的情况下产出的" : ""}。</p>`
    : flow.bypass ? '<p class="flowwarn">⚠ 本会话手动放行过质量闸的出件拦截。</p>' : ""
  return `<section class="flow"><h2>流程状态</h2>${warn}<ol class="flowlist">${rows}</ol></section>`
}
export function renderShareHtml({ title, turns, exportedAt, flow } = {}) {
  const t = escHtml(title || "会话记录")
  const when = exportedAt ? new Date(exportedAt) : new Date()
  const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ` +
    `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
  const list = Array.isArray(turns) ? turns : []
  const body = list.map((tn) => {
    const parts = []
    if (tn.ask) parts.push(`<div class="ask"><div class="who">提问</div><div class="body">${escHtml(tn.ask)}</div></div>`)
    const rep = []
    if (tn.skills?.length)
      rep.push(`<div class="skills">${tn.skills.map((s) => `<span class="pill">${escHtml(s)}</span>`).join("")}</div>`)
    if (tn.tools?.length)
      rep.push(`<details class="tools"><summary>工具调用（${tn.tools.length}）</summary><ol>` +
        tn.tools.map((x) => {
          const st = STI[x.status] || "•"
          const lbl = x.title ? `${x.tool} · ${x.title}` : x.tool
          return `<li><span class="st${x.status === "error" ? " err" : ""}">${escHtml(st)}</span>${escHtml(lbl)}</li>`
        }).join("") + "</ol></details>")
    if (tn.reasoning)
      rep.push(`<details class="think"><summary>思考过程</summary><div class="body">${escHtml(tn.reasoning)}</div></details>`)
    if (tn.answer) rep.push(`<div class="answer">${mdToHtml(tn.answer)}</div>`)
    if (tn.error) rep.push(`<div class="note">⚠ ${escHtml(tn.error)}</div>`)
    if (!rep.length) rep.push(`<div class="note">（本轮没有留下回复）</div>`)
    parts.push(`<div class="reply"><div class="who">回答</div>${rep.join("\n")}</div>`)
    return `<section class="turn">${parts.join("\n")}</section>`
  }).join("\n")
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="doc-head">
<h1>${t}</h1>
<div class="doc-meta">导出于 ${stamp} · 共 ${list.length} 轮对话</div>
<p class="nofiles">本次会话生成的文件（数据表、图表、文稿等）未包含在本分享中；此处只保留对话、思考与工具调用过程。</p>
</header>
${flowBlock(flow)}
${body}
<footer>本文件为会话过程的只读存档，双击即可打开，不依赖网络与任何服务。</footer>
</main>
</body>
</html>
`
}
