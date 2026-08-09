// 产出列表（含子目录）与「打包下载」。
//
// 覆盖的是"改坏了没人发现、而用户当场就丢文件"的几处：
//   ① 子目录里的产物必须【全部】列出来 —— 这正是本次改造的起因：原来只递归一层，更深的文件
//      在界面上一行都没有，只换来一句"让助手把它们移到一层目录就会出现"（用户读作"文件丢了"）。
//   ② 打包下载必须把【列表里看得见的每一份】都装进去，且保留相对路径（拍平会让 figures/fig1.png
//      和 pdfs/fig1.png 互相覆盖，用户解开只剩一个，还看不出少了）。
//   ③ 脱敏还原表 / .private / 网关簿子【绝不】进列表，也绝不进包 —— 打包若走另一套判据，
//      它立刻就是一条绕过脱敏的后门：用户点一下"打包下载"，病人真名就随包出去了。
//   ④ 没有产出、或超过上限时回的是【人话报错】而不是一个坏 zip（前端据此弹原文）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { unzip } from "../minizip.mjs"

// 照 share-export.test.mjs 的老办法：server.mjs 一 import 就起服务，把它关进临时 HOME、端口给 0。
let SRV = null
async function server() {
  if (SRV) return SRV
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outzip-"))
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
  try { mod = await import("../server.mjs?outzip=1") } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来")
  SRV = { mod, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())) }
  return SRV
}
test.after(() => SRV?.close())

// opencode 不可用 → sessionOut 回落到 <仓库根>/outputs/<sid>（见它的头注），测试就往那儿造文件。
const REPO = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
const w = (dir, rel, body) => {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}
/** 造一个像真会话那样的产物目录：顶层交付物 + 几层子目录 + 该被挡掉的几份 */
function makeSession(t, sid) {
  const dir = path.join(REPO, "outputs", sid)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  w(dir, "manuscript.docx", "成稿")
  w(dir, "table1.csv", "变量,A组,B组\n年龄,61,63\n")
  w(dir, "pdfs/smith2024.pdf", "%PDF-1.4 假的")
  w(dir, "figures/forest.png", "PNG 假的")
  w(dir, "figures/panel/fig1.png", "两层深的图")               // ← 改造前这一份在界面上不存在
  w(dir, "audit/2024/q3/report.md", "四层深的报告")
  // 下面几份都不该出现在列表里，更不该进包
  w(dir, "deid_crosswalk.csv", "姓名,住院号\n张三,00012345\n")   // PHI 对照表
  w(dir, ".private/mapping.csv", "姓名,假名\n李四,P002\n")       // 点号目录
  w(dir, "_workflow.json", "{}")                                 // 网关自己的簿子
  return dir
}

test("子目录里的产物【全部】列出来（不再只列一层），且没有一份被悄悄丢掉", async (t) => {
  const { base } = await server()
  const sid = "ws_zip_list_test"
  makeSession(t, sid)
  const r = await fetch(`${base}/api/outputs?sid=${sid}`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get("X-Deeper-Files"), "0", "正常会话不该还有'没列出来的文件'")
  const names = (await r.json()).map((x) => x.name)
  for (const n of ["manuscript.docx", "table1.csv", "pdfs/smith2024.pdf", "figures/forest.png",
                   "figures/panel/fig1.png", "audit/2024/q3/report.md"])
    assert.ok(names.includes(n), `${n} 没进列表（子目录产物在界面上等于不存在）`)
  // 相对路径必须是正斜杠：前端拿它拆目录分组、拼下载 URL，Windows 上写成反斜杠会整条链失效
  assert.ok(names.every((n) => !n.includes("\\")), "路径要统一正斜杠：" + names.join(" "))
})

test("PHI 对照表 / .private / 网关簿子：列表挡掉，包里也必须没有", async (t) => {
  const { base } = await server()
  const sid = "ws_zip_phi_test"
  makeSession(t, sid)
  const names = (await (await fetch(`${base}/api/outputs?sid=${sid}`)).json()).map((x) => x.name)
  for (const n of names) {
    assert.ok(!/crosswalk|mapping/i.test(n), "PHI 对照表进了产出列表：" + n)
    assert.ok(!n.startsWith(".private"), ".private/ 进了产出列表：" + n)
    assert.ok(!n.includes("_workflow.json"), "网关簿子进了产出列表：" + n)
  }
  const z = await fetch(`${base}/api/download-all?sid=${sid}`)
  assert.equal(z.status, 200)
  const inZip = unzip(Buffer.from(await z.arrayBuffer())).map((e) => e.name)
  for (const n of inZip) {
    assert.ok(!/crosswalk|mapping/i.test(n), "PHI 对照表进了打包（这是绕过脱敏的后门）：" + n)
    assert.ok(!n.startsWith(".private"), ".private/ 进了打包：" + n)
    assert.ok(!n.includes("_workflow.json"), "网关簿子进了打包：" + n)
  }
})

test("打包下载：列表里看得见的每一份都在包里，路径原样保留，内容对得上", async (t) => {
  const { base } = await server()
  const sid = "ws_zip_pack_test"
  makeSession(t, sid)
  const listed = (await (await fetch(`${base}/api/outputs?sid=${sid}`)).json()).map((x) => x.name)
  const r = await fetch(`${base}/api/download-all?sid=${sid}`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get("Content-Type") || "", /application\/zip/)
  assert.match(r.headers.get("Content-Disposition") || "", /filename="outputs-\d{8}-\d{4}\.zip"/, "要带下载文件名，否则浏览器存成 download-all")
  const entries = unzip(Buffer.from(await r.arrayBuffer()))
  const inZip = new Set(entries.map((e) => e.name))
  for (const n of listed) assert.ok(inZip.has(n), `列表里有、包里没有：${n}（用户以为拿全了）`)
  assert.equal(entries.length, listed.length, "包里多了列表上看不见的东西：" + [...inZip].join(" "))
  const deep = entries.find((e) => e.name === "figures/panel/fig1.png")
  assert.equal(deep.data.toString(), "两层深的图", "深层文件的内容要原样，不能被同名文件覆盖")
})

test("没有产出时回人话报错，不是一个内容为报错文字的坏 zip", async (t) => {
  const { base } = await server()
  const sid = "ws_zip_empty_test"
  const dir = path.join(REPO, "outputs", sid)
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const r = await fetch(`${base}/api/download-all?sid=${sid}`)
  assert.equal(r.status, 404)
  assert.match(r.headers.get("Content-Type") || "", /text\/plain; charset=utf-8/, "中文报错必须声明 charset，否则用户看到乱码")
  assert.match(await r.text(), /还没有产出文件/)
})
