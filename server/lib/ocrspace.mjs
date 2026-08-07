// 图片识字代理（/ocr/）—— 让客户端不用碰 OCR key。
//
// 【为什么要有这一层】ocr 技能要调 OCR.space 把图片里的字识别出来。技能是在【用户自己那台
// 机器】上跑的（桌面打包版：opencode 是本机进程），所以最省事的做法是把 key 发到每台机器上
// ——那等于把一把共享密钥散出去：用户看得到、没法按人限额、泄了要全员换。与本平台对 LLM key
// 的既有原则（"上游 key 绝不下发到客户端"，见 gateway.mjs）自相矛盾。照 /img 的样子再开一条
// /ocr：客户端带自己的 access key 打过来，服务器贴 OCR key 转发。
//
// 【与 /img 的两点不同，都是刻意的】
//   ① 额度是【全平台共享】的，不只是每人一份。OCR.space 按 key + 出口 IP 计额（免费档
//      Engine3 每月 2500 次、每天 500 次/IP），而走了代理之后所有用户都从本服务器这一个 IP
//      出去 —— 只有每人每天的闸挡不住"人多把公共额度耗光"。故除 tiers.ocr_daily 外，还有
//      OCR_DAILY_CAP / OCR_MONTHLY_CAP 两条全平台闸（0 = 不限，付费 key 就设 0）。
//   ② 图片字节【要经过本服务器】：OCR.space 只认 base64 或它能访问到的公网 URL，而用户的图
//      多半在他自己电脑上。所以客户端把（技能侧已压到 1MB 内的）图 base64 传上来，服务器转
//      成 base64Image 发给上游。识别结果是纯文本，回程很小。
//
// 【额度在什么时候扣】只扣**识别成功**的那次：上游报错、限速、我们自己拦下的都不算——
// 否则一次上游抖动就白吃掉用户当天的一次，而他什么都没拿到。

import https from "node:https"
import http from "node:http"

export const OCR_PATH_PREFIX = "/ocr/"

const DEFAULT_ENDPOINT = "https://api.ocr.space/parse/image"
// Engine3 对中文与表格最准（技能文档里写死的也是它）。引擎由服务器定、不让客户端点名：
// 各引擎的免费额度差一个量级（Engine3 2500/月 vs Engine1/2 25000/月），放任客户端选
// 等于让它自己挑要烧哪个池子（与 /llm 的 pickModel、/img 的 model 同一个理由）。
const DEFAULT_ENGINE = "3"
// 请求体 = 一张 base64 图。技能侧已压到 1MB 以内，base64 后约 1.4MB，留到 6MB 兜底。
const BODY_LIMIT = 6 << 20
// OCR.space 免费档单图上限 1024KB。技能侧压过一次，这里是第二道网——超了要说人话，
// 不能让用户拿到上游一句语焉不详的英文报错。
const MAX_IMAGE_BYTES = 1_024_000
const UPSTREAM_TIMEOUT_MS = 120_000

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

/** application/x-www-form-urlencoded 一次上游调用（Promise 化，便于超时与错误统一处理）。 */
function callUpstream(endpoint, form) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(endpoint) } catch { return reject(new Error("OCR 上游地址配置有误")) }
    const body = Buffer.from(new URLSearchParams(form).toString(), "utf8")
    const mod = u.protocol === "https:" ? https : http
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": body.length,
        // 【钉死 identity】理由同 /llm、/img：压缩体会让下面的 JSON.parse 失败，
        // 而失败的表现是"字没出来但次数扣了"，最难查。
        "accept-encoding": "identity",
      },
    }, (res) => {
      const bufs = []
      let len = 0
      res.on("data", (c) => { if (len < 8 << 20) { bufs.push(c); len += c.length } })
      res.on("end", () => {
        const text = Buffer.concat(bufs).toString("utf8")
        let json = null
        try { json = JSON.parse(text) } catch { /* 上游回了非 JSON（限速时就是一句英文纯文本） */ }
        resolve({ status: res.statusCode || 502, text, json })
      })
      res.on("error", reject)
    })
    req.on("error", reject)
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => { req.destroy(new Error("OCR 上游超时")) })
    req.write(body)
    req.end()
  })
}

/**
 * 从 OCR.space 的响应里取出识别文本。
 * 成功返回 { text }；上游明说失败返回 { err }（文案已是能直接给用户看的中文/原文）。
 */
export function extractText(json) {
  if (!json || typeof json !== "object") return { err: "上游返回的不是合法 JSON" }
  const errish = (v) => (Array.isArray(v) ? v.join("；") : String(v || "")).trim()
  if (json.IsErroredOnProcessing) return { err: errish(json.ErrorMessage) || "上游未说明原因" }
  const rs = json.ParsedResults
  if (!Array.isArray(rs) || !rs.length) return { err: errish(json.ErrorMessage) || "上游没有返回识别结果" }
  const r = rs[0]
  // FileParseExitCode：1 = 成功，其余（0/-10/-20/-30/-99）都是这一张没识别成
  if (Number(r?.FileParseExitCode) !== 1) return { err: errish(r?.ErrorMessage) || "这张图没有识别成功" }
  return { text: String(r?.ParsedText ?? "") }
}

/** 上游的错误话术里带这些字样 = 是平台的额度/限速问题，不是用户的次数用完了 */
const quotaish = (status, msg) =>
  status === 429 || status === 402 || status === 403 ||
  /quota|rate ?limit|maximum|upto|exceed|额度|限速/i.test(msg)

/**
 * 处理 POST /ocr/parse。
 * ctx 提供：authClient / noteClient / resolveEntitlement / todayOcr / recordOcr / ocrTotals
 *           / audit / fail / json / log / clientIp / CFG
 */
export async function ocrForward({ req, res, pathname, ctx }) {
  const { fail, json, audit, log, CFG: cfg } = ctx
  const ip = ctx.clientIp(req)

  if (pathname !== OCR_PATH_PREFIX + "parse")
    return fail(res, 404, "NOT_FOUND", "OCR 接口只有 POST /ocr/parse")
  if (req.method !== "POST")
    return fail(res, 405, "METHOD_NOT_ALLOWED", "只接受 POST")

  // ---- ① 认 key（与 /llm、/img 同一把 access key、同一套判据）----
  const au = ctx.authClient(req)
  if (!au.ok) return fail(res, au.status, au.code, au.message)
  const user = au.user
  ctx.noteClient(user, req)

  // ---- ② 有没有配 OCR key ----
  // 【先于额度判】没配 key 时谁都识别不了，这时候扣人次数或说"你今天用完了"都是误导。
  const upstreamKey = String(cfg.ocrKey || "").trim()
  if (!upstreamKey)
    return fail(res, 503, "OCR_UNCONFIGURED",
      "平台还没有配置图片识字服务，请联系管理员（免费 key 在 https://ocr.space/ocrapi 注册即得）")

  // ---- ③ 次数闸（请求前预检）----
  // 先判全平台、再判个人：全平台先满时，告诉用户"这是平台的池子满了、不是你用完了"，
  // 否则他会去找管理员要更高档位，而调档位根本解决不了。
  const totals = ctx.ocrTotals()
  const dayCap = Math.max(0, Math.floor(Number(cfg.ocrDailyCap) || 0))
  const monCap = Math.max(0, Math.floor(Number(cfg.ocrMonthlyCap) || 0))
  if (dayCap > 0 && totals.day >= dayCap) {
    audit("ocr.platform_block", { actor: user.username, ip, detail: `day ${totals.day}/${dayCap}` })
    return fail(res, 429, "OCR_PLATFORM_QUOTA",
      `平台今天的图片识字总次数已用满（${totals.day}/${dayCap}，全体用户共享），明日 0 点(UTC)恢复。` +
      `不是你的次数用完了；管理员可调 OCR_DAILY_CAP 或换用付费 key。`,
      { scope: "platform-daily", used: totals.day, limit: dayCap })
  }
  if (monCap > 0 && totals.month >= monCap) {
    audit("ocr.platform_block", { actor: user.username, ip, detail: `month ${totals.month}/${monCap}` })
    return fail(res, 429, "OCR_PLATFORM_QUOTA",
      `平台本月的图片识字总次数已用满（${totals.month}/${monCap}，全体用户共享）。` +
      `不是你的次数用完了；管理员可调 OCR_MONTHLY_CAP 或换用付费 key。`,
      { scope: "platform-monthly", used: totals.month, limit: monCap })
  }

  const ent = ctx.resolveEntitlement(user)
  const limit = Math.max(0, Math.floor(Number(ent.ocrDaily) || 0))
  const used = ctx.todayOcr(user.id)
  if (limit > 0 && used >= limit) {
    audit("ocr.quota_block", { actor: user.username, ip, detail: `${used}/${limit}` })
    return fail(res, 429, "OCR_QUOTA_EXCEEDED",
      `今天的图片识字次数已用完（${used}/${limit} 次），明日 0 点(UTC)恢复。需要更多请联系管理员调整档位`,
      { used, limit, scope: "daily" })
  }

  // ---- ④ 读请求体 ----
  const b = await readBody(req)
  if (b.tooLarge) return fail(res, 413, "BODY_TOO_LARGE", "请求体过大（单图请压到 1MB 以内）")
  if (b.bad) return fail(res, 400, "BAD_REQUEST", "请求体不是合法 JSON")
  // 客户端可以直接传 data URI，也可以只传裸 base64；统一剥成裸的再自己拼前缀，
  // 免得两端各拼一次拼出 "data:...;base64,data:...;base64,"。
  const raw = String(b.json?.image || "").trim()
  if (!raw) return fail(res, 400, "BAD_REQUEST", "缺 image（图片的 base64）")
  const m = /^data:([\w.+-]+\/[\w.+-]+)?;base64,(.*)$/s.exec(raw)
  const b64 = (m ? m[2] : raw).replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return fail(res, 400, "BAD_REQUEST", "image 不是合法的 base64")
  const bytes = Math.floor(b64.length * 3 / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0)
  if (bytes > MAX_IMAGE_BYTES)
    return fail(res, 413, "IMAGE_TOO_LARGE",
      `单图上限 1MB，这张 ${(bytes / 1024 / 1024).toFixed(2)}MB。请压缩或分块后重试（ocr.sh 本会自动压缩）`)
  // 上游按 base64 前缀判类型；客户端没说就按 jpeg（技能压缩超标图后统一出 JPEG）。
  // 【PDF 也放行】OCR.space 本来就收 PDF；这里若只认 image/*，客户端老实报了 pdf 反而会被
  // 悄悄改成 jpeg —— 那是"我们把它改错了"，比直接拒绝更难查。
  const okMime = (s) => /^image\/[\w.+-]+$/.test(s) || s === "application/pdf"
  const mime = okMime(String(b.json?.mime || "")) ? String(b.json.mime)
    : (m && okMime(m[1] || "") ? m[1] : "image/jpeg")
  // 语种与"是否按表格排版"不影响计价，随客户端；语种做个白名单式的形状校验，
  // 别把用户输入原样拼进上游表单。
  const lang = /^[a-z]{3}$/.test(String(b.json?.language || "")) ? String(b.json.language) : "chs"
  const isTable = b.json?.table === false ? "false" : "true"
  const engine = String(cfg.ocrEngine || "").trim() || DEFAULT_ENGINE
  const endpoint = String(cfg.ocrEndpoint || "").trim() || DEFAULT_ENDPOINT
  const name = String(b.json?.filename || "").slice(0, 120)

  // ---- ⑤ 转发 ----
  let up
  const t0 = Date.now()
  try {
    up = await callUpstream(endpoint, {
      apikey: upstreamKey,
      base64Image: `data:${mime};base64,${b64}`,
      language: lang,
      OCREngine: engine,
      isTable,
      isOverlayRequired: "false",
    })
  } catch (e) {
    log(`[ocr] ${user.username} 上游异常：${e?.message || e}`)
    audit("ocr.upstream_error", { actor: user.username, ip, detail: String(e?.message || e).slice(0, 200) })
    return fail(res, 502, "OCR_UPSTREAM_ERROR", "图片识字服务暂时不可用，请稍后重试（本次不计入你的次数）")
  }

  if (up.status !== 200) {
    const msg = String(up.json?.ErrorMessage || up.text || "").replace(/\s+/g, " ").slice(0, 300)
    log(`[ocr] ${user.username} 上游 ${up.status}：${msg}`)
    audit("ocr.upstream_fail", { actor: user.username, ip, detail: `${up.status} ${msg}`.slice(0, 250) })
    const q = quotaish(up.status, msg)
    return fail(res, q ? 429 : 502,
      q ? "OCR_UPSTREAM_QUOTA" : "OCR_UPSTREAM_ERROR",
      q
        ? "平台的图片识字额度已用尽或被限速（不是你的次数）。请联系管理员——免费档每月 2500 次、每天 500 次，全体用户共享。你今天的次数没有被扣。"
        : `识别失败（上游 ${up.status}）。请稍后重试；持续如此请联系管理员。本次不计入你的次数。`,
      { upstreamStatus: up.status })
  }

  const got = extractText(up.json)
  if (got.err) {
    log(`[ocr] ${user.username} 上游 200 但没识别成：${got.err.slice(0, 200)}`)
    audit("ocr.no_result", { actor: user.username, ip, detail: got.err.slice(0, 200) })
    // 【不扣次数】用户什么都没拿到
    const q = quotaish(200, got.err)
    return fail(res, q ? 429 : 502,
      q ? "OCR_UPSTREAM_QUOTA" : "OCR_NO_RESULT",
      q
        ? "平台的图片识字额度已用尽或被限速（不是你的次数），请联系管理员。你今天的次数没有被扣。"
        : `这张图没有识别出内容：${got.err}（本次不计入你的次数）`)
  }

  // ---- ⑥ 成功才计数 ----
  const usedAfter = ctx.recordOcr(user.id)
  audit("ocr.parse", { actor: user.username, ip, detail: `e${engine} ${lang} ${got.text.length}字 ${usedAfter}/${limit || "∞"} ${Date.now() - t0}ms` })
  log(`[ocr] ${user.username} 识别成功 ${name || "(未命名)"} ${got.text.length} 字（今日 ${usedAfter}/${limit || "不限"}，${Date.now() - t0}ms）`)

  return json(res, 200, {
    ok: true,
    text: got.text,
    engine,
    quota: { used: usedAfter, limit, remain: limit > 0 ? Math.max(0, limit - usedAfter) : null, unlimited: limit === 0 },
  })
}
