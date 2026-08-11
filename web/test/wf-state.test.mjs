// 流程状态机（wf-state.mjs）的回归测试 —— 每个用例对应一类【实测发生过】的状态误报。
// 状态机原来埋在 server.mjs 里零测试覆盖，每类误报都要等线上用户反馈才发现；
// 抽出模块后这里对临时目录跑真数据，用的模块定义（workflows.mjs）也是真的。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as WFS from "../wf-state.mjs"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wfstate-"))
const seed = (dir, st) => WFS.wfSave(dir, st)
const touch = (dir, rel, content = "x") => {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

// ---------- emits 命中语义 ----------
test("emitMatch：裸 glob 只认根目录，带 / 的整条比", () => {
  assert.equal(WFS.emitMatch("review.md", "review.md"), true)
  // 深层素材/缓存文件不许点亮步骤：basename 全树匹配是假绿的来源之一
  assert.equal(WFS.emitMatch("review.md", "pdfs/review.md"), false)
  assert.equal(WFS.emitMatch("fig*.png", "some/deep/fig_draft.png"), false)
  // 显式声明子目录的照旧
  assert.equal(WFS.emitMatch("audit/*", "audit/REPORT.md"), true)
  assert.equal(WFS.emitMatch("figures/*", "figures/fig1.png"), true)
})

// ---------- staleUp：批次比较 ----------
test("同一轮乱序写文件不再误标「已过期」（mtime 级联的头号误报源）", () => {
  const dir = tmp()
  // 上游（文献检索）的文件 mtime 比下游（综述成文）晚 —— agent 在同轮里回头补写上游文件是常态
  touch(dir, "evidence_table.csv"); touch(dir, "review.md")
  seed(dir, { module: "review", form: {}, done: [], batchN: 1,
    batches: { "evidence_table.csv": 1, "review.md": 1 } })
  const st = WFS.wfSyncDone(dir, "review", { "evidence_table.csv": 2000, "review.md": 1000 })
  assert.deepEqual(st.stale, [], "同批次的文件互相之间没有『谁过期』可言")
  assert.ok(st.done.includes("search") && st.done.includes("write"))
})

test("跨轮才是真过期：上游在更晚的轮里改过 → 下游标 staleUp", () => {
  const dir = tmp()
  touch(dir, "evidence_table.csv"); touch(dir, "review.md")
  seed(dir, { module: "review", form: {}, done: [], batchN: 3,
    batches: { "evidence_table.csv": 3, "review.md": 1 } })
  const st = WFS.wfSyncDone(dir, "review", { "evidence_table.csv": 1, "review.md": 2 })
  assert.ok(st.stale.includes("write") && st.staleUp.includes("write"))
  assert.ok(!st.done.includes("write"))
})

test("没有批次记录（老会话 / 本轮进行中）一律按当前批次算：宁可漏标不误标", () => {
  const dir = tmp()
  touch(dir, "evidence_table.csv"); touch(dir, "review.md")
  seed(dir, { module: "review", form: {}, done: [] })
  const st = WFS.wfSyncDone(dir, "review", { "evidence_table.csv": 9999, "review.md": 1 })
  assert.deepEqual(st.stale, [])
})

// ---------- done 重算（不吃缓存） ----------
test("产物没了绿勾就撤：done 每次从产物重算，误点亮不再永久", () => {
  const dir = tmp()
  seed(dir, { module: "review", form: {}, done: ["write"] })
  const st = WFS.wfSyncDone(dir, "review", {})
  assert.ok(!st.done.includes("write"))
})

test("单调补齐仍在：零结果检索（无产物）在下游完成时标 implied 而不是灰着", () => {
  const dir = tmp()
  touch(dir, "review.md")
  seed(dir, { module: "review", form: {}, done: [] })
  const st = WFS.wfSyncDone(dir, "review", { "review.md": 1 })
  assert.ok(st.done.includes("search") && st.implied.includes("search"))
  assert.ok(st.done.includes("write") && !st.implied.includes("write"))
})

// ---------- 闸：gateReport 与提前变绿 ----------
test("闸只认裁定书：同步产物（preregistration.md）先落盘时闸等报告，不提前绿", () => {
  const dir = tmp()
  touch(dir, "preregistration.md", "H1：缺氧不通过甲基化改变促进复发")   // 假设句，不是裁定
  seed(dir, { module: "grant", form: {}, done: [] })
  const st = WFS.wfSyncDone(dir, "grant", { "preregistration.md": 1 })
  // 注意：状态没有任何变化时返回的是原簿子（可能缺 failed 等字段），断言要兜空
  assert.ok(!(st.done || []).includes("forge"), "裁定书没出来不许绿")
  assert.ok(!(st.failed || []).includes("forge"), "预注册文件里的假设句不许被当裁定误判红")
})

test("裁定书写出后按内容判：不予通过 → failed；通过 → done", () => {
  const dir = tmp()
  touch(dir, "preregistration.md", "假设……")
  touch(dir, "novelty_report.md", "## 裁定\n判定：不予通过（已被回答）")
  seed(dir, { module: "grant", form: {}, done: [] })
  let st = WFS.wfSyncDone(dir, "grant", { "preregistration.md": 1, "novelty_report.md": 2 })
  assert.ok(st.failed.includes("forge"))
  touch(dir, "novelty_report.md", "## 裁定\n判定：通过（真新，可进入标书起草）")
  st = WFS.wfSyncDone(dir, "grant", { "preregistration.md": 1, "novelty_report.md": 3 })
  assert.ok(st.done.includes("forge") && !st.failed.includes("forge"))
})

test("闸红 → 下游产物不论先后一律标「已过期」（不许闸红着还打绿勾出件）", () => {
  const dir = tmp()
  touch(dir, "review.md")
  touch(dir, "refcheck_report.md", "统计：FABRICATED 2，OK 6")
  touch(dir, "review.docx")
  seed(dir, { module: "review", form: {}, done: [] })
  const st = WFS.wfSyncDone(dir, "review",
    { "review.md": 1, "refcheck_report.md": 2, "review.docx": 3 })
  assert.ok(st.failed.includes("refcheck"))
  assert.ok(st.stale.includes("render") && !st.done.includes("render"))
  assert.ok(st.done.includes("write"), "闸上游不受影响")
})

// ---------- 结构化裁定（.gate/<skill>.json） ----------
test("结构化裁定优先：脚本判 pass 时，报告措辞的正则误判不再把闸标红", () => {
  const dir = tmp()
  touch(dir, "review.md")
  // 这份报告按措辞正则必判红（UNVERIFIED 3）——但脚本裁定说 pass 且是同一轮写的
  touch(dir, "refcheck_report.md", "统计：UNVERIFIED 3\n（其余全绿）")
  touch(dir, ".gate/reference-check.json", JSON.stringify({ skill: "reference-check", verdict: "pass" }))
  seed(dir, { module: "review", form: {}, done: [], batchN: 2,
    batches: { "review.md": 1, "refcheck_report.md": 2 },
    gateBatches: { "reference-check.json": 2 } })
  const st = WFS.wfSyncDone(dir, "review", { "review.md": 1, "refcheck_report.md": 2 })
  assert.ok(st.done.includes("refcheck") && !st.failed.includes("refcheck"))
})

test("结构化裁定 fail 恒生效：报告写得再温和闸也红", () => {
  const dir = tmp()
  touch(dir, "review.md")
  touch(dir, "refcheck_report.md", "核查完成，详见附表。")
  touch(dir, ".gate/reference-check.json", JSON.stringify({ skill: "reference-check", verdict: "fail" }))
  seed(dir, { module: "review", form: {}, done: [], batchN: 2,
    batches: { "review.md": 1, "refcheck_report.md": 2 },
    gateBatches: { "reference-check.json": 2 } })
  const st = WFS.wfSyncDone(dir, "review", { "review.md": 1, "refcheck_report.md": 2 })
  assert.ok(st.failed.includes("refcheck"))
})

test("裁定过期护栏：报告在更晚的轮里被重写而脚本没重跑 → 退回措辞判定", () => {
  const dir = tmp()
  touch(dir, "review.md")
  touch(dir, "refcheck_report.md", "统计：UNVERIFIED 3")
  touch(dir, ".gate/reference-check.json", JSON.stringify({ skill: "reference-check", verdict: "pass" }))
  seed(dir, { module: "review", form: {}, done: [], batchN: 3,
    batches: { "review.md": 1, "refcheck_report.md": 3 },       // 报告是第 3 轮重写的
    gateBatches: { "reference-check.json": 2 } })               // 裁定停在第 2 轮
  const st = WFS.wfSyncDone(dir, "review", { "review.md": 1, "refcheck_report.md": 3 })
  assert.ok(st.failed.includes("refcheck"), "过期的 pass 裁定不许替新报告作保")
})

// ---------- emits 收紧（emitsNot） ----------
test("评审报告转的 docx 不算「排版出件」的产物", () => {
  const dir = tmp()
  touch(dir, "review.md"); touch(dir, "refcheck_report.docx")
  seed(dir, { module: "review", form: {}, done: [] })
  const st = WFS.wfSyncDone(dir, "review", { "review.md": 1, "refcheck_report.docx": 2 })
  assert.ok(!st.done.includes("render"))
})

// ---------- 批次记账 ----------
test("wfNoteBatch：本轮 changed 记同一批次、逐轮递增、.gate json 的轮次单独跟踪", () => {
  const dir = tmp()
  touch(dir, ".gate/reference-check.json", "{}")
  WFS.wfNoteBatch(dir, "review", ["a.md", "b.csv"], { "a.md": 1, "b.csv": 1 })
  let st = WFS.wfLoad(dir)
  assert.equal(st.batchN, 1)
  assert.equal(st.batches["a.md"], 1)
  assert.equal(st.gateBatches["reference-check.json"], 1)
  WFS.wfNoteBatch(dir, "review", ["a.md"], { "a.md": 1, "b.csv": 1 })
  st = WFS.wfLoad(dir)
  assert.equal(st.batchN, 2)
  assert.equal(st.batches["a.md"], 2)
  assert.equal(st.batches["b.csv"], 1)
  // json 没动 → 轮次不前移（gateVerdict 判过期就靠这个不前移）
  assert.equal(st.gateBatches["reference-check.json"], 1)
  // 簿子记的是别的模块 → 一个字不动
  const dir2 = tmp()
  seed(dir2, { module: "paper", form: {}, done: [] })
  WFS.wfNoteBatch(dir2, "review", ["x.md"], { "x.md": 1 })
  assert.equal(WFS.wfLoad(dir2).batchN, undefined)
})

// ---------- 兜底归因 ----------
test("产物名不合契约时按本轮调过的技能补记完成，条子不再永远灰", () => {
  const dir = tmp()
  seed(dir, { module: "review", form: {}, done: [] })
  // 本轮调了 literature-review，写出的是不合契约名的「综述初稿.md」
  WFS.wfAttribute(dir, "review", ["literature-review"], ["综述初稿.md"], { "综述初稿.md": 1 })
  assert.deepEqual(WFS.wfLoad(dir).attributed, ["write"])
  const st = WFS.wfSyncDone(dir, "review", { "综述初稿.md": 1 })
  assert.ok(st.done.includes("write"))
})

test("有合约产物就不归因；闸永不归因", () => {
  const dir = tmp()
  seed(dir, { module: "review", form: {}, done: [] })
  // 合约产物在场 → 无主文件不触发对该步的归因（emits 那条路本来就会点亮它）
  WFS.wfAttribute(dir, "review", ["literature-review"], ["杂物.md"], { "review.md": 1, "杂物.md": 1 })
  assert.ok(!(WFS.wfLoad(dir).attributed || []).includes("write"))
  // 闸（reference-check）绝不归因——闸的结论只能由报告得出
  WFS.wfAttribute(dir, "review", ["reference-check"], ["随手记.md"], { "随手记.md": 1 })
  assert.ok(!(WFS.wfLoad(dir).attributed || []).includes("refcheck"))
  // 非交付物体裁（日志/脚本）不算"做出了东西"
  const dir2 = tmp()
  seed(dir2, { module: "review", form: {}, done: [] })
  WFS.wfAttribute(dir2, "review", ["literature-review"], ["debug.log", "tmp.py"], { "debug.log": 1, "tmp.py": 1 })
  assert.ok(!(WFS.wfLoad(dir2).attributed || []).length)
})
