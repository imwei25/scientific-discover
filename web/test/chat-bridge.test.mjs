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

// 【Bug 回归】发文件报 `dial unix ...\.cc-connect\run\api.sock: connect: ...refused`。
// 根因：默认 data_dir（~\.cc-connect）是全机唯一的一条路径，而 --force 只杀"config 相同"的实例，
// 管不住用户自己装的那份 cc-connect；两个实例轮流 unlink-rebind 同一条路径，谁后退出谁留下一个
// 没人监听的孤儿文件。正文走 oc-wrap 的 stdout 不碰 socket，所以症状是"文字通、发文件全哑"。
// 这里钉两条实测得出的约束（改错任一条，发文件都会 100% 失效，而日志上几乎看不出来）：
test("data_dir：服务端(config)与客户端(CC_DATA_DIR)必须指同一个私有目录，且路径短于 AF_UNIX 上限", () => {
  const toml = B.renderConfig(wecomBound("ses_abc12345", path.join(tmp, "out", "x")))
  const server = toml.match(/^data_dir = '(.+)'$/m)?.[1]
  const client = toml.match(/^CC_DATA_DIR = '(.+)'$/m)?.[1]
  assert.ok(server, "config 顶层要有 data_dir —— 服务端【只】认这个键，给它 CC_DATA_DIR 无效")
  assert.ok(client, "project env 里要有 CC_DATA_DIR —— `cc-connect send` 是新进程、不带 --config，【只】认环境变量")
  // ★ 这条是核心：只改一边比不改更糟 —— 服务端和客户端分处两个目录，发文件必然失败。
  assert.equal(client, server, "服务端与客户端的 data_dir 必须【完全一致】")
  assert.ok(!/[\\/]\.cc-connect$/.test(server), "不能再回落到全机唯一的 ~\\.cc-connect，那正是被抢的那条路径")
  // ★ Windows 的 AF_UNIX 同样吃 108 字节 sockaddr_un 限制；超了 cc-connect 只记一条
  //   WARN "api server unavailable" 就照常跑（实测），症状与上面那个 bug 一模一样。
  const sock = Buffer.byteLength(path.join(server, "run", "api.sock"))
  assert.ok(sock <= 100, `socket 路径 ${sock}B，超过 100B 余量就有 bind 失败的风险：${server}`)
})

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

test("renderConfig：getCloudEnv 的生图/OCR 代理变量要进 env（微信画图报缺 key 的回归）", async () => {
  // 桌面版主进程 process.env 里没有这四个变量（server.mjs 只注入过 opencode serve 子进程），
  // 透传兜不住 —— 必须走 init 传入的 getCloudEnv 实时取值。
  delete process.env.SCI_IMAGE_URL; delete process.env.SCI_IMAGE_TOKEN
  const ctx = { root, webDir, sessionOut: async (sid) => sessDirs.get(sid), getModel: () => ({ providerID: "custom", modelID: "m1" }), log: () => {} }
  B.init({ ...ctx, getCloudEnv: () => ({ SCI_IMAGE_URL: "http://127.0.0.1:1234/cloud/img/generate", SCI_IMAGE_TOKEN: "local-t" }) })
  const toml = B.renderConfig(wecomBound("ses_img", path.join(tmp, "out", "img")))
  assert.match(toml, /SCI_IMAGE_URL = 'http:\/\/127\.0\.0\.1:1234\/cloud\/img\/generate'/)
  assert.match(toml, /SCI_IMAGE_TOKEN = 'local-t'/)
  B.init({ ...ctx, getCloudEnv: () => ({}) })
  const toml2 = B.renderConfig(wecomBound("ses_img2", path.join(tmp, "out", "img")))
  assert.ok(!toml2.includes("SCI_IMAGE_URL"), "未登录云端（getCloudEnv 回 {}）→ 不注入")
  await B.syncCloudEnv()   // 桥没在跑时是空转，不该抛
  B.init(ctx)              // 还原（不带 getCloudEnv 的旧签名也得能跑），别影响后续用例
  assert.ok(!B.renderConfig(wecomBound("ses_img3", path.join(tmp, "out", "img"))).includes("SCI_IMAGE_URL"))
})

// ---- 推给聊天的产物挑选（用户反馈：微信/企微把副产出也一并发过来了）----
// 判据复用界面侧栏那一份（workflows.mjs 的 artifactKind），这里守的是"聊天特有的三条排除
// + 成品优先 + 报个数"。这类错在手机上表现为一次刷十几条附件，回归价值很高。
const WFm = await import("../workflows.mjs")
const OC = await import("../chat-bridge/oc-wrap.mjs")

test("pickChatFiles：只发主产物，中间文件只报个数", () => {
  const names = ["manuscript.docx", "fig1.png", "analysis.py", "run.log", "scratch.md", "pdfs/a.pdf"]
  const { send, held } = WFm.pickChatFiles(names, { mod: "paper" })
  assert.deepEqual(send.sort(), ["fig1.png", "manuscript.docx"])
  assert.equal(held, 4, "没发出去的要报数，好让文案里说一句")
})

test("pickChatFiles：脱敏还原表、用户上传、网关簿子绝不推出微信", () => {
  const names = ["deid_cohort_mapping.csv", "姓名对照表.csv", "patient_keyfile.csv",
    "uploads/用户传的.docx", "_workflow.json", "AGENTS.md", ".cc-connect/x.docx"]
  const { send } = WFm.pickChatFiles(names, { mod: "paper" })
  assert.deepEqual(send, [], "这几类一个都不能发（还原表外泄不可逆）")
})

test("pickChatFiles：成品排前面 + 限条数（手机上每个文件都是一条通知）", () => {
  const names = ["a.md", "b.md", "c.md", "final.docx", "d.md", "e.md"]
  const { send, held } = WFm.pickChatFiles(names, { mod: "chat", max: 3 })
  assert.equal(send[0], "final.docx", "成品必须排在被截断的前面")
  assert.equal(send.length, 3)
  assert.equal(held, 3)
})

test("oc-wrap pickOutputs：与侧栏同一份判据；WF 加载不了时退回保守口径", () => {
  const { send, held } = OC.pickOutputs(["manuscript.docx", "notes.md", "tmp.py"], "paper", null)
  assert.deepEqual(send, ["manuscript.docx"])
  assert.equal(held, 2)
  // 兜底口径（模拟 workflows.mjs 没加载成功）：宁可只发成品，也不轰一堆中间文件
  assert.ok(OC.pickOutputs(["x.py", "y.log", "z.docx"], "paper", null).send.includes("z.docx"))
})

test("pushToChat：桥没在跑时不炸、也不会把中间文件算成可推内容", async () => {
  const r = await B.pushToChat({ text: "", files: [], dir: "" })
  assert.equal(r.ok, false)
})

// 【Bug 回归】0.1.31 把 cc-connect 的 data_dir 换成私有目录，顺手把【可跨重启复用】的
// context_token 落在了旧目录里。读 cc-connect 源码（platform/weixin）确认：token 只能从入站
// 消息拿到（长轮询与心跳都不带）、落盘时不记过期时间、启动原样读回，而发送强制要它 ——
// 所以 token 表一空，升级后第一次主动推送（定时任务、产物补发）必然失败，直到用户先发一条
// 消息。起因是把 context_token 误判成"分钟级过期的易失数据"（那是 ret=-2，属 ilink 发送限流）。
test("context_token 迁移：从旧 data_dir 搬进私有目录，不覆盖已有、且只搬一次", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cchome-"))
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "cclocal-"))
  const savedHome = process.env.USERPROFILE, savedLocal = process.env.LOCALAPPDATA
  process.env.USERPROFILE = home
  process.env.LOCALAPPDATA = local
  try {
    const oldBot = path.join(home, ".cc-connect", "weixin", "sci-weixin-OLDSID11", "bot@im.bot")
    fs.mkdirSync(oldBot, { recursive: true })
    fs.writeFileSync(path.join(oldBot, "context_tokens.json"), '{"peer@im.wechat":"TOK-OLD"}')
    // 长轮询游标【不该】被搬（搬了可能重收/漏收消息，而它本来会自愈）
    fs.writeFileSync(path.join(oldBot, "get_updates.buf"), "cursor")

    const r = B.migrateContextTokens("sci-weixin-NEWSID22")
    assert.deepEqual(r.migrated, ["bot@im.bot"], "该搬运一份 token")
    const dst = path.join(local, "niuma-cc", "weixin", "sci-weixin-NEWSID22", "bot@im.bot")
    assert.equal(fs.readFileSync(path.join(dst, "context_tokens.json"), "utf8"), '{"peer@im.wechat":"TOK-OLD"}',
      "★ token 内容要原样搬过去 —— 少了它，升级后第一次主动推送必然发不出去")
    assert.ok(!fs.existsSync(path.join(dst, "get_updates.buf")), "长轮询游标不该跟着搬")

    // 只搬一次：把新的改掉再跑，不许被旧的覆盖回去
    fs.writeFileSync(path.join(dst, "context_tokens.json"), '{"peer@im.wechat":"TOK-NEW"}')
    const again = B.migrateContextTokens("sci-weixin-NEWSID22")
    assert.equal(again.skipped, "已迁移过", "有标记文件就该整段跳过")
    assert.equal(fs.readFileSync(path.join(dst, "context_tokens.json"), "utf8"), '{"peer@im.wechat":"TOK-NEW"}',
      "★ 绝不能把用户后来刷新出来的新 token 覆盖成旧的")

    // ★ 上面那条其实是被【标记文件】短路保护的，测不到 existsSync 那道闸（变异验证发现的）。
    //   这里单独造一次"首次迁移、但目标已经有 token"的局面：用户在第一次主动推送之前就先发了
    //   消息，cc-connect 已经写下【更新】的 token —— 此时绝不能拿旧目录那份把它盖掉。
    const local2 = fs.mkdtempSync(path.join(os.tmpdir(), "cclocal2-"))
    process.env.LOCALAPPDATA = local2
    const dst2 = path.join(local2, "niuma-cc", "weixin", "sci-weixin-NEWSID22", "bot@im.bot")
    fs.mkdirSync(dst2, { recursive: true })
    fs.writeFileSync(path.join(dst2, "context_tokens.json"), '{"peer@im.wechat":"TOK-FRESH"}')
    const r2 = B.migrateContextTokens("sci-weixin-NEWSID22")
    assert.deepEqual(r2.migrated, [], "目标已有 token → 不该搬任何东西")
    assert.equal(fs.readFileSync(path.join(dst2, "context_tokens.json"), "utf8"), '{"peer@im.wechat":"TOK-FRESH"}',
      "★ 首次迁移也不许覆盖目标已有的（更新的）token")
    try { fs.rmSync(local2, { recursive: true, force: true }) } catch {}
  } finally {
    if (savedHome === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedHome
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal
    for (const d of [home, local]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  }
})

// 起桥路径上必须【真的调用】迁移。上面那条只测了函数本身：把 start() 里的调用整行删掉，
// 函数照样自测通过，而线上行为完全失效（变异验证发现的）。start() 会 spawn 真进程、不适合
// 在单测里跑，所以退一步用源码断言 —— 它证明不了调用时机对，但能挡住"整行被删/被注释掉"。
test("起桥时必须调用 context_token 迁移（源码级：挡住调用点被删）", () => {
  const src = fs.readFileSync(new URL("../chat-bridge.mjs", import.meta.url), "utf8")
  const body = src.slice(src.indexOf("export function start()"))
  const stop = body.indexOf("export async function syncCloudEnv")
  const startFn = stop > 0 ? body.slice(0, stop) : body
  assert.match(startFn, /migrateContextTokens\(/,
    "start() 里没有调用 migrateContextTokens —— 升级后第一次主动推送会因为缺 context_token 而失败")
})
