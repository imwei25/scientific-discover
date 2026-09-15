// 生图代理（/img/）—— 让客户端不用碰生图 key。
//
// 【为什么要有这一层】mechanism-figure 技能要调 DashScope 出机制示意图。技能是在【用户自己
// 那台机器】上跑的（桌面打包版：opencode 是本机进程），所以最省事的做法是把 key 发给每个用户
// ——那等于把一把共享密钥散出去：用户看得到、没法按人限额、泄了要全员换。这与本平台对 LLM
// key 的既有原则（"上游 key 绝不下发到客户端，所有调用必走本通道"，见 gateway.mjs）自相矛盾。
// 所以照 /llm 的样子再开一条 /img：客户端带自己的 access key 打过来，服务器贴生图 key 转发。
//
// 【与 /llm 的两点不同，都是刻意的】
//   ① 不做流式、不做多供应商切换：生图是一次性请求，且目前只有 DashScope 一家。
//   ③ 图片【不经过本服务器中转字节】：DashScope 回的是一个带签名的临时 URL，直接原样透给
//      客户端去下。省掉一整条大流量转发，而那个 URL 本身不含任何密钥。
//
// 【计费与额度】每张成功图片按模型固定成本折算为积分，写入与 LLM token 完全相同的 usage_log /
// usage_daily；日/月上限只看总消费，不再有独立的按张数拦截。上游报错、限速、我们自己拦下的
// 都不扣费，用户实际拿到图片才记账。

import https from "node:https"
import http from "node:http"

export const IMAGE_PATH_PREFIX = "/img/"

// 默认打阿里云 DashScope 的多模态生图口（与技能脚本 render_figure.py 的默认端点一致）。
const DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
const DEFAULT_MODEL = "qwen-image-2.0"
// 金额单位是人民币元/张。QWEN_IMAGE_COST 若设置为 >0，允许运营在供应商调价后临时覆盖。
const MODEL_COSTS = Object.freeze({
  "qwen-image-2.0": 0.2,
  "qwen-image-2.0-pro": 0.5,
  "qwen-image-3.0": 0.2,
  "qwen-image-3.0-pro": 0.5,
})
const BODY_LIMIT = 1 << 20        // 生图请求体就是一段提示词，1MB 绰绰有余
const UPSTREAM_TIMEOUT_MS = 300_000   // 生图本来就慢（实测几十秒），但不能无限挂

/** 读一次请求体（带上限）。超限直接拒，别把内存撑爆。 */
async function readBody(req) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > BODY_LIMIT) return { tooLarge: true }
    chunks.push(c)
  }
  try { return { json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") } }
  catch { return { bad: true } }
}

/** 一次上游调用（Promise 化，便于超时与错误统一处理） */
function callUpstream(endpoint, key, payload) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(endpoint) } catch { return reject(new Error("生图上游地址配置有误")) }
    const body = Buffer.from(JSON.stringify(payload), "utf8")
    const mod = u.protocol === "https:" ? https : http
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        authorization: "Bearer " + key,
        "content-type": "application/json",
        "content-length": body.length,
        // 【钉死 identity】与 /llm 同一个理由：压缩体会让下面的 JSON.parse 失败，
        // 而失败的表现是"图没了但额度扣了"，最难查。
        "accept-encoding": "identity",
      },
    }, (res) => {
      const bufs = []
      let len = 0
      res.on("data", (c) => { if (len < 4 << 20) { bufs.push(c); len += c.length } })
      res.on("end", () => {
        const text = Buffer.concat(bufs).toString("utf8")
        let json = null
        try { json = JSON.parse(text) } catch { /* 上游回了非 JSON（网关错误页等） */ }
        resolve({ status: res.statusCode || 502, text, json })
      })
      res.on("error", reject)
    })
    req.on("error", reject)
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => { req.destroy(new Error("生图上游超时")) })
    req.write(body)
    req.end()
  })
}

/** 从 DashScope 响应里取图片 URL（结构变过，宽松地找；找不到返回空数组）。 */
export function extractImageUrls(json) {
  const out = []
  const o = json?.output || {}
  for (const ch of o.choices || []) {
    for (const c of (ch?.message?.content) || []) {
      if (c && typeof c === "object" && c.image) out.push(c.image)
    }
  }
  if (!out.length) {
    for (const it of o.results || []) {
      if (it && (it.url || it.image)) out.push(it.url || it.image)
    }
  }
  return out
}

/** 一张图的实际入账价（元）。未知型号必须显式配置，绝不默认为 0 让它绕过总额度。 */
export function imageCost(model, override = 0) {
  const custom = Number(override)
  if (Number.isFinite(custom) && custom > 0) return custom
  return MODEL_COSTS[String(model || "").trim().toLowerCase()] || 0
}

/**
 * 处理 POST /img/generate。
 * ctx 提供：authClient / noteClient / resolveEntitlement / todayCost / monthCost / recordUsage / audit / fail / json / log / cfg
 */
export async function imageForward({ req, res, pathname, ctx }) {
  const { fail, json, audit, log, CFG: cfg } = ctx
  const ip = ctx.clientIp(req)

  if (pathname !== IMAGE_PATH_PREFIX + "generate")
    return fail(res, 404, "NOT_FOUND", "生图接口只有 POST /img/generate")
  if (req.method !== "POST")
    return fail(res, 405, "METHOD_NOT_ALLOWED", "只接受 POST")

  // ---- ① 认 key（与 /llm 同一把 access key、同一套判据）----
  const au = ctx.authClient(req)
  if (!au.ok) return fail(res, au.status, au.code, au.message)
  const user = au.user
  ctx.noteClient(user, req)

  // ---- ② 有没有配生图 key ----
  // 【先于额度判】没配 key 时谁都出不了图，这时候扣人额度或说"你今天画完了"都是误导。
  const upstreamKey = String(cfg.imageKey || "").trim()
  if (!upstreamKey)
    return fail(res, 503, "IMAGE_UNCONFIGURED",
      "平台还没有配置生图服务，请联系管理员（技能仍可用 --dry-run 做提示词，只是出不了图）")

  // ---- ③ 总积分闸（与 /llm 共用日/月上限）----
  const ent = ctx.resolveEntitlement(user)
  const creditRate = cfg.creditUsd
  const credits = (cost) => cost / creditRate
  const today = ctx.todayCost(user.id)
  if (ent.daily > 0 && today >= ent.daily) {
    audit("img.quota_block", { actor: user.username, ip, detail: `day ${today.toFixed(4)}/${ent.daily}` })
    return fail(res, 429, "QUOTA_EXCEEDED", `今日积分已用尽（上限 ${Math.floor(credits(ent.daily))} 积分），明日 0 点(UTC)恢复`,
      { scope: "daily", used: today, limit: ent.daily, usedCredits: Math.ceil(credits(today)), limitCredits: Math.floor(credits(ent.daily)) })
  }
  const month = ctx.monthCost(user.id)
  if (ent.monthly > 0 && month >= ent.monthly) {
    audit("img.quota_block", { actor: user.username, ip, detail: `month ${month.toFixed(4)}/${ent.monthly}` })
    return fail(res, 429, "QUOTA_EXCEEDED", `本月积分已用尽（上限 ${Math.floor(credits(ent.monthly))} 积分），请联系管理员升级`,
      { scope: "monthly", used: month, limit: ent.monthly, usedCredits: Math.ceil(credits(month)), limitCredits: Math.floor(credits(ent.monthly)) })
  }

  // ---- ④ 读请求体 ----
  const b = await readBody(req)
  if (b.tooLarge) return fail(res, 413, "BODY_TOO_LARGE", "请求体过大")
  if (b.bad) return fail(res, 400, "BAD_REQUEST", "请求体不是合法 JSON")
  const prompt = String(b.json?.prompt || "").trim()
  if (!prompt) return fail(res, 400, "BAD_REQUEST", "缺 prompt")
  const negative = String(b.json?.negative_prompt || "")
  const size = String(b.json?.size || "").trim() || "2048*2048"
  // 模型由服务器定，不让客户端点名：生图单价按模型差很多，放任客户端选等于让它自选价格
  // （与 /llm 的 pickModel 同一个理由）。
  const model = String(cfg.imageModel || "").trim() || DEFAULT_MODEL
  const endpoint = String(cfg.imageEndpoint || "").trim() || DEFAULT_ENDPOINT
  const cost = imageCost(model, cfg.imageCost)
  if (!(cost > 0))
    return fail(res, 503, "IMAGE_PRICE_UNCONFIGURED", `模型 ${model} 没有配置生图单价，已拒绝调用以免绕过积分额度`)

  const payload = {
    model,
    input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
    parameters: {
      size,
      watermark: false,
      // 【必须关】prompt_extend 会让模型自己"润色"提示词、往图里加没有的细胞器和分子，
      // 等于绕开技能侧的反编造闸。技能脚本已经关了一次，这里是服务端的第二道。
      prompt_extend: false,
      negative_prompt: negative,
    },
  }

  // ---- ⑤ 转发 ----
  let up
  const t0 = Date.now()
  try {
    up = await callUpstream(endpoint, upstreamKey, payload)
  } catch (e) {
    log(`[img] ${user.username} 生图上游异常：${e?.message || e}`)
    audit("img.upstream_error", { actor: user.username, ip, detail: String(e?.message || e).slice(0, 200) })
    return fail(res, 502, "IMAGE_UPSTREAM_ERROR", "生图服务暂时不可用，请稍后重试")
  }

  if (up.status !== 200) {
    const msg = String(up.json?.message || up.json?.error?.message || up.text || "").replace(/\s+/g, " ").slice(0, 300)
    log(`[img] ${user.username} 生图上游 ${up.status}：${msg}`)
    audit("img.upstream_fail", { actor: user.username, ip, detail: `${up.status} ${msg}`.slice(0, 250) })
    // 上游额度/欠费要单独说：那是平台的事，别让用户以为是自己的张数用完了。
    const quotaish = up.status === 429 || up.status === 402 || /quota|balance|欠费|额度/i.test(msg)
    return fail(res, quotaish ? 429 : 502,
      quotaish ? "IMAGE_UPSTREAM_QUOTA" : "IMAGE_UPSTREAM_ERROR",
      quotaish
        ? "平台的生图服务额度已用尽或被限速（不是你的积分），请联系管理员。本次没有扣费。"
        : `生图失败（上游 ${up.status}）。请稍后重试；持续如此请联系管理员。`,
      { upstreamStatus: up.status })
  }

  const urls = extractImageUrls(up.json)
  if (!urls.length) {
    log(`[img] ${user.username} 上游 200 但没有图片 URL：${(up.text || "").slice(0, 200)}`)
    audit("img.no_image", { actor: user.username, ip, detail: (up.text || "").slice(0, 200) })
    // 【不扣额度】用户什么都没拿到
    return fail(res, 502, "IMAGE_NO_RESULT", "生图服务没有返回图片，请重试（本次不扣积分）")
  }

  // ---- ⑥ 成功才入同一笔消费账 ----
  ctx.recordUsage(user.id, { model, provider: "DashScope image", cost_usd: cost })
  const usedAfter = ctx.todayCost(user.id)
  audit("img.generate", { actor: user.username, ip, detail: `${model} ${size} ¥${cost}，今日 ¥${usedAfter.toFixed(4)}，${Date.now() - t0}ms` })
  log(`[img] ${user.username} 出图成功 ${model} ${size}（¥${cost}；今日 ¥${usedAfter.toFixed(4)}，${Date.now() - t0}ms）`)

  return json(res, 200, {
    ok: true,
    images: urls,
    model,
    cost,
    credits: Math.ceil(credits(cost) * 10) / 10,
  })
}
