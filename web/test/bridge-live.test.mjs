// 聊天接入（微信/企微）→ 软件侧直播中继的回归测试。
// 覆盖两件事：① oc-wrap 把事件真的 POST 出去了（批量、只留最后一条累计正文、带 sid/dir/startedAt、
// 带 Bearer 令牌）；② 网关认不出会话时的兜底路径（回 sid 后 oc-wrap 记住它）。
// 网关那半边（bridgeIngest / 影子 job）跑在 server.mjs 进程里，这里用一个假网关代替，
// 只钉住"我们发给它的东西长什么样"这个契约。
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"

/** 起一个假网关，收下所有 POST 体，可指定回什么。 */
function fakeGateway(reply = { ok: true }) {
  const got = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch {}
      got.push({ url: req.url, auth: req.headers.authorization, body })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(typeof reply === "function" ? reply(body) : reply))
    })
  })
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, got, port: srv.address().port })))
}

test("oc-wrap 直播中继：批量上报、累计正文只留最后一条、带令牌", async () => {
  const gw = await fakeGateway({ ok: true, sid: "ses_from_gw" })
  process.env.SCI_WRAP_LIVE_URL = `http://127.0.0.1:${gw.port}/api/chat-bridge/live`
  process.env.SCI_WRAP_LIVE_TOKEN = "local-test-token"
  process.env.SCI_WRAP_OC = process.execPath          // 只为让模块加载时不报缺环境（本测试不起 opencode）
  const W = await import("../chat-bridge/oc-wrap.mjs?live=1")

  W.liveNote({ k: "start" })
  W.liveNote({ k: "reasoning", id: "r1", text: "先看看数据" })
  W.liveNote({ k: "tool", callID: "c1", tool: "bash", status: "running", title: "ls" })
  W.liveNote({ k: "text", text: "第一" })
  W.liveNote({ k: "text", text: "第一第二" })
  await new Promise((r) => W.liveFlush(r))

  assert.equal(gw.got.length, 1, "一批只发一个请求")
  const { url, auth, body } = gw.got[0]
  assert.equal(url, "/api/chat-bridge/live")
  assert.equal(auth, "Bearer local-test-token")
  assert.equal(typeof body.dir, "string")
  assert.ok(body.startedAt > 0)
  const kinds = body.events.map((e) => e.k)
  assert.deepEqual(kinds, ["start", "reasoning", "tool", "text"], "累计正文只留最后一条")
  assert.equal(body.events[3].text, "第一第二")

  // 网关认领出来的会话 id 要被记住：下一批就带上它，不必让它再猜
  W.liveNote({ k: "done", text: "答完了" })
  await new Promise((r) => W.liveFlush(r))
  assert.equal(gw.got.length, 2)
  assert.equal(gw.got[1].body.sid, "ses_from_gw")
  assert.deepEqual(gw.got[1].body.events, [{ k: "done", text: "答完了" }])

  gw.srv.close()
})

test("oc-wrap 直播中继：网关不通也不能影响本轮（不抛、不卡）", async () => {
  process.env.SCI_WRAP_LIVE_URL = "http://127.0.0.1:1/api/chat-bridge/live"   // 必然连不上
  process.env.SCI_WRAP_LIVE_TOKEN = "x"
  process.env.SCI_WRAP_OC = process.execPath
  const W = await import("../chat-bridge/oc-wrap.mjs?live=2")
  W.liveNote({ k: "text", text: "hi" })
  const t0 = Date.now()
  await new Promise((r) => W.liveFlush(r))
  assert.ok(Date.now() - t0 < 4000, "连不上要立刻放行，不能拖着本轮")
})
