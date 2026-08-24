// 直连自己 API 的两件事：① 凭证可勾选存在本机（最多 3 套，来回切不用重输 key）；
// ② 模型 ID 可一次填多个，顶部 pill 直接切换。
// 只起本机网关（不接管 opencode、不连云端），断言落盘内容与各接口行为。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let seq = 0

/** 起本机网关进程（不接管 opencode，配置文件都落临时目录） */
async function gateway() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apiprof-"))
  const prev = { ...process.env }
  Object.assign(process.env, {
    MANAGE_OC: "0", PORT: "0", AUTH_ENABLED: "",
    OC_URL: "http://127.0.0.1:1",                            // 不会去连
    ALLOW_PRIVATE_MODEL_URL: "1",                            // 测试用的 baseURL 是 127.0.0.1，默认被 SSRF 护栏拒
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),    // 别读到开发机真实的 cloud.json
    CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    API_PROFILES_PATH: path.join(dir, "api-profiles.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
    OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
  })
  const mod = await import(`../server.mjs?p=${++seq}`)
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来（10 秒内没绑上端口）")
  process.env = prev
  const base = `http://127.0.0.1:${port}`
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) } catch { return null } }
  return {
    base, dir,
    close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())),
    cfg: () => readJson("model-config.json"),
    profs: () => readJson("api-profiles.json"),
    oc: () => readJson("opencode.json"),
    async req(p, { method = "GET", body } = {}) {
      const r = await fetch(base + p, {
        method, headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, json: await r.json().catch(() => null) }
    },
  }
}

test("多个模型 ID：全部注册进 provider，第一个是默认", async (t) => {
  const gw = await gateway(); t.after(() => gw.close())
  const r = await gw.req("/api/model", { method: "POST", body: {
    baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-one", models: "m-a\nm-b, m-c",
  } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.modelID, "m-a")
  assert.deepEqual(r.json.models, ["m-a", "m-b", "m-c"])
  assert.deepEqual(Object.keys(gw.oc().provider.custom.models), ["m-a", "m-b", "m-c"])
  assert.deepEqual(gw.cfg().models, ["m-a", "m-b", "m-c"])

  // 清单接口按它出下拉
  const list = await gw.req("/api/models")
  assert.equal(list.json.route, "custom")
  assert.deepEqual(list.json.models.map((x) => x.model), ["m-a", "m-b", "m-c"])
  assert.equal(list.json.current, "m-a")

  // 切到 m-c：沿用同一套 key，不用重填
  const pick = await gw.req("/api/model/pick", { method: "POST", body: { model: "m-c" } })
  assert.equal(pick.json.ok, true)
  assert.equal(gw.cfg().modelID, "m-c")
  assert.equal((await gw.req("/api/model")).json.modelID, "m-c")

  // 没填过的模型不许切（网关那边会静默换回默认，客户端跟着静默就成了"选了没换"的谜团）
  const bad = await gw.req("/api/model/pick", { method: "POST", body: { model: "m-zzz" } })
  assert.equal(bad.json.ok, false)
})

test("不勾「记住」就绝不落盘；勾了才存，且 key 不回前端", async (t) => {
  const gw = await gateway(); t.after(() => gw.close())
  await gw.req("/api/model", { method: "POST", body: { baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-one", models: "m-a" } })
  assert.equal(gw.profs(), null)
  assert.deepEqual((await gw.req("/api/model")).json.profiles, [])

  const r = await gw.req("/api/model", { method: "POST", body: {
    baseURL: "http://127.0.0.2:9/v1", apiKey: "sk-abcdef123456", models: "m-a\nm-b", remember: true, name: "我的 DeepSeek",
  } })
  assert.equal(r.json.saved.name, "我的 DeepSeek")
  assert.equal(gw.profs().length, 1)
  assert.equal(gw.profs()[0].apiKey, "sk-abcdef123456")

  const m = (await gw.req("/api/model")).json
  assert.equal(m.profiles.length, 1)
  assert.equal(m.profiles[0].keyMask, "sk-a••••3456")
  assert.equal(JSON.stringify(m).includes("sk-abcdef123456"), false, "key 绝不能回前端")
})

test("同一地址覆盖不占新格；满 3 套后挤掉最久没用的那套", async (t) => {
  const gw = await gateway(); t.after(() => gw.close())
  const save = (host, key, name) => gw.req("/api/model", { method: "POST", body: {
    baseURL: `http://127.0.0.${host}:9/v1`, apiKey: key, models: "m-a", remember: true, name,
  } })
  await save(2, "sk-1", "一")
  await save(2, "sk-1b", "一改")              // 同地址 → 覆盖
  assert.equal(gw.profs().length, 1)
  assert.equal(gw.profs()[0].apiKey, "sk-1b")
  assert.equal(gw.profs()[0].name, "一改")

  await save(3, "sk-2", "二")
  await save(4, "sk-3", "三")
  assert.equal(gw.profs().length, 3)
  const r = await save(5, "sk-4", "四")
  assert.equal(gw.profs().length, 3)
  assert.equal(r.json.dropped, "一改", "挤掉的应是最久没用过的那套，并如实告诉前端")
  assert.deepEqual(gw.profs().map((p) => p.name).sort(), ["三", "二", "四"])
})

test("用存下来的凭证切换：不用重填 key；删除只删存档不动当前路由", async (t) => {
  const gw = await gateway(); t.after(() => gw.close())
  await gw.req("/api/model", { method: "POST", body: {
    baseURL: "http://127.0.0.2:9/v1", apiKey: "sk-two", models: "m-a\nm-b", remember: true, name: "甲",
  } })
  await gw.req("/api/model", { method: "POST", body: { baseURL: "http://127.0.0.3:9/v1", apiKey: "sk-three", models: "m-x", remember: true, name: "乙" } })
  const id = (await gw.req("/api/model")).json.profiles.find((p) => p.name === "甲").id

  const use = await gw.req("/api/model/profiles/use", { method: "POST", body: { id, model: "m-b" } })
  assert.equal(use.json.ok, true)
  assert.equal(use.json.modelID, "m-b")
  assert.equal(gw.cfg().apiKey, "sk-two")
  assert.equal(gw.cfg().baseURL, "http://127.0.0.2:9/v1")
  assert.deepEqual(Object.keys(gw.oc().provider.custom.models), ["m-a", "m-b"])

  // 删掉“乙”：当前跑的还是“甲”，不该被动
  const lid = (await gw.req("/api/model")).json.profiles.find((p) => p.name === "乙").id
  const del = await gw.req("/api/model/profiles/delete", { method: "POST", body: { id: lid } })
  assert.equal(del.json.profiles.length, 1)
  assert.equal(gw.cfg().apiKey, "sk-two")
  assert.equal(gw.cfg().modelID, "m-b")

  // 已删掉的 id 再用要说清楚，不能 500
  const gone = await gw.req("/api/model/profiles/use", { method: "POST", body: { id: lid } })
  assert.equal(gone.status, 404)
  assert.equal(gone.json.ok, false)
})

test("key 留空 = 沿用本机已存的那把（只是加个模型 ID，不必翻出 key 重粘）", async (t) => {
  const gw = await gateway(); t.after(() => gw.close())
  await gw.req("/api/model", { method: "POST", body: { baseURL: "http://127.0.0.2:9/v1", apiKey: "sk-two", models: "m-a" } })
  const r = await gw.req("/api/model", { method: "POST", body: { baseURL: "http://127.0.0.2:9/v1", apiKey: "", models: "m-a\nm-b" } })
  assert.equal(r.json.ok, true)
  assert.equal(gw.cfg().apiKey, "sk-two")
  assert.deepEqual(gw.cfg().models, ["m-a", "m-b"])

  // 换个从没配过的地址、又不给 key → 必须报错，别拿别家的 key 去打
  const other = await gw.req("/api/model", { method: "POST", body: { baseURL: "http://127.0.0.9:9/v1", apiKey: "", models: "m-a" } })
  assert.equal(other.status, 400)
  assert.equal(other.json.ok, false)
  assert.equal(gw.cfg().baseURL, "http://127.0.0.2:9/v1")
})

test("SSRF 护栏对「用这套凭证」同样生效（存档里的地址也要过闸）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apiprof-ssrf-"))
  // 先在盘上放一套指向元数据服务的凭证，再起一个【没开】ALLOW_PRIVATE_MODEL_URL 的网关
  fs.writeFileSync(path.join(dir, "api-profiles.json"), JSON.stringify([{
    id: "p1", name: "坏的", baseURL: "http://169.254.169.254/v1", apiKey: "sk-x", modelID: "m-a", models: ["m-a"], savedAt: 1,
  }]))
  const prev = { ...process.env }
  Object.assign(process.env, {
    MANAGE_OC: "0", PORT: "0", AUTH_ENABLED: "", OC_URL: "http://127.0.0.1:1",
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"), CLOUD_STATE_PATH: path.join(dir, "cloud-state.json"),
    MODEL_CFG_PATH: path.join(dir, "model-config.json"), API_PROFILES_PATH: path.join(dir, "api-profiles.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"), SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
    OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "", ALLOW_PRIVATE_MODEL_URL: "",
  })
  const mod = await import(`../server.mjs?p=${++seq}`)
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  process.env = prev
  t.after(() => new Promise((r) => mod.server.close(r)))
  const r = await fetch(`http://127.0.0.1:${port}/api/model/profiles/use`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "p1" }),
  })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).ok, false)
})
