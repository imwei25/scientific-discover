// 积分 —— 用户看得见的额度单位。
//
// 【为什么要有这层】后台的一切计量都是美元：单价按 USD/百万 token 填、usage_log 记 cost_usd、
// 对账要跟上游账单对得上。但美元金额对用户没有意义（"今日额度 $0.087 / $0.30"没人算得清
// 还剩多少轮），所以对外统一换算成积分：1 积分 = CREDIT_USD 美元（默认 0.01）。
//
// 【换算只在这一个文件里】客户端不做除法：服务端算好积分下发，客户端只负责显示。
// 否则改一次汇率就要等所有打包版都更新才对得上——而汇率是运营参数，改了要立刻全站一致。
//
// 【取整方向：一律朝"用户少赚"的方向靠】上限下取整、已用上取整、剩余 = floor(上限 - 已用)。
// 反过来（剩余上取整）会造出"界面显示还剩 1 积分，一发消息就被 429 挡回来"的体验，
// 那比少显示一分难解释得多。

export const DEFAULT_CREDIT_USD = 0.01

/** USD → 积分（不取整；取整规则由 quotaLine 统一定） */
export const toCredits = (usd, rate = DEFAULT_CREDIT_USD) => {
  const r = Number(rate)
  if (!Number.isFinite(r) || r <= 0) return 0
  return (Number(usd) || 0) / r
}

/** 积分 → USD（后台按美元判额度，客户端若要按积分说话得能换回去） */
export const toUsd = (credits, rate = DEFAULT_CREDIT_USD) => (Number(credits) || 0) * (Number(rate) || 0)

const r4 = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4

/**
 * 一条额度线（日 / 月）的用户视图。
 * limitUsd = 0 → 不限额（unlimited:true，remain 给 null 而不是 0 —— 0 会被前端当成"用尽"）。
 */
export function quotaLine(limitUsd, usedUsd, rate = DEFAULT_CREDIT_USD) {
  const unlimited = !(Number(limitUsd) > 0)
  const limitC = toCredits(limitUsd, rate)
  const usedC = toCredits(usedUsd, rate)
  return {
    limitUsd: r4(limitUsd), usedUsd: r4(usedUsd),
    limit: unlimited ? 0 : Math.floor(limitC),
    // 已用保留一位小数：一轮普通对话往往不到 1 积分，全取整的话用户会永远看到"已用 0"，
    // 以为没在扣费。
    used: Math.ceil(usedC * 10) / 10,
    remain: unlimited ? null : Math.max(0, Math.floor(limitC - usedC)),
    unlimited,
    pct: unlimited ? 0 : Math.min(100, Math.round((usedC / limitC) * 100)),
  }
}

/** 下一个 UTC 零点（日额度重置时刻）。库里的 day 键就是 UTC 日期，两处必须同一个口径。 */
export function nextDayResetAt(ts = Date.now()) {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}
/** 下个月 1 日 UTC 零点（月额度重置时刻） */
export function nextMonthResetAt(ts = Date.now()) {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/**
 * 完整的额度视图：日 + 月两条线 + 汇率 + 两个重置时刻。
 * /api/quota 与 /api/me 的档案共用它，两处口径永远一致。
 */
export function quotaView({ dailyUsd = 0, monthlyUsd = 0, todayUsd = 0, monthUsd = 0,
                            creditUsd = DEFAULT_CREDIT_USD, ts = Date.now() } = {}) {
  return {
    creditUsd,
    daily: quotaLine(dailyUsd, todayUsd, creditUsd),
    monthly: quotaLine(monthlyUsd, monthUsd, creditUsd),
    dayResetAt: nextDayResetAt(ts),
    monthResetAt: nextMonthResetAt(ts),
  }
}
