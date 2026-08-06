// 分享导出：把一次会话渲染成单个自包含 HTML。
//
// 覆盖的是「改坏了不会有人发现」的几处 —— 全都属于【导出看着成功、内容却错了】那一类：
//   ① reasoning / tool part 必须真的进导出。这是整个功能最容易做错的地方：/api/history 只留
//      text part，谁要是图省事改成「复用 history 的提取」或「前端序列化 DOM」，导出的分享件对刚聊完
//      的会话看着完全正常，对回看过的会话则思考与工具全空，界面上一点异常都看不出来。
//   ② 产出文件一个都不许进去（用户明确要求）：文件名可以作为工具调用记录出现，但文件内容
//      （tool 的 state.output）绝不能带出去 —— 那里既是产出又最容易夹带患者数据。
//   ③ <details> 不带 open：需求就是「保留过程但默认折叠」，加了 open 一打开就是几屏推理。
//   ④ 注入的前言/任务卡与无人值守哨兵要剥干净，否则用户「说」了一大段没说过的话、
//      或者分享件末尾挂着一个 [FINAL]。
//   ⑤ 绝对路径 / key / 内网地址不外泄 —— 分享件是要发给别人的。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { scrubShare, mdToHtml, escHtml, renderShareHtml } from "../share-export.mjs"

// server.mjs 一 import 就起服务，所以照 workflow.test.mjs 的老办法把它关进临时目录、端口给 0。
// 【必须真的 import server.mjs】而不是把提取逻辑复制一份到测试里：要测的恰恰是它有没有
// 从完整 part 列表里取到 reasoning/tool，以及有没有接上 stripPreamble / autoStripSentinel。
let SRV = null
async function server() {
  if (SRV) return SRV
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-"))
  const over = {
    MANAGE_OC: "0", PORT: "0", OC_URL: "http://127.0.0.1:1",
    HOME: dir, USERPROFILE: dir,
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    CLOUD_STATE_PATH: path.join(dir, "no-cloud.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
    ALLOWED_SKILLS: "", ALLOWED_MODULES: "", SUGGEST_ENABLED: "0",
  }
  const saved = {}
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  let mod
  try { mod = await import("../server.mjs?share=1") } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来")
  SRV = { mod, dir, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())) }
  return SRV
}
test.after(() => SRV?.close())

// 一份「长得像真的」的会话：结构照 opencode /session/:id/message 的实际返回摆
// （每个 LLM step 一条 assistant 消息，reasoning 与 tool 各是独立 part）。
const REPO = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
const fixture = () => ([
  { info: { role: "user", id: "m1" }, parts: [{ type: "text", text:
    "【本会话工作区，务必遵守】\n- 你的当前工作目录就是本会话的产物目录：" + REPO + "\\outputs\\ws_x\n\n帮我把这份队列数据做成 Table 1" }] },
  { info: { role: "assistant", id: "m2" }, parts: [
    { type: "step-start" },
    { type: "reasoning", text: "先看看数据长什么样，文件在 " + REPO + "/uploads/ws_x/cohort.csv" },
    { type: "tool", tool: "read", callID: "c1", state: { status: "completed", title: REPO + "\\uploads\\ws_x\\cohort.csv",
      output: "患者ID,姓名,住院号\n1,张三,00012345\n（整份原始数据都在工具输出里）" } },
    { type: "tool", tool: "skill", callID: "c2", state: { status: "completed", title: "Loaded skill: clinical-stats", input: { name: "clinical-stats" } } },
    { type: "step-finish" },
  ] },
  { info: { role: "assistant", id: "m3" }, parts: [
    { type: "reasoning", text: "算完了，写结论。" },
    { type: "tool", tool: "bash", callID: "c3", state: { status: "error", title: "python stats.py --out table1.csv" } },
    { type: "text", text: "## 结果\n\n已生成 **Table 1**，见 `table1.csv`。\n\n| 变量 | A 组 | B 组 |\n|---|---|---|\n| 年龄 | 61 | 63 |\n\n[FINAL]" },
  ] },
])

test("reasoning 与 tool part 确实进了导出（不能只留 text —— /api/history 那套口径会把过程整个丢掉）", async () => {
  const { mod } = await server()
  const turns = mod.shareTurns(fixture())
  assert.equal(turns.length, 1, "一条 user + 其后所有 assistant = 一轮")
  const t = turns[0]
  assert.match(t.reasoning, /先看看数据长什么样/, "第一条 reasoning 丢了")
  assert.match(t.reasoning, /算完了，写结论/, "第二条 assistant 消息的 reasoning 丢了（只取首条消息是典型写法错误）")
  assert.deepEqual(t.tools.map((x) => x.tool), ["read", "bash"], "工具调用要按顺序全收，技能不混进来")
  assert.equal(t.tools[1].status, "error", "工具状态要带上，否则读者看不出哪一步失败了")
  assert.deepEqual(t.skills, ["clinical-stats"], "技能徽章取 state.input.name，与直播口径一致")
  assert.match(t.answer, /已生成/)

  const html = mod.shareHtmlFromMessages(fixture(), { title: "Table 1 分析" })
  assert.match(html, /先看看数据长什么样/, "思考没进 HTML")
  assert.match(html, /clinical-stats/, "技能徽章没进 HTML")
  assert.match(html, /python stats\.py/, "工具调用没进 HTML")
})

test("产出文件不进分享：工具输出（=文件内容）一个字节都不带出去", async () => {
  const { mod } = await server()
  const html = mod.shareHtmlFromMessages(fixture(), { title: "x" })
  assert.ok(!html.includes("张三"), "工具 output 里的原始数据泄进了分享件")
  assert.ok(!html.includes("00012345"), "工具 output 里的住院号泄进了分享件")
  assert.ok(!/<img|data:image|base64,/.test(html), "分享件不该内嵌任何文件/图片")
  assert.match(html, /未包含在本分享中/, "要有一行明说文件没带上，否则读者以为附件丢了")
  // 文件【名】允许出现：它是工具调用记录的一部分，正是「过程」本身
  assert.match(html, /cohort\.csv/)
})

test("思考与工具默认折叠：<details> 一律不带 open", async () => {
  const { mod } = await server()
  const html = mod.shareHtmlFromMessages(fixture(), { title: "x" })
  const opens = html.match(/<details[^>]*\bopen\b[^>]*>/g)
  assert.equal(opens, null, "有 <details open>：一打开分享件就是几屏推理，正文反而找不到")
  assert.equal((html.match(/<details/g) || []).length, 2, "思考与工具各一个折叠块")
  // 折叠必须是原生的：分享件不带脚本，靠 JS 折叠等于在别人机器上什么都不会发生
  assert.ok(!/<script/i.test(html), "分享件里不该有任何脚本")
})

test("注入的前言/任务卡与无人值守哨兵都要剥掉", async () => {
  const { mod } = await server()
  const html = mod.shareHtmlFromMessages(fixture(), { title: "x" })
  assert.ok(!html.includes("本会话工作区"), "工作区前言泄进了分享件（用户会看到自己'说'了一段没说过的话）")
  assert.match(html, /帮我把这份队列数据做成 Table 1/, "剥前言不能把用户原话一起剥掉")
  assert.ok(!html.includes("[FINAL]"), "无人值守哨兵是网关与模型的协议标记，不该出现在分享件里")

  const card = [{ info: { role: "user", id: "u" }, parts: [{ type: "text", text:
    "【任务卡 · SCI 论文 / 立项确认】\n- 研究类型：回顾性队列\n【以上为用户通过表单勾选提交，请据此推进】\n\n另外帮我看下样本量" }] }]
  const t = mod.shareTurns(card)
  assert.equal(t[0].ask, "另外帮我看下样本量", "任务卡没剥干净")
})

test("绝对路径 / key / 内网地址不外泄（分享件是要发给别人的）", async () => {
  const { mod } = await server()
  const html = mod.shareHtmlFromMessages(fixture(), { title: "x" })
  assert.ok(!html.includes(REPO), "工作区绝对路径泄进了分享件：" + REPO)
  assert.match(html, /uploads[\\/]ws_x[\\/]cohort\.csv/, "剥路径前缀不能把相对路径一起剥掉——那是读者理解过程所必需的")

  // scrubShare 单独再验一遍（上面走的是真实 ROOT，这里挑几种典型形态）
  const s = scrubShare("跑 C:/w/r/x.py 和 C:\\w\\r\\y.py；网关 http://127.0.0.1:4098/session；key sk-abcdefghijklmnopqrstuvwx；OPENAI_API_KEY=zzzzzzzzzzzzzz",
    { root: "C:/w/r" })
  assert.match(s, /跑 x\.py 和 y\.py/, "正反斜杠两种写法都要认（agent 两种都在用）")
  assert.ok(!s.includes("127.0.0.1"), "内网地址没洗掉")
  assert.ok(!s.includes("sk-abcdefghijklmnopqrstuvwx"), "key 形态的串没洗掉")
  assert.ok(!s.includes("zzzzzzzzzzzzzz"), "KEY= 赋值没洗掉")
  // 别误伤：/app 这种短根不能把 /application 也吃掉
  assert.equal(scrubShare("见 /application/readme", { root: "/app" }), "见 /application/readme")
})

test("空会话不导出空文件：没内容时轮次为空，路由据此回 404", async () => {
  const { mod, base } = await server()
  assert.deepEqual(mod.shareTurns([]), [])
  assert.deepEqual(mod.shareTurns([{ info: { role: "user" }, parts: [{ type: "text", text: "【本会话工作区，务必遵守】\n- x\n\n" }] }]), [],
    "只剩被剥掉的前言 = 没内容")
  // 会话 id 不存在时 opencode 回 404 而 SDK 不抛，交过来的是个对象不是数组 —— 只写 `msgs || []`
  // 会当场 for...of TypeError（实测踩到，整个导出 500）。这条盯的就是它。
  assert.deepEqual(mod.shareTurns({ name: "NotFoundError", message: "Session not found" }), [])
  assert.deepEqual(mod.shareTurns(null), [])
  const r = await fetch(base + "/api/share/export")
  assert.equal(r.status, 400, "缺 sid 要明确报错")
  assert.ok(!/^application\/json/.test(r.headers.get("content-type") || ""), "这个 URL 是直接下载用的，错误要给人话不是 JSON")
})

test("HTML 是自包含的：不引任何外部资源，正文里的标签被转义（分享件无脚本，但仍会被当 HTML 解析）", async () => {
  const { mod } = await server()
  const evil = [{ info: { role: "user", id: "u" }, parts: [{ type: "text", text: "<img src=x onerror=alert(1)>" }] },
    { info: { role: "assistant", id: "a" }, parts: [{ type: "text", text: "回答里也有 <b>标签</b>" }] }]
  const html = mod.shareHtmlFromMessages(evil, { title: "<script>bad</script>" })
  assert.ok(!html.includes("<img src=x"), "用户正文里的标签没转义")
  assert.ok(!/<script/i.test(html), "标题里的标签没转义")
  assert.match(html, /&lt;b&gt;标签&lt;\/b&gt;/, "回答正文里的裸标签要按字面显示")
  // 外部资源：src=/href= 只允许出现在正文的 http 链接上，不许有 <link>/<script src>/@import
  assert.ok(!/<link\b|<script\b|@import|url\(https?:/i.test(html), "分享件引了外部资源，离线打开就残了")
})

test("markdown 子集渲染：标题/表格/代码块/列表要成形，不认识的写法原样留着", () => {
  const h = mdToHtml("# 标题\n\n- 甲\n- 乙\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode <not a tag>\n```\n\n结尾 **粗** 与 `码`")
  assert.match(h, /<h1>标题<\/h1>/)
  assert.match(h, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/)
  // 表格标记与界面口径一致：外面包 .tblw 滚动容器（宽表不许把整页顶出横向滚动条），
  // 整列都是数字的列带 num 类右对齐 —— 表头也要带，否则表头与它下面的数据各对各的。
  assert.match(h, /<div class="tblw"><table>.*<\/table><\/div>/s)
  assert.match(h, /<th class="num">a<\/th>.*<td class="num">2<\/td>/s)
  assert.match(h, /<pre><code>code &lt;not a tag&gt;<\/code><\/pre>/)
  assert.match(h, /<strong>粗<\/strong>/)
  assert.match(h, /<code>码<\/code>/)
  assert.equal(escHtml('<a "b" & c>'), "&lt;a &quot;b&quot; &amp; c&gt;")
})

test("零轮次也要出一份完整 HTML 骨架（渲染器本身不能因为空数组崩）", () => {
  const html = renderShareHtml({ title: "空", turns: [] })
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<meta charset="utf-8">/)
  assert.match(html, /共 0 轮对话/)
})
