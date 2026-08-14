// 并发闸 + 排队：/llm 转发的入口配额器。
//
// 【为什么要有这一层】上游供应商按并发限速（DeepSeek 等都有 RPM/并发上限），十几个人同时
// 让 agent 跑长任务，打过去就是一片 429。而 429 落到客户端上表现为"这一轮无输出、报个红"，
// 用户完全不知道发生了什么、也不知道等多久。改成**在网关排队**：超出并发的请求不打上游，
// 先在队里等着，客户端能问到"你前面还有几个"，等到位就正常发出去。
//
// 【只在内存里排，不落库】队列是"此刻在飞的请求"，进程重启后本来就不该存在（那些 HTTP
// 连接都断了）。落库只会带来一堆需要清理的僵尸行。代价是多实例部署下每个进程各排一队 ——
// 本架构是单进程（见改造方案 §2），真要横向扩再换 Redis，那时口径也不变。
//
// 【谁来放行】release() 由网关在**响应收尾时**调用（正常结束 / 断流 / 客户端跑了都算）。
// 漏调一次就等于永久占掉一个并发位，闸会越来越紧直到全站卡死 —— 所以 gateway.mjs 里那处
// 是 finally 语义（每条出口都走同一个 done()），改那段时务必保持。
//
// 【时间从外面注入】测试要能把时钟捏在手里；生产就是 Date.now。

/** 采样多少次调用时长来估等待时间。太长了会被历史拖住（换模型后估值失真），20 次够用。 */
const SAMPLE_MAX = 20
/** 上游 429 没给 Retry-After 时，按这个时长记一段"正在限速" */
const RATE_LIMIT_DEFAULT_MS = 20_000

export const LIMIT_DEFAULTS = {
  maxConcurrent: 0,   // 全站同时在飞的上游请求数上限；0 = 不限（默认，老部署行为不变）
  perUser: 0,         // 单用户同时在飞上限；0 = 不限。档位可以覆盖（tiers.max_conc）
  maxQueue: 200,      // 最多排多少个在等；超了直接拒（别把内存排成雪崩），0 = 不限
  maxWaitMs: 300_000, // 排队等到这么久还没轮到就放弃；0 = 一直等
}

/** 净化一份限额配置：非法/负数/小数一律回落到默认值，别让脏数据把闸变成"零并发"。 */
export function sanitizeLimits(patch = {}, base = LIMIT_DEFAULTS) {
  const out = { ...LIMIT_DEFAULTS, ...base }
  for (const k of Object.keys(LIMIT_DEFAULTS)) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === "") continue
    const n = Math.floor(Number(patch[k]))
    if (!Number.isFinite(n) || n < 0) continue
    out[k] = n
  }
  // 等待上限比 1 秒还短没有任何意义（连一次握手都不够），当成"不排队"处理更诚实
  if (out.maxWaitMs > 0 && out.maxWaitMs < 1000) out.maxWaitMs = 1000
  return out
}

export function createQueue({ limits = {}, log = () => {}, now = () => Date.now() } = {}) {
  let lim = sanitizeLimits(limits)
  let seq = 0
  let runningTotal = 0
  const runningByUser = new Map()          // userId -> 在飞数
  let waiters = []                         // FIFO；队首是等得最久的
  const samples = []                       // 最近几次调用时长（ms），用于估等待
  let rate = null                          // { until, model, provider }：上游限速中
  const counters = { admitted: 0, queued: 0, timeout: 0, rejected: 0, canceled: 0 }

  const capOf = (perUser) => {
    const n = Math.floor(Number(perUser) || 0)
    return n > 0 ? n : lim.perUser
  }
  const mine = (userId) => runningByUser.get(userId) || 0
  const canAdmit = (userId, cap) =>
    (lim.maxConcurrent <= 0 || runningTotal < lim.maxConcurrent) &&
    (cap <= 0 || mine(userId) < cap)

  const avgMs = () => (samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0)

  function take(userId) {
    runningTotal++
    runningByUser.set(userId, mine(userId) + 1)
  }
  function give(userId) {
    runningTotal = Math.max(0, runningTotal - 1)
    const n = mine(userId) - 1
    if (n > 0) runningByUser.set(userId, n); else runningByUser.delete(userId)
  }

  /** 造一张"已放行"的票。release 幂等：同一张票放两次不会把并发位放飞。 */
  function admit(userId, waitedMs) {
    take(userId)
    counters.admitted++
    const t0 = now()
    let done = false
    return {
      ok: true, queued: waitedMs > 0, waitedMs,
      release() {
        if (done) return
        done = true
        const dur = now() - t0
        if (dur > 0) { samples.push(dur); if (samples.length > SAMPLE_MAX) samples.shift() }
        give(userId)
        pump()
      },
    }
  }

  /**
   * 有位子就放人。
   *
   * 【必须跳过队首继续往后找】队首那位可能是"单用户已满"（同一个人开了三轮），若见队首
   * 不可放行就整队停摆，别人明明有位却全被他堵住 —— 典型的队首阻塞，实测就是"一个人跑
   * 长任务，全站都进不去"。所以按 FIFO 顺序找**第一个当下可放行**的人。
   */
  function pump() {
    if (!waiters.length) return
    let progressed = true
    while (progressed && waiters.length) {
      progressed = false
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i]
        if (!canAdmit(w.userId, w.cap)) continue
        waiters.splice(i, 1)
        if (w.timer) clearTimeout(w.timer)
        w.resolve(admit(w.userId, now() - w.enqueuedAt))
        progressed = true
        break
      }
    }
  }

  /** 这位等待者排在第几（1 起）。已被放行/取消的返回 0。 */
  const posOf = (w) => {
    const i = waiters.indexOf(w)
    return i < 0 ? 0 : i + 1
  }

  /** 估还要等多久：平均时长 × 前面要腾出几批位子。没有样本就不瞎猜（返回 0 = 说不上）。 */
  function etaMs(position) {
    const a = avgMs()
    if (!a || position <= 0) return 0
    const width = lim.maxConcurrent > 0 ? lim.maxConcurrent : Math.max(1, runningTotal)
    return a * Math.ceil(position / width)
  }

  return {
    /**
     * 要一个并发位。返回形状**只有两种**，调用方照着写就行：
     *   { rejected:{code,message,…} }                          — 队满，别等了，直接回客户端
     *   { queued:bool, position, etaMs, promise, cancel }      — 拿到位（queued=false）或进队了
     * 无论哪种，`await promise` 的结果统一是
     *   {ok:true, release()} / {ok:false, code:"QUEUE_TIMEOUT"|"CANCELED"}
     * —— 当场放行时 promise 已经 resolve，调用方不必分支两种写法。
     */
    enqueue({ userId, perUser = 0 } = {}) {
      const uid = Number(userId) || 0
      const cap = capOf(perUser)
      if (canAdmit(uid, cap))
        return { queued: false, position: 0, etaMs: 0, promise: Promise.resolve(admit(uid, 0)), cancel() {} }

      if (lim.maxQueue > 0 && waiters.length >= lim.maxQueue) {
        counters.rejected++
        return {
          rejected: {
            code: "QUEUE_FULL",
            message: `服务器正忙（已有 ${waiters.length} 个请求在排队），请稍后再试`,
            waiting: waiters.length, running: runningTotal, limit: lim.maxConcurrent,
          },
        }
      }

      const w = { id: ++seq, userId: uid, cap, enqueuedAt: now(), resolve: null, timer: null }
      const promise = new Promise((resolve) => { w.resolve = resolve })
      waiters.push(w)
      counters.queued++
      // 【为什么给等待也设上限】不设的话，上游整体挂掉时队列只进不出，客户端全挂在那儿等，
      // 连"出错了"都看不到。等够久就明确失败，比无声地悬着好。
      if (lim.maxWaitMs > 0) {
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i < 0) return
          waiters.splice(i, 1)
          counters.timeout++
          w.resolve({ ok: false, code: "QUEUE_TIMEOUT", waitedMs: now() - w.enqueuedAt })
        }, lim.maxWaitMs)
        // 【别 unref】unref 过的定时器不阻止事件循环退出，于是"进程没别的事做"时它根本不会
        // 触发 —— 等待者就永远悬着（测试里表现为整条用例卡死）。这个定时器寿命有上限、且
        // cancel/放行两条路都会清掉它，让它 ref 住是安全的。
      }
      const position = posOf(w)
      return {
        queued: true, position, etaMs: etaMs(position), promise,
        /** 客户端断了就别占位（否则轮到它时白放一个位子，还得等下一次 release 才推进） */
        cancel() {
          const i = waiters.indexOf(w)
          if (i < 0) return
          waiters.splice(i, 1)
          if (w.timer) clearTimeout(w.timer)
          counters.canceled++
          w.resolve({ ok: false, code: "CANCELED", waitedMs: now() - w.enqueuedAt })
        },
      }
    },

    /** 上游回了 429 → 记一段"正在限速"，好让客户端把话说准（不是"服务器坏了"，是被限速） */
    noteRateLimit({ model = "", provider = "", retryAfterMs = 0 } = {}) {
      const ms = Number(retryAfterMs) > 0 ? Math.min(Number(retryAfterMs), 10 * 60_000) : RATE_LIMIT_DEFAULT_MS
      rate = { until: now() + ms, model: String(model || ""), provider: String(provider || "") }
      return rate
    },

    /** 客户端问"我在排第几"用的那份（不含别人的身份信息）。 */
    snapshot(userId = 0) {
      const uid = Number(userId) || 0
      const my = waiters.filter((w) => w.userId === uid)
      const first = my[0]
      const position = first ? posOf(first) : 0
      const rl = rate && rate.until > now() ? rate : null
      return {
        limit: lim.maxConcurrent, perUser: lim.perUser,
        maxQueue: lim.maxQueue, maxWaitMs: lim.maxWaitMs,
        running: runningTotal, runningMine: mine(uid),
        waiting: waiters.length, waitingMine: my.length,
        position, etaMs: etaMs(position),
        waitedMs: first ? now() - first.enqueuedAt : 0,
        avgMs: avgMs(),
        rateLimited: rl ? { retryAfterMs: Math.max(0, rl.until - now()), model: rl.model, provider: rl.provider } : null,
      }
    },

    /** 后台那一页要的全量视图 */
    stats() {
      const byUser = [...runningByUser.entries()].map(([id, n]) => ({ userId: id, running: n }))
        .sort((a, b) => b.running - a.running).slice(0, 20)
      const rl = rate && rate.until > now() ? rate : null
      return {
        limits: { ...lim },
        running: runningTotal, waiting: waiters.length,
        oldestWaitMs: waiters.length ? now() - waiters[0].enqueuedAt : 0,
        avgMs: avgMs(), samples: samples.length,
        byUser, counters: { ...counters },
        rateLimited: rl ? { retryAfterMs: Math.max(0, rl.until - now()), model: rl.model, provider: rl.provider } : null,
      }
    },

    limits() { return { ...lim } },

    /**
     * 把队里的人全放弃掉（各自收到 CANCELED），并清掉他们的定时器。
     *
     * 用处：① 测试收尾——等待者的超时定时器是 ref 住事件循环的（见上面为什么不 unref），
     * 留着会把整轮测试拖到超时；② 将来若要做优雅停机（现在是 SIGTERM 直接退，用不上），
     * 停机前调它能让排队的人立刻收到明确答复，而不是连接被硬断。
     */
    close() {
      const list = waiters; waiters = []
      for (const w of list) {
        if (w.timer) clearTimeout(w.timer)
        counters.canceled++
        w.resolve({ ok: false, code: "CANCELED", waitedMs: now() - w.enqueuedAt })
      }
      return list.length
    },
    /** 改限额【立刻生效】：放宽了就当场把队里的人放出去，别等下一次 release 才想起来。 */
    setLimits(patch) {
      const next = sanitizeLimits(patch, lim)
      const changed = Object.keys(LIMIT_DEFAULTS).some((k) => next[k] !== lim[k])
      lim = next
      if (changed) log(`[queue] 并发限额已更新：全站 ${lim.maxConcurrent || "不限"} / 单用户 ${lim.perUser || "不限"} / 队列 ${lim.maxQueue || "不限"} / 等待上限 ${lim.maxWaitMs || 0}ms`)
      pump()
      return { ...lim }
    },
  }
}
