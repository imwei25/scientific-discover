// oc-wrap「先上传后提问」判定的单测：只发文件（含中文本地化外壳、含空格路径、图片经 --file）
// 该识别为 file-only；带正文的、纯文本的不该。import 不会触发入口分发（isMain 守卫）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { classifyRun, attachPaths, stripRefs, imageArgs, stageFiles, consumePending, stdoutAbandoned, agentSessionOf, stallReason, silenceDue } from "../chat-bridge/oc-wrap.mjs"

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

// ── stdout 被抛弃的判定 ──────────────────────────────────────────────────────
// cc-connect 对"出队的第一条消息"不读 agent 的 stdout，几百毫秒就宣告 turn complete 并发出
// 占位符「(空响应)」。判据：属于本 agent_session 的 turn complete，落在【我们启动之后、
// 我们吐出第一个字节之前】。最要紧的是别误判——误判会让正常轮次把答案重复推一遍。
const SID = "ses_abc123"
const line = (t, extra = "") => `time=${t} level=INFO msg="turn complete" session=s3 agent_session=${SID} ${extra}`

test("stdoutAbandoned：出队首条被抛弃 → 判定成立", () => {
  // 我们 10:00:00.500 起跑，还没输出过（Infinity）；10:00:00.900 就冒出一条 turn complete
  const log = line("2026-08-15T10:00:00.900+08:00", "response_len=11")
  assert.equal(stdoutAbandoned(log, SID, Date.parse("2026-08-15T10:00:00.500+08:00"), Infinity), true)
})

test("stdoutAbandoned：正常轮次（turn complete 在我们输出之后）→ 不判定", () => {
  // 这是同一份日志里【上一轮】的完成记录：它发生在我们首个字节【之后】，不是冲我们来的。
  // 上一轮的 wrapper 此刻可能还在做收尾（送文件、等 send 回调），绝不能让它也去补推一遍。
  const log = line("2026-08-15T10:00:20.000+08:00", "response_len=405")
  const start = Date.parse("2026-08-15T10:00:00.500+08:00")
  const firstOut = Date.parse("2026-08-15T10:00:19.000+08:00")
  assert.equal(stdoutAbandoned(log, SID, start, firstOut), false)
})

test("stdoutAbandoned：我们起跑之前的记录一律不算", () => {
  const log = line("2026-08-15T09:59:59.000+08:00", "response_len=11")
  assert.equal(stdoutAbandoned(log, SID, Date.parse("2026-08-15T10:00:00.500+08:00"), Infinity), false)
})

test("stdoutAbandoned：别的会话的 turn complete 不算（多平台并存时会混在同一份日志里）", () => {
  const log = `time=2026-08-15T10:00:00.900+08:00 level=INFO msg="turn complete" agent_session=ses_OTHER response_len=11`
  assert.equal(stdoutAbandoned(log, SID, Date.parse("2026-08-15T10:00:00.500+08:00"), Infinity), false)
})

test("stdoutAbandoned：拿不到 session / 日志为空 → 保守不判定", () => {
  const log = line("2026-08-15T10:00:00.900+08:00")
  assert.equal(stdoutAbandoned(log, "", Date.parse("2026-08-15T10:00:00.500+08:00"), Infinity), false)
  assert.equal(stdoutAbandoned("", SID, Date.parse("2026-08-15T10:00:00.500+08:00"), Infinity), false)
  assert.equal(stdoutAbandoned(null, SID, 0, Infinity), false)
})

test("agentSessionOf：从 argv 取 --session；没有就空串", () => {
  assert.equal(agentSessionOf(["run", "--format", "json", "--session", SID, "--thinking"]), SID)
  assert.equal(agentSessionOf(["run", "--format", "json"]), "")
  assert.equal(agentSessionOf(["run", "--session"]), "")   // 末尾缺值别读出 undefined
  assert.equal(agentSessionOf(undefined), "")
})

// ── 卡住时的原因识别 ────────────────────────────────────────────────────────
// 云端排队/限速只写进 gateway.log（网关把它 SSE 广播给网页界面，聊天这条链路收不到）。
// 真机 2026-08-15：用户问美股，10 分钟零反馈，而 gateway.log 里已有 6 条「上游限速中」。
test("stallReason：认出上游限速", () => {
  assert.equal(stallReason("[cloud] 云端正忙：上游限速中\n"), "云端上游正在限速（大家都在用，得排队）")
})

test("stallReason：认出排队并带上位次", () => {
  assert.equal(stallReason("[cloud] 云端正忙：排队第 3 位（共 5 个在等，2 个在跑）"), "云端排队中（当前第 3 位）")
})

test("stallReason：无关日志不瞎猜原因", () => {
  // 说不出原因就返回空串，让调用方退回"还在等模型响应"的中性说法——
  // 编一个原因比不说更糟：用户会照着那个错误的原因去做无用功。
  for (const s of ["gateway on http://localhost:27821", "[oc] 就绪", "", null, undefined])
    assert.equal(stallReason(s), "")
})

// 静默播报的节流：首次门槛短（用户屏幕上什么都没有，等太久他会以为软件死了、反复重发），
// 之后拉长；报够次数就闭嘴。两个条件都要满足：距最后事件够久 且 距上次播报够久。
test("silenceDue：首次用短门槛，未到不报", () => {
  const base = { lastEventAt: 0, lastSilenceAt: 0, notices: 0, first: 90_000, repeat: 300_000, max: 4 }
  assert.equal(silenceDue({ ...base, now: 89_000 }), false)
  assert.equal(silenceDue({ ...base, now: 90_000 }), true)
})

test("silenceDue：报过一次后改用长间隔", () => {
  const base = { lastEventAt: 0, notices: 1, first: 90_000, repeat: 300_000, max: 4 }
  assert.equal(silenceDue({ ...base, now: 200_000, lastSilenceAt: 90_000 }), false)
  assert.equal(silenceDue({ ...base, now: 400_000, lastSilenceAt: 90_000 }), true)
})

test("silenceDue：刚有过事件就不该报（哪怕上次播报很久以前）", () => {
  assert.equal(silenceDue({ now: 600_000, lastEventAt: 599_000, lastSilenceAt: 0, notices: 1, first: 90_000, repeat: 300_000, max: 4 }), false)
})

test("silenceDue：报满上限就闭嘴，剩下交给用户判断", () => {
  assert.equal(silenceDue({ now: 1e9, lastEventAt: 0, lastSilenceAt: 0, notices: 4, first: 90_000, repeat: 300_000, max: 4 }), false)
})
