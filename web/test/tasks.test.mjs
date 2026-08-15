// 定时任务的定义层单测：校验归一、下次运行时间、锁、运行记录修剪，以及无头运行器的事件判定。
//
// 全部走临时目录（SCI_TASKS_DIR），不碰开发机真实的 tasks/。
// 【时间断言一律用本地时区构造】nextRunAt 按墙上时间算（Windows 任务计划就是这么触发的），
// 拿 UTC 字符串断言会在非零时区机器上假失败。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sci-tasks-"))
process.env.SCI_TASKS_DIR = dir
process.env.SCI_TASK_KEEP_RUNS = "3"

const T = await import("../tasks.mjs")
const H = await import("../headless-run.mjs")

const baseTask = (over = {}) => ({
  title: "每周文献扫描", prompt: "扫一遍本周新文献并写成 weekly.md",
  schedule: { kind: "daily", time: "07:00" }, ...over,
})

test("normalizeTask：好的定义补齐默认值", () => {
  const { ok, task, errors } = T.normalizeTask(baseTask())
  assert.equal(ok, true, errors.join("；"))
  assert.equal(task.module, "chat")
  assert.equal(task.enabled, true)
  assert.ok(T.validTaskId(task.id))
})

test("normalizeTask：坏的定义把问题一次列全，不是报第一个就停", () => {
  const { ok, errors } = T.normalizeTask({ title: "", prompt: "", schedule: { kind: "weekly", time: "25:00" } })
  assert.equal(ok, false)
  assert.equal(errors.length, 4)   // 缺标题 + 缺内容 + time 非法 + weekly 没选天
})

test("normalizeTask：一次性任务必须给日期", () => {
  assert.equal(T.normalizeTask(baseTask({ schedule: { kind: "once", time: "08:00" } })).ok, false)
  assert.equal(T.normalizeTask(baseTask({ schedule: { kind: "once", time: "08:00", date: "2026-09-01" } })).ok, true)
})

test("nextRunAt：每天——今天还没到就今天，过了就明天", () => {
  const t = T.normalizeTask(baseTask({ schedule: { kind: "daily", time: "07:00" } })).task
  const before = new Date(2026, 7, 11, 6, 0)   // 8/11 06:00 本地
  assert.equal(T.nextRunAt(t, before).getDate(), 11)
  const after = new Date(2026, 7, 11, 9, 0)
  assert.equal(T.nextRunAt(t, after).getDate(), 12)
})

test("nextRunAt：同一分钟算已经过去（否则界面会显示一个 0 秒后的下次运行）", () => {
  const t = T.normalizeTask(baseTask({ schedule: { kind: "daily", time: "07:00" } })).task
  const at = new Date(2026, 7, 11, 7, 0, 30)
  assert.equal(T.nextRunAt(t, at).getDate(), 12)
})

test("nextRunAt：每周——跳到下一个选中的星期几", () => {
  // 2026-08-11 是周二（getDay()=2）；只选周一(1) → 应落在 8/17
  const t = T.normalizeTask(baseTask({ schedule: { kind: "weekly", time: "07:00", days: [1] } })).task
  const nxt = T.nextRunAt(t, new Date(2026, 7, 11, 9, 0))
  assert.equal(nxt.getDay(), 1)
  assert.equal(nxt.getDate(), 17)
})

test("nextRunAt：一次性任务过期后返回 null（不再触发）", () => {
  const t = T.normalizeTask(baseTask({ schedule: { kind: "once", time: "08:00", date: "2026-08-01" } })).task
  assert.equal(T.nextRunAt(t, new Date(2026, 7, 11)), null)
})

test("增删查：存了能读出来，删了连历史一起没", () => {
  const t = T.normalizeTask(baseTask({ title: "任务A" })).task
  T.saveTask(t)
  assert.equal(T.readTask(t.id).title, "任务A")
  assert.ok(T.listTasks().some((x) => x.id === t.id))
  T.writeRun(t.id, { startedAt: new Date().toISOString(), ok: true, reason: "完成" })
  assert.equal(T.listRuns(t.id).length, 1)
  T.deleteTask(t.id)
  assert.equal(T.readTask(t.id), null)
  assert.equal(T.listRuns(t.id).length, 0)
})

test("非法 id 不能穿越目录", () => {
  assert.equal(T.validTaskId("../../evil"), false)
  assert.equal(T.readTask("../../evil"), null)
  assert.throws(() => T.saveTask({ id: "../x" }))
})

test("锁：占着时第二次抢不到；释放后能抢到", () => {
  const t = T.normalizeTask(baseTask({ title: "锁测试" })).task
  T.saveTask(t)
  const a = T.acquireLock(t.id)
  assert.equal(a.ok, true)
  const b = T.acquireLock(t.id)
  assert.equal(b.ok, false)
  assert.equal(b.reason, "running")
  a.release()
  const c = T.acquireLock(t.id)
  assert.equal(c.ok, true)
  c.release()
})

test("锁：持有者进程已死 → 直接夺锁（关机留下的锁不能把任务永久卡死）", () => {
  const t = T.normalizeTask(baseTask({ title: "死锁测试" })).task
  T.saveTask(t)
  T.acquireLock(t.id, { pid: 999_999_998 })   // 一个几乎不可能存在的 pid
  const got = T.acquireLock(t.id)
  assert.equal(got.ok, true)
  got.release()
})

test("运行记录：超出保留条数删最旧的，lastRun 摘要回写进任务", () => {
  const t = T.normalizeTask(baseTask({ title: "记录测试" })).task
  T.saveTask(t)
  for (let i = 0; i < 5; i++)
    T.writeRun(t.id, { startedAt: new Date(2026, 7, 11, 7, 0, i).toISOString(), ok: i === 4, reason: "第" + i, outputs: ["a.md"] })
  const runs = T.listRuns(t.id)
  assert.equal(runs.length, 3, "KEEP_RUNS=3 应只留 3 条")
  assert.equal(runs[0].reason, "第4", "最新的排最前")
  assert.equal(T.readTask(t.id).lastRun.ok, true)
})

test("运行记录：一次性任务跑完自动停用（否则会天天被触发）", () => {
  const t = T.normalizeTask(baseTask({ schedule: { kind: "once", time: "08:00", date: "2026-09-01" } })).task
  T.saveTask(t)
  T.writeRun(t.id, { startedAt: new Date().toISOString(), ok: true, reason: "完成" })
  assert.equal(T.readTask(t.id).enabled, false)
})

// ---- 无头运行器的纯函数 --------------------------------------------------

test("parseArgs：认得四个开关", () => {
  const a = H.parseArgs(["--task", "t1", "--dry-run", "--force"])
  assert.deepEqual([a.task, a.dryRun, a.force], ["t1", true, true])
  assert.equal(H.parseArgs(["--file", "x.json"]).file, "x.json")
})

test("usedCredits：云端日线优先，缺了退回本机额度线", () => {
  assert.equal(H.usedCredits({ cloud: { daily: { usedUsd: 0.35 } } }), 35)
  assert.equal(H.usedCredits({ used: 0.2 }), 20)
  assert.equal(H.usedCredits({}), null)
})

test("onEvent：final/auto/done/failed 各归各位", () => {
  const acc = H.newAcc()
  H.onEvent("final", { text: "第一轮结论" }, acc)
  H.onEvent("auto", { round: 1 }, acc)
  H.onEvent("done", {}, acc)
  H.onEvent("final", { text: "交付完成" }, acc)
  H.onEvent("done", {}, acc)
  assert.equal(acc.doneCount, 2, "两轮")
  assert.equal(acc.finalText, "交付完成", "正文取最后一轮")
  assert.equal(acc.sawAuto, false, "done 之后要把续跑标记清掉，否则末轮会被当成还要继续")
  H.onEvent("failed", { message: "上游炸了" }, acc)
  assert.equal(acc.failed, "上游炸了")
})

// pushTo：定时任务跑在自己的新会话目录里，桥认不出平台会回落到"推所有在线平台"（双发）。
// 留空必须保持这个老行为——老任务的 json 里根本没有这个字段，读出来就是 ""，不能因此改变它们的推送去向。
test("normalizeTask：pushTo 缺省为空（= 全部已连接平台，与升级前一致）", () => {
  const { task } = T.normalizeTask(baseTask())
  assert.equal(task.pushTo, "")
})

test("normalizeTask：pushTo 只收 wecom / weixin，别的一律当空", () => {
  for (const v of ["wecom", "weixin"]) {
    assert.equal(T.normalizeTask({ ...baseTask(), pushTo: v }).task.pushTo, v)
  }
  // 乱值不能原样存进去——它会被 headless-run 当平台名发给网关
  for (const v of ["qq", "WECOM", 1, null, undefined, {}]) {
    assert.equal(T.normalizeTask({ ...baseTask(), pushTo: v }).task.pushTo, "")
  }
})
