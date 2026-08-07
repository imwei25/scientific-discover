// 供应侧：每家供应商还剩多少额度、现在是不是还能打。
//
// 【这层要治的病】2026-08 火山账户额度耗尽，全站输出空白。当时系统里能查的只有「**用户**
// 花了多少」（tiers.daily_usd，跟得很准），而「**供应商账户**还剩多少」一个字节都没存 ——
// 于是唯一的发现途径是用户来报「没输出」，网关侧则是每来一单往干涸的那家撞一次 402
// 再切下一家。切家逻辑本身是对的（gateway.mjs 那处 402 分支），但它是**事后**的：
// 每一单都要先浪费一个 RTT，而且只要没人手动去后台停用，就会一直撞下去。
//
// 这里补的是**事前**那一半：
//   ① 预算闸 —— 管理员填「这个账号有多少额度」，消费从 usage_log 按 provider 聚合，
//      算出来超了就不再往这家送（不依赖各家余额 API，一份代码通吃所有供应商）；
//   ② 熔断 —— 真撞上 402/401/429 就记下来，冷却期内不再往这家送，到点自动半开重试。
//
// 【它是闸，不是账本】预算用的是我们自己的单价表算出来的消费额，与供应商真实账单必然有
// 偏差（缓存 token 计价、对方的最小计费单位、汇率…）。用来判断「还该不该往这家打」够用；
// 要对账仍然看 usage_log 与对方账单。所以预算写宽一点没关系，写死到分毫反而会误伤。

import * as DB from "./db.mjs"

/**
 * 预算窗口。**全部是滚动窗口**（往前推这么长时间），不是自然日/自然月。
 *
 * 【为什么不用自然日切】用户额度那套是 UTC 日切（usage_daily 按 day 聚合），因为它要跟
 * 「今天还剩多少积分」这句话对得上。而供应侧要挡的是**把对方账户打爆**，供应商自己的限流
 * 也基本都是滚动的（opencode Go 的 $12/5小时就是滚动桶）。滚动窗口严格更保守：自然日切
 * 会在跨日那一刻把额度全放开，正好给了「23:59 和 00:01 各花一整天预算」的口子。
 *
 * total 是唯一的例外：从 anchor（充值时刻）起算，永不重置 —— 对应「充了 500 块用完为止」
 * 这种一次性充值账户，火山就是这种。
 */
export const WINDOWS = {
  h5: 5 * 3600_000,
  day: 24 * 3600_000,
  week: 7 * 24 * 3600_000,
  month: 30 * 24 * 3600_000,
  total: 0,
}
export const WINDOW_LABELS = { h5: "5 小时", day: "24 小时", week: "7 天", month: "30 天", total: "累计" }
export const isWindow = (w) => Object.prototype.hasOwnProperty.call(WINDOWS, String(w))

/** 窗口起点（ms）。total 用 anchor；anchor 为 0 时退化成「从有记录以来」。 */
export function windowStart(win, ts = Date.now(), anchor = 0) {
  const w = String(win)
  if (w === "total") return Math.max(0, Number(anchor) || 0)
  const span = WINDOWS[w]
  if (!span) return 0            // 认不出的窗口名 = 不限，别把脏数据变成"永远超支"
  return Math.max(0, Number(ts) - span)
}

// 冷却时长：撞上之后多久才允许再试这家。
//
// 【为什么各不相同】402 是「钱没了」——充值是人工动作，几分钟内不可能好，但也不该等太久
// （管理员充完总得自动恢复）。401/403 是「key 废了」——必须换 key，一小时内再撞纯属浪费，
// 而且要吵醒运维。429 是「打太快了」——对方给了 Retry-After 就听它的，几十秒就能好。
export const COOLDOWN = {
  dry: 30 * 60_000,
  invalid_key: 60 * 60_000,
  rate_limited: 60_000,
}
const RATE_LIMIT_CAP = 10 * 60_000

/**
 * 上游回的状态码 → 要不要摘掉这家、摘多久。返回 null = 不摘。
 *
 * 【5xx 和网络错误刻意不摘家】那是「对方抖了一下」，不是「这家不能用了」。按 5xx 摘家的话，
 * 主力供应商一次几秒的抖动就会把它停用半小时，全站被迫降级到备用家 —— 治病治成了残疾。
 * 5xx 仍然会当场切下一家（gateway.mjs 的 shouldRetryStatus），那是**这一单**的补救，
 * 与「这家整体还能不能用」是两回事，别混。
 */
export function classifyFailure(status, retryAfterMs = 0) {
  const s = Number(status) || 0
  if (s === 402)
    return { state: "dry", cooldownMs: COOLDOWN.dry, reason: "上游回 402：账户余额不足或欠费" }
  if (s === 401 || s === 403)
    return { state: "invalid_key", cooldownMs: COOLDOWN.invalid_key, reason: `上游回 ${s}：密钥失效或无权限` }
  if (s === 429) {
    const ra = Number(retryAfterMs) || 0
    return {
      state: "rate_limited",
      cooldownMs: Math.min(ra > 0 ? ra : COOLDOWN.rate_limited, RATE_LIMIT_CAP),
      reason: "上游回 429：被限速",
    }
  }
  return null
}

/**
 * 按 blockOf 给的判断把候选筛一遍。blockOf(provider) 返回 null=放行，或 {why, until}。
 *
 * 【fail-open 是硬要求，不是保守】筛完一个候选都不剩时，**原样放回全部候选**并让调用方
 * 报警。理由：这一层的输入是「我们自己估的消费额」和「上一次撞墙的记忆」，两者都可能错
 * （单价填错、时钟跳变、某次 402 其实是对方误报）。如果允许它把候选筛空，那么一个估算
 * 错误就能让全站彻底不可用 —— 比它要治的那个病严重得多。宁可打一次注定失败的上游，
 * 由既有的切家逻辑去兜，也不要自己把自己饿死。
 *
 * env 兜底那条候选（provider 为空串）永不参与筛选：它没有 provider 键，也就没有预算与
 * 健康记录，筛它等于把老部署的唯一一条路掐了。
 */
export function filterAttempts(attempts, blockOf) {
  const list = [], dropped = []
  for (const a of attempts || []) {
    const b = a && a.provider ? blockOf(a.provider) : null
    if (b) dropped.push({ provider: a.provider, providerName: a.providerName || a.provider, why: b.why, until: b.until || 0 })
    else list.push(a)
  }
  if (!list.length && dropped.length) return { attempts: attempts || [], dropped, failOpen: true }
  return { attempts: list, dropped, failOpen: false }
}

/** 一条预算线的视图（后台展示与闸判定共用，两处口径永远一致）。 */
export function budgetLine(row, spentUsd) {
  const limit = Number(row.limit_usd) || 0
  const spent = Math.max(0, Number(spentUsd) || 0)
  return {
    win: row.win,
    label: WINDOW_LABELS[row.win] || row.win,
    limitUsd: limit,
    spentUsd: spent,
    remainUsd: Math.max(0, limit - spent),
    pct: limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0,
    exhausted: limit > 0 && spent >= limit,
    anchor: Number(row.anchor) || 0,
  }
}

const LOW_WATER_PCT = 85              // 用掉这么多就开始喊，留出充值的时间
const LOW_WATER_QUIET_MS = 6 * 3600_000  // 同一家同一条线，6 小时内只喊一次

/**
 * 供应侧跟踪器。热路径（每一单请求）只读内存，不碰库。
 *
 * 【为什么内存是权威、库是副本】预算闸要在每一单转发前判一次。若每次都去 SUM(usage_log)，
 * 十几个人并发时就是一串同步查询压在网关的关键路径上。所以：消费额按 cacheMs 周期性地从库
 * 里重算一次，期间由 noteSpend 增量累加 —— 这样即使缓存还没到期，一轮长任务花掉的钱也会
 * **立刻**计进闸里。只靠 TTL 不增量的话，20 秒内一波并发足以把预算冲穿而闸毫无察觉。
 */
export function createSupply({ db, log = () => {}, audit = () => {}, now = Date.now, cacheMs = 20_000 } = {}) {
  const health = new Map()      // provider -> {state, until, reason, httpStatus, notedAt, trips}
  const cache = new Map()       // provider -> {at, lines:[budgetLine]}
  const warned = new Map()      // `${provider}:${win}` -> ts，低水位告警去重

  // 启动时把库里的健康状态载回来。不载的话，一次重启（发版、OOM 重拉）就把所有干涸标记
  // 忘光，于是又开始挨家撞 402 —— 而重启恰恰常发生在「正在处理这类故障」的时候。
  if (db) {
    try {
      for (const r of DB.listHealth(db))
        health.set(r.provider, {
          state: r.state, until: Number(r.until) || 0, reason: r.reason || "",
          httpStatus: Number(r.http_status) || 0, notedAt: Number(r.noted_at) || 0, trips: Number(r.trips) || 0,
        })
    } catch (e) { log(`[supply] 载入健康状态失败：${e.message}`) }
  }

  const persist = (provider, h) => {
    if (!db) return
    try { DB.saveHealth(db, provider, h) } catch (e) { log(`[supply] 写健康状态失败：${e.message}`) }
  }

  /** 这家的预算行（带已用/剩余）。cacheMs 内复用上一次的结果。 */
  function linesOf(provider, ts) {
    const hit = cache.get(provider)
    if (hit && ts - hit.at < cacheMs) return hit.lines
    let lines = []
    if (db) {
      try {
        lines = DB.listBudgets(db, provider)
          .map((row) => budgetLine(row, DB.providerSpend(db, provider, windowStart(row.win, ts, row.anchor))))
      } catch (e) { log(`[supply] 读预算失败（${provider}）：${e.message}`); lines = [] }
    }
    cache.set(provider, { at: ts, lines })
    return lines
  }

  /** 低水位告警：快用完了要在**耗尽之前**让人看见，否则这层只是把「突然没输出」换了个说法。 */
  function warnLowWater(provider, line, ts) {
    if (line.exhausted || line.limitUsd <= 0 || line.pct < LOW_WATER_PCT) return
    const k = `${provider}:${line.win}`
    if (ts - (warned.get(k) || 0) < LOW_WATER_QUIET_MS) return
    warned.set(k, ts)
    const msg = `${provider} ${line.label}预算已用 ${line.pct}%（$${line.spentUsd.toFixed(2)}/$${line.limitUsd.toFixed(2)}），剩 $${line.remainUsd.toFixed(2)}`
    log(`[supply] ⚠ ${msg}`)
    audit("supply.low_water", { actor: "system", target: provider, detail: msg })
  }

  /** 这家现在能不能打。返回 null = 能，或 {why, until}。 */
  function blockOf(provider, ts = now()) {
    const h = health.get(provider)
    if (h && h.until > ts) {
      const mins = Math.ceil((h.until - ts) / 60_000)
      return { why: `${h.reason}（冷却中，约 ${mins} 分钟后重试）`, until: h.until, state: h.state }
    }
    for (const line of linesOf(provider, ts)) {
      warnLowWater(provider, line, ts)
      if (line.exhausted)
        return { why: `${line.label}预算已用尽（$${line.spentUsd.toFixed(2)}/$${line.limitUsd.toFixed(2)}）`, until: 0, state: "over_budget" }
    }
    return null
  }

  return {
    blockOf,

    /**
     * 转发前筛候选。调用方拿 attempts 直接用；failOpen 为真时说明「全被筛掉了，已兜底放行」，
     * 这属于要人看见的状态（要么预算都填小了，要么真的全家都挂了）。
     */
    filter(attempts, ts = now()) {
      const r = filterAttempts(attempts, (p) => blockOf(p, ts))
      if (r.failOpen)
        audit("supply.fail_open", { actor: "system", target: r.dropped.map((d) => d.provider).join(","),
          detail: `全部候选被摘（${r.dropped.map((d) => d.provider + ":" + d.why).join("；")}），已兜底放行` })
      return r
    },

    /** 上游打脸了。status 认不出（5xx/网络错误）就什么也不做 —— 见 classifyFailure。 */
    noteFailure(provider, status, retryAfterMs = 0, ts = now()) {
      if (!provider) return null
      const c = classifyFailure(status, retryAfterMs)
      if (!c) return null
      const prev = health.get(provider)
      const h = {
        state: c.state, until: ts + c.cooldownMs, reason: c.reason,
        httpStatus: Number(status) || 0, notedAt: ts, trips: (prev?.trips || 0) + 1,
      }
      health.set(provider, h)
      persist(provider, h)
      const mins = Math.round(c.cooldownMs / 60_000)
      log(`[supply] ${provider} 摘除：${c.reason} —— ${mins >= 1 ? mins + " 分钟" : Math.round(c.cooldownMs / 1000) + " 秒"}内不再派单（累计第 ${h.trips} 次）`)
      // 429 是常态限流，天天有；402/401 是要人动手的事故，得进审计让后台看得见。
      if (c.state !== "rate_limited")
        audit("supply.trip", { actor: "system", target: provider, detail: `${c.reason}；冷却 ${mins} 分钟；累计 ${h.trips} 次` })
      return h
    },

    /**
     * 这家刚成功服务了一单 → 解除标记。
     *
     * 【恢复靠的就是这条】冷却到期后 blockOf 不再拦，下一单就会正常打过去；成功了在这里清掉，
     * 还是不行就被 noteFailure 重新按下（新的冷却）。这就是半开重试，管理员充完值不用手动点。
     * 代价是每个冷却周期会放过去一小把注定失败的请求 —— 十来个用户的量级完全可以接受，
     * 换来的是「充完值自动就好」而不是「还得记得去后台点一下」。
     */
    noteSuccess(provider) {
      if (!provider || !health.has(provider)) return
      health.delete(provider)
      if (db) { try { DB.deleteHealth(db, provider) } catch {} }
      log(`[supply] ${provider} 已恢复（上游正常响应）`)
    },

    /**
     * 增量记一笔消费，让预算闸在缓存到期前就跟上。
     * 只加在已有的线上：没设预算的家本来就不该被闸。
     */
    noteSpend(provider, usd) {
      const hit = cache.get(provider)
      const v = Number(usd) || 0
      if (!hit || !v) return
      for (const line of hit.lines) {
        line.spentUsd += v
        line.remainUsd = Math.max(0, line.limitUsd - line.spentUsd)
        line.pct = line.limitUsd > 0 ? Math.min(100, Math.round((line.spentUsd / line.limitUsd) * 100)) : 0
        line.exhausted = line.limitUsd > 0 && line.spentUsd >= line.limitUsd
      }
    },

    /** 管理员在后台改了预算 / 充了值 → 缓存作废，下一单立刻按新数算。 */
    invalidate(provider) {
      if (provider) { cache.delete(provider); for (const k of warned.keys()) if (k.startsWith(provider + ":")) warned.delete(k) }
      else { cache.clear(); warned.clear() }
    },

    /**
     * 忘掉这家的一切（健康、缓存、告警去重）。
     * byAdmin=true 才写审计：删供应商时也要走这条清理，但那已经有 provider.del 一条审计了，
     * 再补一条 supply.clear 只会让审计流里出现两条讲同一件事的记录。
     */
    clear(provider, { byAdmin = false } = {}) {
      health.delete(provider)
      cache.delete(provider)
      for (const k of [...warned.keys()]) if (k.startsWith(provider + ":")) warned.delete(k)
      if (db) { try { DB.deleteHealth(db, provider) } catch {} }
      if (byAdmin) audit("supply.clear", { actor: "admin", target: provider, detail: "手动解除摘除标记" })
    },

    /** 后台那一页要的视图：每家的健康 + 每条预算线。 */
    snapshot(providers, ts = now()) {
      return (providers || []).map((p) => {
        const key = typeof p === "string" ? p : p.key
        const h = health.get(key) || null
        const b = blockOf(key, ts)
        return {
          provider: key,
          health: h ? { ...h, cooling: h.until > ts, remainMs: Math.max(0, h.until - ts) } : { state: "ok", cooling: false },
          budgets: linesOf(key, ts),
          blocked: !!b,
          blockedWhy: b ? b.why : "",
        }
      })
    },
  }
}
