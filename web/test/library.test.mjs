// 文献管理模块的服务端半边：xlsx 读写、台账改分类、按分类归档 / 撤销。
//
// 这三件事都是【确定性操作】且会动用户硬盘上的原始文献，所以必须有回归测试守着：
//   · xlsx 自己解自己写的（openpyxl 生成的那一版在真机上验，这里守住"我们写的 Excel 能被读回来"）
//   · 改分类必须同时改 library.json 与 library.xlsx，两边不能漂
//   · 归档必须可预演、可撤销，且台账里的 file 字段跟着走（否则第二次归档就找不到文件）
//   · 台账里的 file 来自模型，是不可信输入：../ 逃出会话目录必须被挡住
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readXlsx, writeXlsx, colName, colIndex, safeSheetName } from "../xlsx-lite.mjs"
import * as Lib from "../library.mjs"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "libtest-"))

const LIB = {
  classified: true,
  rule: "按研究类型分",
  columns: ["文件名", "标题", "年份", "作者", "杂志", "核心观点"],
  fields: ["file", "title", "year", "authors", "journal", "point"],
  categories: ["随机对照试验", "队列研究"],
  records: [
    { file: "a.pdf", category: "随机对照试验", title: "A 试验", year: "2021", authors: "Smith J, et al.", journal: "Lancet", point: "A 优于 B（HR 0.72）" },
    { file: "b.docx", category: "随机对照试验", title: "B 试验", year: "原文未标注", authors: "李雷 等", journal: "中华医学杂志", point: "两组无差异" },
    { file: "sub/c.pdf", category: "队列研究", title: "C 队列", year: "2019", authors: "Wang L", journal: "BMJ", point: "暴露与结局相关（RR 1.4）" },
  ],
}

function seed(dir, lib = LIB) {
  for (const r of lib.records) {
    const p = path.join(dir, r.file)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, "x")
  }
  Lib.saveLibrary(dir, JSON.parse(JSON.stringify(lib)))
}

test("xlsx 读写往返：多 sheet、中文、需要转义的字符、长文本都要原样回来", () => {
  const nasty = 'a & b < c > d "q" \'s\' 5<10'
  const buf = writeXlsx([
    { name: "随机对照试验", widths: [34, 42], rows: [["文件名", "核心观点"], ["a.pdf", nasty], ["b.pdf", "换行\n第二段"]] },
    { name: "队列研究", rows: [["文件名", "核心观点"], ["c.pdf", "x".repeat(500)]] },
  ])
  const { sheets } = readXlsx(buf)
  assert.equal(sheets.length, 2)
  assert.deepEqual(sheets.map((s) => s.name), ["随机对照试验", "队列研究"])
  assert.equal(sheets[0].rows[1][1], nasty, "转义字符必须原样回来，不能变成 &amp;")
  assert.equal(sheets[0].rows[2][1], "换行\n第二段")
  assert.equal(sheets[1].rows[1][1].length, 500)
})

test("列引用换算与 sheet 名消毒（Excel 的硬规矩）", () => {
  assert.equal(colName(0), "A"); assert.equal(colName(25), "Z"); assert.equal(colName(26), "AA")
  assert.equal(colIndex("A"), 0); assert.equal(colIndex("AA"), 26); assert.equal(colIndex("AB"), 27)
  const used = new Set()
  assert.equal(safeSheetName("随机/对照:试验", used), "随机_对照_试验", "非法字符要换掉，否则 Excel 判定文件损坏")
  assert.equal(safeSheetName("同名", used), "同名")
  assert.equal(safeSheetName("同名", used), "同名(2)", "重名要自动加序号，不能悄悄丢一个 sheet")
  assert.equal(safeSheetName("", used), "未分类")
  assert.ok(safeSheetName("超长".repeat(40), used).length <= 31)
})

test("按台账出 Excel：一类一个 sheet，顺序照 categories，缺分类的落到「未分类」", () => {
  const dir = tmp()
  const lib = JSON.parse(JSON.stringify(LIB))
  lib.records.push({ file: "d.pdf", title: "D", year: "2020", authors: "", journal: "", point: "" })  // 没写 category
  Lib.rebuildWorkbook(dir, lib)
  const { sheets } = readXlsx(fs.readFileSync(path.join(dir, "library.xlsx")))
  assert.deepEqual(sheets.map((s) => s.name), ["随机对照试验", "队列研究", "未分类"])
  assert.deepEqual(sheets[0].rows[0], LIB.columns, "表头就是 columns，别自作主张改列")
  assert.equal(sheets[0].rows.length, 3, "表头 + 2 篇")
  assert.equal(sheets[2].rows[1][0], "d.pdf", "没分类的不能被悄悄丢掉")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("改分类：library.json 与 library.xlsx 必须一起变；可以新建一个类；类空了就不再出 sheet", () => {
  const dir = tmp(); seed(dir)
  Lib.moveRecord(dir, "sub/c.pdf", "随机对照试验")
  let lib = Lib.loadLibrary(dir)
  assert.equal(lib.records.find((r) => r.file === "sub/c.pdf").category, "随机对照试验")
  let sheets = readXlsx(fs.readFileSync(path.join(dir, "library.xlsx"))).sheets
  assert.deepEqual(sheets.map((s) => s.name), ["随机对照试验"], "队列研究被搬空了，不该留一个空 sheet")
  assert.equal(sheets[0].rows.length, 4)

  Lib.moveRecord(dir, "b.docx", "个案报道")           // 新类
  sheets = readXlsx(fs.readFileSync(path.join(dir, "library.xlsx"))).sheets
  assert.deepEqual(sheets.map((s) => s.name), ["随机对照试验", "个案报道"])
  assert.throws(() => Lib.moveRecord(dir, "不存在.pdf", "X"), /没有这一篇/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("归档：先预演不动文件，执行后原文件进子文件夹、台账路径跟着走，撤销能原样搬回", () => {
  const dir = tmp(); seed(dir)
  const plan = Lib.archivePlan(dir)
  assert.equal(plan.plan.length, 3)
  assert.ok(plan.plan.every((p) => p.to.startsWith("随机对照试验/") || p.to.startsWith("队列研究/")))
  assert.ok(fs.existsSync(path.join(dir, "a.pdf")), "预演绝不许动文件")

  const r = Lib.archiveApply(dir)
  assert.equal(r.moved, 3)
  assert.equal(r.failed.length, 0)
  assert.ok(fs.existsSync(path.join(dir, "随机对照试验", "a.pdf")))
  assert.ok(!fs.existsSync(path.join(dir, "a.pdf")), "移动就是移动，原位置不该还留着")
  assert.ok(fs.existsSync(path.join(dir, "队列研究", "c.pdf")), "子目录里的文件也按类归位")
  const lib = Lib.loadLibrary(dir)
  assert.equal(lib.records.find((x) => x.title === "A 试验").file, "随机对照试验/a.pdf", "台账不同步的话，第二次归档就找不到文件了")
  assert.ok(fs.existsSync(path.join(dir, "archive_log.json")))

  // 归好位之后再预演一次：全都在位，没有要移动的
  assert.equal(Lib.archivePlan(dir).plan.length, 0)

  // ★ Excel 的「文件名」列必须跟着变成新路径。不重出的实测后果：预览里每一行都判成
  //   "台账里没有这一篇"，改分类的下拉当场全部失效（界面按这一列去台账里找记录）。
  const after = readXlsx(fs.readFileSync(path.join(dir, "library.xlsx"))).sheets
  const files = after.flatMap((s) => s.rows.slice(1).map((r) => r[0]))
  assert.ok(files.every((f) => f.includes("/")), "归档后 Excel 里的文件名要是「类名/文件名」：" + files.join("、"))

  const u = Lib.archiveUndo(dir)
  assert.equal(u.restored, 3)
  assert.ok(fs.existsSync(path.join(dir, "a.pdf")))
  assert.ok(fs.existsSync(path.join(dir, "sub", "c.pdf")), "原来在子目录里的要搬回子目录")
  assert.ok(!fs.existsSync(path.join(dir, "随机对照试验")), "搬空的分类目录要收拾掉")
  assert.equal(Lib.loadLibrary(dir).records.find((x) => x.title === "A 试验").file, "a.pdf")
  assert.ok(!fs.existsSync(path.join(dir, "archive_log.json")))
  const back = readXlsx(fs.readFileSync(path.join(dir, "library.xlsx"))).sheets.flatMap((s) => s.rows.slice(1).map((r) => r[0]))
  assert.ok(back.includes("a.pdf"), "撤销之后 Excel 的文件名列也要跟着回到原路径：" + back.join("、"))
  fs.rmSync(dir, { recursive: true, force: true })
})

test("复制归档：原件留在原地，台账不改路径，且不给撤销（没什么可撤的）", () => {
  const dir = tmp(); seed(dir)
  const r = Lib.archiveApply(dir, { copy: true })
  assert.equal(r.moved, 3)
  assert.ok(fs.existsSync(path.join(dir, "a.pdf")), "复制不许动原件")
  assert.ok(fs.existsSync(path.join(dir, "随机对照试验", "a.pdf")))
  assert.equal(Lib.loadLibrary(dir).records[0].file, "a.pdf")
  assert.throws(() => Lib.archiveUndo(dir), /不需要撤销/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("台账里的 file 是模型写的，属不可信输入：逃出会话目录的一律不当文件处理", () => {
  const dir = tmp()
  const outside = path.join(dir, "..", "outside-" + path.basename(dir) + ".pdf")
  fs.writeFileSync(outside, "机密")
  const lib = { ...LIB, records: [{ file: "../" + path.basename(outside), category: "X", title: "坏", year: "", authors: "", journal: "", point: "" }] }
  Lib.saveLibrary(dir, lib)
  const plan = Lib.archivePlan(dir)
  assert.equal(plan.plan.length, 0, "绝不能把会话目录外的文件排进归档计划")
  assert.equal(plan.missing.length, 1)
  const r = Lib.archiveApply(dir)
  assert.equal(r.moved, 0)
  assert.ok(fs.existsSync(outside), "目录外的文件一根汗毛都不许动")
  fs.rmSync(outside, { force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test("同名冲突不覆盖：两个不同目录下的同名文件归到同一类时，第二个自动改名", () => {
  const dir = tmp()
  const lib = { ...LIB, categories: ["综述"], records: [
    { file: "x/paper.pdf", category: "综述", title: "1", year: "", authors: "", journal: "", point: "" },
    { file: "y/paper.pdf", category: "综述", title: "2", year: "", authors: "", journal: "", point: "" },
  ] }
  seed(dir, lib)
  const r = Lib.archiveApply(dir)
  assert.equal(r.moved, 2)
  assert.ok(fs.existsSync(path.join(dir, "综述", "paper.pdf")))
  assert.ok(fs.existsSync(path.join(dir, "综述", "paper (2).pdf")), "同名必须留两份，不能悄悄覆盖掉一篇文献")
  fs.rmSync(dir, { recursive: true, force: true })
})
