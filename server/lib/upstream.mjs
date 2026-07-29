// 对「模型供应商」的两次探测：列它有哪些模型、拿一个模型真打一发看通不通。
// 只在管理台里用（加供应商时的「拉取模型」「测试」两个按钮），转发本身不走这里。
//
// 【为什么不像 /api/model/test 那样拦私网地址】那条接口是【用户】填地址，必须防内网探测；
// 这里是【管理员】配上游，而本部署最常见的上游恰恰就是私网 —— one-api 跑在 127.0.0.1:3010。
// 拦了等于把主力形态拦死。管理员本来就等同 root，这条不构成新的权限提升。

const TIMEOUT_MS = 20_000

/** baseURL 归一：去尾斜杠；没写 /v1 的自动补（各家 OpenAI 兼容端点都在 /v1 下）。 */
export function normalizeBase(baseUrl) {
  const b = String(baseUrl || "").trim().replace(/\/+$/, "")
  if (!b) return ""
  return /\/v\d+$/.test(b) ? b : b + "/v1"
}

async function call(url, { key, method = "GET", body } = {}) {
  const headers = { authorization: "Bearer " + String(key || "") }
  if (body !== undefined) headers["content-type"] = "application/json"
  let r
  try {
    r = await fetch(url, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",                       // 不跟跳转：正经的兼容端点不会重定向 POST
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, err: e?.name === "TimeoutError" ? "连接超时（20s 内无响应）" : "连不上这个地址：" + (e?.message || "网络错误") }
  }
  const text = await r.text().catch(() => "")
  let j = null
  try { j = JSON.parse(text) } catch {}
  if (r.status >= 300 && r.status < 400) return { ok: false, status: r.status, err: `该地址发生了重定向（HTTP ${r.status}），请直接填最终地址` }
  if (!r.ok) {
    const hint = (r.status === 401 || r.status === 403) ? "密钥无效或无权限"
      : r.status === 404 ? "地址或模型不存在（检查是否要带 /v1、模型名是否正确）"
        : r.status === 429 ? "上游限流，稍后再试"
          : r.status >= 500 ? "上游服务异常" : "上游返回错误"
    const detail = j?.error?.message || j?.message || ""
    return { ok: false, status: r.status, err: `${hint}（HTTP ${r.status}）${detail ? "：" + String(detail).slice(0, 160) : ""}` }
  }
  return { ok: true, status: r.status, data: j, text }
}

/** GET /models —— 拉这家有哪些模型。不是所有兼容端点都实现它，失败要能说清楚。 */
export async function listUpstreamModels(baseUrl, key) {
  const base = normalizeBase(baseUrl)
  if (!base) return { ok: false, err: "请先填 API 地址" }
  const r = await call(base + "/models", { key })
  if (!r.ok) return r
  const arr = Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : [])
  const models = arr.map((m) => (typeof m === "string" ? m : String(m?.id || ""))).filter(Boolean)
  if (!models.length) return { ok: false, err: "这家没有返回模型列表（有些兼容端点不实现 /models），请手动填模型名" }
  return { ok: true, models: [...new Set(models)].sort() }
}

/** 真打一发最小对话，确认「地址 + key + 模型名」三件套是通的。 */
export async function pingModel(baseUrl, key, model) {
  const base = normalizeBase(baseUrl)
  if (!base) return { ok: false, err: "请先填 API 地址" }
  if (!model) return { ok: false, err: "请先填模型名" }
  const t0 = Date.now()
  const r = await call(base + "/chat/completions", {
    key, method: "POST",
    body: { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false },
  })
  const ms = Date.now() - t0
  if (!r.ok) return { ...r, ms }
  const reply = r.data?.choices?.[0]?.message?.content || ""
  return { ok: true, ms, model: r.data?.model || model, reply: String(reply).slice(0, 80) }
}
