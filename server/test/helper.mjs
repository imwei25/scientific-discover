// 测试脚手架：每个测试起一个独立的 sci-auth 实例（内存库 + 随机端口），互不干扰。
//
// sci-auth.mjs 在模块加载时就开库、读配置，所以只能靠「改 env 再动态 import」来隔离；
// 加 query 串绕过 ESM 模块缓存，拿到全新实例。

import http from "node:http"

let seq = 0

export async function startApp(env = {}) {
  const prev = { ...process.env }
  Object.assign(process.env, {
    DB_FILE: ":memory:",
    LISTEN: "127.0.0.1:0",
    ADMIN_PASSWORD: "adminpw",
    KEY_SECRET: "test-secret-" + (++seq),
    LLM_UPSTREAM_KEY: "upstream-key",
    DATA_DIR: "",
    TEST_BYPASS_TOKEN: "t-bypass",   // 只免图形验证码，口令仍要对（见 sci-auth.mjs 的说明）
    ...env,
  })
  const mod = await import(`../sci-auth.mjs?t=${seq}`)
  await new Promise((r) => mod.server.listen(0, "127.0.0.1", r))
  const port = mod.server.address().port
  const base = `http://127.0.0.1:${port}`
  process.env = prev

  return {
    mod, base, db: mod.db, port,
    async close() { await new Promise((r) => mod.server.close(r)) },
    /** 发请求，返回 {status, headers, json, text} */
    async req(pathname, { method = "GET", body, headers = {}, raw = false } = {}) {
      const h = { ...headers }
      let payload
      if (body !== undefined) {
        if (raw) { payload = body } else { payload = JSON.stringify(body); h["content-type"] = "application/json" }
      }
      const r = await fetch(base + pathname, { method, headers: h, body: payload })
      const text = await r.text()
      let js = null
      try { js = JSON.parse(text) } catch {}
      return { status: r.status, headers: Object.fromEntries(r.headers), json: js, text }
    },
  }
}

/** 以管理员身份登录，返回可直接塞进 headers 的 cookie 串。 */
export async function adminLogin(app, password = "adminpw") {
  const r = await app.req("/admin/api/login", {
    method: "POST", body: { password }, headers: { "x-test-bypass": "t-bypass" },
  })
  if (r.status !== 200) throw new Error("管理员登录失败：" + r.text)
  const sc = r.headers["set-cookie"] || ""
  return sc.split(";")[0]
}

/** 便捷：以管理员身份发请求 */
export const asAdmin = (app, cookie) => (p, opt = {}) =>
  app.req(p, { ...opt, headers: { ...(opt.headers || {}), cookie } })

/** 起一个假的上游模型服务，用来验证网关的转发/计量。 */
export function startFakeUpstream(handler) {
  const srv = http.createServer(handler)
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      srv,
      url: `http://127.0.0.1:${srv.address().port}`,
      close: () => new Promise((r) => srv.close(r)),
    }))
  })
}

/** SSE 响应体拼装工具 */
export const sse = (objs) =>
  objs.map((o) => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n"
