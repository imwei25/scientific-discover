// 探活不能被 opencode 拖住。
//
// 【为什么有这个文件】真机现场：一台机器装完一直停在启动页转圈满 120 秒。日志显示网关
// 早就 `gateway on http://localhost:27821` 了，没起来的是 opencode。根因是桌面壳拿
// /api/health 判就绪，而该接口应答前要先 await ocHealthy()（最长 2.5s）——于是
// 「网关是否就绪」反过来吊在「opencode 是否就绪」上，而后者恰是现场最常坏的一环。
//
// 这里把 opencode 摆成真机上的那个状态：**TCP 连得上、但永不应答**（进程起来了还在加载中，
// 正对应日志里的「30s 内未就绪」）。连接被拒是快路径，测不出问题，必须用黑洞。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"

let seq = 0

/** 只接受连接、永不回字节的 opencode 替身 */
function blackHole() {
  const socks = []
  const srv = net.createServer((s) => socks.push(s))   // 存着，别让它被 GC 或提前关
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((x) => { for (const s of socks) s.destroy(); srv.close(x) }),
  })))
}

async function gateway(ocUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webhealth-"))
  const prev = { ...process.env }
  Object.assign(process.env, {
    MANAGE_OC: "0", PORT: "0", AUTH_ENABLED: "",
    OC_URL: ocUrl,
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
  })
  const mod = await import(`../server.mjs?h=${++seq}`)
  let port
  for (let i = 0; i < 200; i++) {
    port = mod.server?.address()?.port
    if (port) break
    await new Promise((r) => setTimeout(r, 50))
  }
  process.env = prev
  if (!port) throw new Error("网关没起来（10 秒内没绑上端口）")
  const base = `http://127.0.0.1:${port}`
  return {
    close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())),
    async timed(p) {
      const t0 = Date.now()
      const r = await fetch(base + p)
      const text = await r.text()
      return { status: r.status, text, ms: Date.now() - t0 }
    },
  }
}

test("opencode 卡住时 quick 探活立刻返回，普通探活才去等它", async (t) => {
  const oc = await blackHole()
  const gw = await gateway(oc.url)
  t.after(async () => { await gw.close(); await oc.close() })

  // 壳走的这条：必须马上有答案，且判定串 "gateway":true 在里面
  const quick = await gw.timed("/api/health?quick=1")
  assert.equal(quick.status, 200)
  assert.ok(quick.text.includes('"gateway":true'), `quick 应答缺判定串: ${quick.text}`)
  assert.ok(quick.ms < 500, `quick 探活被拖了 ${quick.ms}ms —— 它绝不该去碰 opencode`)

  // 对照组：不带 quick 就该老老实实吊在 ocHealthy 的 2.5s 超时上。
  // 这条同时说明了故障是真的——否则上面那条"快"没有意义。
  const full = await gw.timed("/api/health")
  assert.equal(full.status, 503, "opencode 不可用时整体探活应报 503")
  assert.ok(full.ms >= 2000, `完整探活只花了 ${full.ms}ms，ocHealthy 的超时没生效，本测试失去意义`)
})
