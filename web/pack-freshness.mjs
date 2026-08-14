// "服务器上那个包，比我机器上这套新吗？" —— 技能包与界面包共用的判新逻辑。
//
// 【为什么不能只比版本号】版本号只在【在线更新装过】的机器上才有意义。安装器自带的
// 那套（出厂版）在 installed.json 里 current 是空串，没有版本号可比，于是老逻辑
// "服务端最新版 ≠ 本机版本 → 提示更新" 对刚装完的客户端恒为真：哪怕安装包是今天
// 打的、里面的技能比服务器上最后一次发布还新，客户端照样弹"有新版技能"，点下去
// 反而把技能换旧。
//
// 【改成比时间】出厂版没有版本号，但有"这个安装包是什么时候打的"（bundle.ps1 在
// 清空 skill-packs/ 后写进 installed.json 的 factoryAt）。包的发布时间早于打包时间，
// 就说明它的内容已经在安装器里了（甚至更旧），不提示。
//
// 【老客户端兜底】0.1.5 及更早的安装器没写 factoryAt。那些机器上 factoryAt=0，
// 保持原行为（照常提示）—— 宁可偶尔提示一次过时的包，也不能让存量客户端从此
// 再也收不到任何技能更新。

/** 点分数字版本号比较：a>b 返回 1，a<b 返回 -1，相等 0（与 server/lib/skillpacks.mjs 同口径） */
export function cmpVersion(a, b) {
  const pa = String(a || "").split(".").map((n) => Number(n) || 0)
  const pb = String(b || "").split(".").map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * 要不要把这个包当作"可更新"提示给用户。
 * latest: 服务端 /api/{skills,web}/latest 的 latest（要有 version，publishedAt 为毫秒时间戳）
 * installed: { current, factoryAt } —— current 空串 = 出厂版；factoryAt 0 = 不知道打包时间
 */
export function shouldOfferUpdate(latest, { current = "", factoryAt = 0 } = {}) {
  if (!latest || !latest.version) return false
  if (current) return cmpVersion(latest.version, current) > 0
  const at = Number(latest.publishedAt) || 0
  if (factoryAt > 0 && at > 0) return at > factoryAt
  return true
}
