// 用户反馈：客户端提交（zip）→ 服务端存 → 后台浏览 / 标记 / 附件下载 / 导出 HTML。
//
// 两处要特别钉：① 附件名与下载路径不能被越界字符串牵着走；② 导出 HTML 必须转义 ——
// 对话正文是用户与模型写的，里面出现 <script> 再正常不过，而导出文件是给管理员用浏览器打开的。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startApp, adminLogin, asAdmin } from "./helper.mjs"
import { zip } from "../lib/minizip.mjs"

const STRONG = "Aa1!aaaa9"

async function rig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-data-"))
  const app = await startApp({ DATA_DIR: dataDir })
  const cookie = await adminLogin(app)
  const admin = asAdmin(app, cookie)
  const add = await admin("/admin/api/user-add", { method: "POST", body: { username: "zhangsan", displayName: "张三" } })
  const li = await app.req("/api/auth/login", { method: "POST", body: { username: "zhangsan", password: add.json.initialPassword } })
  const chg = await app.req("/api/auth/password", {
    method: "POST", headers: { authorization: "Bearer " + li.json.access },
    body: { oldPassword: add.json.initialPassword, newPassword: STRONG },
  })
  const token = chg.json.access
  const submit = (fb, files = []) => app.req("/api/feedback", {
    method: "POST", raw: true,
    headers: { authorization: "Bearer " + token, "content-type": "application/zip", "x-client-version": "0.1.4" },
    body: zip([
      { name: "feedback.json", data: Buffer.from(JSON.stringify(fb)) },
      ...files.map(([name, data]) => ({ name: "files/" + name, data: Buffer.from(data) })),
    ]),
  })
  return { app, admin, token, dataDir, submit, close: async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }) } }
}

const SAMPLE = {
  sessionId: "ses_1", title: "写一篇综述", vote: -1, comment: "讨论部分把两篇文献的结论说反了",
  transcript: [
    { role: "user", text: "帮我写讨论部分", ts: 1 },
    { role: "assistant", text: "好的，已完成", ts: 2, skills: ["write-paper"] },
  ],
  meta: { model: "deepseek-v4-pro" },
}

test("提交 → 后台列表能看到；详情带完整对话；附件落盘可下载", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const s = await r.submit(SAMPLE, [["figure1.png", "PNGDATA"]])
  assert.equal(s.status, 200, s.text)
  const id = s.json.id

  const list = await r.admin("/admin/api/feedback")
  assert.equal(list.json.total, 1)
  const row = list.json.rows[0]
  assert.equal(row.title, "写一篇综述")
  assert.equal(row.vote, -1)
  assert.equal(row.msgs, 2)
  assert.equal(row.username, "zhangsan")
  assert.equal(row.status, "new")
  assert.deepEqual(row.files, [{ name: "figure1.png", size: 7 }])
  assert.equal(row.transcript, undefined, "列表不该带对话正文（几十上百 KB × 每行）")

  const one = await r.admin("/admin/api/feedback?id=" + id)
  assert.equal(one.json.item.transcript.length, 2)
  assert.equal(one.json.item.transcript[1].skills[0], "write-paper")
  assert.equal(one.json.item.meta.clientVersion, "0.1.4", "客户端版本要顺手记下（复现时要知道是哪一版）")

  const dl = await fetch(r.app.base + "/admin/api/feedback-file?id=" + id + "&name=figure1.png",
    { headers: { cookie: await adminLogin(r.app) } })
  assert.equal(dl.status, 200)
  assert.equal(await dl.text(), "PNGDATA")
})

test("导出 HTML：自带样式、内容全转义（对话正文里的标签不能变成真标签）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.submit({
    ...SAMPLE, comment: "<img src=x onerror=alert(1)>",
    transcript: [{ role: "user", text: "<script>alert('xss')</script>", ts: 1 }],
  })
  const cookie = await adminLogin(r.app)
  const ex = await fetch(r.app.base + "/admin/api/feedback-export?id=1", { headers: { cookie } })
  assert.equal(ex.status, 200)
  assert.match(ex.headers.get("content-type"), /text\/html/)
  assert.match(ex.headers.get("content-disposition"), /attachment/)
  const html = await ex.text()
  // 引号不转义是有意的：用户文本只出现在文本节点与双引号属性外，转 &#39; 只会让导出难读
  assert.match(html, /&lt;script&gt;alert\('xss'\)&lt;\/script&gt;/, "对话正文必须被转义")
  assert.doesNotMatch(html, /<script>alert/, "转义漏了就是给管理员的浏览器开了个注入口")
  assert.doesNotMatch(html, /<img src=x onerror/)
  assert.match(html, /写一篇综述/)
  assert.match(html, /👎/)
})

test("标记已处理 / 重开 / 删除（删除连附件一起清）", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const id = (await r.submit(SAMPLE, [["a.txt", "x"]])).json.id
  const dir = path.join(r.dataDir, "feedback", String(id))
  assert.ok(fs.existsSync(path.join(dir, "a.txt")))

  await r.admin("/admin/api/feedback", { method: "POST", body: { id, action: "done" } })
  assert.equal((await r.admin("/admin/api/feedback?id=" + id)).json.item.status, "done")
  assert.equal((await r.admin("/admin/api/feedback?status=new")).json.total, 0)
  await r.admin("/admin/api/feedback", { method: "POST", body: { id, action: "reopen" } })
  assert.equal((await r.admin("/admin/api/feedback?status=new")).json.total, 1)

  await r.admin("/admin/api/feedback", { method: "POST", body: { id, action: "delete" } })
  assert.equal((await r.admin("/admin/api/feedback")).json.total, 0)
  assert.equal(fs.existsSync(dir), false, "附件目录要跟着删，别留孤儿文件")
})

test("筛选：按状态 / 赞踩 / 关键词", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.submit({ ...SAMPLE, title: "综述A", vote: 1, comment: "很好用" })
  await r.submit({ ...SAMPLE, title: "标书B", vote: -1, comment: "图错了" })
  await r.submit({ ...SAMPLE, title: "统计C", vote: 0, comment: "建议加个功能" })
  assert.equal((await r.admin("/admin/api/feedback?vote=up")).json.total, 1)
  assert.equal((await r.admin("/admin/api/feedback?vote=down")).json.total, 1)
  assert.equal((await r.admin("/admin/api/feedback?q=标书")).json.total, 1)
  assert.equal((await r.admin("/admin/api/feedback?q=功能")).json.total, 1, "留言也要能搜到")
  const c = (await r.admin("/admin/api/feedback")).json.counts
  assert.equal(c.all_n, 3); assert.equal(c.up_n, 1); assert.equal(c.down_n, 1)
})

test("附件名越界一律消毒；下载只认库里记着的名字", async (t) => {
  const r = await rig(); t.after(() => r.close())
  // zip 层已经挡掉 ../ 这类（cleanName 直接抛），这里验的是"合法 zip 里的怪名字"也不会写飞
  const id = (await r.submit(SAMPLE, [["a:b*c?.png", "X"], ["很长的中文名.docx", "Y"]])).json.id
  const files = (await r.admin("/admin/api/feedback?id=" + id)).json.item.files
  assert.deepEqual(files.map((f) => f.name), ["a_b_c_.png", "很长的中文名.docx"])
  for (const f of files) assert.ok(fs.existsSync(path.join(r.dataDir, "feedback", String(id), f.name)))

  const cookie = await adminLogin(r.app)
  const bad = await fetch(r.app.base + "/admin/api/feedback-file?id=" + id + "&name=" + encodeURIComponent("../../sci.db"), { headers: { cookie } })
  assert.equal(bad.status, 404, "不在清单里的名字一律 404，绝不去拼路径试探")
})

test("坏包与未鉴权：整包拒绝，不留半条记录", async (t) => {
  const r = await rig(); t.after(() => r.close())
  const raw = (body, headers) => r.app.req("/api/feedback", { method: "POST", raw: true, body, headers })
  assert.equal((await raw(zip([{ name: "feedback.json", data: Buffer.from("{}") }]), { "content-type": "application/zip" })).status, 401, "没带票据不许提交")
  const H = { authorization: "Bearer " + r.token, "content-type": "application/zip" }
  assert.equal((await raw(Buffer.from("not-a-zip"), H)).status, 400)
  assert.equal((await raw(zip([{ name: "x.txt", data: Buffer.from("hi") }]), H)).status, 400, "没有 feedback.json")
  assert.equal((await r.admin("/admin/api/feedback")).json.total, 0)
})

test("未登录管理台看不到任何反馈", async (t) => {
  const r = await rig(); t.after(() => r.close())
  await r.submit(SAMPLE)
  assert.equal((await r.app.req("/admin/api/feedback")).status, 401)
  assert.equal((await r.app.req("/admin/api/feedback-export?id=1")).status, 401)
  assert.equal((await r.app.req("/admin/api/feedback-file?id=1&name=a.txt")).status, 401)
})
