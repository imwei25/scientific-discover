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
import { fileURLToPath } from "node:url"

let seq = 0

// 真实的产物根与聊天接入状态文件。删会话的保护判据落在【路径本身】上（insideOutputs），
// 而 OUTPUTS / Bridge 的 root 在 server.mjs 里都是按 __dirname 定死的、没有环境变量口子，
// 所以要测"目录在 outputs/ 之内"的那几档，只能用真实路径，测完自己清干净。
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..")
const REPO_OUTPUTS = path.join(REPO_ROOT, "outputs")
const BRIDGE_STATE = path.join(REPO_ROOT, "chat-bridge", "state.json")

/** 假 opencode：只实现网关会打的几个会话口，并记下建会话时收到的 directory。 */
async function fakeOpencode(outRoot) {
  const state = { sessions: [], deleted: [], created: [] }
  let n = 0
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x")
    res.setHeader("content-type", "application/json")
    const m = /^\/session\/([^/]+)$/.exec(u.pathname)
    // ★ 真 opencode 的 /session 列表是【按 directory 分域】的：不带参数只回"默认那一域"
    //   （网关 cwd 那个 project，产物目录 outputs/ws_xxx 在它里面），带 directory 才回那个目录的。
    //   这里必须照样分域 —— 假服务从前无差别回全部，于是"文件夹会话在侧栏里彻底隐身"这个
    //   实打实的线上缺陷，测试一路全绿（2026-08-14 由文献管理模块暴露）。
    if (u.pathname === "/session" && req.method === "GET") {
      const q = u.searchParams.get("directory") || ""
      const norm = (p) => { try { return path.resolve(p).toLowerCase() } catch { return "" } }
      // 默认域 = 网关自己造的产物目录（outputs/ws_xxx，在仓库内 → 与网关同一个 project）；
      // 用户自己挑的目录在仓库外，只有带上它的 directory 才查得到。
      const inDefault = (s) => !s.directory || /[\\/]outputs[\\/]ws_/i.test(s.directory)
      const list = q
        ? state.sessions.filter((s) => s.directory && norm(s.directory) === norm(q))
        : state.sessions.filter(inDefault)
      return res.end(JSON.stringify(list))
    }
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

// 【Bug 回归】「不再按这个目录分组」会把组内会话的 folderId 清掉，而删会话时保护用户目录的
// 判据若只看 folderId，这条链就是灾难：forget → delete → rmSync 把用户的真实目录连锅端。
// 判据必须落在路径本身（delOut 在不在我们的 outputs/ 根之内），folderId 只是软标记。
test("忘掉文件夹之后再删会话：用户目录仍然一个文件都不能少", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  const mine = path.join(dir, "毕业课题")
  fs.mkdirSync(mine, { recursive: true })
  fs.writeFileSync(path.join(mine, "稿子.docx"), "三年的心血")
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const fid = (await gw.post("/api/folder/create?path=" + encodeURIComponent(mine))).json.folder.id
  const sid = await gw.newSession(fid)
  assert.equal((await gw.post("/api/folder/forget?id=" + fid)).json.ok, true)

  const del = await gw.post("/api/session/delete?id=" + sid)
  assert.equal(del.json.ok, true, "删除本身要成功")
  assert.ok(fs.existsSync(path.join(mine, "稿子.docx")), "★ forget 清掉 folderId 之后，用户的文件也绝不能被删")
  assert.ok(fs.existsSync(mine), "★ 目录本身也得在")
})

// 【超链接式删除的服务端半边】同一个会话同时挂项目和文件夹时，"删除"应是逐条解除归属：
// 移出项目（已有 /api/session/project?projectId=none）、移出文件夹分组（/api/session/folder，
// 只许清不许改——opencode 的 directory 建后不可改，"挂进另一个文件夹"是做不到的事）。
test("会话同时在项目和文件夹：移出只删链接不动会话，folderId 只能清不能改", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  const mine = path.join(dir, "数据目录")
  fs.mkdirSync(mine, { recursive: true })
  fs.writeFileSync(path.join(mine, "数据.csv"), "x")
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const fid = (await gw.post("/api/folder/create?path=" + encodeURIComponent(mine))).json.folder.id
  const sid = await gw.newSession(fid)
  const pid = (await gw.post("/api/project/create?name=P")).json.project.id
  assert.equal((await gw.post(`/api/session/project?id=${sid}&projectId=${pid}`)).json.ok, true)

  let s = (await gw.get("/api/sessions")).json.sessions.find((x) => x.id === sid)
  assert.equal(s.projectId, pid); assert.equal(s.folderId, fid, "两个归属该同时成立")

  // 改挂到别的文件夹：目录建后不可改，必须拒绝
  assert.equal((await gw.post(`/api/session/folder?id=${sid}&folderId=f_xxx`)).status, 400)

  // 移出文件夹分组：只删这条链接，会话、项目归属、目录里的文件全都不动
  assert.equal((await gw.post(`/api/session/folder?id=${sid}&folderId=none`)).json.ok, true)
  s = (await gw.get("/api/sessions")).json.sessions.find((x) => x.id === sid)
  assert.ok(s, "会话还在")
  assert.equal(s.folderId, null, "文件夹链接解除了")
  assert.equal(s.projectId, pid, "项目链接不受影响")
  assert.ok(fs.existsSync(path.join(mine, "数据.csv")), "目录里的文件不动")

  // 最后一条归属也没了之后真删：会话消失，但用户目录仍受路径判据保护
  assert.equal((await gw.post(`/api/session/project?id=${sid}&projectId=none`)).json.ok, true)
  assert.equal((await gw.post("/api/session/delete?id=" + sid)).json.ok, true)
  assert.ok(!(await gw.get("/api/sessions")).json.sessions.some((x) => x.id === sid), "这回才是真删")
  assert.ok(fs.existsSync(path.join(mine, "数据.csv")), "★ 真删也只删我们自己的东西，用户目录不动")
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
  // 文件走【另一路】files：选文件夹时要能看见里面有什么（尤其文献文件夹常常没有子目录，
  // 只列目录的话界面上是一句"这里面没有子目录"，用户无从确认自己站对了地方）。
  // ★ 不许把它并进 entries —— 前端拿 entries 建的是"点进去 / 选它"两个动作，
  //   混进文件等于让人能把一个 PDF 当工作目录选定。
  assert.deepEqual(r.json.files.map((f) => f.name), ["不是目录.txt"], "文件另开 files 一路")
  assert.equal(r.json.files[0].size, 1)
  assert.equal(r.json.moreFiles, 0)
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

// 【2026-08-14 线上缺陷的回归】opencode 的 /session 列表按 directory 分域，网关从前直接调
// client.session.list()（不带 directory）→ 凡是挑了工作目录的会话【一条都不在列表里】：
// 侧栏看不到、文件夹分组恒空（分组只列"还有会话挂着的"），而 pruneOrphanMeta 更会把它们的
// 元数据当孤儿删掉（ws 一丢，uploads 与 outputs 的配对就断了）。
// 文献管理模块必选文件夹，等于每次都撞上——用户报"会话不见了"就是这条。
test("文件夹会话必须出现在列表里：opencode 的会话列表按目录分域，得逐个目录查过来", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  const mine = path.join(dir, "文献库")
  fs.mkdirSync(mine, { recursive: true })
  const oc = await fakeOpencode(path.join(dir, "out"))
  const gw = await gateway(oc.url, dir)
  t.after(async () => { await gw.close(); await oc.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const fid = (await gw.post("/api/folder/create?path=" + encodeURIComponent(mine))).json.folder.id
  const folderSid = await gw.newSession(fid)
  const plainSid = await gw.newSession()                 // 没挑目录的，落在默认域

  const list = await gw.get("/api/sessions")
  const ids = list.json.sessions.map((s) => s.id)
  assert.ok(ids.includes(plainSid), "默认域的会话本来就在")
  assert.ok(ids.includes(folderSid), "★ 挑了工作目录的会话必须一起列出来（别退回 session.list() 不带 directory）")
  assert.deepEqual(list.json.folders.map((f) => f.id), [fid], "有会话挂着，文件夹分组才出得来")

  // 元数据整理不许把它清掉：ws / folderId 是不可再生的
  await new Promise((r) => setTimeout(r, 300))       // saveMeta 是防抖写盘（50ms），别抢在它前面读
  const metaPath = path.join(dir, "sessions-meta.json")
  const meta = () => JSON.parse(fs.readFileSync(metaPath, "utf8"))
  assert.ok(meta().sessions[folderSid]?.ws, "建会话时该记下 ws")
  assert.equal(meta().sessions[folderSid]?.dir, path.resolve(mine), "还要记下工作目录本身——忘掉文件夹之后就靠它把会话找回来")
})

// 【Bug 回归】聊天接入的绑定语义是「目录锚点」：cc-connect 每轮对话在 boundDir 里【另起一个新
// 会话】，于是锚点会话与手机端建的 N 个会话【共用同一个目录】，而删除路径整段是按"一个会话独占
// 一个目录"写的。少了针对绑定目录的判据，用户在侧栏删掉任意一个手机端会话（它们确实会被列出来，
// 见 listSessionsAll 的第 ③ 条来源），就会把整个绑定目录连锅端 —— 锚点与所有兄弟会话的产物、
// 注入的 AGENTS.md 发文件说明书、.cc-connect\ 里的投递看门狗暂存与配额台账，一起没。
//
// ★ 绑定目录必须造在 outputs/ 【之内】：那正是"新会话直接绑微信"的默认形态，也是既有三个信号
//   （folderId / META.dir / 不在 outputs 内）【全部落空】、只剩这条新判据能救的情形。造在仓库外
//   的话第三个信号就把它保下来了，等于什么都没测到。
test("聊天接入的绑定目录：删手机端另起的会话不许动共用目录；删锚点会话则同步解绑", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fold-"))
  fs.mkdirSync(REPO_OUTPUTS, { recursive: true })
  const bound = fs.mkdtempSync(path.join(REPO_OUTPUTS, "ws_bridge-"))
  const keep = path.join(bound, "手机端出的图.png")
  fs.writeFileSync(keep, "x")
  // 真实的绑定状态：Bridge 的 root 是仓库根，没有环境变量口子 → 只能写真文件。开发机上可能
  // 已经有一份（里面是真微信凭证）→ 先备份、测完原样放回去，绝不能把人家的绑定冲掉。
  const hadState = fs.existsSync(BRIDGE_STATE)
  const backup = hadState ? fs.readFileSync(BRIDGE_STATE) : null
  fs.mkdirSync(path.dirname(BRIDGE_STATE), { recursive: true })
  fs.writeFileSync(BRIDGE_STATE, JSON.stringify({
    enabled: false,   // 别让 unbind 里的 start() 真去拉进程（supported() 也会挡，双保险）
    weixin: { token: "tk", account_id: "acc", base_url: "", allow_from: "", boundSid: "ses_anchor", boundDir: bound },
  }))
  const oc = await fakeOpencode(path.join(dir, "out"))
  // 锚点会话 + 手机端另起的一条，两者 directory 都是绑定目录（这就是真实形态）
  oc.state.sessions.push(
    { id: "ses_anchor", title: "微信绑定的会话", time: { updated: Date.now() }, directory: bound },
    { id: "ses_phone", title: "手机端那轮", time: { updated: Date.now() }, directory: bound })
  const gw = await gateway(oc.url, dir)
  t.after(async () => {
    await gw.close(); await oc.close()
    if (backup) fs.writeFileSync(BRIDGE_STATE, backup)
    else { try { fs.rmSync(path.dirname(BRIDGE_STATE), { recursive: true, force: true }) } catch {} }
    for (const p of [dir, bound]) { try { fs.rmSync(p, { recursive: true, force: true }) } catch {} }
  })

  // ① 删手机端那条：会话本身该删掉，共用目录一个字节都不许动
  const d1 = await gw.post("/api/session/delete?id=ses_phone")
  assert.equal(d1.json.ok, true, "删除本身要成功")
  assert.ok(oc.state.deleted.includes("ses_phone"), "会话该真的下到 opencode")
  assert.ok(fs.existsSync(keep), "★ 手机端会话被删，共用的绑定目录里的产物绝不能跟着没")
  assert.deepEqual(d1.json.unbound || [], [], "删的不是锚点会话，不该解绑")

  // ② 删锚点会话：目录照样保住（里面还有兄弟会话的产物），但要同步解绑并如实告诉前端
  const d2 = await gw.post("/api/session/delete?id=ses_anchor")
  assert.equal(d2.json.ok, true)
  assert.ok(fs.existsSync(keep), "★ 锚点会话被删，目录里手机端各轮的产物同样不能删")
  assert.deepEqual(d2.json.unbound, ["weixin"], "★ 锚点会话被删 → 必须同步解绑，否则桥挂着一个已删会话空转、界面还显示已绑定")
  assert.equal(path.resolve(d2.json.keptDir || ""), path.resolve(bound), "要把保留下来的目录回给前端，好让界面说清文件还在哪")
  const after = JSON.parse(fs.readFileSync(BRIDGE_STATE, "utf8"))
  assert.equal(after.weixin.boundSid, "", "状态文件里的绑定要真的清掉")
  assert.equal(after.weixin.boundDir, "", "绑定目录同理")
  assert.equal(after.weixin.token, "tk", "凭证不该被顺手抹掉——解绑只解会话，不是重置账号")
})
