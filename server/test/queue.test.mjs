// 并发闸 / 排队的单元测试。
//
// 这一层的错法都很安静：位子漏还、队首把别人堵死、改上限后队里的人没被放出来 —— 表现都是
// "有时候大家一起卡住"，线上极难复现。所以这里逐条钉死。
import test from "node:test"
import assert from "node:assert/strict"
import { createQueue, sanitizeLimits, LIMIT_DEFAULTS } from "../lib/queue.mjs"

const tick = () => new Promise((r) => setImmediate(r))

/**
 * 建一个队列，并登记"用例结束就把队里的人清掉"。
 *
 * 【为什么必须清】等待者的超时定时器是 ref 住事件循环的（不 ref 就不会触发，见 queue.mjs），
 * 用例结束时若还留着等待者，node:test 会挂在那儿直到 maxWaitMs（默认 5 分钟）。
 */
function mk(t, limits, opts = {}) {
  const q = createQueue({ limits, ...opts })
  t.after(() => q.close())
  return q
}

test("sanitizeLimits：非法值一律忽略并保留原值，不许悄悄变成 0", () => {
  const base = { maxConcurrent: 5, perUser: 2, maxQueue: 50, maxWaitMs: 60_000 }
  assert.deepEqual(sanitizeLimits({}, base), base)
  assert.deepEqual(sanitizeLimits({ maxConcurrent: -1 }, base).maxConcurrent, 5, "负数是误输入，不是「不限」")
  assert.deepEqual(sanitizeLimits({ maxConcurrent: "abc" }, base).maxConcurrent, 5)
  assert.deepEqual(sanitizeLimits({ maxConcurrent: "" }, base).maxConcurrent, 5, "空 = 不改")
  assert.deepEqual(sanitizeLimits({ maxConcurrent: "3" }, base).maxConcurrent, 3, "字符串数字要收")
  assert.deepEqual(sanitizeLimits({ maxConcurrent: 2.7 }, base).maxConcurrent, 2, "小数取整")
  assert.equal(sanitizeLimits({ maxWaitMs: 10 }, base).maxWaitMs, 1000, "比 1 秒还短没有意义")
  assert.equal(sanitizeLimits({ maxWaitMs: 0 }, base).maxWaitMs, 0, "0 = 一直等，是合法选择")
  assert.equal(sanitizeLimits({}).maxConcurrent, LIMIT_DEFAULTS.maxConcurrent, "不传 base 就用默认")
})

test("不限并发（默认）时：谁来都当场放行，队列恒空", async (t) => {
  const q = mk(t, {})
  const ts = []
  for (let i = 0; i < 20; i++) ts.push(q.enqueue({ userId: 1 }))
  assert.ok(ts.every((x) => x.queued === false))
  assert.equal(q.stats().running, 20)
  assert.equal(q.stats().waiting, 0)
  for (const x of ts) (await x.promise).release()
  assert.equal(q.stats().running, 0)
})

test("超出全站上限 → 排队，前一个 release 后按 FIFO 放行", async (t) => {
  const q = mk(t, { maxConcurrent: 2 })
  const a = await q.enqueue({ userId: 1 }).promise
  const b = await q.enqueue({ userId: 2 }).promise
  const t3 = q.enqueue({ userId: 3 })
  const t4 = q.enqueue({ userId: 4 })
  assert.equal(t3.queued, true)
  assert.equal(t3.position, 1)
  assert.equal(t4.position, 2)
  assert.equal(q.snapshot(4).waiting, 2)
  assert.equal(q.snapshot(4).position, 2, "第 4 位用户问到的是自己的位次")
  assert.equal(q.snapshot(1).position, 0, "已经在跑的人不在队里")

  let got3 = false, got4 = false
  t3.promise.then(() => { got3 = true })
  t4.promise.then(() => { got4 = true })
  await tick()
  assert.equal(got3, false, "位子没腾出来之前谁都别放")

  a.release(); await tick()
  assert.equal(got3, true, "队首先走")
  assert.equal(got4, false)
  b.release(); await tick()
  assert.equal(got4, true)
  assert.equal(q.stats().waiting, 0)
})

test("单用户上限：同一个人占满自己的份额后要排队，别人不受影响", async (t) => {
  const q = mk(t, { maxConcurrent: 10, perUser: 2 })
  const a = await q.enqueue({ userId: 1 }).promise
  await q.enqueue({ userId: 1 }).promise
  const t3 = q.enqueue({ userId: 1 })
  assert.equal(t3.queued, true, "同一个人的第三路要等")
  const other = q.enqueue({ userId: 2 })
  assert.equal(other.queued, false, "别人还有全站的位子，当场放行")
  a.release(); await tick()
  assert.equal((await t3.promise).ok, true)
})

test("档位可以覆盖单用户上限（perUser 参数）", async (t) => {
  const q = mk(t, { maxConcurrent: 10, perUser: 1 })
  await q.enqueue({ userId: 1, perUser: 3 }).promise
  await q.enqueue({ userId: 1, perUser: 3 }).promise
  assert.equal(q.enqueue({ userId: 1, perUser: 3 }).queued, false, "档位给了 3 路就是 3 路")
  assert.equal(q.enqueue({ userId: 1, perUser: 3 }).queued, true, "第 4 路才排队")
  assert.equal(q.enqueue({ userId: 2 }).queued, false, "没覆盖的用户仍按全局 1 路")
  assert.equal(q.enqueue({ userId: 2 }).queued, true)
})

test("队首阻塞：队首受自己的单用户上限所限时，要跳过他放行后面的人", async (t) => {
  const q = mk(t, { maxConcurrent: 2, perUser: 1 })
  await q.enqueue({ userId: 1 }).promise              // 用户 1 用掉自己唯一的一路
  const b = await q.enqueue({ userId: 2 }).promise    // 全站 2/2 满
  const stuck = q.enqueue({ userId: 1 })             // 队首：等的是"用户 1 自己的份额"
  const next = q.enqueue({ userId: 3 })              // 队尾：只等全站腾位
  assert.equal(stuck.position, 1)
  assert.equal(next.position, 2)

  let okNext = false, okStuck = false
  next.promise.then(() => { okNext = true })
  stuck.promise.then(() => { okStuck = true })

  b.release(); await tick()      // 全站空出一位，但队首那位仍占着自己的 1/1
  assert.equal(okNext, true, "队首放不出去时后面能走的人必须能走，否则一个人堵死全站")
  assert.equal(okStuck, false)
  assert.equal(q.snapshot(1).position, 1, "队首还在队里等自己的份额")
})

test("队满 → 直接拒绝（QUEUE_FULL），不无限吃内存", async (t) => {
  const q = mk(t, { maxConcurrent: 1, maxQueue: 2 })
  await q.enqueue({ userId: 1 }).promise
  assert.equal(q.enqueue({ userId: 2 }).queued, true)
  assert.equal(q.enqueue({ userId: 3 }).queued, true)
  const r = q.enqueue({ userId: 4 })
  assert.ok(r.rejected)
  assert.equal(r.rejected.code, "QUEUE_FULL")
  assert.match(r.rejected.message, /排队/)
  assert.equal(q.stats().counters.rejected, 1)
})

test("等太久 → QUEUE_TIMEOUT（而不是无声地悬着）", async (t) => {
  const q = mk(t, { maxConcurrent: 1, maxWaitMs: 1000 })
  await q.enqueue({ userId: 1 }).promise
  const w = q.enqueue({ userId: 2 })
  const r = await w.promise
  assert.equal(r.ok, false)
  assert.equal(r.code, "QUEUE_TIMEOUT")
  assert.ok(r.waitedMs >= 900, "等待时长要如实报回来：" + r.waitedMs)
  assert.equal(q.stats().waiting, 0, "超时的人要从队里摘掉")
  assert.equal(q.stats().counters.timeout, 1)
})

test("客户端断开 → cancel 让位，且不会白放一个位子", async (t) => {
  const q = mk(t, { maxConcurrent: 1 })
  const a = await q.enqueue({ userId: 1 }).promise
  const gone = q.enqueue({ userId: 2 })
  const t3 = q.enqueue({ userId: 3 })
  gone.cancel()
  assert.equal((await gone.promise).code, "CANCELED")
  assert.equal(q.stats().waiting, 1)
  a.release(); await tick()
  assert.equal((await t3.promise).ok, true, "取消的那位不该占用这次放行的机会")
})

test("release 幂等：放两次不会把并发位放飞", async (t) => {
  const q = mk(t, { maxConcurrent: 1 })
  const a = await q.enqueue({ userId: 1 }).promise
  a.release(); a.release()
  assert.equal(q.stats().running, 0)
  // 位子只有一个：连开两路，第二路必须排队
  await q.enqueue({ userId: 1 }).promise
  assert.equal(q.enqueue({ userId: 1 }).queued, true)
})

test("改上限立刻生效：放宽了就当场把队里的人放出去", async (t) => {
  const q = mk(t, { maxConcurrent: 1 })
  await q.enqueue({ userId: 1 }).promise
  const t2 = q.enqueue({ userId: 2 })
  const t3 = q.enqueue({ userId: 3 })
  assert.equal(q.stats().waiting, 2)
  q.setLimits({ maxConcurrent: 3 })
  await tick()
  assert.equal((await t2.promise).ok, true)
  assert.equal((await t3.promise).ok, true)
  assert.equal(q.stats().waiting, 0)
  assert.equal(q.limits().maxConcurrent, 3)
})

test("收紧上限不会掐掉在飞的请求，只是之后的要等", async (t) => {
  const q = mk(t, { maxConcurrent: 3 })
  await q.enqueue({ userId: 1 }).promise
  await q.enqueue({ userId: 1 }).promise
  q.setLimits({ maxConcurrent: 1 })
  assert.equal(q.stats().running, 2, "已经在跑的照跑完")
  assert.equal(q.enqueue({ userId: 1 }).queued, true)
})

test("snapshot：给客户端的那份带位次与预计等待", async (t) => {
  let clock = 0
  const q = mk(t, { maxConcurrent: 1 }, { now: () => clock })
  const a = await q.enqueue({ userId: 1 }).promise
  clock += 4000
  a.release()                     // 记下一次 4 秒的样本
  const b = await q.enqueue({ userId: 1 }).promise
  const w = q.enqueue({ userId: 7 })
  clock += 1500
  const s = q.snapshot(7)
  assert.equal(s.position, 1)
  assert.equal(s.waiting, 1)
  assert.equal(s.waitingMine, 1)
  assert.equal(s.running, 1)
  assert.equal(s.runningMine, 0)
  assert.equal(s.limit, 1)
  assert.equal(s.avgMs, 4000)
  assert.equal(s.etaMs, 4000, "平均 4 秒 × 前面 1 批 = 4 秒")
  assert.equal(s.waitedMs, 1500)
  b.release(); await tick()
  assert.equal((await w.promise).ok, true)
})

test("上游 429 → snapshot/stats 报「上游限速中」，过期自动消失", (t) => {
  let clock = 1_000_000
  const q = mk(t, {}, { now: () => clock })
  assert.equal(q.snapshot(1).rateLimited, null)
  q.noteRateLimit({ model: "m", provider: "p", retryAfterMs: 5000 })
  const s = q.snapshot(1)
  assert.equal(s.rateLimited.model, "m")
  assert.equal(s.rateLimited.retryAfterMs, 5000)
  assert.equal(q.stats().rateLimited.provider, "p")
  clock += 5001
  assert.equal(q.snapshot(1).rateLimited, null, "限速窗口过了就别再报")
})
