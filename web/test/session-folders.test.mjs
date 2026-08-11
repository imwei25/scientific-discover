// 「文件夹」（用户自己挑的工作目录）+ 会话手工排序 —— 服务端契约的回归测试。
//
// 【为什么有这个文件】这个功能把会话的产物目录从"网关自己造的 outputs/ws_xxx"变成了
// "用户电脑上的任意一个目录"，于是删会话那条路径（rmSync -r 产物目录）从"删我们自己造的临时目录"
// 变成了可能"把用户的整个项目文件夹连锅端"。这是本功能唯一的灾难性失误可能，必须钉死在测试里。
// 顺带钉住另外三条：
//   · 目录只能在建会话时定（opencode 的 session.directory 建后不可改）→ 建会话时必须真的传过去；
//   · 局域网共用（SCI_FS_SCOPE=workspace）不许浏览整台机器，只能在自己的产物根里挑；
//   · 排序按"列表"各记各的：同一个会话同时在项目列表和文件夹列表里，两处顺序互不干扰。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

let seq = 0

/** 假 opencode：只实现网关会打的几个会话口，并记下建会话时收到的 directory。 */
async function fakeOpencode(outRoot) {
  const state = { sessions: [], deleted: [], created: [] }
  let n = 0
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x")
    res.setHeader("content-type", "application/json")
    const m = /^\/session\/([^/]+)$/.exec(u.pathname)
    if (u.pathname === "/session" && req.method === "GET") return res.end(JSON.stringify(state.sessions))
    if (u.pathname === "/session" && req.method === "POST") {
      const dir = u.searchParams.get("directory") || ""
      const s = { id: "ses_new" + ++n, title: "t" + n, time: { updated: Date.now() }, directory: dir }
      state.sessions.push(s); state.created.push({ id: s.id, directory: dir })
      return res.end(JSON.stringify(s))
    }
    if (m && req.method === "GET") {
      const s = state.sessions.find((x) => x.id === m[1])
      if (!s) { res.statusCode = 404; return res.end(JSON.stringify({ error: "no such session" })) }
      return res.end(JSON.stringify({ ...s, directory: s.directory || path.join(outRoot, s.id) }))
    }
    if (m && req.method === "DELETE") {
      state.deleted.push(m[1])
      state.sessions = state.sessions.filter((x) => x.id !== m[1])
      return res.end(JSON.stringify(true))
    }
    res.end(JSON.stringify({}))
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  return { state, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }
}

/** 起本机网关，接到假 opencode 上（不接管 opencode 进程，不连云端） */
async function gateway(ocUrl, dir, extra = {}) {
  const over = {
    MANAGE_OC: "0", PORT: "0", AUTH_ENABLED: "",
    OC_URL: ocUrl,
    HOME: dir, USERPROFILE: dir,
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
    ALLOWED_SKILLS: "", ALLOWED_MODULES: "", SUGGEST_ENABLED: "0",
    BASE_PATH: "", SCI_FS_SCOPE: "",
    ...extra,
  }
  const saved = {}
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  let mod
  try { mod = await import(`../server.mjs?fold=${++seq}`) } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来")
  const base = `http://127.0.0.1:${port}`
  return {
    base,
    close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())),
    async get(p) { const r = await fetch(base + p); return { status: r.status, json: await r.json().catch(() => null) } },
    async post(p, body) {
      const r = await fetch(base + p, body === undefined ? { method: "POST" }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      return { status: r.status, json: await r.json().catch(() => null) }
    },
    // 建会话最省事的一条真实路径：上传一个文件（没有 sid 时网关会现建会话）
    async newSession(folderId) {
      const r = await fetch(`${base}/api/upload?name=a.txt${folderId ? "&folderId=" + encodeURIComponent(folderId) : ""}`, { method: "POST", body: "hello" })
      return (await r.json()).sid
    },
  }
}

test("挑了目录的会话：directory 真传给了 opencode，且左侧按目录归成一个文件夹", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  const mine = path.join(dir, "我的课题")           // 假装这是用户电脑上的项目目录
  fs.mkdirSync(mine, { recursive: true })
  fs.writeFileSync(path.join(mine, "原始数据.xlsx"), "important")
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const cr = await gw.post("/api/folder/create?path=" + encodeURIComponent(mine))
  assert.equal(cr.status, 200)
  assert.equal(cr.json.folder.path, path.resolve(mine))
  assert.equal(cr.json.folder.name, "我的课题", "显示名取目录末段")
  const fid = cr.json.folder.id

  const sid = await gw.newSession(fid)
  assert.ok(sid, "上传该现建一个会话")
  assert.equal(oc.state.created.at(-1).directory, path.resolve(mine), "建会话时必须把用户挑的目录传给 opencode")

  const list = await gw.get("/api/sessions")
  const s = list.json.sessions.find((x) => x.id === sid)
  assert.equal(s.folderId, fid, "会话该挂在这个文件夹下")
  assert.deepEqual(list.json.folders.map((f) => f.id), [fid], "文件夹该出现在分组列表里")

  // 同一个目录再挑一次不该多出一个重名分组
  const again = await gw.post("/api/folder/create?path=" + encodeURIComponent(mine.replace(/\//g, path.sep)))
  assert.equal(again.json.folder.id, fid, "同一个目录重复认领应返回已有的那条")

  // 上传目录仍是会话私有的 uploads/ws_xxx，不能混进用户的目录
  assert.ok(!fs.existsSync(path.join(mine, "a.txt")), "上传的文件不该落进用户自己的目录")
})

test("删除文件夹会话：用户目录里的文件一个都不能少（本功能唯一的灾难性失误可能）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  const mine = path.join(dir, "论文")
  fs.mkdirSync(path.join(mine, "figures"), { recursive: true })
  fs.writeFileSync(path.join(mine, "稿子.docx"), "三年的心血")
  fs.writeFileSync(path.join(mine, "figures", "fig1.png"), "x")
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const fid = (await gw.post("/api/folder/create?path=" + encodeURIComponent(mine))).json.folder.id
  const sid = await gw.newSession(fid)

  const del = await gw.post("/api/session/delete?id=" + sid)
  assert.equal(del.status, 200)
  assert.equal(del.json.ok, true, "删除本身要成功（不能因为跳过产物目录就报失败）")
  assert.deepEqual(oc.state.deleted, [sid])
  assert.ok(fs.existsSync(path.join(mine, "稿子.docx")), "★ 用户自己的文件绝不能被删")
  assert.ok(fs.existsSync(path.join(mine, "figures", "fig1.png")), "★ 子目录里的也一样")
  assert.ok(fs.existsSync(mine), "★ 目录本身也得在")
})

test("没挑目录的会话照旧：产物目录是网关自己造的，删会话时连目录一起删", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const sid = await gw.newSession()
  const outDir = oc.state.created.at(-1).directory
  assert.ok(/[\\/]outputs[\\/]ws_/.test(outDir), "没挑目录时该落在 outputs/ws_xxx：" + outDir)
  fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, "fig1.png"), "x")

  const del = await gw.post("/api/session/delete?id=" + sid)
  assert.equal(del.json.ok, true)
  assert.ok(!fs.existsSync(outDir), "会话专属目录该随会话一起删掉")
})

test("排序：每条列表各记各的，同一个会话在项目里和在文件夹里的位置互不干扰", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const a = await gw.newSession(), b = await gw.newSession(), c = await gw.newSession()
  const r = await gw.post("/api/sessions/order", { bucket: "recent", ids: [c, a, b] })
  assert.equal(r.json.ok, true)
  let list = await gw.get("/api/sessions")
  const ord = (id) => list.json.sessions.find((s) => s.id === id).orders
  assert.equal(ord(c).recent, 0); assert.equal(ord(a).recent, 1); assert.equal(ord(b).recent, 2)

  await gw.post("/api/sessions/order", { bucket: "p:p1", ids: [a, b, c] })
  list = await gw.get("/api/sessions")
  assert.equal(ord(c).recent, 0, "另一条列表排过之后，recent 的顺序不该被动到")
  assert.equal(ord(c)["p:p1"], 2)

  assert.equal((await gw.post("/api/sessions/order", { bucket: "", ids: [a] })).status, 400)
  assert.equal((await gw.post("/api/sessions/order", { bucket: "recent" })).status, 400)
})

test("置顶已经去掉：接口还在但是空操作，列表里 pinned 恒为 false（老界面包配新网关不至于报错）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const sid = await gw.newSession()
  const r = await gw.post("/api/session/pin?id=" + sid + "&pinned=1")
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.noop, true)
  const list = await gw.get("/api/sessions")
  assert.equal(list.json.sessions.find((s) => s.id === sid).pinned, false, "钉过之后也必须是 false")
})

// 局域网共用（一台机器当小组服务器，别人带密码登进来）：目录浏览必须收在自己的产物根里，
// 否则等于把整台机器的文件系统摆进任何一个登录者的界面。靠显式的 SCI_FS_SCOPE 打开
//（原先是"设了 BASE_PATH 就自动收窄"，那套多用户容器部署已下线，判据没了）。
test("局域网共用时收窄：只能在自己的产物根里挑目录，翻不到机器上别的地方", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir, { SCI_FS_SCOPE: "workspace" })
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const roots = await gw.get("/api/fs/list")
  assert.equal(roots.json.mode, "workspace")
  assert.equal(roots.json.roots.length, 1, "只该有工作区一个根")

  const outside = process.platform === "win32" ? "C:\\Windows" : "/etc"
  const r = await gw.get("/api/fs/list?path=" + encodeURIComponent(outside))
  assert.equal(r.status, 403, "工作区之外一律拒绝")
  const c = await gw.post("/api/folder/create?path=" + encodeURIComponent(path.join(dir, "别人的目录")))
  assert.equal(c.status, 403, "认领工作区之外的目录同样拒绝")
})

test("本机部署：能浏览整台机器，读不动的目录说清原因而不是装作空目录", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  // 单独开一层来浏览：dir 本身被当成了 HOME（见 gateway 的 over），网关会往里写 quota 之类的东西，
  // 断言"只有甲乙两个子目录"就会被那些副产物打翻。
  const browse = path.join(dir, "浏览")
  fs.mkdirSync(path.join(browse, "甲"), { recursive: true })
  fs.mkdirSync(path.join(browse, "乙"), { recursive: true })
  fs.writeFileSync(path.join(browse, "不是目录.txt"), "x")
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const roots = await gw.get("/api/fs/list")
  assert.equal(roots.json.mode, "local")
  assert.ok(roots.json.roots.length >= 1)

  const r = await gw.get("/api/fs/list?path=" + encodeURIComponent(browse))
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.entries.map((e) => e.name).sort(), ["乙", "甲"].sort(), "只列子目录，不列文件")
  assert.equal(r.json.canUse, true)
  assert.equal(path.resolve(r.json.parent), path.resolve(dir), "该给得出上一级")

  const missing = await gw.get("/api/fs/list?path=" + encodeURIComponent(path.join(browse, "没有这个")))
  assert.equal(missing.status, 404)
  // 路径写错（上一级都不存在）时不许递归造出一整条目录来
  const bad = await gw.post("/api/folder/create?path=" + encodeURIComponent(path.join(browse, "打错了", "又打错了")))
  assert.equal(bad.status, 400)
  assert.ok(!fs.existsSync(path.join(browse, "打错了")), "不该在用户硬盘上留下垃圾目录")
  // 目录不存在但上一级在 → 替用户建出来（选择器里的「在此新建文件夹」走的就是这条）
  const made = await gw.post("/api/folder/create?path=" + encodeURIComponent(path.join(browse, "新课题")))
  assert.equal(made.status, 200)
  assert.ok(fs.statSync(path.join(browse, "新课题")).isDirectory())
})

test("不再按目录分组：只去掉分组，会话和目录里的文件都不动", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  const mine = path.join(dir, "课题")
  fs.mkdirSync(mine, { recursive: true }); fs.writeFileSync(path.join(mine, "数据.csv"), "x")
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const fid = (await gw.post("/api/folder/create?path=" + encodeURIComponent(mine))).json.folder.id
  const sid = await gw.newSession(fid)
  assert.equal((await gw.post("/api/folder/forget?id=" + fid)).json.ok, true)

  const list = await gw.get("/api/sessions")
  assert.deepEqual(list.json.folders, [], "分组没了")
  const s = list.json.sessions.find((x) => x.id === sid)
  assert.ok(s, "会话还在")
  assert.equal(s.folderId, null, "会话回到未归类")
  assert.ok(fs.existsSync(path.join(mine, "数据.csv")), "目录里的文件一个都不动")
})
