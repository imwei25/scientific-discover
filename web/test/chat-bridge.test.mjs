// 聊天接入桥单测：config.toml 生成、AGENTS.md 注入/收回（标记块语义）、换绑（自动脱离+沿用配置）。
// 全部走临时目录，不碰真 cc-connect / 真 opencode（enabled=false 时 bind 不会 spawn 进程）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sci-bridge-"))
const root = path.join(tmp, "app"); fs.mkdirSync(root, { recursive: true })
// 假二进制：让 supported()/renderConfig 有东西可指
const fakeCc = path.join(tmp, "cc-connect.exe"); fs.writeFileSync(fakeCc, "x")
const fakeOc = path.join(tmp, "opencode.exe"); fs.writeFileSync(fakeOc, "x")
process.env.SCI_CC_BIN = fakeCc
process.env.OC_BIN = fakeOc

const webDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..")
const B = await import("../chat-bridge.mjs")

// 会话目录 mock：sid → 目录
const sessDirs = new Map()
const mkSess = (sid) => { const d = path.join(tmp, "out", sid); fs.mkdirSync(d, { recursive: true }); sessDirs.set(sid, d); return d }
B.init({ root, webDir, sessionOut: async (sid) => sessDirs.get(sid), getModel: () => ({ providerID: "custom", modelID: "m1" }), log: () => {} })

const readAgents = (d) => { try { return fs.readFileSync(path.join(d, "AGENTS.md"), "utf8") } catch { return null } }

// 构造一个 state：某平台已配置凭证 + 绑定会话（即 active，会进 config）
const wecomBound = (sid, d, over = {}) => ({ ...B.loadState(), wecom: { bot_id: "bid", bot_secret: "sec", allow_from: "", boundSid: sid, boundDir: d, ...over } })

test("renderConfig：cmd 无空格、env 齐全、project 名带平台+会话、allow_from 只在设置时出现", () => {
  const s = wecomBound("ses_abc12345", path.join(tmp, "out", "x"))
  const toml = B.renderConfig(s)
  const cmd = toml.match(/^cmd = '(.+)'$/m)?.[1]
  assert.ok(cmd, "有 cmd 行")
  for (const part of cmd.split(" ")) assert.ok(!part.includes(" ") && fs.existsSync(part), `cmd 每段无空格且存在: ${part}`)
  assert.match(toml, /OPENCODE_CONFIG = '/)
  assert.match(toml, /SCI_WRAP_OC = '/)
  assert.match(toml, /model = 'custom\/m1'/)
  assert.match(toml, /name = 'sci-wecom-abc12345'/)
  assert.ok(!toml.includes("allow_from"), "没设 allow_from 就不写")
  assert.ok(!toml.includes("admin_from"), "admin_from 永远不写")
  const toml2 = B.renderConfig(wecomBound("ses_zzz99999", path.join(tmp, "out", "x"), { allow_from: "u1,u2" }))
  assert.match(toml2, /allow_from = 'u1,u2'/)
  assert.match(toml2, /name = 'sci-wecom-zzz99999'/)
})

test("renderConfig：微信+企微都 active → 生成两个 project，各自 work_dir/platform", () => {
  const dW = path.join(tmp, "out", "pw"), dX = path.join(tmp, "out", "px")
  const s = {
    ...B.loadState(),
    wecom: { bot_id: "b", bot_secret: "s", allow_from: "", boundSid: "ses_wc", boundDir: dW },
    weixin: { token: "tok", account_id: "acc", base_url: "", allow_from: "", boundSid: "ses_wx", boundDir: dX },
  }
  const toml = B.renderConfig(s)
  assert.equal((toml.match(/\[\[projects\]\]/g) || []).length, 2, "两个 project")
  assert.match(toml, /name = 'sci-wecom-\w*ses_wc'|name = 'sci-wecom-/)
  assert.match(toml, /name = 'sci-weixin-/)
  assert.match(toml, /type = 'wecom'/); assert.match(toml, /type = 'weixin'/)
  assert.ok(toml.includes(`work_dir = '${dW.replace(/\\/g, "\\")}'`) || toml.includes("work_dir = '" + dW + "'"), "企微 project 的 work_dir")
  assert.match(toml, /token = 'tok'/); assert.match(toml, /bot_id = 'b'/)
})

test("renderConfig：weixin 平台出 token 块、不混入企微凭证", () => {
  const s = {
    ...B.loadState(),
    weixin: { token: "tok123", account_id: "acc1", base_url: "", allow_from: "u@im.wechat", boundSid: "ses_wx1", boundDir: path.join(tmp, "out", "wx") },
    wecom: { bot_id: "", bot_secret: "", allow_from: "woWECOMID", boundSid: "", boundDir: "" },   // 企微没绑 → 不 active
  }
  const toml = B.renderConfig(s)
  assert.match(toml, /type = 'weixin'/)
  assert.match(toml, /allow_from = 'u@im.wechat'/)
  assert.ok(!toml.includes("woWECOMID"), "企微白名单不混进微信配置")
  assert.match(toml, /token = 'tok123'/); assert.match(toml, /account_id = 'acc1'/)
  assert.ok(!toml.includes("bot_id"), "企微没 active，不出企微块")
})

test("renderConfig：thinking / uploadFirst → 注入 SCI_WRAP_* env（默认 0，开了变 1）", () => {
  const base = wecomBound("ses_env", path.join(tmp, "out", "env"))
  const off = B.renderConfig(base)
  assert.match(off, /SCI_WRAP_THINKING = '0'/)
  assert.match(off, /SCI_WRAP_UPLOAD_FIRST = '0'/)
  const on = B.renderConfig({ ...base, thinking: true, uploadFirst: true })
  assert.match(on, /SCI_WRAP_THINKING = '1'/)
  assert.match(on, /SCI_WRAP_UPLOAD_FIRST = '1'/)
})

test("setConfig：thinking / uploadFirst 落盘并回 status", async () => {
  await B.setConfig({ thinking: true, uploadFirst: true })
  let s = B.loadState()
  assert.equal(s.thinking, true); assert.equal(s.uploadFirst, true)
  const st = B.status()
  assert.equal(st.thinking, true); assert.equal(st.uploadFirst, true)
  await B.setConfig({ thinking: false, uploadFirst: false })
  s = B.loadState()
  assert.equal(s.thinking, false); assert.equal(s.uploadFirst, false)
})

test("renderConfig：s.model 覆盖网关默认，空则跟随", () => {
  const base = wecomBound("ses_m", path.join(tmp, "out", "m"))
  assert.match(B.renderConfig({ ...base, model: "doubao-seed-2.0-lite" }), /model = 'custom\/doubao-seed-2.0-lite'/)
  assert.match(B.renderConfig({ ...base, model: "" }), /model = 'custom\/m1'/)
})

test("inject/retract：空目录注入→收回删除；幂等；用户内容保留", () => {
  const d = mkSess("ses_t1")
  B.injectAgents(d)
  assert.ok(readAgents(d).includes("sci-chat-bridge:start"), "注入了标记块")
  B.injectAgents(d)
  assert.equal((readAgents(d).match(/sci-chat-bridge:start/g) || []).length, 1, "幂等不重复")
  B.retractAgents(d); assert.equal(readAgents(d), null, "纯注入收回后删文件")
  const d2 = mkSess("ses_t2")
  fs.writeFileSync(path.join(d2, "AGENTS.md"), "# 用户规则\n重要\n")
  B.injectAgents(d2); B.retractAgents(d2)
  assert.ok(readAgents(d2).includes("用户规则") && !readAgents(d2).includes("sci-chat-bridge"), "用户内容留、我们的块删净")
})

test("bind(platform,sid)：绑定注入、换绑收回旧、平台独立", async () => {
  const dA = mkSess("ses_A"), dB = mkSess("ses_B")
  await B.setConfig({ wecom: { bot_id: "bid", bot_secret: "sec", allow_from: "boss" } })
  let r = await B.bind("wecom", "ses_A")
  assert.equal(r.ok, true)
  assert.ok(readAgents(dA)?.includes("sci-chat-bridge:start"), "A 已注入")
  r = await B.bind("wecom", "ses_B")
  assert.equal(readAgents(dA), null, "换绑后 A 收回")
  assert.ok(readAgents(dB)?.includes("sci-chat-bridge"), "B 已注入")
  const s = B.loadState()
  assert.equal(s.wecom.boundSid, "ses_B")
  assert.equal(s.wecom.bot_id, "bid", "凭证沿用")
  assert.equal(s.wecom.allow_from, "boss")
  await B.unbind("wecom")
  assert.equal(readAgents(dB), null, "解绑收回")
  assert.equal(B.loadState().wecom.boundSid, "")
})

test("多平台独立：微信、企微绑不同会话，解绑一个不动另一个", async () => {
  const dW = mkSess("ses_wc"), dX = mkSess("ses_wx")
  await B.setConfig({ wecom: { bot_id: "b", bot_secret: "s" } })
  // 手动写入微信 token（不走扫码）
  const st0 = B.loadState(); st0.weixin.token = "tok"; fs.writeFileSync(path.join(root, "chat-bridge", "state.json"), JSON.stringify(st0))
  await B.bind("wecom", "ses_wc")
  await B.bind("weixin", "ses_wx")
  const s = B.loadState()
  assert.equal(s.wecom.boundSid, "ses_wc")
  assert.equal(s.weixin.boundSid, "ses_wx")
  assert.ok(readAgents(dW)?.includes("sci-chat-bridge"), "企微目录已注入")
  assert.ok(readAgents(dX)?.includes("sci-chat-bridge"), "微信目录已注入")
  assert.equal(B.platformOfDir(dW), "wecom", "目录→企微")
  assert.equal(B.platformOfDir(dX), "weixin", "目录→微信")
  await B.unbind("wecom")
  assert.equal(readAgents(dW), null, "企微解绑收回")
  assert.ok(readAgents(dX)?.includes("sci-chat-bridge"), "微信不受影响")
  assert.equal(B.loadState().weixin.boundSid, "ses_wx", "微信绑定还在")
})

test("两平台绑【同一目录】：解绑一个不收回注入（另一个还在用）", async () => {
  const d = mkSess("ses_shared")
  await B.setConfig({ wecom: { bot_id: "b", bot_secret: "s" } })
  const st0 = B.loadState(); st0.weixin.token = "tok"; fs.writeFileSync(path.join(root, "chat-bridge", "state.json"), JSON.stringify(st0))
  await B.bind("wecom", "ses_shared")
  await B.bind("weixin", "ses_shared")
  await B.unbind("wecom")
  assert.ok(readAgents(d)?.includes("sci-chat-bridge"), "微信还绑着同目录 → 注入不收回")
  await B.unbind("weixin")
  assert.equal(readAgents(d), null, "两个都解绑了 → 才收回")
})

test("loadState 迁移旧单平台格式：platform+boundSid → 归到对应平台", () => {
  const bdir = path.join(root, "chat-bridge"); fs.mkdirSync(bdir, { recursive: true })
  fs.writeFileSync(path.join(bdir, "state.json"), JSON.stringify({
    enabled: true, platform: "wecom", boundSid: "ses_old", boundDir: "/tmp/old",
    wecom: { bot_id: "ob", bot_secret: "os" }, allowFrom: "legacy",
  }))
  const s = B.loadState()
  assert.equal(s.wecom.boundSid, "ses_old", "旧 boundSid 归到 wecom")
  assert.equal(s.wecom.boundDir, "/tmp/old")
  assert.equal(s.wecom.allow_from, "legacy", "旧顶层 allowFrom 归到 wecom")
  assert.equal(s.platform, undefined, "旧顶层字段清掉")
  assert.equal(s.boundSid, undefined)
})

test("bind：未知平台 / 找不到目录都不炸", async () => {
  assert.equal((await B.bind("qq", "ses_A")).ok, false)
  assert.equal((await B.bind("wecom", "ses_missing")).ok, false)
})

test("spaceFree：含空格的不同路径绝不能撞进同一个 junction（真机踩过的回归）", () => {
  if (process.platform !== "win32") return
  // 两个目录：共享长前缀（模拟 node 目录与包装器目录都在 c:\users\<u>\... 下）、都含空格
  const d1 = path.join(tmp, "with space", "runtime", "node"); fs.mkdirSync(d1, { recursive: true })
  const d2 = path.join(tmp, "with space", "app", "web", "chat-bridge"); fs.mkdirSync(d2, { recursive: true })
  const f1 = path.join(d1, "node.exe"); fs.writeFileSync(f1, "x")
  const f2 = path.join(d2, "oc-wrap.mjs"); fs.writeFileSync(f2, "y")
  const r1 = B.spaceFree(f1), r2 = B.spaceFree(f2)
  assert.ok(!r1.includes(" ") && !r2.includes(" "), "结果无空格")
  assert.ok(fs.existsSync(r1) && fs.existsSync(r2), "两个结果都真实存在")
  assert.equal(fs.readFileSync(r2, "utf8"), "y", "r2 指向的是包装器本尊，不是别的目录")
  assert.notEqual(path.dirname(r1), path.dirname(r2), "不同目标目录不共用 junction")
})
