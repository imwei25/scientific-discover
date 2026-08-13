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

// ---- 以下两条来自模拟用户测试（sonnet agent）抓到的两个 Major ----
test("并行分支不连坐：后一轮重跑统计，不许把毫无依赖的基线表标「已过期」", () => {
  const dir = tmp()
  // paper 模块：table1 与 stats 是并行分支（都只吃原始数据），staleUp 必须沿 deps 判，不按数组下标。
  // ★ 表单必须给 materials/studyType：stats 与 table1 都挂着 when 条件，空表单时整步被裁掉，
  //   断言会对着一条不存在的步骤空转（第一版就踩了这个坑）。
  touch(dir, "table1.csv"); touch(dir, "stats_extra.csv"); touch(dir, "fig1.png")
  seed(dir, { module: "paper", form: { materials: ["rawdata"], studyType: "retrospective" },
    done: [], batchN: 2,
    batches: { "table1.csv": 1, "stats_extra.csv": 2, "fig1.png": 2 } })   // 第 2 轮重跑了统计+画图
  const st = WFS.wfSyncDone(dir, "paper",
    { "table1.csv": 1, "stats_extra.csv": 2, "fig1.png": 2 })
  assert.ok(!(st.stale || []).includes("table1"), "基线表不消费统计产物，不许被连坐标过期")
  assert.ok((st.done || []).includes("table1"))
  // 真实依赖链照抓：figure deps 含 stats，图(第2轮)不比统计(第2轮)旧 → figure 也不过期
  assert.ok(!(st.stale || []).includes("figure"))
})

test("deps 链上的真过期仍然抓：改了稿（write），下游 refcheck/render 照标", () => {
  const dir = tmp()
  touch(dir, "evidence_table.csv"); touch(dir, "review.md")
  touch(dir, "refcheck_report.md", "核查结论：全部通过。"); touch(dir, "review.docx")
  seed(dir, { module: "review", form: {}, done: [], batchN: 3,
    batches: { "evidence_table.csv": 1, "review.md": 3,          // 第 3 轮改了稿
      "refcheck_report.md": 2, "review.docx": 2 } })              // 闸和 docx 停在第 2 轮
  const st = WFS.wfSyncDone(dir, "review",
    { "evidence_table.csv": 1, "review.md": 3, "refcheck_report.md": 2, "review.docx": 2 })
  assert.ok(st.stale.includes("refcheck"), "闸绿的是旧稿 → 过期")
  assert.ok(st.stale.includes("render"), "docx 排的是旧稿 → 过期")
})

test("归因不连坐：多技能轮里的孤儿文件不许把没产出的步骤补绿", () => {
  const dir = tmp()
  seed(dir, { module: "review", form: {}, done: [] })
  // 一轮同时调了排版(正常出件)与润色(什么都没写)，外加一份无主杂文件 —— 谁都不许被归因
  WFS.wfAttribute(dir, "review", ["render-pdf-doc", "humanize-academic"],
    ["review.docx", "random_notes.md"], { "review.docx": 1, "random_notes.md": 1 })
  assert.ok(!(WFS.wfLoad(dir).attributed || []).length, "孤儿文件是谁写的无从判定，多技能轮不归因")
})

// ---- 以下一组来自 2026-08-13 综述模块实测（用户反馈「全部做完了，条子说还没出件/还在润色」）----
test("出件契约覆盖成文步全部命名系：literature_review / *_review / *_humanized 的 docx 都算出件", () => {
  // render_docx.sh 不带 -o 时输出=输入名换后缀，成文契约允许的每一种 .md 命名都会产生对应 .docx
  for (const name of ["literature_review.docx", "PD1_review.docx", "literature_review_humanized.docx"]) {
    const dir = tmp()
    touch(dir, "literature_review.md")
    touch(dir, "refcheck_report.md", "核查结论：全部通过。")
    touch(dir, name)
    seed(dir, { module: "review", form: {}, done: [] })
    const st = WFS.wfSyncDone(dir, "review",
      { "literature_review.md": 1, "refcheck_report.md": 2, [name]: 3 })
    assert.ok(st.done.includes("render"), `${name} 应点亮「排版出件」`)
  }
})

test("grant：grant_proposal.docx 算「标书最终成稿」的产物（proposal* 从头匹配收不到它）", () => {
  const dir = tmp()
  touch(dir, "grant_proposal.md"); touch(dir, "grant_proposal.docx")
  seed(dir, { module: "grant", form: {}, done: [] })
  const st = WFS.wfSyncDone(dir, "grant", { "grant_proposal.md": 1, "grant_proposal.docx": 2 })
  assert.ok((st.done || []).includes("write"))
  assert.ok((st.done || []).includes("render"))
})

test("多技能轮扩展名唯一归因：单轮全流程 + 自由命名 docx，出件步不再永远灰", () => {
  const dir = tmp()
  seed(dir, { module: "review", form: {}, done: [] })
  // 综述最常见跑法：一轮跑完全流程。出件取了自由名（中文），.docx 只有出件步契约收 → 唯一 → 归因
  const fstate = { "evidence_table.csv": 1, "PD-1综述.md": 2, "refcheck_report.md": 3, "PD-1综述.docx": 4 }
  WFS.wfAttribute(dir, "review", ["search-lit", "literature-review", "reference-check", "render-docx"],
    ["evidence_table.csv", "PD-1综述.md", "refcheck_report.md", "PD-1综述.docx"], fstate)
  assert.deepEqual(WFS.wfLoad(dir).attributed, ["render"], ".docx 唯一映射到出件步；.md 人人都写，歧义不归因")
  const st = WFS.wfSyncDone(dir, "review", fstate)
  assert.ok(st.done.includes("render"))
})

test("多技能轮里同一扩展名有两个候选步 → 歧义不归因（唯一性是硬条件）", () => {
  const dir = tmp()
  seed(dir, { module: "paper", form: { materials: ["rawdata"], studyType: "retrospective" }, done: [] })
  // paper 的作图步（fig*.pdf）与出件步（manuscript*.pdf）都收 .pdf → 一份无主 pdf 谁也不许认领
  WFS.wfAttribute(dir, "paper", ["nature-figure", "render-docx"],
    ["extra_chart.pdf"], { "extra_chart.pdf": 1 })
  assert.ok(!(WFS.wfLoad(dir).attributed || []).length)
})

test("emitsNot 黑名单不走归因侧门：报告转 docx 不许归因给出件步", () => {
  const dir = tmp()
  seed(dir, { module: "review", form: {}, done: [] })
  // refcheck_report.docx 被出件步的 emitsNot 点名排除 —— emits 那条路挡住了，归因这条侧门也必须挡
  WFS.wfAttribute(dir, "review", ["reference-check", "render-docx"],
    ["refcheck_report.md", "refcheck_report.docx"],
    { "review.md": 1, "refcheck_report.md": 2, "refcheck_report.docx": 2 })
  assert.ok(!(WFS.wfLoad(dir).attributed || []).length)
})

test("被跳过的可选步不补 implied：综述跳过润色直接出件，「语言润色」保持灰而不是谎称跑过", () => {
  const dir = tmp()
  touch(dir, "review.md")
  touch(dir, "refcheck_report.md", "核查结论：全部通过。")
  touch(dir, "review.docx")
  seed(dir, { module: "review", form: {}, done: [] })
  const st = WFS.wfSyncDone(dir, "review",
    { "review.md": 1, "refcheck_report.md": 2, "review.docx": 3 })
  assert.ok(st.done.includes("render"))
  assert.ok(!st.done.includes("humanize"), "可选步没跑就是没跑，不进 done")
  assert.ok(!st.implied.includes("humanize"), "更不许标「跑过了但没有产物」")
  // 非可选步的单调补齐不受影响（search 无产物仍标 implied）
  assert.ok(st.done.includes("search") && st.implied.includes("search"))
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
