// LLM 网关：客户端拿 access key 打这里，服务端换成真实上游 key 再转发，并按响应里的
// usage 计量入账。
//
// 【为什么计量必须在这一层】改造方案 §3.1：桌面客户端完全在用户手里，让它自报消费额
// 等于没有额度。所以：上游 key 绝不下发到客户端，所有调用必走本通道，账按上游响应记。
//
// 从 deploy/manager.mjs 的 llmForward 继承下来的、别顺手改掉的几处（都是线上踩出来的）：
//   · 流式透传不攒包（用管道，不缓冲整个响应）；
//   · upRes 必须挂 error：pipe 不转发可读侧错误，上游在分钟级长流中途 RST 会抛出未捕获异常
//     → 进程退出 → 全站一起没。这里响应头多半已发出，只能断流收尾；
//   · 刻意不设 idle 超时：推理模型首字节可以很慢，误杀比挂着更糟。

import http from "node:http"
import https from "node:https"
import { Transform } from "node:stream"
import { StringDecoder } from "node:string_decoder"

export const GATEWAY_PATH_PREFIX = "/llm/"

const REQ_BODY_LIMIT = 32 * 1024 * 1024   // 32MB：长上下文也够，再大多半是异常
const JSON_CAP = 4 * 1024 * 1024          // 非流式响应最多缓这么多用于解析 usage
const SSE_BUF_CAP = 1 << 20               // 畸形流（一直不换行）时的保护上限

/**
 * 从各家的 usage 结构里取统一口径。
 * DeepSeek：prompt_tokens / completion_tokens / prompt_cache_hit_tokens
 * OpenAI  ：prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== "object") return null
  const prompt = Number(u.prompt_tokens) || 0
  const completion = Number(u.completion_tokens) || 0
  const cached = Number(
    u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0) || 0
  // 缓存命中数不该超过输入数；上游偶发的脏数据不能让计费变成负的
  const cachedSafe = Math.max(0, Math.min(cached, prompt))
  return { prompt, completion, cached: cachedSafe }
}

/** 成本（USD）。单价是 USD/百万 token，与旧架构 OC_COST_* 同口径。 */
export function costOf(usage, cfg) {
  if (!usage) return 0
  const fresh = Math.max(0, usage.prompt - usage.cached)
  return (fresh * cfg.priceIn + usage.cached * cfg.priceCached + usage.completion * cfg.priceOut) / 1e6
}

/**
 * 拼上游 URL，并消掉重复的 /v1。
 *
 * 客户端的 baseURL 有两种写法，两种都得能用：
 *   http://host/llm      → OpenAI SDK 拼成 /llm/chat/completions       → fwdPath=/chat/completions
 *   http://host/llm/v1   → OpenAI SDK 拼成 /llm/v1/chat/completions    → fwdPath=/v1/chat/completions
 * 而 LLM_UPSTREAM_URL 接 one-api 时必须带 /v1（它的 OpenAI 兼容端点就在 /v1 下）。
 * 直接相加就会出现 http://127.0.0.1:3010/v1 + /v1/chat/completions = /v1/v1/... → 上游 404。
 * 真机第一次接 one-api 就是栽在这里，而且报错只是个干巴巴的 404，看不出是拼错了。
 */
export function joinUpstream(baseUrl, fwdPath) {
  const base = String(baseUrl || "").replace(/\/+$/, "")
  let p = String(fwdPath || "")
  if (/\/v1$/.test(base) && /^\/v1\//.test(p)) p = p.slice(3)
  return base + p
}

/** 读完整请求体（网关必须重写 body：强制模型 + 注入 include_usage），带上限。 */
async function readRawBody(req, limit = REQ_BODY_LIMIT) {
  const chunks = []; let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) { const e = new Error("body too large"); e.tooLarge = true; throw e }
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

/**
 * 重写请求体：
 *   ① 强制模型 —— 客户端传什么都覆盖成档位规定的模型（需求「换模型对客户端透明」）；
 *   ② stream:true 时注入 stream_options.include_usage —— 不注入的话最后一个 chunk 没有
 *      usage，这一单就白记（计量直接失效）。
 * 非 JSON body（少见）原样透传，只是记不到账。
 */
export function rewriteBody(raw, { model }) {
  let obj
  try { obj = JSON.parse(raw.toString("utf8")) } catch { return { buf: raw, stream: false, model: "" } }
  if (!obj || typeof obj !== "object") return { buf: raw, stream: false, model: "" }
  if (model) obj.model = model
  const stream = obj.stream === true
  if (stream) obj.stream_options = { ...(obj.stream_options || {}), include_usage: true }
  return { buf: Buffer.from(JSON.stringify(obj), "utf8"), stream, model: String(obj.model || "") }
}

/**
 * 旁路解析响应里的 usage，同时把数据原样透传。
 * 用 Transform + pipe 而不是手写 res.write：pipe 自带背压，慢客户端不会把内存撑爆。
 */
function makeUsageTap(isSse, onUsage) {
  const dec = new StringDecoder("utf8")   // 防多字节字符被切在两个 chunk 之间
  let sseBuf = ""
  const jsonChunks = []; let jsonLen = 0
  let usage = null, model = ""

  const scanLine = (line) => {
    if (!line.startsWith("data:")) return
    const d = line.slice(5).trim()
    if (!d || d === "[DONE]") return
    try {
      const o = JSON.parse(d)
      if (o && o.usage) usage = o.usage
      if (o && o.model && !model) model = String(o.model)
    } catch { /* 半截 JSON 或非标准事件，忽略 */ }
  }

  const t = new Transform({
    transform(chunk, _enc, cb) {
      if (isSse) {
        sseBuf += dec.write(chunk)
        let i
        while ((i = sseBuf.indexOf("\n")) >= 0) {
          scanLine(sseBuf.slice(0, i).replace(/\r$/, ""))
          sseBuf = sseBuf.slice(i + 1)
        }
        if (sseBuf.length > SSE_BUF_CAP) sseBuf = sseBuf.slice(-4096)
      } else if (jsonLen < JSON_CAP) {
        jsonChunks.push(chunk); jsonLen += chunk.length
      }
      cb(null, chunk)
    },
    flush(cb) {
      if (isSse) {
        sseBuf += dec.end()
        if (sseBuf) scanLine(sseBuf.replace(/\r$/, ""))
      } else if (jsonLen && jsonLen < JSON_CAP) {
        try {
          const o = JSON.parse(Buffer.concat(jsonChunks).toString("utf8"))
          if (o && o.usage) usage = o.usage
          if (o && o.model) model = String(o.model)
        } catch { /* 上游返回的不是 JSON（错误页等），记不到账 */ }
      }
      try { onUsage(usage, model) } catch { /* 记账失败不该影响已经发完的响应 */ }
      cb()
    },
  })
  return t
}

export async function llmForward({ req, res, pathname, ctx }) {
  const { CFG, log, audit, clientIp, authClient, fail, noteClient } = ctx
  const ip = clientIp(req)

  // ---- ① 认 key ----
  const au = authClient(req)
  if (!au.ok) return fail(res, au.status, au.code, au.message)
  const user = au.user
  noteClient(user, req)

  // ---- ② 额度闸（请求前预检）----
  const ent = ctx.resolveEntitlement(user)
  const today = ctx.todayCost(user.id)
  if (ent.daily > 0 && today >= ent.daily) {
    audit("llm.quota_block", { actor: user.username, ip, detail: `day ${today.toFixed(4)}/${ent.daily}` })
    return fail(res, 429, "QUOTA_EXCEEDED", `今日额度已用尽（上限 $${ent.daily.toFixed(2)}），明日 0 点(UTC)恢复`,
      { scope: "daily", used: today, limit: ent.daily })
  }
  const month = ctx.monthCost(user.id)
  if (ent.monthly > 0 && month >= ent.monthly) {
    audit("llm.quota_block", { actor: user.username, ip, detail: `month ${month.toFixed(4)}/${ent.monthly}` })
    return fail(res, 429, "QUOTA_EXCEEDED", `本月额度已用尽（上限 $${ent.monthly.toFixed(2)}），请联系管理员升级`,
      { scope: "monthly", used: month, limit: ent.monthly })
  }

  // ---- ③ 技能白名单（软管控，见改造方案 §3.3）----
  // 客户端不带 X-Skill 时放行并记为空：自由对话本来就没有技能，不能一刀切拒。
  const skill = String(req.headers["x-skill"] || "").slice(0, 64)
  if (skill && ent.skills.length && !ent.skills.includes(skill)) {
    audit("llm.skill_block", { actor: user.username, ip, detail: skill })
    return fail(res, 403, "SKILL_NOT_ALLOWED", `当前档位未开通「${skill}」，请联系管理员升级`, { skill })
  }

  // ---- ④ 上游 key ----
  if (!CFG.upstreamKey)
    return fail(res, 503, "UPSTREAM_UNCONFIGURED", "服务器未配置上游模型密钥，请联系管理员")

  // ---- ⑤ 读并重写请求体 ----
  let raw
  try { raw = await readRawBody(req) }
  catch (e) {
    if (e.tooLarge) return fail(res, 413, "BODY_TOO_LARGE", "请求体过大")
    return fail(res, 400, "BAD_REQUEST", "读取请求体失败")
  }
  const { buf, stream, model } = rewriteBody(raw, { model: ent.model })

  const fwdPath = pathname.slice(GATEWAY_PATH_PREFIX.length - 1) // "/llm/v1/x" -> "/v1/x"
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""
  let tu
  try { tu = new URL(joinUpstream(CFG.upstreamUrl, fwdPath) + query) }
  catch { return fail(res, 500, "INTERNAL", "上游地址配置有误") }

  const headers = { ...req.headers }
  for (const h of ["host", "connection", "content-length", "transfer-encoding",
    "x-forwarded-for", "x-forwarded-proto", "x-forwarded-prefix", "x-skill", "x-client-version"]) delete headers[h]
  headers["authorization"] = "Bearer " + CFG.upstreamKey
  headers["content-length"] = Buffer.byteLength(buf)

  const started = Date.now()
  const mod = tu.protocol === "https:" ? https : http
  const up = mod.request({
    hostname: tu.hostname,
    port: tu.port || (tu.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: tu.pathname + tu.search,
    headers,
  }, (upRes) => {
    const h = { ...upRes.headers }
    delete h["connection"]
    delete h["content-length"]   // 旁路不改内容，但去掉更稳（上游若分块，长度可能对不上）
    res.writeHead(upRes.statusCode || 502, h)

    const isSse = String(upRes.headers["content-type"] || "").includes("text/event-stream") || stream
    const tap = makeUsageTap(isSse, (rawUsage, respModel) => {
      const u = normalizeUsage(rawUsage)
      if (!u) {
        // 上游没给 usage：多半是错误响应（4xx/5xx，不该计费）；2xx 却没给就要看见
        if ((upRes.statusCode || 0) < 400)
          log(`[llm] ${user.username} 上游 ${upRes.statusCode} 未返回 usage —— 这一单没计到账（model=${model} stream=${stream}）`)
        return
      }
      const cost = costOf(u, CFG)
      try {
        ctx.recordUsage(user.id, {
          model: respModel || model, skill,
          prompt_tokens: u.prompt, completion_tokens: u.completion,
          cached_tokens: u.cached, cost_usd: cost,
        })
      } catch (e) { log(`[llm] ${user.username} 记账失败：${e.message}`) }
      log(`[llm] ${user.username} ${respModel || model} in=${u.prompt}(cache ${u.cached}) out=${u.completion} $${cost.toFixed(6)} ${Date.now() - started}ms`)
    })

    // ★ 上游可读侧的 error 必须自己接：pipe 不转发它，抛出去就是进程级未捕获异常
    upRes.on("error", (e) => {
      log(`[llm] ${user.username} 上游流中断：${e.message}`)
      try { res.destroy() } catch {}
    })
    upRes.pipe(tap).pipe(res)
  })

  up.on("error", (e) => {
    log(`[llm] ${user.username} 上游错误：${e.message}`)
    if (!res.headersSent) fail(res, 502, "UPSTREAM_UNAVAILABLE", "上游模型服务暂不可用，请稍后重试")
    else { try { res.destroy() } catch {} }
  })
  res.on("close", () => { if (!res.writableEnded) { try { up.destroy() } catch {} } })
  up.end(buf)
}
