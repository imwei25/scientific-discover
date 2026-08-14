// one-api 管理 API 的薄封装：让运营后台能看/切上游通道（DeepSeek、硅基流动……）。
//
// 【失败自动切备用是 one-api 自己的能力，不是我们实现的】它按 (分组, 模型名) 选通道：
// 优先级(priority)高的先用，同优先级按权重随机；调用失败会自动重试其它可用通道。
// 所以"默认走哪个 / 谁当备用"= 调优先级，"停用某通道"= 调 status。
//
// ⚠ 两条必须让运营看见的约束（UI 里也写了）：
//   ① **只有服务同一个模型名的通道之间才构成备份**。DeepSeek 挂 deepseek-v4-pro、
//      硅基流动挂 deepseek-ai/DeepSeek-V4-Flash，这俩互相不是备用——档位请求哪个模型名，
//      就只会在挂了该名字的通道里挑。要互为备份，就得给两个通道挂上同一个模型名。
//   ② 我们的计量单价（COST_*）是**全局一张表**。若同一模型名下挂了不同价的供应商，
//      流量切过去时账会静默偏。切之前先对价。
import http from "node:http"
import https from "node:https"

/** one-api 里 status 的含义 */
export const CHANNEL_STATUS = { 1: "启用", 2: "已停用", 3: "自动停用" }

function request(cfg, method, apiPath, body) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(String(cfg.url).replace(/\/+$/, "") + apiPath) } catch { return resolve({ ok: false, err: "one-api 地址配置有误" }) }
    const data = body !== undefined ? JSON.stringify(body) : null
    const headers = { "Authorization": "Bearer " + cfg.token, "New-Api-User": "1" }
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data) }
    const mod = u.protocol === "https:" ? https : http
    const req = mod.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, headers,
    }, (r) => {
      let b = ""
      r.on("data", (c) => (b += c))
      r.on("end", () => {
        let j = null
        try { j = JSON.parse(b || "{}") } catch {}
        if (!j) return resolve({ ok: false, status: r.statusCode, err: "one-api 返回的不是 JSON" })
        // one-api 的约定：{success:bool, message:string, data:any}
        if (j.success === false) return resolve({ ok: false, status: r.statusCode, err: j.message || "one-api 拒绝了请求" })
        resolve({ ok: true, status: r.statusCode, data: j.data !== undefined ? j.data : j })
      })
    })
    req.on("error", (e) => resolve({ ok: false, err: "连不上 one-api：" + e.message }))
    req.setTimeout(20000, () => { req.destroy(); resolve({ ok: false, err: "one-api 响应超时" }) })
    if (data) req.write(data)
    req.end()
  })
}

export const enabled = (cfg) => !!(cfg && cfg.url && cfg.token)

/** 通道列表（含优先级/状态/模型），按"模型名 → 优先级"整理好给前端 */
export async function listChannels(cfg) {
  const r = await request(cfg, "GET", "/api/channel/?p=0&page_size=200")
  if (!r.ok) return r
  const raw = Array.isArray(r.data) ? r.data : (r.data?.items || r.data?.records || [])
  const channels = raw.map((c) => ({
    id: c.id,
    name: c.name || "",
    type: c.type,
    status: c.status,
    statusText: CHANNEL_STATUS[c.status] || String(c.status),
    priority: Number(c.priority) || 0,
    weight: Number(c.weight) || 0,
    group: c.group || "default",
    baseUrl: c.base_url || "",
    models: String(c.models || "").split(",").map((s) => s.trim()).filter(Boolean),
    // one-api 把模型改名规则存成 JSON 字符串：{"对外模型名":"该供应商真实模型名"}
    modelMapping: (() => { try { return JSON.parse(c.model_mapping || "{}") || {} } catch { return {} } })(),
    // 统计信息（不同 one-api 版本字段不全一致，取到就给）
    usedQuota: c.used_quota, responseTime: c.response_time, testTime: c.test_time,
  }))
  // 每个模型名下谁是默认、谁是备用：同名里 priority 最大的是默认
  const byModel = {}
  for (const c of channels) {
    for (const m of c.models) {
      (byModel[m] = byModel[m] || []).push({ id: c.id, name: c.name, priority: c.priority, status: c.status })
    }
  }
  for (const m of Object.keys(byModel)) byModel[m].sort((a, b) => b.priority - a.priority || a.id - b.id)
  return { ok: true, channels, byModel }
}

/** 改一个通道（只允许改这三样，别把 key/base_url 也开出去——那属于配置变更，走 one-api 自己的台） */
export async function updateChannel(cfg, { id, priority, status, weight }) {
  const cur = await listChannels(cfg)
  if (!cur.ok) return cur
  const c = cur.channels.find((x) => x.id === Number(id))
  if (!c) return { ok: false, err: "通道不存在" }
  // one-api 的更新是整体 PUT：必须把原字段带全，只改我们要改的那几个，
  // 否则没带上的字段会被清空（key 被清掉 = 该通道直接废掉）。
  const body = { id: c.id }
  if (priority !== undefined) body.priority = Math.max(0, Number(priority) || 0)
  if (weight !== undefined) body.weight = Math.max(0, Number(weight) || 0)
  if (status !== undefined) body.status = Number(status) === 1 ? 1 : 2
  const r = await request(cfg, "PUT", "/api/channel/", body)
  if (!r.ok) return r
  return { ok: true }
}

/** 让 one-api 实测一个通道（它会真发一次请求） */
export async function testChannel(cfg, id) {
  const r = await request(cfg, "GET", `/api/channel/test/${Number(id)}`)
  if (!r.ok) return r
  return { ok: true, data: r.data }
}

/**
 * 让某通道也接管某个模型名（默认当备用挂上去）。
 *
 * 这一步才让「默认不通走备用」真正成立：one-api 只在**挂了同一模型名**的通道之间兜底。
 * 现网就是活例子——DeepSeek 挂 deepseek-v4-pro、硅基流动挂 deepseek-ai/DeepSeek-V4-Flash，
 * 看着有两条通道，实际互不兜底，主通道一挂全站就停。
 *
 * mapTo：该供应商自己的真实模型名。填了就写进 model_mapping，请求转过去时自动改名；
 *        不填就表示这家也用同一个名字。
 * asBackup：挂成备用（优先级低于当前默认）。当前默认优先级是 0 时，先把它抬到 1，
 *          否则两边同级会变成负载均衡，而不是"主挂了才走备用"。
 */
export async function serveModel(cfg, { id, model, mapTo, asBackup = true }) {
  const name = String(model || "").trim()
  if (!name) return { ok: false, err: "请填要接管的模型名" }
  const cur = await listChannels(cfg)
  if (!cur.ok) return cur
  const me = cur.channels.find((x) => x.id === Number(id))
  if (!me) return { ok: false, err: "通道不存在" }
  if (me.models.includes(name)) return { ok: false, err: `该通道已经挂了 ${name}` }

  const mapping = { ...me.modelMapping }
  if (mapTo && String(mapTo).trim()) mapping[name] = String(mapTo).trim()

  const body = {
    id: me.id,
    models: [...me.models, name].join(","),
    model_mapping: JSON.stringify(mapping),
  }
  if (asBackup) {
    const peers = (cur.byModel[name] || []).filter((x) => x.id !== me.id)
    const top = peers.length ? Math.max(...peers.map((x) => x.priority)) : 0
    if (peers.length && top <= 0) {
      // 把现任默认抬到 1，自己留在 0 —— 否则同级会变成随机分流
      const def = peers.find((x) => x.priority === top)
      const up = await updateChannel(cfg, { id: def.id, priority: 1 })
      if (!up.ok) return up
      body.priority = 0
    } else {
      body.priority = Math.max(0, top - 1)
    }
  }
  const r = await request(cfg, "PUT", "/api/channel/", body)
  if (!r.ok) return r
  return { ok: true, models: body.models.split(","), priority: body.priority, mapping }
}

/**
 * 把某通道设为某模型的默认：给它一个比同模型其它通道都高的优先级。
 * 不去动别人的优先级 —— 只抬自己，语义最小、也不会把别人的相对次序搅乱。
 */
export async function makeDefault(cfg, id, model) {
  const cur = await listChannels(cfg)
  if (!cur.ok) return cur
  const me = cur.channels.find((x) => x.id === Number(id))
  if (!me) return { ok: false, err: "通道不存在" }
  const peers = (cur.byModel[model] || []).filter((x) => x.id !== me.id)
  const top = peers.length ? Math.max(...peers.map((x) => x.priority)) : 0
  if (me.priority > top) return { ok: true, unchanged: true, priority: me.priority }
  const next = top + 1
  const r = await updateChannel(cfg, { id: me.id, priority: next })
  if (!r.ok) return r
  return { ok: true, priority: next }
}
