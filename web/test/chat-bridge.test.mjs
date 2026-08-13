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

test("renderConfig：cmd 无空格、env 齐全、allow_from 只在设置时出现、project 名随会话变", () => {
  const s = { ...B.loadState(), boundSid: "ses_abc12345", boundDir: path.join(tmp, "out", "x"), wecom: { bot_id: "bid", bot_secret: "sec", allow_from: "" } }
  const toml = B.renderConfig(s)
  const cmd = toml.match(/^cmd = '(.+)'$/m)?.[1]
  assert.ok(cmd, "有 cmd 行")
  for (const part of cmd.split(" ")) assert.ok(!part.includes(" ") && fs.existsSync(part), `cmd 每段无空格且存在: ${part}`)
  assert.match(toml, /OPENCODE_CONFIG = '/)
  assert.match(toml, /XDG_CONFIG_HOME = '/)
  assert.match(toml, /SCI_WRAP_OC = '/)
  assert.match(toml, /model = 'custom\/m1'/)
  assert.match(toml, /name = 'sci-abc12345'/)
  assert.ok(!toml.includes("allow_from"), "没设 allowFrom 就不写")
  assert.ok(!toml.includes("admin_from"), "admin_from 永远不写")
  const toml2 = B.renderConfig({ ...s, wecom: { ...s.wecom, allow_from: "u1,u2" }, boundSid: "ses_zzz99999" })
  assert.match(toml2, /allow_from = 'u1,u2'/)
  assert.match(toml2, /name = 'sci-zzz99999'/)
})

test("inject/retract：空目录注入→收回后文件删除；幂等", () => {
  const d = mkSess("ses_t1")
  B.injectAgents(d)
  const a = readAgents(d)
  assert.ok(a.includes("sci-chat-bridge:start") && a.includes("cc-connect send"), "注入了标记块")
  B.injectAgents(d)   // 幂等：不重复
  assert.equal((readAgents(d).match(/sci-chat-bridge:start/g) || []).length, 1)
  B.retractAgents(d)
  assert.equal(readAgents(d), null, "纯注入文件收回后连文件删掉")
})

test("inject/retract：用户已有 AGENTS.md 内容不丢", () => {
  const d = mkSess("ses_t2")
  fs.writeFileSync(path.join(d, "AGENTS.md"), "# 用户自己的规则\n重要内容\n")
  B.injectAgents(d)
  assert.ok(readAgents(d).includes("用户自己的规则"))
  assert.ok(readAgents(d).includes("sci-chat-bridge:start"))
  B.retractAgents(d)
  const after = readAgents(d)
  assert.ok(after.includes("用户自己的规则"), "用户内容保留")
  assert.ok(!after.includes("sci-chat-bridge"), "我们的块删干净")
})

test("bind 换绑：自动脱离前一个（收回注入）、凭证沿用、boundSid 更新", async () => {
  const dA = mkSess("ses_A"), dB = mkSess("ses_B")
  await B.setConfig({ wecom: { bot_id: "bid", bot_secret: "sec" }, allowFrom: "boss" })   // enabled 仍 false，不会 spawn
  let r = await B.bind("ses_A")
  assert.equal(r.ok, true)
  assert.ok(readAgents(dA)?.includes("sci-chat-bridge:start"), "A 已注入")
  r = await B.bind("ses_B")
  assert.equal(r.ok, true)
  assert.equal(readAgents(dA), null, "换绑后 A 的注入被收回")
  assert.ok(readAgents(dB)?.includes("sci-chat-bridge:start"), "B 已注入")
  const s = B.loadState()
  assert.equal(s.boundSid, "ses_B")
  assert.equal(s.wecom.bot_id, "bid", "凭证沿用前一个的配置")
  assert.equal(s.wecom.allow_from, "boss", "白名单存在当前平台（wecom）名下")
  await B.unbind()
  assert.equal(readAgents(dB), null, "解绑收回 B")
  assert.equal(B.loadState().boundSid, "")
})

test("lastSessionKey：从桥日志取最近一条 message received 的 session（推送对象）", () => {
  const bdir = path.join(root, "chat-bridge"); fs.mkdirSync(bdir, { recursive: true })
  fs.writeFileSync(path.join(bdir, "bridge.log"),
    'noise\nlevel=INFO msg="message received" session=weixin:dm:aaa@im.wechat user=aaa\n' +
    'level=INFO msg="message received" session=weixin:dm:bbb@im.wechat user=bbb\nmore noise\n')
  assert.equal(B.lastSessionKey(), "weixin:dm:bbb@im.wechat")   // 取最后一条
})

test("bind：找不到会话目录时报错不炸", async () => {
  const r = await B.bind("ses_missing")
  assert.equal(r.ok, false)
})

test("renderConfig：聊天接入专用模型 s.model 覆盖网关默认，空则跟随", () => {
  const base = { ...B.loadState(), boundSid: "ses_m", boundDir: path.join(tmp, "out", "m"), wecom: { bot_id: "b", bot_secret: "s", allow_from: "" } }
  assert.match(B.renderConfig({ ...base, model: "doubao-seed-2.0-lite" }), /model = 'custom\/doubao-seed-2.0-lite'/)
  assert.match(B.renderConfig({ ...base, model: "" }), /model = 'custom\/m1'/)   // 空=跟随 getModel() 的 m1
})

test("renderConfig：weixin 平台出 token 块、不出企微凭证", () => {
  const s = {
    ...B.loadState(), platform: "weixin", boundSid: "ses_wx1", boundDir: path.join(tmp, "out", "wx"),
    weixin: { token: "tok123", account_id: "acc1", base_url: "", allow_from: "u@im.wechat" },
    wecom: { bot_id: "shouldnotappear", bot_secret: "nope", allow_from: "woWECOMID" },
  }
  const toml = B.renderConfig(s)
  assert.match(toml, /type = 'weixin'/)
  assert.match(toml, /allow_from = 'u@im.wechat'/)
  assert.ok(!toml.includes("woWECOMID"), "企微白名单绝不能混进微信配置（真机踩过：机主被自己拦在门外）")
  assert.match(toml, /token = 'tok123'/)
  assert.match(toml, /account_id = 'acc1'/)
  assert.ok(!toml.includes("base_url"), "空 base_url 不写")
  assert.ok(!toml.includes("bot_id") && !toml.includes("bot_secret"), "企微凭证不进 weixin 配置")
  assert.ok(!toml.includes("websocket"), "weixin 不带企微的 mode")
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
