// 「用本机 Word 打开产物文档」这条路，以及它带出来的那件更要紧的事：真相源转移。
//
// 覆盖的是"改坏了没人发现、而用户当场就丢稿子"的几处：
//   ① Word 打开文档期间落下的 `~$稿件.docx` 锁文件不许进产出列表，更不许进打包 ——
//      它不以点开头，skipEntry 原来那条挡不住。用户每改一次稿，侧栏就多一个他看不懂、
//      还因为 Word 独占着而下载必失败的条目。
//   ② /api/doc/open 必须【先记基线再起进程】，且同一份稿子重复打开不许刷新基线 ——
//      刷了的话，"用户改过这一份"这件事就从账上消失，AI 下一轮照旧从 markdown 重渲染，
//      把他亲手改的每一句无声覆盖掉。这是本功能最贵的一个 bug，所以单独一条测试钉住。
//   ③ 记账文件本身（.docedit.json）不许进列表/打包。
//   ④ name 的路径穿越必须挡住 —— 这条接口会把任意路径交给本机的 ShellExecute，
//      比读文件的接口更要紧：它不是"泄露一份文件"，是"在用户机器上打开一个文件"。
//   ⑤ 非 Office 后缀、以及非本机（中心部署）一律不给开。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { unzip } from "../minizip.mjs"

// 照 outputs-zip.test.mjs 的老办法：server.mjs 一 import 就起服务，把它关进临时 HOME、端口给 0。
// SCI_DOC_OPEN_DRYRUN=1 让打开那一步不真的起 explorer —— 否则跑一次测试就弹一个 Word 出来。
let SRV = null
async function server() {
  if (SRV) return SRV
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docedit-"))
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
    SCI_DOC_OPEN_DRYRUN: "1",
  }
  const saved = {}
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  let mod
  try { mod = await import("../server.mjs?docedit=1") } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来")
  SRV = { mod, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())) }
  return SRV
}
test.after(() => SRV?.close())

// opencode 不可用 → sessionOut 回落到 <仓库根>/outputs/<sid>，测试就往那儿造文件。
const REPO = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
function makeSession(t, sid) {
  const dir = path.join(REPO, "outputs", sid)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, "manuscript.docx"), "成稿第一版")
  fs.writeFileSync(path.join(dir, "manuscript.md"), "# 稿子\n")
  return dir
}
const jget = async (base, p) => (await fetch(base + p)).json()
const names = async (base, sid) => (await jget(base, `/api/outputs?sid=${sid}`)).map((x) => x.name)
/** 把文件的 mtime 往后推，模拟"用户在 Word 里改完存了盘"。直接写一次内容即可。 */
const touchLater = (p, body) => {
  fs.writeFileSync(p, body)
  const t = new Date(Date.now() + 5000)
  fs.utimesSync(p, t, t)
}

test("Word 的 ~$ 锁文件：不进产出列表，也不进打包", async (t) => {
  const { base } = await server()
  const sid = "ws_docedit_lock"
  const dir = makeSession(t, sid)
  fs.writeFileSync(path.join(dir, "~$manuscript.docx"), "Word 的锁")
  const list = await names(base, sid)
  assert.ok(list.includes("manuscript.docx"), "正经稿件反而不见了")
  assert.ok(!list.some((n) => n.startsWith("~$")), "Word 锁文件进了产出列表：" + list.join(" "))
  const z = await fetch(`${base}/api/download-all?sid=${sid}`)
  assert.equal(z.status, 200)
  const inZip = unzip(Buffer.from(await z.arrayBuffer())).map((e) => e.name)
  assert.ok(!inZip.some((n) => n.includes("~$")), "Word 锁文件进了打包：" + inZip.join(" "))
})

test("打开一份 docx：记下基线；用户改完存盘后，列表上打出「已被你改过」", async (t) => {
  const { base } = await server()
  const sid = "ws_docedit_flag"
  const dir = makeSession(t, sid)
  // 还没打开过 → 不该有任何标记
  let outs = await jget(base, `/api/outputs?sid=${sid}`)
  assert.ok(!outs.some((o) => o.edited), "还没人动过就说改过了")
  // 打开
  const r = await (await fetch(`${base}/api/doc/open?sid=${sid}&name=manuscript.docx`, { method: "POST" })).json()
  assert.equal(r.ok, true, "打开失败：" + JSON.stringify(r))
  // 只是打开、还没改 → 仍然不该有标记
  outs = await jget(base, `/api/outputs?sid=${sid}`)
  assert.ok(!outs.some((o) => o.edited), "只打开没改就说改过了（用户会以为自己动了什么）")
  // 用户改完存盘
  touchLater(path.join(dir, "manuscript.docx"), "成稿第二版（用户改的）")
  outs = await jget(base, `/api/outputs?sid=${sid}`)
  const hit = outs.find((o) => o.name === "manuscript.docx")
  assert.equal(hit?.edited, true, "用户改过却没打标 —— AI 下一轮会从 md 重排把他的改动覆盖掉")
  // 记账文件本身不能出现在列表里
  assert.ok(!outs.some((o) => o.name.includes("docedit")), "记账文件进了产出列表")
})

test("再次打开【不许】刷新基线（否则用户的改动会从账上凭空消失）", async (t) => {
  const { base } = await server()
  const sid = "ws_docedit_reopen"
  const dir = makeSession(t, sid)
  await fetch(`${base}/api/doc/open?sid=${sid}&name=manuscript.docx`, { method: "POST" })
  touchLater(path.join(dir, "manuscript.docx"), "用户改过了")
  // 用户"改完存盘，再打开看一眼"——这是最常见的动作，基线必须钉在第一次打开那一刻
  await fetch(`${base}/api/doc/open?sid=${sid}&name=manuscript.docx`, { method: "POST" })
  const outs = await jget(base, `/api/outputs?sid=${sid}`)
  assert.equal(outs.find((o) => o.name === "manuscript.docx")?.edited, true,
    "第二次打开把基线刷成了改后的 mtime，'用户改过'这件事被抹掉了")
})

test("路径穿越：不许把会话目录外的文件交给本机去打开", async (t) => {
  const { base } = await server()
  const sid = "ws_docedit_escape"
  makeSession(t, sid)
  for (const bad of ["../../secret.docx", "..%2F..%2Fsecret.docx", "/etc/passwd.docx", "C:/Windows/x.docx"]) {
    const r = await fetch(`${base}/api/doc/open?sid=${sid}&name=${encodeURIComponent(bad)}`, { method: "POST" })
    const j = await r.json()
    assert.equal(j.ok, false, `会话目录外的路径被放行了：${bad}`)
  }
})

test("非 Office 后缀不给开；能力探测对它也回 canOpen:false", async (t) => {
  const { base } = await server()
  const sid = "ws_docedit_ext"
  const dir = makeSession(t, sid)
  fs.writeFileSync(path.join(dir, "notes.md"), "# 笔记")
  const cap = await jget(base, "/api/doc/opener?name=notes.md")
  assert.equal(cap.canOpen, false, "markdown 不该出现「用 Word 打开」按钮")
  const j = await (await fetch(`${base}/api/doc/open?sid=${sid}&name=notes.md`, { method: "POST" })).json()
  assert.equal(j.ok, false, "非 Office 后缀被放行了")
  // docx 则应当给出能力（测试环境走 dryrun）
  const cap2 = await jget(base, "/api/doc/opener?name=manuscript.docx")
  assert.equal(cap2.canOpen, true, "docx 反而说打不开")
})

test("文件不存在时给人话，不是 500", async (t) => {
  const { base } = await server()
  const sid = "ws_docedit_missing"
  makeSession(t, sid)
  const r = await fetch(`${base}/api/doc/open?sid=${sid}&name=nope.docx`, { method: "POST" })
  assert.equal(r.status, 404)
  const j = await r.json()
  assert.equal(j.ok, false)
  assert.match(j.err, /不在了|移走|改名/, "报错没说清是文件没了：" + j.err)
})
