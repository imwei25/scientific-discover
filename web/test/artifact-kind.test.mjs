// 产物分级（主产物 / 中间文件 / 文件夹里原有的）—— 侧栏三段式与「打包下载」范围都靠它。
//
// 为什么值得单独守：判据是"以各步 emits 契约为准 + 两条兜底"，而 emits 是会随模块演进改的。
// 一旦某个模块的交付物被误判成 aux，用户看到的就是"跑完了但主区是空的"——而文件其实都在，
// 只是折起来了，这类错最难从截图上看出来。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import * as WF from "../workflows.mjs"

const kind = (mod, name) => WF.artifactKind(mod, null, name)

test("各模块的交付物必须落在主区（这是本功能的底线）", () => {
  const must = [
    ["review", "review.docx"], ["review", "literature_review.md"], ["review", "evidence_table.csv"],
    ["paper", "manuscript.docx"], ["paper", "table1.csv"], ["paper", "fig1.png"], ["paper", "figures/fig2.svg"],
    ["paper", "design_brief.md"], ["paper", "refcheck_report.md"],
    ["grant", "proposal.docx"], ["grant", "requirement_card.md"], ["grant", "novelty_report.md"],
    // 锻打定案：标书里最值钱的一份，2026-08-14 才补进 grant 的 emits（原来会被折进中间文件）
    ["grant", "design_brief.md"], ["grant", "closest_work.md"],
    ["stats", "table1.csv"], ["stats", "stats_main.csv"], ["stats", "data_profile.md"],
    ["litread", "reading_guide.md"], ["litread", "translation_zh.docx"], ["litread", "slides.pptx"],
    ["litmanage", "library.xlsx"],
    ["humanize", "manuscript_humanized.docx"],
    ["figure", "figures/fig1.png"],
  ]
  for (const [mod, name] of must) assert.equal(kind(mod, name), "main", `${mod} 的 ${name} 应当是主产物`)
})

test("确定的中间态一律折叠：脚本 / 日志 / json / 成批素材目录", () => {
  const aux = [
    ["paper", "analysis.py"], ["paper", "run.log"], ["stats", "fit.ipynb"],
    ["review", "pdfs/a.pdf"], ["review", "zotero_lib/b.pdf"],
    ["litmanage", "library_texts/001__a.txt"], ["litmanage", "library.json"], ["litmanage", "archive_log.json"],
    ["stats", "audit/step1.csv"],
    // 契约之外的中间 md/csv：折叠是有意的取舍（折叠块带计数、点一下就展开）
    ["review", "search_log.md"], ["paper", "scratch_notes.md"],
  ]
  for (const [mod, name] of aux) assert.equal(kind(mod, name), "aux", `${mod} 的 ${name} 应当算中间文件`)
})

test("成品扩展名是兜底：没写进 emits 的 Word/PDF/Excel/图也照样进主区", () => {
  // emits 不可能写全（模型常写出契约之外的合理产物）。方向必须是"宁可多留一个在主区"，
  // 绝不能把用户真正要的 Word 默默折起来。
  for (const n of ["交付稿.docx", "附件.pdf", "汇总.xlsx", "海报.png", "路线图.svg"])
    assert.equal(kind("review", n), "main", n)
})

test("自由对话没有契约：只折确定的中间态，其余一律主区（别收窄最自由的那个模块）", () => {
  assert.equal(kind("chat", "answer.md"), "main")
  assert.equal(kind("chat", "data.csv"), "main")
  assert.equal(kind("chat", "report.docx"), "main")
  assert.equal(kind("chat", "script.py"), "aux")
  assert.equal(kind("chat", "run.log"), "aux")
  assert.equal(kind("", "whatever.md"), "main", "模块认不出时也不许收窄")
})

// ---- ppt-master 的产物树 ----
// 一次 8 页 PPT 会写出 24 个 SVG（svg_output/ 草稿、svg_final/ 定稿、backup/<时间戳>/ 整份副本）
// 外加素材 png。它们全命中"成品扩展名"兜底，而 ppt-master 把一切都放在 `<项目名>/` 底下、
// 老的 BULK_DIRS 只看路径第一段——两者叠起来，主区就是 30 个文件里躺着唯一那份 .pptx。
const PPT_TREE = [
  "汇报.pptx", "ppt_outline.md",
  "bench/exports/bench_20260815.pptx", "bench/design_spec.md", "bench/spec_lock.md",
  "bench/notes/total.md", "bench/sources/source.md", "bench/images/hero.png",
  ...Array.from({ length: 8 }, (_, i) => `bench/svg_output/page-0${i + 1}.svg`),
  ...Array.from({ length: 8 }, (_, i) => `bench/svg_final/page-0${i + 1}.svg`),
  ...Array.from({ length: 8 }, (_, i) => `bench/backup/20260815/svg_output/page-0${i + 1}.svg`),
]
const DELIVERED = ["汇报.pptx", "ppt_outline.md", "bench/exports/bench_20260815.pptx"]

for (const mod of ["litread", "chat"]) {
  test(`PPT 会话（${mod}）主区只留交付物，24 个中间 SVG 不许挤进来`, () => {
    const main = PPT_TREE.filter((f) => kind(mod, f) === "main")
    assert.deepEqual(main, DELIVERED)
  })
}

// ★ 2026-08-31 用户反馈：做 PPT 时"一堆 svg 图片也被归成最终产出"。
//   根因不是黑名单少了几个名字，而是 SVG 走了"成品扩展名"那条兜底 —— ppt-master 一个工程会往
//   svg_flat / assets / validation / charts / <它随手起的名> 里都写 SVG，目录黑名单永远追不齐。
//   所以规则改成：子目录里的 .svg 必须命中 emits（或落在约定的 figures/）才算主产物。
test("ppt 工程里【任何】目录下的 SVG 都不许进主区，哪怕黑名单不认识那个目录名", () => {
  const tree = [
    "bench/svg_flat/page-01.svg", "bench/assets/logo.svg", "bench/validation/v.svg",
    "bench/charts/chart1.svg", "bench/我随手起的目录/page-01.svg", "bench/page-01.svg",
  ]
  for (const mod of ["litread", "chat", "paper"])
    for (const n of tree) assert.equal(kind(mod, n), "aux", mod + " 的 " + n)
  // 反向：根目录的 svg 与 figures/ 里的图仍是交付物，别把这条修过头
  assert.equal(kind("chat", "路线图.svg"), "main")
  assert.equal(kind("chat", "figures/fig1.svg"), "main")
})

test("按目录降级不能误伤 figure —— 它的交付物本来就是 svg/png", () => {
  // 所以修法是把 svg_output/ svg_final/ backup/ 判成中间目录，
  // 而【不是】把 svg/png 从成品扩展名里删掉。
  for (const n of ["figures/fig1.png", "fig2.svg", "figures/fig3.svg", "fig4.png"])
    assert.equal(kind("figure", n), "main", n)
  for (const n of ["fig1.png", "figures/fig2.svg", "路线图.svg"])
    assert.equal(kind("paper", n), "main", n)
})

test("backup/<时间戳>/ 底下一律副产物：那是重复副本，不是第二份交付", () => {
  assert.equal(kind("litread", "稿件/backup/20260815/svg_output/page-01.svg"), "aux")
  // 连交付扩展名也一样——备份出来的 pptx 不该和正本并排
  assert.equal(kind("figure", "proj/backup/20260815/figures/fig1.png"), "aux")
})

test("PPT 会话推进微信的是 .pptx，不是一堆 SVG", () => {
  for (const mod of ["litread", "chat"]) {
    const { send, held } = WF.pickChatFiles(PPT_TREE, { mod })
    assert.ok(send.every((f) => !f.endsWith(".svg")), `${mod} 不许把 SVG 推给用户：${send}`)
    assert.equal(send[0], "汇报.pptx", `${mod} 交付物要排在最前`)
    assert.equal(held, PPT_TREE.length - send.length)
  }
})

// ---- /api/outputs 的 kind 字段（含 pre 那一档）----
// pre = 会话开始前就在目录里的文件。文件夹会话的工作目录就是用户自己的目录，
// 他那几百篇原始 PDF 必须能和"这次做出来的"分开，否则侧栏永远是一片噪声。
test("/api/outputs 要给每个文件带上分级，且会话开始前就存在的判成 pre", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akind-"))
  const sid = "ses_kindtest"
  // opencode 不可达时 sessionOut 回落到 <仓库根>/outputs/<sid>（ROOT 由 server.mjs 按自身位置算，
  // 不是 cwd —— 用 cwd 拼会在 web/outputs 下建出一个永远不会被读到的目录）
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..")
  const outRoot = path.join(repoRoot, "outputs", sid)
  fs.mkdirSync(outRoot, { recursive: true })
  t.after(() => { try { fs.rmSync(outRoot, { recursive: true, force: true }) } catch {}; try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  const started = Date.now()
  // 会话开始【之前】就在的（把 mtime 往前调一小时）
  fs.writeFileSync(path.join(outRoot, "用户自己的.pdf"), "x")
  const old = new Date(started - 3600_000)
  fs.utimesSync(path.join(outRoot, "用户自己的.pdf"), old, old)
  // 会话期间产出的
  fs.writeFileSync(path.join(outRoot, "library.xlsx"), "x")
  fs.writeFileSync(path.join(outRoot, "scan.py"), "x")

  const metaPath = path.join(dir, "sessions-meta.json")
  fs.writeFileSync(metaPath, JSON.stringify({ sessions: { [sid]: { startedAt: started, module: "litmanage" } }, projects: [], folders: [] }))
  const over = {
    MANAGE_OC: "0", PORT: "0", OC_URL: "http://127.0.0.1:1",
    HOME: dir, USERPROFILE: dir,
    SESSIONS_META_PATH: metaPath,
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "", SUGGEST_ENABLED: "0",
  }
  const saved = {}
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  let mod
  try { mod = await import(`../server.mjs?akind=1`) } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  assert.ok(port, "网关没起来")
  t.after(() => new Promise((r) => mod.server.close(r)))

  const list = await fetch(`http://127.0.0.1:${port}/api/outputs?sid=${sid}`).then((r) => r.json())
  const by = Object.fromEntries(list.map((x) => [x.name, x.kind]))
  assert.equal(by["用户自己的.pdf"], "pre", "会话开始前就在目录里的要判成 pre，不能混进产出")
  assert.equal(by["library.xlsx"], "main")
  assert.equal(by["scan.py"], "aux")

  // 打包下载：默认不含 pre；scope=main 只要主产物
  const zipAll = await fetch(`http://127.0.0.1:${port}/api/download-all?sid=${sid}`)
  assert.equal(zipAll.status, 200)
  const bufAll = Buffer.from(await zipAll.arrayBuffer())
  assert.ok(!bufAll.includes(Buffer.from("用户自己的.pdf", "utf8")), "用户原有的文件不该被打进「本次产出」")
  assert.ok(bufAll.includes(Buffer.from("scan.py", "utf8")), "默认范围要含中间文件")
  const zipMain = await fetch(`http://127.0.0.1:${port}/api/download-all?sid=${sid}&scope=main`)
  const bufMain = Buffer.from(await zipMain.arrayBuffer())
  assert.ok(bufMain.includes(Buffer.from("library.xlsx", "utf8")))
  assert.ok(!bufMain.includes(Buffer.from("scan.py", "utf8")), "scope=main 不该含中间文件")
})

// 用不到的 http 引用留着会被 lint 挑出来，这里显式消费一下（保持与其它测试同风格的最小依赖）
void http
