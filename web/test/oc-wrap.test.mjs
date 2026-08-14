// oc-wrap「先上传后提问」判定的单测：只发文件（含中文本地化外壳、含空格路径、图片经 --file）
// 该识别为 file-only；带正文的、纯文本的不该。import 不会触发入口分发（isMain 守卫）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { classifyRun, attachPaths, stripRefs, imageArgs, stageFiles, consumePending } from "../chat-bridge/oc-wrap.mjs"

const A = ["run", "--format", "json"]   // cc-connect 固定前缀
const ATT = "C:\\Users\\u\\Niuma Science\\out\\.cc-connect\\attachments\\m1"
const IMG = "C:\\Users\\u\\out\\.cc-connect\\images\\a.png"

test("imageArgs：取出所有 --file 路径", () => {
  assert.deepEqual(imageArgs([...A, "--file", IMG]), [IMG])
  assert.deepEqual(imageArgs([...A, "--file", IMG, "--file", "C:\\x\\.cc-connect\\images\\b.jpg"]).length, 2)
  assert.deepEqual(imageArgs(A), [])
})

test("attachPaths：从引用块抠出附件绝对路径（含空格、多个）", () => {
  const p = `\n\n(Files saved locally, please read them: ${ATT}\\a b.xlsx, ${ATT}\\c.csv)`
  assert.deepEqual(attachPaths(p), [`${ATT}\\a b.xlsx`, `${ATT}\\c.csv`])
})

test("stripRefs：剥掉引用块与图片占位语后看正文", () => {
  assert.equal(stripRefs(`\n\n(Files saved locally, please read them: ${ATT}\\a.xlsx)`), "")
  assert.equal(stripRefs("Please analyze the attached image(s)."), "")
  assert.equal(stripRefs(`帮我分析这个表\n\n(Files saved locally, please read them: ${ATT}\\a.xlsx)`), "帮我分析这个表")
})

test("file-only：只发普通文件、无正文 → 命中", () => {
  const r = classifyRun(A, `\n\n(Files saved locally, please read them: ${ATT}\\data.xlsx)`)
  assert.equal(r.fileOnly, true)
  assert.deepEqual(r.staged, [`${ATT}\\data.xlsx`])
})

test("file-only：只发图片（--file）、prompt 是占位语 → 命中", () => {
  const r = classifyRun([...A, "--file", IMG], "Please analyze the attached image(s).")
  assert.equal(r.fileOnly, true)
  assert.deepEqual(r.staged, [IMG])
})

test("file-only：cc-connect 把外壳本地化成中文也不影响（路径不翻译）", () => {
  const r = classifyRun(A, `\n\n(文件已保存到本地，请阅读：${ATT}\\报告.pdf)`)
  assert.equal(r.fileOnly, true, "靠 .cc-connect 路径锚定，免疫外壳本地化")
  assert.deepEqual(r.staged, [`${ATT}\\报告.pdf`])
})

test("非 file-only：文件带了正文 → 照常跑模型", () => {
  const r = classifyRun(A, `这张表说明了什么\n\n(Files saved locally, please read them: ${ATT}\\a.xlsx)`)
  assert.equal(r.fileOnly, false)
})

test("非 file-only：图片带了说明 → 照常跑模型", () => {
  const r = classifyRun([...A, "--file", IMG], "这张图里的曲线是什么趋势？")
  assert.equal(r.fileOnly, false)
})

test("非 file-only：纯文本、没有任何文件 → 照常跑模型", () => {
  const r = classifyRun(A, "帮我查一下最新的文献")
  assert.equal(r.fileOnly, false)
  assert.deepEqual(r.staged, [])
})

test("stageFiles：把文件剪切进会话 uploads\\、登记台账；consumePending 取出并清台账", () => {
  const cwd0 = process.cwd()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sci-upl-"))
  try {
    process.chdir(work)
    // 模拟 cc-connect 存下的入站文件
    const attDir = path.join(work, ".cc-connect", "attachments", "m1")
    fs.mkdirSync(attDir, { recursive: true })
    const src = path.join(attDir, "data.xlsx"); fs.writeFileSync(src, "xx")

    const added = stageFiles([src])
    assert.equal(added.length, 1)
    const dest = path.join(work, "uploads", "data.xlsx")
    assert.ok(fs.existsSync(dest), "文件已进 uploads\\")
    assert.ok(!fs.existsSync(src), "原件被剪切走（move 而非 copy）")
    assert.equal(added[0].path, dest)

    // 第二次同名 → 去重不覆盖
    fs.mkdirSync(attDir, { recursive: true }); const src2 = path.join(attDir, "data.xlsx"); fs.writeFileSync(src2, "yy")
    const added2 = stageFiles([src2])
    assert.ok(added2[0].path.endsWith(path.join("uploads", "1_data.xlsx")), "同名加数字前缀")

    const got = consumePending()
    assert.deepEqual(got.map((e) => e.name).sort(), ["1_data.xlsx", "data.xlsx"], "两条都在，且台账清空")
    assert.equal(consumePending().length, 0, "消费后台账已空")
  } finally {
    process.chdir(cwd0)
    try { fs.rmSync(work, { recursive: true, force: true }) } catch {}
  }
})

// ---- 投递看门狗：bridge.log 里认哪些行算"微信投递失败"（行样式取自真机日志）----
test("deliveryFailedSince：只认 sinceMs 之后的微信失败行", async () => {
  const { deliveryFailedSince } = await import("../chat-bridge/oc-wrap.mjs")
  const LOG = [
    `time=2026-08-14T20:54:51.832+08:00 level=ERROR msg="weixin: chunk send failed, message incomplete" peer=o9@im.wechat failed_chunk=1/1 error="weixin: sendMessage ret=-2 (expired context_token)"`,
    `time=2026-08-14T20:54:52.014+08:00 level=ERROR msg="platform send failed" platform=weixin error="weixin: send chunk 1/1: ..." content_len=334`,
    `time=2026-08-14T20:54:52.681+08:00 level=WARN msg="weixin: sendMessage ret=-2 for media, no fresh context_token" attempt=1 peer=o9@im.wechat`,
    `time=2026-08-14T20:55:00.000+08:00 level=INFO msg="message received" platform=weixin content_len=4`,
  ].join("\n")
  const t0 = Date.parse("2026-08-14T20:54:00+08:00")
  const r = deliveryFailedSince(LOG, t0)
  assert.equal(r.text, true); assert.equal(r.media, true)
  // sinceMs 在失败之后 → 全都是旧账，不算（防止一次失败被反复补发）
  const r2 = deliveryFailedSince(LOG, Date.parse("2026-08-14T21:00:00+08:00"))
  assert.equal(r2.text, false); assert.equal(r2.media, false)
})

test("deliveryFailedSince：企微失败/普通日志不触发（企微不丢，别乱补发）", async () => {
  const { deliveryFailedSince } = await import("../chat-bridge/oc-wrap.mjs")
  const LOG = [
    `time=2026-08-14T20:54:52.014+08:00 level=ERROR msg="platform send failed" platform=wecom error="..." content_len=10`,
    `time=2026-08-14T20:54:53.000+08:00 level=ERROR msg="failed to send prompt" error="opencodeSession: start: chdir ..."`,
    `time=2026-08-14T20:54:54.000+08:00 level=WARN msg="slow agent send" elapsed=45s session=weixin:dm:o9@im.wechat content_len=74`,
  ].join("\n")
  const r = deliveryFailedSince(LOG, 0)
  assert.equal(r.text, false); assert.equal(r.media, false)
})

// ---- 产物兜底补发只发主产物（用户反馈：微信把副产出也一并发过来了）----
test("pickOutputs：与界面侧栏同一份判据，中间文件只报个数不外发", async () => {
  const { pickOutputs } = await import("../chat-bridge/oc-wrap.mjs")
  const { send, held } = pickOutputs(["manuscript.docx", "notes.md", "tmp.py", "pdfs/a.pdf"], "paper", null)
  assert.deepEqual(send, ["manuscript.docx"])
  assert.equal(held, 3)
  // 用户刚上传的、脱敏还原表：一个都不许回发
  assert.deepEqual(pickOutputs(["uploads/他传的.docx", "deid_mapping.csv"], "paper", null).send, [])
  // workflows.mjs 万一加载不了 → 保守兜底：只发成品扩展名，绝不因此哑掉或反过来全发
  assert.ok(pickOutputs(["x.py", "y.log", "z.docx"], "paper", null).send.includes("z.docx"))
})
