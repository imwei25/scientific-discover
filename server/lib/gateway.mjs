// LLM 网关：客户端拿 access key 打这里，服务端换成真实上游 key 再转发，并按响应里的
// usage 计量入账。
//
// 【模型怎么定、流量打给谁】（2026-07-29 加供应商目录后）
//   ① 客户端点名的模型在该档位的允许清单里 → 用它；不在 → 静默打回档位默认模型。
//   ② 拿模型名去 models 目录查候选：一行一家供应商，各带自己的地址/key/真实模型名/单价；
//      sort 小的先打，连不上或 5xx 且响应头还没发出去 → 自动落到下一家。
//   ③ 目录里查不到（还没建目录，或该模型只由 env 上游提供）→ 回落 LLM_UPSTREAM_* + COST_*，
//      与加目录之前的行为逐字节一致。老部署不改任何配置也照常跑。
//   ④ 计价按【命中的那一行】的单价，不再是全局一张表 —— 这正是多供应商下账会静默偏的老病根。
//
// 【并发闸】超出并发上限的请求不打上游，先进 queue.mjs 的 FIFO 队列等着；客户端问
//   /api/queue 就能拿到"你排第几、大概还要多久"并显示等待提示。上限在后台可改、即时生效。
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
import zlib from "node:zlib"
import { Transform } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import * as Credits from "./credits.mjs"

export const GATEWAY_PATH_PREFIX = "/llm/"

const REQ_BODY_LIMIT = 32 * 1024 * 1024   // 32MB：长上下文也够，再大多半是异常
const JSON_CAP = 4 * 1024 * 1024          // 非流式响应最多缓这么多用于解析 usage
const SSE_BUF_CAP = 1 << 20               // 畸形流（一直不换行）时的保护上限

/**
 * 该不该换下一家：所有 5xx，外加这几个"这家伺候不了你"的 4xx。
 * 400/404/413/422 不在内 —— 那是请求本身的问题（模型名错、体过大…），换谁都一样。
 */
const RETRY_4XX = new Set([401, 402, 403, 408, 409, 429])
export const shouldRetryStatus = (code) => Number(code) >= 500 || RETRY_4XX.has(Number(code))

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
 *
 * 【版本号不只有 v1】火山方舟这类端点是 .../api/coding/v3、.../api/v3，客户端仍然按 OpenAI
 * 协议发 /v1/chat/completions。只认 /v1 结尾的话就拼成 /api/coding/v3/v1/chat/completions
 * → 又是个干巴巴的 404。更糟的是后台「测试连通」用的 normalizeBase 认 /v\d+，那边一片绿、
 * 一转发就 404，最难查。所以这里与 normalizeBase 口径对齐：base 以 /vN 结尾时，吃掉客户端
 * 路径开头的那段 /vN（版本以【上游 base 写的】为准）。
 */
export function joinUpstream(baseUrl, fwdPath) {
  const base = String(baseUrl || "").replace(/\/+$/, "")
  let p = String(fwdPath || "")
  if (/\/v\d+$/.test(base) && /^\/v\d+\//.test(p)) p = p.replace(/^\/v\d+/, "")
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
 *   ① 覆盖模型名 —— 客户端选的模型要么在档位允许清单里（用它），要么被打回默认模型；
 *      供应商自己的真实模型名不同时（models.upstream），这里换成它的名字；
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

/** 请求体里客户端点名的模型（拿不到就空串——非 JSON / 非对话接口都属这种）。 */
export function requestedModel(raw) {
  try {
    const o = JSON.parse(raw.toString("utf8"))
    return o && typeof o === "object" ? String(o.model || "") : ""
  } catch { return "" }
}

/**
 * 定这一单用哪个模型：客户端点的名字在档位允许清单里就照办，否则一律打回档位默认模型。
 *
 * 【为什么不是"客户端传什么就用什么"】额度与计价都按模型算，放任客户端点名等于让它自选价格。
 * 【为什么不是直接拒绝】老客户端（打包版）会照着自己的配置传模型名，直接 400 会把它们全打死；
 * 静默打回默认模型正是改造前的行为，兼容性最好，且响应体里带的是真实模型名，前端看得见。
 */
export function pickModel(requested, ent) {
  const req = String(requested || "").trim()
  // callable = 界面可选清单 ∪ 定时任务专用模型（见 db.mjs resolveEntitlement）。
  // 老的调用方只给 models 时照旧走 models，行为不变。
  const pool = Array.isArray(ent.callable) && ent.callable.length ? ent.callable : ent.models
  const allowed = Array.isArray(pool) && pool.length ? pool : (ent.model ? [ent.model] : [])
  if (req && allowed.includes(req)) return { model: req, coerced: false }
  return { model: ent.model || req, coerced: !!req && req !== ent.model }
}

/**
 * 这一单可以打给谁，按顺序排好。
 *
 * ① 目录里有这个模型名 → 每一行就是一个候选（多家 = 故障切换，sort 小的先上），
 *    各自带自己的地址、key、真实模型名与单价；
 * ② 目录里没有（还没建目录 / 只由 env 上游提供）→ 回落到 env 的 LLM_UPSTREAM_*，
 *    单价用全局 COST_*。这条是老部署一字不改也照常跑的保证。
 */
export function buildAttempts(model, routes, CFG) {
  const list = (routes || []).filter((r) => r.base_url).map((r) => ({
    provider: r.provider, providerName: r.provider_name || r.provider,
    baseUrl: r.base_url, apiKey: r.api_key || "",
    upstreamModel: r.upstream || r.model || model,
    price: { priceIn: Number(r.price_in) || 0, priceOut: Number(r.price_out) || 0, priceCached: Number(r.price_cached) || 0 },
  }))
  if (list.length) return list
  return [{
    provider: "", providerName: "默认上游(env)",
    baseUrl: CFG.upstreamUrl, apiKey: CFG.upstreamKey, upstreamModel: model,
    price: { priceIn: CFG.priceIn, priceOut: CFG.priceOut, priceCached: CFG.priceCached },
  }]
}

/** 记账侧兜底：上游压缩了就解出来看 usage（透传的字节不动，客户端拿到的还是原样）。 */
function inflateForUsage(buf, encoding) {
  const enc = String(encoding || "").trim().toLowerCase()
  if (!enc || enc === "identity") return buf
  try {
    if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf)
    if (enc === "deflate") return zlib.inflateSync(buf)
    if (enc === "br") return zlib.brotliDecompressSync(buf)
    if (enc === "zstd" && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf)
  } catch { /* 解不开就当没 usage，日志里会喊"未返回 usage" */ }
  return buf
}

/**
 * 旁路解析响应里的 usage，同时把数据原样透传。
 * 用 Transform + pipe 而不是手写 res.write：pipe 自带背压，慢客户端不会把内存撑爆。
 *
 * 【encoding 这个参数不是可有可无的】上游若回 gzip，攒下来的就是压缩字节，JSON.parse 必失败
 * → usage=null → 这一单【白送】（不计费、不扣额度），而客户端一切正常，只有日志里一行
 * "未返回 usage"。转发时已把 accept-encoding 钉成 identity，这里是上游不听话时的第二道。
 */
function makeUsageTap(isSse, onUsage, encoding = "") {
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
          const o = JSON.parse(inflateForUsage(Buffer.concat(jsonChunks), encoding).toString("utf8"))
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

/**
 * 上游的 429 分两种，给用户的话完全相反，必须分开：
 *   · 真限速（RPM/TPM 打满）：几秒到几十秒就好，"稍等再试"是对的建议；
 *   · 额度耗尽（账号配额/余额打光）：要等到某个时刻或要充值，**重试完全无用**。
 *
 * 【为什么非分不可】实测（2026-08-07 生产）火山方舟额度耗尽时回的就是 429：
 *   {"error":{"code":"AccountQuotaExceeded","type":"TooManyRequests",
 *     "message":"You have exceeded the 5-hour usage quota. It will reset at 2026-08-07 14:12:52 +0800 CST..."}}
 * 而当时全都按"限速"处理 → queue 记一段 rateLimited → 客户端把它显示成
 * 「上游限速中，正在等待重试…本轮会在限速解除后自动继续，请不要重发」，同时首输出看门狗
 * 因为 cloudQueueBlocking() 每 30 秒续一次命、**永不超时** —— 用户就守着转圈等一个
 * 五小时后才恢复的额度，还被明确告知别重发。这正是"额度触顶静默转圈"的第二条入口。
 *
 * 判据取"够用且不误伤"：认供应商的机器码（各家都给），再兜一层措辞。
 * 纯限速的措辞（rate limit / too many requests / TPM / RPM / concurrenc*）不在此列。
 */
const QUOTA_CODES = new Set([
  "accountquotaexceeded",      // 火山方舟
  "insufficient_quota",        // OpenAI 系
  "insufficient_user_quota",   // one-api / new-api 中转
  "quota_exceeded", "exceeded_quota", "insufficientbalance", "insufficient_balance",
])
const QUOTA_WORDS = /exceeded[^.]{0,40}quota|quota[^.]{0,20}(exceeded|exhausted|used up|run out)|out of (credits?|quota)|额度(已)?(用尽|耗尽|不足)|配额(已)?(用尽|耗尽|不足)|余额不足|欠费|arrears|insufficient (quota|balance|credit)/i

/** 上游 429/402 的响应体 → 是不是"额度耗尽"（而非短暂限速）。读不出结构就按限速处理（保守）。 */
export function isUpstreamQuotaExhausted(bodyText) {
  const s = String(bodyText || "")
  if (!s.trim()) return false
  let code = ""
  try {
    const e = JSON.parse(s)?.error
    code = String(e?.code ?? e?.type ?? "").trim().toLowerCase()
    if (QUOTA_CODES.has(code)) return true
  } catch { /* 非 JSON：只靠措辞兜 */ }
  return QUOTA_WORDS.test(s)
}

/**
 * 从上游原话里抠出"什么时候恢复"。这是用户唯一真正需要的信息，而它只存在于上游那句话里
 * —— 丢掉它，用户就只能每隔几分钟试一次直到蒙对。抠不出来就返回空串，由调用方省略这一句。
 */
export function extractResetHint(bodyText) {
  const s = String(bodyText || "").replace(/\s+/g, " ")
  // 排除类里【必须含引号与花括号】：抽的是 JSON 串里的一段，不排掉就会把 `"}}` 一起带出来
  // （实测漏过，已被测试锚定）。也排掉逗号/句号/右括号/换行 —— 时间后面通常紧跟一句解释。
  const STOP = '[^,.)"}\\n，。）]'
  const m = s.match(new RegExp(`reset(?:s|ting)?\\s+(?:at|on)\\s+([0-9]{4}-[0-9]{2}-[0-9]{2}${STOP}{0,30})`, "i"))
    || s.match(new RegExp(`(?:恢复|重置)(?:时间|于)?\\s*[:：]?\\s*([0-9]{4}-[0-9]{2}-[0-9]{2}${STOP}{0,25})`))
  return m ? m[1].trim() : ""
}

/** 上游 429 带的 Retry-After（秒，或 HTTP-date）→ 毫秒。读不出来就 0，由 queue 用自己的默认值。 */
export function retryAfterMs(v) {
  const s = String(v || "").trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Math.min(Number(s), 600) * 1000
  const t = Date.parse(s)
  return Number.isFinite(t) ? Math.max(0, Math.min(t - Date.now(), 600_000)) : 0
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
  // 判定仍然全程用美元（与计量、对账同一口径）；只有【给用户看的那句话】换成积分，
  // 否则用户顶栏看的是"还剩 0 积分"、被拦时却收到一句 "$0.30"，对不上号。
  // used/limit 两个字段保持美元不变：老客户端与运维脚本在读它们。
  const ent = ctx.resolveEntitlement(user)
  const cr = (usd) => Credits.toCredits(usd, CFG.creditUsd)
  const today = ctx.todayCost(user.id)
  if (ent.daily > 0 && today >= ent.daily) {
    audit("llm.quota_block", { actor: user.username, ip, detail: `day ${today.toFixed(4)}/${ent.daily}` })
    return fail(res, 429, "QUOTA_EXCEEDED", `今日积分已用尽（上限 ${Math.floor(cr(ent.daily))} 积分），明日 0 点(UTC)恢复`,
      { scope: "daily", used: today, limit: ent.daily, usedCredits: Math.ceil(cr(today)), limitCredits: Math.floor(cr(ent.daily)) })
  }
  const month = ctx.monthCost(user.id)
  if (ent.monthly > 0 && month >= ent.monthly) {
    audit("llm.quota_block", { actor: user.username, ip, detail: `month ${month.toFixed(4)}/${ent.monthly}` })
    return fail(res, 429, "QUOTA_EXCEEDED", `本月积分已用尽（上限 ${Math.floor(cr(ent.monthly))} 积分），请联系管理员升级`,
      { scope: "monthly", used: month, limit: ent.monthly, usedCredits: Math.ceil(cr(month)), limitCredits: Math.floor(cr(ent.monthly)) })
  }

  // ---- ③ 技能白名单（软管控，见改造方案 §3.3）----
  // 客户端不带 X-Skill 时放行并记为空：自由对话本来就没有技能，不能一刀切拒。
  const skill = String(req.headers["x-skill"] || "").slice(0, 64)
  if (skill && ent.skills.length && !ent.skills.includes(skill)) {
    audit("llm.skill_block", { actor: user.username, ip, detail: skill })
    return fail(res, 403, "SKILL_NOT_ALLOWED", `当前档位未开通「${skill}」，请联系管理员升级`, { skill })
  }

  // ---- ④ 读请求体 → 定模型 → 定这一单可以打给谁 ----
  let raw
  try { raw = await readRawBody(req) }
  catch (e) {
    if (e.tooLarge) return fail(res, 413, "BODY_TOO_LARGE", "请求体过大")
    return fail(res, 400, "BAD_REQUEST", "读取请求体失败")
  }
  const picked = pickModel(requestedModel(raw), ent)
  const model = picked.model
  if (picked.coerced)
    log(`[llm] ${user.username} 点名的模型不在档位允许清单内，已打回 ${model}（档位 ${ent.tier}）`)

  // ---- ④.2 调试抓包（管理员按用户点名开启；见 capture.mjs 头注）----
  // 抓的是重写前的原始 body —— 那才是客户端（opencode）真实发出的 messages 全文。
  try { ctx.capture?.record(user.username, { path: pathname, model, skill }, raw) } catch { /* 抓包绝不影响转发 */ }

  const routes = ctx.modelRoutes ? ctx.modelRoutes(model) : []
  let attempts = buildAttempts(model, routes, CFG)
  // 没有任何可用凭证就别白跑一趟：目录里那家没填 key、或压根没建目录而 env 也是空的
  if (!attempts.some((a) => a.apiKey && a.baseUrl))
    return fail(res, 503, "UPSTREAM_UNCONFIGURED", "服务器未配置上游模型密钥，请联系管理员")

  // ---- ④.5 供应侧闸：预算用尽 / 刚撞过墙的家，这一单直接跳过 --------------------
  // 上面那套切家是【事后】的：先打过去、被 402 打回来、再切下一家，每一单都要浪费一个 RTT，
  // 而且没人手动停用就会一直撞。supply 记着「谁的预算见底了、谁刚回过 402」，在这里就把它
  // 们从候选里划掉。全被划掉时 filter 会原样放回（fail-open，见 supply.mjs），绝不让这层
  // 自己把全站饿死。
  if (ctx.supply) {
    const f = ctx.supply.filter(attempts)
    if (f.dropped.length)
      log(`[llm] ${user.username} ${model} 跳过 ${f.dropped.map((d) => `${d.providerName}(${d.why})`).join("、")}${f.failOpen ? " —— 全被跳过，兜底照原顺序试" : ""}`)
    attempts = f.attempts
  }

  const fwdPath = pathname.slice(GATEWAY_PATH_PREFIX.length - 1) // "/llm/v1/x" -> "/v1/x"
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""
  const baseHeaders = { ...req.headers }
  for (const h of ["host", "connection", "content-length", "transfer-encoding", "authorization",
    "x-forwarded-for", "x-forwarded-proto", "x-forwarded-prefix", "x-skill", "x-client-version"]) delete baseHeaders[h]
  // 【必须钉成 identity】客户端默认带 accept-encoding: gzip,br；照转的话上游（火山方舟就会）
  // 回压缩体，旁路攒到的是压缩字节 → 解不出 usage → 这一单不计费、不扣额度，而客户端毫无察觉。
  // 少压这一段的代价远小于账目静默漏记。（上游仍压缩时由 inflateForUsage 兜底。）
  baseHeaders["accept-encoding"] = "identity"

  // ---- ⑤ 并发闸：满了就排队，别把 429 甩给用户 ----------------------------------
  //
  // 上游按并发/RPM 限速，十几个人同时跑长任务打过去就是一片 429，而 429 到客户端上只表现为
  // "这一轮没输出"。所以超出上限的请求**在这里等**，客户端可以问 /api/queue 拿到"前面还有
  // 几个"并显示等待提示（见 web/server.mjs 的 cloudForward 与前端的 queue 事件）。
  //
  // 【放行位必须还回去】拿到位之后每一条出口（正常收尾、上游断流、客户端跑了、我们自己回
  // 错误）都得 release，漏一次就永久占掉一个并发位。所以只挂在 res 的 'close' 上 ——
  // 它是这条响应【唯一】的终点，不管走哪条路都会到。
  //
  // 【只闸写请求】GET（如 /v1/models 的清单查询）不排队：它便宜、几乎不占上游配额，而客户端
  // 启动时就会问一次 —— 让它挤在一堆生成请求后面等五分钟，只会让"刚打开就转圈"。
  let waitedMs = 0
  if (ctx.queue && req.method !== "GET") {
    const t = ctx.queue.enqueue({ userId: user.id, perUser: ent.maxConc })
    if (t.rejected) {
      audit("llm.queue_full", { actor: user.username, ip, detail: `waiting=${t.rejected.waiting} running=${t.rejected.running}` })
      log(`[llm] ${user.username} 队列已满（在等 ${t.rejected.waiting}）—— 直接回绝`)
      return fail(res, 503, t.rejected.code, t.rejected.message,
        { waiting: t.rejected.waiting, running: t.rejected.running, limit: t.rejected.limit, retryAfterMs: 15_000 })
    }
    if (t.queued) {
      const snap = ctx.queue.snapshot(user.id)
      log(`[llm] ${user.username} 并发已满（在跑 ${snap.running}/${snap.limit || "不限"}）—— 排队第 ${t.position} 位`)
      // 排队期间客户端断开（用户点了终止、进程退出）→ 让位，否则轮到它时白放一个位子
      res.on("close", () => { if (!res.writableEnded) t.cancel() })
    }
    const adm = await t.promise
    if (!adm.ok) {
      if (adm.code === "CANCELED") { try { res.destroy() } catch {} ; return }
      audit("llm.queue_timeout", { actor: user.username, ip, detail: `waited=${adm.waitedMs}ms` })
      return fail(res, 503, "QUEUE_TIMEOUT",
        `排队等待超过 ${Math.round(adm.waitedMs / 1000)} 秒仍未轮到，服务器繁忙，请稍后重试`,
        { waitedMs: adm.waitedMs, retryAfterMs: 20_000 })
    }
    waitedMs = adm.waitedMs
    // 【等的过程中客户端可能已经走了】那时 'close' 早就发过，再挂监听器永远不会触发 →
    // 这个并发位就永久漏掉了。所以先自己查一遍状态。
    if (res.writableEnded || res.destroyed || res.closed) { adm.release(); return }
    res.on("close", () => adm.release())
    if (waitedMs > 0) log(`[llm] ${user.username} 排队 ${waitedMs}ms 后放行`)
  }

  const started = Date.now()
  let cur = null                       // 当前在飞的上游请求（客户端断开时要拆掉它）
  let clientGone = false
  res.on("close", () => {
    if (!res.writableEnded) { clientGone = true; try { cur?.destroy() } catch {} }
  })

  /**
   * 打第 i 家。失败（连不上 / 5xx）且【响应头还没发出去】时自动落到下一家 —— 这就是
   * 同一模型名挂多家供应商时的故障切换。头一旦发出去就只能断流收尾：已经吐给客户端的
   * 字节收不回来，重发会得到两段拼在一起的答案。
   */
  const tryAttempt = (i) => {
    if (clientGone) return
    const at = attempts[i]
    const last = i >= attempts.length - 1
    // 【一次尝试只能了结一次】走了 5xx 换家那支之后，被弃用的那条连接稍后仍可能吐出一个
    // error 事件；不挡住的话就会再切一次家（或对已经在回的响应二次 fail），表现是同一问
    // 一次答两遍 / 502 覆盖掉已经开始流的正常响应。
    let settled = false
    const nextOr = (why, code, msg) => {
      if (settled || clientGone) return
      settled = true
      if (!last && !res.headersSent) {
        log(`[llm] ${user.username} ${at.providerName} ${why} —— 切下一家（${attempts[i + 1].providerName}）`)
        return tryAttempt(i + 1)
      }
      log(`[llm] ${user.username} ${at.providerName} ${why}`)
      if (!res.headersSent) fail(res, 502, code, msg)
      else { try { res.destroy() } catch {} }
    }
    if (!at.apiKey || !at.baseUrl) return nextOr("未配置地址或密钥", "UPSTREAM_UNCONFIGURED", "服务器未配置上游模型密钥，请联系管理员")

    // 每一家的真实模型名可能不同（models.upstream），所以 body 要按家重新生成
    const { buf, stream } = rewriteBody(raw, { model: at.upstreamModel })
    let tu
    try { tu = new URL(joinUpstream(at.baseUrl, fwdPath) + query) }
    catch { return nextOr("地址配置有误", "INTERNAL", "上游地址配置有误") }

    const headers = { ...baseHeaders, authorization: "Bearer " + at.apiKey, "content-length": Buffer.byteLength(buf) }
    const mod = tu.protocol === "https:" ? https : http
    const up = mod.request({
      hostname: tu.hostname,
      port: tu.port || (tu.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: tu.pathname + tu.search,
      headers,
    }, (upRes) => {
      // 还没开始回客户端、且这家明显"伺候不了"→ 换下一家再试。
      // 【4xx 里也有该切家的】真实事故（2026-07-29）：主供应商余额耗尽，上游回 402，
      // 而当时只对 5xx 切家 —— 备用供应商明明是好的，却一次都没被用上，全站输出空白。
      // 402 余额/欠费、401/403 我们这把 key 在这家失效、408 超时、429 限流，都属于
      // "换一家就能好"，必须切。400/404/413/422 是请求本身的问题（模型名不对、体过大…），
      // 换谁都一样，原样透传给客户端才有诊断价值。
      // 【429 要单独认出来】它不是"服务器坏了"而是"被限速了"，两者给用户的话完全不同，
      // 而客户端只看得见状态码。记一段"正在限速"（/api/queue 会把它下发给前端显示），
      // 并在无处可切时回结构化错误码 + Retry-After，而不是把上游那个裸 429 页甩过去。
      // 【供应侧记一笔】成功就解除这家的摘除标记（管理员充完值不用手动点，见 supply.mjs
      // 的半开重试）；402/401/403/429 则记下来，冷却期内不再往这家派单。5xx 与网络错误
      // 刻意不记 —— 那是抖动，不是「这家不能用了」，按它摘家会把一次几秒的抖动放大成半小时降级。
      try {
        const st = Number(upRes.statusCode) || 0
        if (st >= 200 && st < 300) ctx.supply?.noteSuccess(at.provider)
        else ctx.supply?.noteFailure(at.provider, st, retryAfterMs(upRes.headers["retry-after"]))
      } catch (e) { log(`[llm] 供应侧记录失败：${e.message}`) }

      if (Number(upRes.statusCode) === 429) {
        const ra = retryAfterMs(upRes.headers["retry-after"])
        // 【无处可切时先把错误体读出来分类】限速 vs 额度耗尽给用户的话完全相反（见
        // isUpstreamQuotaExhausted 的注释）。错误体只有几百字节，读它的代价可以忽略；
        // 而分错的代价是用户守着一个五小时后才恢复的额度转圈，还被告知"别重发"。
        // 只在这条终止路径上读：要切下一家时抓紧切，那几毫秒不值得等。
        if (last && !res.headersSent) {
          settled = true
          let body = ""
          const done = () => {
            const exhausted = isUpstreamQuotaExhausted(body)
            if (!exhausted) {
              // 真限速：照旧记一段"正在限速"，前端显示"稍等自动重试"是对的建议。
              try { ctx.queue?.noteRateLimit({ model, provider: at.provider, retryAfterMs: ra }) } catch {}
              audit("llm.upstream_rate_limited", { actor: user.username, ip, detail: `${at.providerName} ${model}${ra ? ` retry-after ${ra}ms` : ""}` })
              log(`[llm] ${user.username} ${at.providerName} 限速（429），无备用可切`)
              return fail(res, 429, "UPSTREAM_RATE_LIMITED",
                `上游模型服务正在限速，请稍等片刻再试${ra ? `（建议 ${Math.ceil(ra / 1000)} 秒后）` : ""}`,
                { provider: at.provider, model, retryAfterMs: ra || 20_000 })
            }
            // 额度耗尽：【刻意不记 noteRateLimit】—— 它会让客户端显示"限速中，正在等待重试、
            // 请不要重发"，并给首输出看门狗无限续命（cloudQueueBlocking），于是本轮永不超时。
            // 这是老客户端也能受益的关键一改：不喂这个状态，它们至少不会卡在"别重发"的假等待里。
            const reset = extractResetHint(body)
            const upMsg = (() => { try { return String(JSON.parse(body)?.error?.message || "").trim() } catch { return "" } })()
            audit("llm.upstream_quota_exceeded", { actor: user.username, ip,
              detail: `${at.providerName} ${model}${reset ? ` reset=${reset}` : ""}` })
            log(`[llm] ${user.username} ${at.providerName} 上游额度耗尽（429）${reset ? `，${reset} 恢复` : ""}，无备用可切`)
            return fail(res, 429, "UPSTREAM_QUOTA_EXCEEDED",
              `平台的上游模型额度已用尽（不是你的积分），本轮未能生成${reset ? `；预计 ${reset} 恢复` : ""}。`
              + "现在重试不会成功，请联系管理员充值或换一家供应商。",
              { provider: at.provider, model, resetHint: reset, upstreamMessage: upMsg.slice(0, 300) })
          }
          let n = 0, finished = false
          const finish = () => { if (!finished) { finished = true; try { upRes.destroy() } catch {}; done() } }
          upRes.on("data", (c) => { if (n < 8192) { body += c.toString("utf8"); n += c.length } })
          upRes.on("end", finish)
          upRes.on("error", finish)          // 读不到体 → body 为空 → 按限速处理（保守，行为同修改前）
          setTimeout(finish, 3000).unref?.() // 上游挂着不收尾也不能把用户拖在这儿
          return
        }
        // 还有下一家可切（或响应头已发出）：抓紧走下面的切家分支，不为分类等那几毫秒。
        // 这里仍记一段"正在限速"：切家成功的话本轮照常出结果，这个提示只是个短暂的进度说明。
        try { ctx.queue?.noteRateLimit({ model, provider: at.provider, retryAfterMs: ra }) } catch {}
        audit("llm.upstream_rate_limited", { actor: user.username, ip, detail: `${at.providerName} ${model}${ra ? ` retry-after ${ra}ms` : ""}` })
      }
      if (shouldRetryStatus(upRes.statusCode) && !last && !res.headersSent) {
        upRes.resume()
        return nextOr(`返回 ${upRes.statusCode}`, "UPSTREAM_UNAVAILABLE", "上游模型服务暂不可用，请稍后重试")
      }
      settled = true          // 已决定用这一家：之后这条连接再报错也不许再切家/再改响应
      const h = { ...upRes.headers }
      delete h["connection"]
      delete h["content-length"]   // 旁路不改内容，但去掉更稳（上游若分块，长度可能对不上）
      // 排过队就如实告诉客户端等了多久（诊断"这轮为什么慢"时，日志与客户端能对上）
      if (waitedMs > 0) h["x-queue-waited-ms"] = String(waitedMs)
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
        const cost = costOf(u, at.price)
        try {
          // 【入账记的是对外模型名，不是上游改名后的那个】账单要按用户看得见的模型对得上，
          // 而 respModel 是上游回的（改过名的那家会回它自己的名字）。
          ctx.recordUsage(user.id, {
            model, provider: at.provider, skill,
            prompt_tokens: u.prompt, completion_tokens: u.completion,
            cached_tokens: u.cached, cost_usd: cost,
          })
          // 供应侧同步加一笔，让预算闸在缓存到期前就跟上 —— 只靠 TTL 的话，一波并发长任务
          // 足以在 20 秒内把预算冲穿而闸毫无察觉。
          ctx.supply?.noteSpend(at.provider, cost)
        } catch (e) { log(`[llm] ${user.username} 记账失败：${e.message}`) }
        log(`[llm] ${user.username} ${model}@${at.providerName}${respModel && respModel !== model ? `(上游 ${respModel})` : ""} in=${u.prompt}(cache ${u.cached}) out=${u.completion} $${cost.toFixed(6)} ${Date.now() - started}ms`)
      }, upRes.headers["content-encoding"])

      // ★ 上游可读侧的 error 必须自己接：pipe 不转发它，抛出去就是进程级未捕获异常
      upRes.on("error", (e) => {
        log(`[llm] ${user.username} 上游流中断：${e.message}`)
        try { res.destroy() } catch {}
      })
      upRes.pipe(tap).pipe(res)
    })
    cur = up
    up.on("error", (e) => nextOr("上游错误：" + e.message, "UPSTREAM_UNAVAILABLE", "上游模型服务暂不可用，请稍后重试"))
    up.end(buf)
  }
  tryAttempt(0)
}
