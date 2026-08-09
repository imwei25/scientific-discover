import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { spawn, execSync, execFile } from "node:child_process"
import { promisify } from "node:util"
import { setGlobalDispatcher, Agent } from "undici"
import { createOpencodeClient } from "@opencode-ai/sdk"
import * as Cloud from "./cloud-account.mjs"
import * as SkillUp from "./skill-update.mjs"
import * as WebUp from "./web-update.mjs"
import { shouldOfferUpdate } from "./pack-freshness.mjs"
import { zip as zipPack } from "./minizip.mjs"
import * as WF from "./workflows.mjs"
import { scrubShare, renderShareHtml } from "./share-export.mjs"

// opencode 的完整流水线（标书/论文/系统综述）单轮可跑十几分钟，而 session.prompt 是“等整轮结束才返回”的请求；
// undici 默认 5 分钟 headers/body 超时会让这类长轮假性抛错。关掉这两个超时（0=不限），连接超时保留。
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 10_000 }))

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const UPLOADS = path.join(ROOT, "uploads")
const OUTPUTS = path.join(ROOT, "outputs")
fs.mkdirSync(UPLOADS, { recursive: true })
fs.mkdirSync(OUTPUTS, { recursive: true })

const OC_URL = process.env.OC_URL || "http://127.0.0.1:4098"
const client = createOpencodeClient({ baseUrl: OC_URL })
const un = (r) => (r && r.data !== undefined ? r.data : r)
// provider/model：只按【第一个】斜杠切——模型名本身可能含斜杠（如 deepseek-ai/DeepSeek-V4-Flash），不能整体 split
const _OCM = process.env.OC_MODEL || "deepseek/deepseek-v4-pro"
const _sl = _OCM.indexOf("/")
const PID = _sl >= 0 ? _OCM.slice(0, _sl) : _OCM
const MID = _sl >= 0 ? _OCM.slice(_sl + 1) : _OCM
let MODEL = { providerID: PID, modelID: MID }
const PORT = Number(process.env.PORT || 3000)

// ---- 云端账号（桌面版）：登录 sci-auth 拿 access key，本进程代持并自动续期 ----
// opencode 恒指向本机 /cloud/v1，key 由本进程在转发时贴上 —— 于是 key 轮换不必重写
// opencode.json、更不必重启 opencode（重启会把正在跑十几分钟的轮连根拔掉）。
const CLOUD_PROXY_PREFIX = "/cloud/"
// 给 opencode provider 用的占位 key：SDK 不接受空 key，但它只在本机回环上出现，
// 真正的凭证是本进程内存/状态文件里的 access key。同时用它挡住"局域网访客白嫖你的云端额度"。
const CLOUD_LOCAL_TOKEN = "local-" + crypto.randomBytes(18).toString("hex")

// ---- 自定义大模型（OpenAI 兼容）：前端可切换后台 opencode 用的模型 ----
// 两个路径都可用环境变量覆盖：自动化测试要在临时目录里跑，绝不能写到开发机真正的
// model-config.json / opencode.json 上（前者含 key，后者一改就影响本机 opencode）。
const MODEL_CFG_PATH = process.env.MODEL_CFG_PATH || path.join(__dirname, "model-config.json")   // 持久化所选自定义模型（含 key，已 gitignore）
const OC_CONFIG_PATH = process.env.OC_CONFIG_PATH || path.join(ROOT, "opencode.json")            // opencode 项目配置：注册自定义 provider
const CUSTOM_PROVIDER_ID = "custom"
// 读 JSON 时统一剥 UTF-8 BOM：PowerShell 的 Out-File -Encoding utf8 与记事本另存都会写 BOM，
// 而 JSON.parse 见了 BOM 直接抛 —— 症状是"配置文件在、内容也对，程序却当成没配"。
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
const readJsonFile = (p) => JSON.parse(stripBom(fs.readFileSync(p, "utf8")))
const loadModelCfg = () => { try { return readJsonFile(MODEL_CFG_PATH) } catch { return null } }
const saveModelCfg = (c) => { try { fs.writeFileSync(MODEL_CFG_PATH, JSON.stringify(c, null, 2)) } catch {} }
// 给自定义/网关模型注入定价（USD / 每百万 token），否则 opencode 不知道价格 → session.cost 恒为 0 →
// 每日成本额度与中途封顶全部失效。价格由 OC_COST_* 环境变量给（部署时按环境变量配），缺省按 DeepSeek 常见价。
const _modelCost = () => {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d }
  return { input: n(process.env.OC_COST_INPUT, 0.27), output: n(process.env.OC_COST_OUTPUT, 1.10), cache_read: n(process.env.OC_COST_CACHE_READ, 0.07), cache_write: n(process.env.OC_COST_CACHE_WRITE, 0) }
}
// cost 传了就用传的（云端账号形态下，每个模型的单价由服务器随档案下发——各家价格不同，
// 拿 env 里那套 DeepSeek 价去算别家的模型，本机显示的成本会系统性偏）。没传才回落 env。
// 思考模型的"关思考"开关。OC_THINKING=off 时给模型带上停用思考的参数。
// 【为什么没有 low】实测火山 Ark 的 /api/coding/v3 上，reasoning_effort=low / minimal 被静默忽略
// （思考长度不降反升几个字），只有 reasoning_effort=none 与 thinking={type:"disabled"} 真正生效：
// 同一问题的输出 token 从 105 降到 4。所以这里是二值开关，不是强度档位。
// 两个字段都发：不同厂商吃不同的那一个，多发一个无害（未识别的参数被忽略）。
// 【默认不开】思考对方法学推理、统计判断是有价值的；关掉是拿质量换配额，要由使用者显式决定。
const THINKING_OFF = String(process.env.OC_THINKING || "").toLowerCase() === "off"
const customProviderCfg = ({ baseURL, apiKey, modelID, cost }) => ({
  npm: "@ai-sdk/openai-compatible", name: "Custom (OpenAI 兼容)",
  options: { baseURL, apiKey },
  models: { [modelID]: {
    name: modelID, tool_call: true, attachment: true, cost: cost || _modelCost(),   // 开工具调用 + 注入定价（用于算成本额度）
    ...(THINKING_OFF ? { options: { thinking: { type: "disabled" }, reasoning_effort: "none" } } : {}),
  } },
})
// opencode 的 `question` 工具会弹交互式提问卡片；本部署（web 网关）没有应答它的 UI，
// 模型一旦调用就整轮 error/卡死（实测卡在“确认方向选择”那步）。各技能与 AGENTS.md §六 已要求
// “一律用编号文本让用户回数字选、别弹卡片”，但模型会无视提示词照调——故在配置层全局禁用，从根上杜绝。
// 固化两条无论如何都要成立的 opencode 策略。所有写 opencode.json 的路径 + 启动时都会过这里。
//
// 【为什么这里【不】用 permission.edit/read 去保护 /app/.opencode、AGENTS.md、网关代码等】
// 实测（2026-07-23，服务器隔离容器 + 钉死的 opencode 1.17.14，逐配置复跑）：opencode 的
// permission.edit/read 的路径规则【只作用于会话工作目录(cwd)以内】的文件；cwd 之【外】的文件
// 完全由 external_directory 一个开关决定，路径规则对它们一律不生效。而本部署把每个会话的 cwd
// 指到 /app/outputs/<会话id>/，要保护的 /app/.opencode、/app/AGENTS.md、/app/web、/app/opencode.json
// 全在 cwd 之外 → 归 external_directory 管；而它又【必须】是 allow（否则「上传文件→分析」100% 挂死，
// 见下）。结论：靠 opencode 配置保护这些文件在本部署形态下【根本做不到】，写了也是惰性失效的安全
// 表演。真正enforceable的写保护要靠容器层【只读绑定挂载】（内核级、连 root+bash 都写不动），见
// deploy 侧（render-compose.sh 的 :ro 卷 / 或只读根文件系统）。故此处不再写任何 edit/read 规则。
const enforceOcTools = (oc) => {
  oc.tools = { ...(oc.tools || {}), question: false }
  // ★ external_directory 必须 allow，否则「上传文件→让 agent 分析」这条最常用的路径 100% 卡死。
  // 起因是会话工作目录改造：cwd 从 /app 变成了 /app/outputs/<会话id>/，于是用户上传所在的
  // /app/uploads/<会话id>/ 对 opencode 而言成了【外部目录】，默认策略是 ask →
  // 无头网关里没有任何人能应答这个授权询问 → read 工具永久停在 running。
  // 实测后果（一次上传即触发，且不可自救）：
  //   ① 该轮永不结束，前端一直转圈；② /api/chat/abort 返回 aborted:false，终止按钮救不回来；
  //   ③ 该会话被永久锁死（再发消息只得到"上一轮仍在进行中"）；④ busy 恒真 → manager 永不回收该容器，
  //   白占内存与 WARM_CAP 槽位，且 /api/model/pick 恒 409，用户连换模型自救都做不到。
  //   只有 docker restart 能解，而普通用户没这个能力。
  // 为什么给 allow 而不是按目录细分：容器是单用户的，agent 本来就有 shell、与网关同 uid，
  // 它能 cat 的东西不因这个开关而增减 —— 这不是安全边界，只是交互式场景下的确认提示，
  // 在无头服务里唯一的效果就是把请求挂死。跨用户隔离靠的是「一人一容器」，不是它。
  oc.permission = { ...(oc.permission || {}), external_directory: "allow" }
  return oc
}
// 把自定义 provider 合并进 ROOT/opencode.json（保留其它配置），opencode 启动时读取它
const writeOcProvider = (cfg) => {
  let oc = {}
  try { oc = readJsonFile(OC_CONFIG_PATH) } catch {}
  oc.provider = oc.provider || {}
  oc.provider[CUSTOM_PROVIDER_ID] = customProviderCfg(cfg)
  enforceOcTools(oc)
  fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(oc, null, 2))
}
// opencode 只在【启动时】读 opencode.json，所以"文件里写着什么"和"它正在用的是什么"是两码事。
// ocLiveProvider 记的是后者：每次重启成功时把当时文件里的那份 provider 存下来。
// 有了它才能判断"这次改动到底用不用重启" —— 见 /api/cloud/login：同一个账号重新登录（闲置锁屏
// 后输口令解锁走的正是这条）写出来的 provider 与正在跑的一模一样，重启纯属把用户留着跑的轮拔掉。
const ocProviderOnDisk = () => {
  try { return JSON.stringify(readJsonFile(OC_CONFIG_PATH)?.provider?.[CUSTOM_PROVIDER_ID] ?? null) } catch { return "null" }
}
let ocLiveProvider = null
const removeOcProvider = () => {
  try {
    const oc = readJsonFile(OC_CONFIG_PATH)
    if (oc.provider) { delete oc.provider[CUSTOM_PROVIDER_ID]; if (!Object.keys(oc.provider).length) delete oc.provider }
    enforceOcTools(oc)
    fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(oc, null, 2))
  } catch {}
}
// 启动时无条件确保 opencode.json 已禁用 question 工具（无论用不用自定义模型；opencode.json 已 gitignore）
try {
  let oc = {}
  try { oc = readJsonFile(OC_CONFIG_PATH) } catch {}
  enforceOcTools(oc)
  fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(oc, null, 2))
} catch {}
// ---- 路由归属：当前这套配置算「走云端网关」还是「走用户自己的 API」----
//
// 不能用 isCustom 判断：接了网关时启动也会写 CUSTOM_PROVIDER_ID（网关本身就是个 OpenAI 兼容端点），
// 而 /api/model/pick 换网关下的模型时还会把网关地址存进 MODEL_CFG —— 两种情况都会让 isCustom 为真。
// 真正的判据只有一条：**存下来的 baseURL 是不是网关那个地址**（没存过 = 默认就走网关）。
const sameEndpoint = (a, b) => String(a || "").replace(/\/+$/, "") === String(b || "").replace(/\/+$/, "")
// 云端账号形态下 opencode 要指的地址：本机自己，转发由本进程做（见 CLOUD_PROXY_PREFIX 的说明）
const cloudProxyBase = () => `http://127.0.0.1:${PORT}${CLOUD_PROXY_PREFIX}v1`
const cloudLoggedIn = () => !!Cloud.loadState()
// 平台公告的本机短缓存（见 /api/cloud/notice）。两种失效方式，别混用：
//   · expire：只把它标成过期，【留着上一份数据】。用户手点「刷新」走这条 —— 万一这次
//     正好连不上云端，还能继续显示上一份，而不是把维护通知凭空抹掉。
//   · clear：连数据一起丢。只有切换账号（登录/登出）才用 —— 换了人还拿着上一个账号那次
//     的结果，表现是登出后公告还挂着、或换号后短时间看到不属于自己的通知。
let noticeCache = null
// 公告列表（带正文，近半年）的缓存，见 /api/cloud/notices。与上面那份分开：它只在用户
// 点开公告面板时才用得上，缓存久一点（2 分钟）；两份的失效动作同步进行，别让面板里的
// 列表与红点算出来的未读数对不上。
let noticesCache = null
const expireNoticeCache = () => { if (noticeCache) noticeCache.at = 0; if (noticesCache) noticesCache.at = 0 }
const clearNoticeCache = () => { noticeCache = null; noticesCache = null }
// ---- 技能包更新检查（桌面版）----
// 挂在公告轮询顺风车上，但自己限流半小时：技能包发布是低频事件，公告那条 60 秒的节奏
// 对它纯属浪费。检查失败 5 分钟后重试（第一次打开就赶上断网时，别把"有更新"憋到半小时后）。
let skillLatestCache = null   // { at, latest }
const SKILL_CHECK_MS = 30 * 60 * 1000
const clearSkillLatestCache = () => { skillLatestCache = null }
async function skillLatestSoon(force) {
  if (!cloudLoggedIn()) return null
  const now = Date.now()
  if (!force && skillLatestCache && now - skillLatestCache.at < SKILL_CHECK_MS) return skillLatestCache.latest
  const r = await Cloud.fetchSkillLatest(SkillUp.currentVersion()).catch(() => null)
  if (r && r.ok) skillLatestCache = { at: now, latest: r.latest }
  else skillLatestCache = { at: now - SKILL_CHECK_MS + 5 * 60_000, latest: skillLatestCache?.latest ?? null }
  return skillLatestCache.latest
}
/**
 * 要不要在界面上提示更新：这个包确实比本机新（见 pack-freshness.mjs——刚装的新安装包
 * 里技能可能比服务器上最后一次发布还新，那种"更新"是把技能换旧），
 * 且这次变更与本账号的技能授权有交集（服务端算好 relevant）。
 */
function skillUpdateInfo(latest) {
  if (!latest || !latest.relevant) return null
  if (!shouldOfferUpdate(latest, { current: SkillUp.currentVersion(), factoryAt: SkillUp.factoryAt() })) return null
  return { version: latest.version, changedSkills: latest.changedSkills || [], changelog: latest.changelog || "", size: latest.size || 0 }
}
/**
 * 取一个会话的完整对话（提交反馈用）。与 /api/history 同一套提取口径（剥掉注入的工作区前言），
 * 但多带两样管理员复现时用得上的东西：时间戳与这一轮走了哪些技能。
 *
 * 【单独写一个而不是复用 /api/history 的处理器】那个是 HTTP 处理器、还掺着"生成中的末轮要
 * 从历史里剔除"的直播逻辑；反馈要的恰恰是【全部】，包括刚生成完的那一轮。
 */
async function collectTranscript(sid) {
  // Array.isArray 而非 `|| []`：会话不存在时 SDK 不抛，交回来的是 NotFoundError 的 data
  //（一个对象），`|| []` 判不住，后面 for-of 会 is-not-iterable 抛成 500。
  const raw = un(await client.session.messages({ path: { id: sid } }))
  const msgs = Array.isArray(raw) ? raw : []
  const out = []
  for (const m of msgs) {
    const role = m.info?.role
    if (role !== "user" && role !== "assistant") continue
    const parts = m.parts || []
    let text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim()
    text = stripPreamble(text)
    if (role === "assistant") text = autoStripSentinel(text)   // 与 /api/history 同口径：协议哨兵不进反馈正文
    // 技能名的取法与直播那条一致（见 broadcast("tool") 处）：state.input.name，
    // 只有 running/completed 的调用才有；取不到就退到 title，再取不到就不记。
    const skills = [...new Set(parts.filter((p) => p.type === "tool" && p.tool === "skill")
      .map((p) => p.state?.input?.name || p.state?.title || "").filter(Boolean))]
    if (!text && !skills.length) continue
    out.push({ role, text, ts: m.info?.time?.created || 0, ...(skills.length ? { skills } : {}) })
  }
  return out
}

// ---- 界面包更新检查（桌面版）----
// 与技能包同一条顺风车、同一套节流。分开缓存是因为两者版本号各走各的，
// 而且界面包换完【不重启任何进程】——网关每次请求现读 index.html，用户刷新页面就生效。
let webLatestCache = null
const clearWebLatestCache = () => { webLatestCache = null }
async function webLatestSoon(force) {
  if (!cloudLoggedIn()) return null
  const now = Date.now()
  if (!force && webLatestCache && now - webLatestCache.at < SKILL_CHECK_MS) return webLatestCache.latest
  const r = await Cloud.fetchWebLatest(WebUp.currentVersion()).catch(() => null)
  if (r && r.ok) webLatestCache = { at: now, latest: r.latest }
  else webLatestCache = { at: now - SKILL_CHECK_MS + 5 * 60_000, latest: webLatestCache?.latest ?? null }
  return webLatestCache.latest
}
function webUpdateInfo(latest) {
  if (!latest) return null
  // 与技能包同一把尺子：只有确实比本机新才提示（出厂版按打包时间比，见 pack-freshness.mjs）
  if (!shouldOfferUpdate(latest, { current: WebUp.currentVersion(), factoryAt: WebUp.factoryAt() })) return null
  return { version: latest.version, changelog: latest.changelog || "", size: latest.size || 0, files: latest.files || [] }
}
const gatewayEnvSet = () => !!(process.env.OC_GATEWAY_URL && process.env.OC_GATEWAY_KEY)
/** 平台路由是否可用：登录了云端账号（桌面版），或注入了静态网关 key（云端多用户容器） */
const platformAvailable = () => cloudLoggedIn() || gatewayEnvSet()

/**
 * 当前走哪条路：cloud（云端账号）| gateway（静态网关 key）| custom（用户自己的 API）| none。
 *
 * 不能用 isCustom 判断 —— 三种形态在 opencode 眼里都是 CUSTOM_PROVIDER_ID（平台入口本身
 * 就是个 OpenAI 兼容端点）。所以在 model-config 里【显式记一个 route 字段】；
 * 老配置文件没有这个字段，回落到按地址比对（本机代理地址 / 网关地址）。
 */
function inferLegacyRoute(saved) {
  if (sameEndpoint(saved.baseURL, cloudProxyBase())) return "cloud"
  if (gatewayEnvSet() && sameEndpoint(saved.baseURL, process.env.OC_GATEWAY_URL)) return "gateway"
  return "custom"
}
function currentRoute() {
  const saved = loadModelCfg()
  if (!saved?.baseURL) return cloudLoggedIn() ? "cloud" : (gatewayEnvSet() ? "gateway" : "none")
  const r = saved.route || inferLegacyRoute(saved)
  // 记着 cloud 但已经登出（或反过来）时，以【当前事实】为准，别报一个走不通的路由
  if (r === "cloud" && !cloudLoggedIn()) return gatewayEnvSet() ? "gateway" : "none"
  if (r === "gateway" && !gatewayEnvSet()) return cloudLoggedIn() ? "cloud" : "none"
  return r
}
/** 云端账号档案里这个用户能选的模型（服务器下发；[] = 服务器还没给，或没登录） */
const cloudModels = () => {
  const list = Cloud.loadState()?.profile?.models
  return Array.isArray(list) ? list : []
}
/** 某个模型名在不在允许清单里。清单为空 = 服务器没下发（老服务端），此时不拦，交给网关判 */
const modelAllowed = (m) => { const l = cloudModels(); return !l.length || l.some((x) => x.model === m) }
/** 该模型的单价（USD/百万 token），转成 opencode 的 cost 结构；没有就返回 null 走 env 缺省 */
const costOfModel = (m) => {
  const e = cloudModels().find((x) => x.model === m)
  if (!e || !e.price) return null
  return { input: Number(e.price.input) || 0, output: Number(e.price.output) || 0, cache_read: Number(e.price.cached) || 0, cache_write: 0 }
}

/**
 * 该用平台的哪种形态：登录了就用云端账号，否则回落静态网关 key。
 *
 * 【picked 是用户在顶部 pill 里选的模型】它要跨重启存活，所以记在 model-config 里而不是内存。
 * 每次都要拿当前档案校验一遍：管理员把这个模型从档位里撤掉 / 供应商停用之后，
 * 客户端必须自动落回默认模型 —— 否则本机一直请求一个服务器已经不认的模型名，
 * 每一轮都被网关静默打回默认模型，而界面还显示着那个早就没有的名字。
 */
function platformProvider() {
  const saved = loadModelCfg()
  if (cloudLoggedIn()) {
    const st = Cloud.loadState()
    const picked = saved?.picked && modelAllowed(saved.picked) ? saved.picked : ""
    const modelID = picked || st?.profile?.model || MID
    return { route: "cloud", baseURL: cloudProxyBase(), apiKey: CLOUD_LOCAL_TOKEN, modelID, picked, cost: costOfModel(modelID) }
  }
  const picked = saved?.route === "gateway" && saved?.picked ? saved.picked : ""
  return { route: "gateway", baseURL: process.env.OC_GATEWAY_URL, apiKey: process.env.OC_GATEWAY_KEY, modelID: picked || MID, picked }
}
// 回到平台路由（清掉用户自设，按平台形态重写 provider）。启动兜底与 /api/model/reset 共用同一段，
// 避免"重启后回到平台、运行时重置却回到内置默认"这种两套行为。
function useGatewayRoute() {
  const p = platformProvider()
  writeOcProvider(p)
  // picked 要一起存下去（跨重启保住用户选的模型）；cost 是算出来的，不入盘免得放着过期数据
  saveModelCfg({ route: p.route, baseURL: p.baseURL, apiKey: p.apiKey, modelID: p.modelID, picked: p.picked || "" })
  MODEL = { providerID: CUSTOM_PROVIDER_ID, modelID: p.modelID }
}

// 启动时恢复路由：用户自设 > 平台（云端账号 / 静态网关 key）。
// 注意云端账号那支【每次启动都要重写 provider】：本机端口可能变、CLOUD_LOCAL_TOKEN 每进程一新，
// 沿用上次存的配置会让 opencode 拿着上一进程的占位 token 打进来，被下面的代理判为未授权。
{
  const saved = loadModelCfg()
  const savedRoute = saved?.baseURL ? (saved.route || inferLegacyRoute(saved)) : null
  if (savedRoute === "custom" && saved.apiKey && saved.modelID) {
    writeOcProvider(saved)
    MODEL = { providerID: CUSTOM_PROVIDER_ID, modelID: saved.modelID }
  } else if (platformAvailable()) {
    // 走平台：桌面版是登录后的云端账号（经本机 /cloud 转发），云端多用户容器是注入的
    // 静态网关 key（one-api）。网关内做多渠道调度/failover。
    // 【云端账号这支每次启动都要重写】本机端口可能变、CLOUD_LOCAL_TOKEN 每进程一新，
    // 沿用上次存的配置会让 opencode 拿着上一进程的占位 token 打进来，被代理判为未授权。
    useGatewayRoute()
  }
}
// ---- 每个会话独占一套工作区目录（多用户 / 多会话隔离）----
//
// 关键机制：建会话时就把 opencode 的 session.directory 指到该会话的产物目录，
// 于是 agent 的所有工具（bash / write / read）都以【会话产物目录】为工作目录，
// 产物天然落在正确的地方，不再依赖 agent 记得传 --outdir 或环境变量。
// （已在服务器实测：directory 会改变工具 cwd；projectID 仍是 global，技能与 AGENTS.md 照常加载。）
//
// 但 directory 【只能在 session.create 时指定、之后不可改】（PATCH 只允许 title/metadata/...），
// 而目录名又想跟会话走 —— 鸡生蛋。解法：网关自己先生成一个工作区 id(ws_xxx) 当目录名，
// 用它建会话；之后要用时直接问 opencode 要 session.directory（它已持久化在 ocdata 卷里），
// 网关不必再维护一张自己的映射表。
const safeSid = (s) => (s || "").replace(/[^a-zA-Z0-9_-]/g, "")   // 防目录穿越
const newWsId = () => "ws_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex")
const dirCache = new Map()   // sid -> 绝对产物目录（进程内缓存，冷启动后按需回填）

// 会话的绝对产物目录。老会话（本次改造之前建的）的 directory 是仓库根，
// 回落到旧约定 outputs/<sid>，保证既有数据仍能被列出/下载。
async function sessionOut(sid) {
  const s = safeSid(sid)
  if (!s) return OUTPUTS
  if (dirCache.has(s)) return dirCache.get(s)
  let dir = path.join(OUTPUTS, s)                       // 回落：老会话
  let resolved = false                                  // 是否真从 opencode 问到了 directory
  try {
    const info = un(await client.session.get({ path: { id: sid } }))
    const d = info?.directory
    if (d && path.resolve(d) !== path.resolve(ROOT)) { dir = path.resolve(d); resolved = true }
  } catch { /* opencode 不可用时用回落值，不阻断文件接口 */ }
  // 【只缓存问到的结果】失败回落不能进缓存，否则一次失败就把错目录钉死【整个进程生命周期】：
  // 容器冷启动时 opencode 要几十秒才就绪，这期间若前端先打到 /api/outputs，session.get 会抛 →
  // 缓存 outputs/<sid>（错的）→ 此后产出侧栏永远空、下载预览全 404，而 agent 实际把文件写进
  // outputs/ws_xxx → 用户看到"跑完了但一个产物都没有"，只有重启网关才能恢复。
  if (resolved) dirCache.set(s, dir)
  return dir
}
const relFromRoot = (abs) => path.relative(ROOT, abs).replace(/\\/g, "/")   // 仅用于回给前端展示，统一正斜杠
// 本机真实可用的 python。前言里【必须给这个绝对路径】，不能再教 agent 写 ${REPO_ROOT:-/app}/.venv/bin/python：
// 容器里那是对的，但开发机 / 自建部署上 REPO_ROOT 常常没设 → 落到 /app/... （不存在）→ agent 转去
// which python3，在 Windows 上找到的是 Microsoft Store 的 0 字节 app-execution alias（无输出、
// 退出码还被 cmd 吞掉），它完全看不出坏在哪，于是同一条命令连发 35+ 次、跑满 10 分钟零产出。
const PY_BIN = (() => {
  for (const rel of ["Scripts/python.exe", "bin/python.exe", "bin/python", "bin/python3"]) {
    const f = path.join(ROOT, ".venv", rel)
    try { if (fs.statSync(f).isFile()) return f } catch {}
  }
  return null   // 没建过 .venv：前言里如实说，让它先跑 env-setup
})()
// uploads 与 outputs 同名配对：outputs/<ws> ←→ uploads/<ws>（老会话则同为 <sid>）
const sessionUp = async (sid) => path.join(UPLOADS, path.basename(await sessionOut(sid)))
const ensureWsAt = (outDir, upDir) => { fs.mkdirSync(outDir, { recursive: true }); fs.mkdirSync(upDir, { recursive: true }) }
async function ensureWs(sid) {
  const o = await sessionOut(sid), u = await sessionUp(sid)
  ensureWsAt(o, u); return { out: o, up: u }
}
// 新建会话：先定目录名，再用它建 opencode 会话（directory 只有这一次机会能设）
async function createSession(title) {
  const ws = newWsId()
  const outDir = path.join(OUTPUTS, ws), upDir = path.join(UPLOADS, ws)
  ensureWsAt(outDir, upDir)
  const s = un(await client.session.create({ body: { title }, query: { directory: outDir } }))
  dirCache.set(safeSid(s.id), outDir)
  return s.id
}

// ---- 会话/项目元数据（网关级，opencode 不管这些）----
// 【会话永久保留】曾经有过"非项目会话 7 天无活动自动删"的 TTL 档位（配套钉住/续期/临期提醒），
// 已整体移除：用户的会话与产物只在用户自己动手删时才消失，系统不再替他做保留期判断。
// 钉（pinned）保留下来，但语义只剩"置顶分组"，不再影响存活。要清理请用界面上的批量勾选删除。
// opencode 只存会话本体；项目分组 / 钉标记存这里，随磁盘持久（已 gitignore）。
// 路径可用 SESSIONS_META_PATH 覆盖：测试/隔离实例必须能把它重定向到临时文件，
// 否则任何在本仓库里起的第二个网关实例都会读写【开发机真实的】会话元数据并互相覆盖
// （cloud-state/model-config/opencode.json 早就有同款覆盖开关，唯独这个漏了）。
const META_PATH = process.env.SESSIONS_META_PATH || path.join(__dirname, "sessions-meta.json")
let META = { version: 1, projects: [], sessions: {} }
try { const m = JSON.parse(fs.readFileSync(META_PATH, "utf8")); META = { version: 1, projects: m.projects || [], sessions: m.sessions || {} } } catch {}
let _metaSaveTimer = null
const saveMeta = () => { try { clearTimeout(_metaSaveTimer) } catch {}; _metaSaveTimer = setTimeout(() => { try { fs.writeFileSync(META_PATH, JSON.stringify(META, null, 2)) } catch {} }, 50) }
const sessMeta = (sid) => (META.sessions[sid] ||= {})   // 取（不存在则建空）某会话的元数据
const projectOf = (sid) => { const p = META.sessions[sid]?.projectId; return p && META.projects.some((x) => x.id === p) ? p : null }
const newId = (p) => p + crypto.randomBytes(6).toString("hex")
// 彻底删除一个会话：终止在跑的轮 → 删 opencode 会话 → 删产物/上传目录 → 清元数据
async function hardDeleteSession(id) {
  try { await jobs.get(id)?.abort() } catch {}   // 会话还在生成中 → 先终止再删
  autoStates.delete(id)   // 无人值守状态一并清掉（abort 里也清，这里兜没有在跑轮的情形）
  // 【顺序要紧】必须在 session.delete 之【前】把目录解析出来：sessionOut/sessionUp 在 dirCache 未命中时
  // 要回头问 opencode 要 session.directory，而会话一旦删掉，session.get 必然 404 → 静默回落到
  // outputs/<sid>，而真实目录是 outputs/ws_xxx → rmSync 对着一个不存在的路径 force 空转，
  // 返回 ok:true 但一个字节都没删。容器按需停起是本架构常态，网关重启后 dirCache 就是空的，
  // 即"删会话释放空间"这唯一的回收手段在最常见的情形下完全失效，最终把用户卡在存储上限上。
  // （批量删除也走这里，所以这条次序对批删同样要紧。）
  // ★ 目录解析【失败】也要认出来，不能当成"解析到了"。上面那段注释修的是"删完再解析"的次序，
  //   但没堵住"解析本身失败"（session.get 500 / 网关刚重启 dirCache 空 / opencode 暂时不可达）：
  //   sessionOut 此时静默回落到 outputs/<sid>，而真实目录是 outputs/ws_xxx —— 于是会话被删掉、
  //   目录原样留着占配额，界面上再也点不到它，而用户唯一的回收手段（删会话）刚刚已经用完了。
  //   判据借 dirCache：sessionOut 只在【真从 opencode 问到 directory】时才写缓存（见那边的注释），
  //   所以调用之后缓存里有没有它，就等于"这次解析成没成"。
  const delOut = await sessionOut(id), delUp = await sessionUp(id)
  const resolved = dirCache.has(safeSid(id))
  let ocOk = true
  try { await client.session.delete({ path: { id } }) } catch (e) { ocOk = false; console.warn(`[session] 删除 ${id} 失败：${e.message}`) }
  let dirOk = true
  // 解析不到真实目录就【不要删】：对着一个猜出来的路径 force 空转，只会把"没删干净"伪装成成功。
  if (!resolved) dirOk = false
  else try { fs.rmSync(delUp, { recursive: true, force: true }); fs.rmSync(delOut, { recursive: true, force: true }); dirCache.delete(safeSid(id)) }
  catch (e) { dirOk = false; console.warn(`[session] 删除 ${id} 的目录失败：${e.message}`) }
  pendingReverts.delete(id)   // 已删会话的待提交登记没人再消费，别驻留到进程重启
  unbindSessionModule(id)     // 模块绑定同样随会话删除，别在持久表里越积越多
  clearGateBypass(id)         // 手动放行的标记同理：会话没了就不该在放行表里留着
  // ★ 元数据只在 opencode 那侧真删掉之后才清。否则："删除失败 → 会话回到列表 → 但项目归属与
  //   置顶被抹掉了"，用户再点一次删，还得先把它重新归类。
  if (ocOk && META.sessions[id]) { delete META.sessions[id]; saveMeta() }
  return { ok: ocOk && dirOk, ocOk, dirOk }
}
// 元数据整理：只清掉「元数据里还挂着、但 opencode 里已经没有」的会话残留。
// 【不会删任何会话】按会话年龄自动删除的机制已整体移除，会话永久保留，删只由用户主动发起。
async function pruneOrphanMeta() {
  try {
    const all = un(await client.session.list()) || []
    // 清掉元数据里已不存在的会话残留。
    // 【空列表不算数】opencode 返回空数组既可能是"真的一条会话都没有"，也可能是它刚起来还没
    // 加载完 / 连到了另一个数据目录 / 降级返回空——后几种情况下按"全都不存在"去删，会把用户
    // 全部的项目归属与钉标记一次性抹平（表现为 sessions 被清成 {}，projects 还在）。
    // 代价不对等：留几条陈旧残留无害，误删要用户重新归类所有会话。故空列表直接跳过修剪。
    if (!all.length) return
    const live = new Set(all.map((s) => s.id))
    let dirty = false
    for (const id of Object.keys(META.sessions)) if (!live.has(id)) { delete META.sessions[id]; dirty = true }
    if (dirty) saveMeta()
  } catch (e) { console.warn("[meta] 整理失败:", String(e).slice(0, 200)) }
}
// 某目录里顶层文件的 name -> mtime 快照（跳过隐藏项和子目录）
// 递归【一层】：键是相对 dir 的路径，顶层文件仍是裸文件名（"a.png"），子目录里的是 "pdfs/a.pdf"。
// 为什么要递归：好几个技能天然产出子目录（fulltext-retrieval 的 pdfs/、data-integrity 的 audit/、
// systematic-review 的 counts/）。此前只列顶层 → 这些产物在界面"产出"侧栏里【一个都看不到】，
// agent 报告"已下载 4 篇文献"而用户什么也拿不到（生产上真实发生过）。
// 为什么只一层：够覆盖已知的技能产出结构，同时把列表规模与前端展示复杂度控制住；
// 更深的层级仍读得到（下载接口按包含性校验，不限深度），只是不主动列出来。
const DIRSTATE_DEPTH = 1
const WIN_RESERVED = /^(nul|con|prn|aux|com[1-9]|lpt[1-9])(\.|$)/i
const dirState = (dir, depth = DIRSTATE_DEPTH, prefix = "") => {
  if (!fs.existsSync(dir)) return {}
  const m = {}
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return m }
  for (const e of ents) {
    if (e.name.startsWith(".")) continue          // .preview 等派生缓存不进列表
    if (e.name === "_workflow.json" || e.name === "_lasterror.json") continue   // 网关自己的簿子，不是用户产物
    // Windows 保留名。agent 偶尔会写出 `... 2>nul` 这种 cmd 习惯的重定向，而 Git Bash 不认
    // `nul` 这个设备名，直接当普通文件建了出来 —— 于是一个 172 字节的垃圾文件出现在用户的
    // "产出"侧栏里（实测见过）。Linux 生产不会有（那边是 /dev/null），但桌面版就是 Windows。
    if (WIN_RESERVED.test(e.name)) continue
    // ★ 脱敏还原表绝不进"产出"侧栏。deidentify 现在已经写进 .private/（点号目录本就被上面跳过），
    //   这条是纵深防御：兜住旧会话里已经落在产物目录的、以及别的技能日后可能写出的同类文件。
    //   它第一列就是真实姓名 / 住院号 / 身份证 / 手机号，和成果并排摆着，一次误转发就是真实泄露。
    // ★ 判据引 workflows.mjs 的唯一定义（WF.isSecretName）。原来这里只写了 `*_mapping.csv`，
    //   而渲染器与前端 isSecret 收的是一整组 —— deid_crosswalk.csv / 姓名对照表.csv /
    //   patient_keyfile.csv 三类真 PHI 表照常列在侧栏、可一键下载，"纵深防御"只挡住了六分之一。
    //   代价：gene_mapping.csv 这类良性表也会被挡（判据宁可宽，泄露不可逆、找不到文件可补救）。
    if (WF.isSecretName(e.name)) continue
    const p = path.join(dir, e.name)
    const rel = prefix ? prefix + "/" + e.name : e.name
    let st; try { st = fs.statSync(p) } catch { continue }
    if (st.isFile()) m[rel] = st.mtimeMs
    else if (st.isDirectory() && depth > 0) Object.assign(m, dirState(p, depth - 1, rel))
    // ★ 再深一层就不列了（约定如此：侧栏只递归一层）。但【必须让用户知道它存在】——
    //   实测 agent 把图写进 figures/panel/fig1.png 时，侧栏、正文嵌图、步骤条三条线索同时失效，
    //   图等于凭空消失，用户零线索。这里只数个数，交给 /api/outputs 挂一行灰字提示。
    else if (st.isDirectory()) deeperCount.n += countFilesDeep(p)
  }
  return m
}
// dirState 递归到底层时，被"只列一层"挡在外面的文件有多少个。用对象是为了在递归里累加。
const deeperCount = { n: 0 }
const countFilesDeep = (dir) => {
  let n = 0
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of ents) {
    if (e.name.startsWith(".")) continue
    try { n += e.isDirectory() ? countFilesDeep(path.join(dir, e.name)) : 1 } catch { /* 读不到就不数 */ }
  }
  return n
}
/** 跑一次 dirState 并顺带拿到"更深层还有几个文件没列出来" */
const dirStateDeep = (dir) => { deeperCount.n = 0; const m = dirState(dir); return { map: m, deeper: deeperCount.n } }
// 相对某个快照，哪些文件是本轮新建或被改动的（最新在前）
const changedSince = (dir, before) => {
  const now = dirState(dir)
  return Object.keys(now)
    .filter(name => !(name in before) || now[name] > before[name])
    .sort((a, b) => now[b] - now[a])
}
// 把用户传来的 name 解析成 dir 内的绝对路径；越界一律返回 null（调用方回 404）。
// ★ 为什么不能再用 path.basename：支持子目录后 name 必须允许带分隔符，而 basename 会把
//   "pdfs/a.pdf" 砍成 "a.pdf"（功能直接坏掉）。basename 之所以安全，恰恰是因为它把分隔符全扔了；
//   一旦要保留分隔符，这条一行防线就失效，必须换成"解析后检查是否仍在 dir 之内"。
// 三重检查缺一不可：
//   ① path.resolve 后做前缀包含 → 挡住 ../、绝对路径、以及 %2e%2e 解码后的形态；
//   ② 前缀比较必须带 path.sep → 否则 /data/outputs-evil 会被 /data/outputs 的前缀误判为"在内"；
//   ③ realpath 后再查一次 → 挡住 dir 内部指向外面的符号链接（agent 有 shell，能造软链）。
// 注意：写入路径（/api/upload）【不使用】本函数，仍用 basename —— 那里的 name 完全由用户控制，
// 允许分隔符等于把写入点从"会话目录内一个文件"放大成"任意相对路径"，不值得为它冒险。
const safeUnder = (dir, name) => {
  if (!name || typeof name !== "string") return null
  if (name.includes("\0")) return null
  const base = path.resolve(dir)
  const p = path.resolve(base, name)
  if (p !== base && !p.startsWith(base + path.sep)) return null
  try {
    const realBase = fs.realpathSync(base)
    const real = fs.realpathSync(p)
    if (real !== realBase && !real.startsWith(realBase + path.sep)) return null
  } catch { /* 文件不存在时 realpath 会抛 —— 交给调用方的 existsSync 去 404 */ }
  return p
}
const send = (res, code, type, body) => { res.writeHead(code, { "Content-Type": type }); res.end(body) }
// 在【请求体还没读完】就提前回包时必须用它：HTTP/1.1 默认 keep-alive，若不声明关闭连接，
// 未读完的 body 会滞留在这条连接上，把它彻底堵死——同一条连接上的下一个请求永远不返回
// （实测：同一 keepAlive Agent 上先发超限请求拿到 413，紧接着的请求 >15s 无响应）。
// 典型场景：上传/发消息的体积超限，我们不想把几 MB 收完才拒绝。
const sendClose = (res, code, type, body) => { res.writeHead(code, { "Content-Type": type, "Connection": "close" }); res.end(body) }
// 小 JSON 请求体（工作流表单等）。带上限：表单值全由前端给，不设限等于让任意登录用户拿内存说事。
// 超限直接抛，调用方 catch 成 400 —— 这类请求正常也就几 KB。
const JSON_BODY_MAX = 256 * 1024
async function readJson(req) {
  const chunks = []; let n = 0
  for await (const c of req) { n += c.length; if (n > JSON_BODY_MAX) throw new Error("请求体过大"); chunks.push(c) }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
}

// ---- 局域网访问的简易单用户登录（demo）----
// 本机（localhost）访问免登录；从局域网 IP 访问才要求输入密码。登录成功发一个随机 token 到 Cookie。
const LAN_USER = process.env.LAN_USER || "tellgen"             // 单用户账号，可用环境变量覆盖
const LAN_PASSWORD = process.env.LAN_PASSWORD || "123"         // 单用户密码，可用环境变量覆盖
const AUTH_ENABLED = process.env.LAN_AUTH !== "0"             // LAN_AUTH=0 可整体关闭登录
// 路径路由前缀：多用户单域名部署时每容器设 BASE_PATH=/用户名（如 /alice）。前面的 manager 会剥掉该前缀再转进来，
// 所以容器内部仍按根路径处理；这里只在"发给浏览器"的东西上补回前缀——跳转 Location 与 Cookie 的 Path。
// 尤其 Cookie 的 Path=/用户名/ 是隔离关键：保证 alice 的登录 token 只发往 /alice/，不会泄露给别的用户容器。
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/+$/, "")   // 归一化，去掉结尾斜杠；根部署留空
// 未登录时把浏览器送去哪个登录页：
// - 多用户部署（设了 BASE_PATH，前面有 manager 按 /用户名/ 反代并剥前缀）→ 必须送到 manager 根 "/" 的
//   验证码登录门户。容器自带的 login.html 没有验证码输入框，而 manager 对 POST /<用户名>/api/login
//   强制校验图形验证码（verifyCaptcha 不过直接 401「验证码错误」，压根不转进容器）→ 在容器登录页永远登不进来。
//   "/" 在 manager 那层（不带用户名前缀），故此处【不能】加 BASE_PATH。
// - 单机/局域网部署（BASE_PATH 为空、前面没有 manager）→ 没有验证码这回事，照旧用容器自带的 /login。
const LOGIN_URL = BASE_PATH ? "/" : "/login"

// ---- 功能模块（封装的技能入口 + 每用户授权）----
// 每个"模块"= 一种会话形态：chat 是不设限的自由对话（走 AGENTS.md 的完整路由）；
// 其余模块把会话锁定到【单个技能】——注入模块专用前言，且网关在事件流里强制校验：
// agent 一旦调用模块外的技能（或试图用 task 子代理绕道），本轮立即中止（见 startJob 的模块闸）。
// 会话在创建那一刻绑定模块，绑定持久化在 ocdata 卷（module-map.json），之后不可改——
// 换功能 = 新开会话。老会话（本功能上线前建的）一律按 chat 处理。
// skills：该模块放行的技能【集合】。**不再手写**——由 workflows.mjs 的 steps 展开（WF.skillsOf），
// 那份定义同时喂前端表单与任务卡，一份事实多用，不会再与 AGENTS.md §三 的路由表漂开
// （手写时代的实况：paper 缺了脱敏/统计/作图整个前半段、litread 缺排版出件）。null = 不受限（仅 chat）。
// primary：主技能，模块可用性看它（被技能白名单收权则整个模块不可用）。
// ★ 必须【显式声明】，不能再取 skills[0]：技能集现在是从 steps 自动展开的，数组顺序不再可控，
//   而它决定模块开不开 —— 靠顺序会静默错判（旧写法遗留的真隐患，随本次改造一并修掉）。
// 本表是模块清单的【唯一来源】（旧的容器架构曾把它抄在 manager.mjs 与 user-modules.sh 里三处同步，
// 那套已随 Docker 部署整体删除）。模块 id 一经发布就不要改：授权记录存的是 id，改名等于把老用户的授权改没。
// group：工作台（workspace.html）按它把卡片分到两栏——
//   workbench =「工作台 / Research Tools」：从零到成稿的完整流程模块（含自由对话）
//   skills    =「核心能力 / Skills」：单点能力，随时插进任一流程
// 表内顺序即两个页面的展示顺序（工作台分栏、聊天页欢迎区列表都读 /api/modules 的原序）。
// 将来新增模块若忘了写 group，工作台把它落到「核心能力」栏——不会从界面上凭空消失。
const MODULE_DEFS = {
  review:   { name: "综述撰写",       group: "workbench",
              desc: "整合医学前沿研究成果，梳理领域发展脉络，挖掘研究缺口，明晰创新方向，为课题设计与成果输出夯实理论基础。" },
  grant:    { name: "基金申报",       group: "workbench",
              desc: "国自然 / 基金标书智能生成、润色与格式校验，搭建完整研究方案，优化技术路线，覆盖立项依据到研究基础全章节。" },
  paper:    { name: "SCI 论文",       group: "workbench",
              desc: "契合医学期刊规范，梳理试验逻辑、深化结果讨论，雕琢全文表述，助力高水平学术成果刊发。" },
  chat:     { name: "自由对话",       group: "workbench", skills: null,
              desc: "与科研助手开放对话，随问随答，支持上传文献、数据与方法学讨论。" },
  // 模块 id 保持 litread 不变（deploy 的 users/<名>.env 里 MODULES= 存的是 id，改名等于把老用户的授权改没）；
  // 变的是它做什么：从"检索一个方向的文献"改成"把用户上传的这一篇读透"（专用界面 web/reader.html）。
  litread:  { name: "文献研读",       group: "skills",
              desc: "上传一篇 PDF / Word 文献，逐篇读透：自动导读理清核心与论证逻辑，可全文翻译、生成汇报 PPT，也能对着原文随时追问。" },
  refcheck: { name: "文稿核查与审校", group: "skills",
              // ⚠️ 别写成"识别伪造、篡改" —— data-integrity 技能的铁律是「只出待核信号、不下造假结论」
              // （signal not verdict）。首屏承诺"查得出造假"而实际只给待核清单，既让用户失望，本身也有风险。
              desc: "核验文献与引用是否真实存在、DOI 与撤稿情况，检查统计方法与数据的自洽性，逐条列出需要你复核的疑点。" },
  humanize: { name: "文章润色",       group: "skills",
              desc: "贴合期刊写作范式，优化行文逻辑、专业表述与段落架构，消除生成式文本痕迹，还原自然学术语感与逻辑节奏。" },
  stats:    { name: "数据统计与分析", group: "skills",
              desc: "一站式医学科研数据服务，涵盖统计建模、基线分析、期刊图表绘制、数据脱敏与源数据核查，完成从数据质控到结果可视化全流程处理。" },
  // ⚠️ 简介里必须把「和 stats 的分界」与「AI 生图」两件事都说出来：
  //   ① 由数值画出来的统计图（森林图 / KM / 火山图）在 stats 那张卡里，不在这里——两张卡都写着
  //      "作图"时，带着一份 Excel 的用户十有八九点进这一个，然后发现没地方传表；
  //   ② 出的是 AI 生成位图、不是矢量图，多数期刊不接受直接入稿。这句话放在进门之前说，
  //      比等他出完图（还扣掉了当天的生图张数）才被告知要好。
  figure:   { name: "科研作图",       group: "skills",
              desc: "用一段文字描述机制、通路或技术路线，直接生成示意图与图形摘要，不用上传数据。出的是 AI 生成位图，适合组会汇报、标书插图与投稿前构思稿；由数值画出来的统计图请用「数据统计与分析」。" },
}
// 技能集与主技能由 workflows.mjs 回填（chat 例外：skills 恒为 null = 不受限）。
// 就地写回 MODULE_DEFS 而不是到处调 WF.skillsOf()：下游有十几处读 m.skills，保持它们不用改。
for (const [id, m] of Object.entries(MODULE_DEFS)) {
  if (m.skills === null) continue                     // chat
  m.skills = WF.skillsOf(id)
  m.primary = WF.primaryOf(id)
  if (!m.skills || !m.primary) {
    // ★ 必须显式置成不可用。此前只打一行告警就完事，而 moduleUsable 的写法是
    //   `!modPrimarySkill(id) || skillAllowed(...)` —— primary 为 null 时前半段为真 → 模块【照常可选】，
    //   建出来的会话 modSkills=null → skillGate 退成账号级、restricted=false、连 task 都不禁，
    //   等于这个受限模块完全没有闸。是 fail-open，方向错了。
    //   触发条件：往 MODULE_DEFS 加模块或改 id 而忘了在 workflows.mjs 加对应条目。
    m.broken = true
    console.warn(`[modules] 模块 ${id} 在 workflows.mjs 里没有对应工作流 → 已置为不可用（fail-closed），请补上定义`)
  }
}
/** 模块的主技能（决定该模块是否可用）；chat 无主技能 */
const modPrimarySkill = (id) => MODULE_DEFS[id]?.primary || null
/**
 * 技能 → "该去哪个模块" 的反查，用于越权报错时指路。
 * 只说"请到自由对话"太糊：用户在 SCI 论文模块里被 nature-figure 挡下时，真正该去的是
 * 「数据统计与分析」。找不到归属（如 systematic-review 不属于任何模块）才回落到自由对话。
 */
const skillHome = (skill, curMod) => {
  const name = String(skill || "").replace(/（.*$/, "").trim()   // 剥掉 "（bash 直呼技能脚本）" 这类后缀
  // 排除用户当前所在的模块：技能集扩成整条 pipeline 后一个技能常属于多个模块（nature-figure 同属
  // paper 与 stats）。账号级白名单单独收掉它时，在 paper 里被拦却提示"请到 SCI 论文模块"——指回原地。
  const hits = Object.entries(MODULE_DEFS).filter(([id, m]) => id !== curMod && m.skills?.includes(name)).map(([, m]) => m.name)
  if (!hits.length) return ""
  return `「${name}」属于${hits.map((h) => `「${h}」`).join(" / ")}模块，请到那里新开会话继续。`
}
/** 模块是否可用 = 模块本身获授权 且 主技能未被技能白名单收权 */
const moduleUsable = (id) => !MODULE_DEFS[id]?.broken && ALLOWED_MODULES.includes(id) && (!modPrimarySkill(id) || skillAllowed(modPrimarySkill(id)))
// 每用户授权（ALLOWED_MODULES=chat,grant,...，由 deploy 的 users/<名>.env 注入）。
// 空/未设 = 全部模块（单机部署与老容器的兼容默认）。非空但没有一个合法 id = 配置错误 →
// fail-closed 回落到仅 chat 并响亮告警（别把乱码静默当"全开"）。
const ALLOWED_MODULES = (() => {
  const raw = String(process.env.ALLOWED_MODULES || "").trim()
  if (!raw) return Object.keys(MODULE_DEFS)
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => MODULE_DEFS[s])
  if (!ids.length) { console.warn(`[modules] ALLOWED_MODULES 配置非法：${JSON.stringify(raw)} → 回落到仅 chat，请修正 users/<名>.env 的 MODULES`); return ["chat"] }
  return ids
})()
// ---- 每用户技能白名单（比模块更细的授权粒度）----
// ALLOWED_SKILLS=（逗号分隔，deploy 的 users/<名>.env 经 SKILLS= 注入）；空/未设 = 全部技能。
// 生效范围：自由对话(chat)会话——注入"未开通技能"前言 + 事件流强制（调未开通技能即中止本轮，
// 与模块闸同一机制）；受限模块的绑定技能被收权时，该模块整体不可用（/api/modules 置 false、start 拒绝）。
// env-setup 恒许可（基础设施：各技能都依赖它建的 .venv，禁它只会让一切技能坏得莫名其妙）。
// 已知逃逸面（与模块闸一致的取舍）：chat 会话不禁 task 子代理（禁了会破坏正常流水线），子会话里的
// 技能调用不经本闸；且 agent 有 shell，理论上可绕过 skill 工具直接跑技能脚本——本闸是产品分权，不是对抗边界。
const SKILL_IDS = (() => {   // 以技能目录为唯一事实来源（含 SKILL.md 的子目录才算技能）
  try {
    return fs.readdirSync(path.join(ROOT, ".opencode", "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, ".opencode", "skills", e.name, "SKILL.md")))
      .map((e) => e.name)
  } catch { return [] }
})()
// 工作流自检：steps 里写的技能必须真实存在，否则那一步会静默变成"agent 调了就被闸掐掉"的哑失败
// （技能改名/删除时尤其容易发生）。只告警不阻断——受限容器过滤挂载后技能目录本就是子集，
// SKILL_IDS 读到的东西比仓库少是正常的，不能因此拒绝启动。
if (SKILL_IDS.length) {
  for (const [id, m] of Object.entries(MODULE_DEFS)) {
    if (!m.skills) continue
    const missing = m.skills.filter((s) => !SKILL_IDS.includes(s))
    if (missing.length) console.warn(`[modules] 模块 ${id} 的工作流引用了本环境不存在的技能：${missing.join("、")}（该步骤会被技能闸挡下，请核对 workflows.mjs 与技能目录）`)
  }
}
const ALLOWED_SKILLS_SET = (() => {   // null = 不设限（全部技能）
  const raw = String(process.env.ALLOWED_SKILLS || "").trim()
  if (!raw) return null
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean)
  const valid = ids.filter((s) => SKILL_IDS.includes(s))
  const dropped = ids.filter((s) => !SKILL_IDS.includes(s))
  if (dropped.length) console.warn(`[skills] ALLOWED_SKILLS 含未知技能（已忽略）：${dropped.join(",")}`)
  // 非空但全非法 = 配置错误：fail-closed 成"一个都不许"（响亮告警），而不是静默放开全部
  if (!valid.length) console.warn(`[skills] ALLOWED_SKILLS 无一合法：${JSON.stringify(raw)} → 按全部禁用处理，请修正 users/<名>.env 的 SKILLS`)
  return new Set([...valid, "env-setup"])
})()
// ---- 云端账号的技能授权（运营后台改完，客户端要跟着变）----
//
// 【为什么必须在客户端这边落地】技能是"软管控"：技能在客户端执行，云端网关只看得到
// 每一单 LLM 请求，而请求里并没有"这是哪个技能在跑"的信息（X-Skill 由客户端自愿携带，
// 本客户端不带——opencode 直连本机代理，中间没有能可靠标出技能名的地方）。所以运营后台
// 那份白名单要真正生效，靠的就是这里：模块卡片、chat 前言、事件流强制三处都读它。
//
// 生效时机（回答"管理员改完客户端多久知道"）：白名单在 /api/me 的档案里，档案随
// ① 登录、② access key 续期（改档位/技能会 bumpEpoch 吊销 key → 下一次模型请求即被迫续）、
// ③ /api/cloud/notice 那条 5 分钟轮询顺带同步（见 syncProfileSoon）刷新。
// 最坏情况也就是"下次登录必然生效"，正常情况几分钟内自己就变了。
const cloudSkillSet = () => {
  if (!cloudLoggedIn()) return null                     // 没走云端账号（容器/自设 API）→ 只看 env
  const list = Cloud.loadState()?.profile?.skills
  if (!Array.isArray(list) || !list.length) return null // [] = 档位不限技能
  return new Set([...list.map(String), "env-setup"])     // env-setup 恒许可（各技能都靠它建 .venv）
}
/** env 白名单 ∩ 云端白名单；null = 两层都不限 */
const effectiveSkillSet = () => {
  const env = ALLOWED_SKILLS_SET, cloud = cloudSkillSet()
  if (!env) return cloud
  if (!cloud) return env
  return new Set([...env].filter((s) => cloud.has(s)))
}
const skillAllowed = (name) => { const s = effectiveSkillSet(); return !s || s.has(name) }
// chat 会话的技能限制前言（受限模块会话不用它——那边本就锁死单技能）。
// 注意：受限容器的技能目录已被 deploy 侧过滤挂载（未开通技能物理不存在，见 render-compose.sh），
// 所以这里【只能】列"已开通"的一边——SKILL_IDS 读自过滤后的目录，算不出被禁清单。
// 单行无空行（stripPreamble 按第一个空行剥离，见 modulePreamble 同款约束）。
const skillsPreamble = () => {
  const set = effectiveSkillSet()
  if (!set) return ""
  const allowed = [...set].filter((s) => s !== "env-setup")
  // 措辞对两种来源都成立：容器形态下未开通技能确实不存在，云端账号形态下它们装着但没授权。
  // 早先只说"本环境也只安装了这些"，云端授权收紧时那句话是假的，agent 会去 ls 技能目录、
  // 发现明明在，然后照常调用。
  return `\n- **【技能授权，最高优先级】**本账号只开通了以下技能：${allowed.join("、")}（外加 env-setup）。其它技能对本账号【未授权】（本环境里可能根本没安装，即使目录里看得到也不许用）：不要尝试调用、查找或读取它们；涉及未开通技能的步骤直接跳过并明确告知用户"该步骤因未开通对应技能而省略"，也不要徒手模仿该技能的产出。`
}
// 本会话若已从 Zotero 导入小文献库（前端「Zotero 文献库」面板的"导入"），告诉 agent 怎么按范围选 RAG scope。
// 与 skillsPreamble / modulePreamble 同块注入，故同样【单行、不许有空行】（stripPreamble 按第一个空行剥离）。
// 路径写相对：会话的 cwd 就是产物目录，zotero_lib 正在其下。
const zoteroPreamble = (outDir) => {
  try { if (!fs.existsSync(path.join(outDir, "zotero_lib", "zotero_refs.json"))) return "" } catch { return "" }
  return `\n- 本会话已从 Zotero 导入一个小文献库到当前目录下的 \`zotero_lib/\`（含 PDF 与 zotero_refs.csv）。用 zotero-library 技能做全文 RAG 时按范围选：用户说"基于我导入的文献 / 这批文献 / 我的小库"→ 只检索该目录 \`\${REPO_ROOT:-/app}/.venv/bin/python \${REPO_ROOT:-/app}/.opencode/skills/zotero-library/references/zotero_rag.py --pdf-dir zotero_lib --backend embed\`（可加 \`--rerank\`）；用户明确说"整个 Zotero 库"→ 换成 \`--library\`。证据表写当前目录。`
}

// ---- 云端档案的定期同步 ----
// 运营后台改了档位 / 技能授权 / 可选模型之后，客户端靠三条路知道：登录、key 续期、以及这里。
// 挂在 /api/cloud/notice 那条已有的 5 分钟轮询上（前端本来就在打它），不新增任何定时器；
// 自己再限流 5 分钟，多标签页 / 窗口聚焦补拉都不会把 /api/me 打穿。
let profileSyncAt = 0
const PROFILE_SYNC_MS = 5 * 60 * 1000
async function syncProfileSoon() {
  if (!cloudLoggedIn()) return
  const now = Date.now()
  if (now - profileSyncAt < PROFILE_SYNC_MS) return
  profileSyncAt = now
  // 【只刷数据，不重启 opencode】/api/cloud/refresh 那条路会在默认模型变了时重启后台，
  // 而这里是后台轮询：重启会把正在跑的所有轮连根拔掉（用户可能正跑一小时的综述）。
  // 模型切换仍然是用户主动动作，这里只把授权/清单更新到本地状态。
  let r = null
  try { r = await Cloud.fetchProfile() } catch {}
  // 管理员改档位/技能会 key_epoch++，这把 access key 与 refresh 一起作废（服务端设计如此）。
  // 于是 /api/me 回的是 KEY_EXPIRED —— 档案根本刷不到。这时【主动续一次】：
  //   · 续得上（管理员只是加了模型之类不吊销的改动）→ 档案跟着回包一起更新；
  //   · 续不上（refresh 已随 epoch 作废）→ cloud-account 会清掉本地登录态，
  //     前端下一次轮询看到 loggedOut 就弹登录窗 —— 这正是"改了权限要重新登录"的如实呈现，
  //     比让用户对着一个权限已变的旧界面继续点、直到发消息才被打断要好。
  const code = r && !r.ok && r.error && r.error.code
  if (code === "KEY_EXPIRED" || code === "KEY_INVALID" || code === "KEY_MISSING") {
    try { await Cloud.currentAccess({ force: true }) } catch {}
  }
}
// ---- 云端剩余额度（积分）的本机短缓存 ----
// 权威在云端（服务端按每一单 LLM 响应的 usage 记账，客户端算不出也改不了），这里只做两件事：
// 压掉高频轮询（顶栏 30 秒一次 × 多标签页）、以及断网时别把已经显示着的数字抹成空白。
//
// 【不落盘】剩余额度是"过一分钟就不准"的东西，写进 cloud-state.json 只会让离线启动时
// 顶栏显示一个骗人的旧数；进程重启后重新问一次云端即可，代价一次轻请求。
let cloudQuotaCache = null
const CLOUD_QUOTA_TTL = 20_000
const clearCloudQuotaCache = () => { cloudQuotaCache = null }
async function cloudQuota(fresh = false) {
  if (!cloudLoggedIn()) return null           // 容器/自设 API 形态：没有云端积分这回事
  const now = Date.now()
  if (!fresh && cloudQuotaCache && now - cloudQuotaCache.at < CLOUD_QUOTA_TTL)
    return { ...cloudQuotaCache.data, stale: false }
  const r = await Cloud.fetchQuota().catch(() => ({ ok: false }))
  if (r.ok && r.quota) { cloudQuotaCache = { at: now, data: r.quota }; return { ...r.quota, stale: false } }
  // 拉失败：保留上一份并标 stale（前端加一句"未更新"），与公告同一口径 —— 断网时让额度栏
  // 凭空消失，用户会理解成"额度被清零/被停用"，比显示一个几十秒前的旧数糟得多。
  // 同时把重试时间挪近（5 秒后可再试），但不是每次请求都去戳一个已经不可达的云端。
  if (cloudQuotaCache) { cloudQuotaCache.at = now - (CLOUD_QUOTA_TTL - 5_000); return { ...cloudQuotaCache.data, stale: true } }
  return null
}

/**
 * 影响界面的授权摘要。前端拿它和上次比：变了就重取模块清单与模型清单并提示一句。
 * 只放"看得见的授权"，不放用量——用量每分钟都在变，摘要就永远在变，提示会成噪音。
 */
const entRev = () => {
  const p = (cloudLoggedIn() && Cloud.loadState()?.profile) || {}
  const set = effectiveSkillSet()
  const payload = {
    tier: p.tier || "", model: p.model || "",
    models: (p.models || []).map((m) => (m && m.model) || m).sort(),
    skills: set ? [...set].sort() : null,
    modules: ALLOWED_MODULES.filter(moduleUsable),
  }
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 12)
}

// 会话 → 模块 绑定表（持久化在 ocdata 卷，容器重建不丢；与 quota.json 同目录）
const MODULE_MAP_FILE = path.join(os.homedir(), ".local", "share", "opencode", "module-map.json")
let _modMap = null
const moduleMap = () => {
  if (_modMap) return _modMap
  try { _modMap = JSON.parse(fs.readFileSync(MODULE_MAP_FILE, "utf8")) || {} } catch { _modMap = {} }
  return _modMap
}
const saveModuleMap = () => { try { fs.mkdirSync(path.dirname(MODULE_MAP_FILE), { recursive: true }); fs.writeFileSync(MODULE_MAP_FILE, JSON.stringify(_modMap || {})) } catch (e) { console.warn(`[modules] 绑定表写入失败：${e.message}`) } }
// ---- 用户手动放行质量闸（会话级）----
// 【为什么要有】闸的判据是关键词匹配报告正文（GATE_FAIL_*），必然有假阳性，而假阳性的代价是
// 【用户永远拿不到送审件】：实测 11 条"其实通过"的英文写法里 6 条被判红
// （`Decision: Accept. No major revision required.` —— NEG_PREFIX 只列了中文否定词，挡不住英文 No；
//  `Recommendation: Accept. No critical issues.` —— 结论行判据压根没做否定处理），
// 而"改稿→重跑闸"这条解锁路径对措辞型误判是无效的：报告写得再对，措辞一样会被读成红。
// 所以给用户一个出口，由【他】判断这是误判还是真硬伤。
//
// 【为什么不落在会话产物目录】那个文件（_workflow.json）agent 有写权，把开关放进去等于让被拦的一方
// 自己解锁 —— 模型撞了两次墙之后完全可能"顺手"改掉它。放在 ocdata 卷里，与模块绑定表同处。
// 【但这也不是防篡改边界】agent 有 shell，铁了心也能写到这儿；它挡的是"顺手改掉"，不是恶意。
// 【放行 ≠ 闸转绿】failed / stale 照旧按实际结论显示，产物卡与步骤条仍写"未通过"。放行只免掉"中止本轮"。
const GATE_BYPASS_FILE = path.join(os.homedir(), ".local", "share", "opencode", "gate-bypass.json")
let _gbMap = null
const gbMap = () => {
  if (_gbMap) return _gbMap
  try { _gbMap = JSON.parse(fs.readFileSync(GATE_BYPASS_FILE, "utf8")) || {} } catch { _gbMap = {} }
  return _gbMap
}
const saveGbMap = () => { try { fs.mkdirSync(path.dirname(GATE_BYPASS_FILE), { recursive: true }); fs.writeFileSync(GATE_BYPASS_FILE, JSON.stringify(_gbMap || {})) } catch (e) { console.warn(`[gate] 放行表写入失败：${e.message}`) } }
const gateBypassed = (sid) => !!gbMap()[safeSid(sid)]
const setGateBypass = (sid, on) => {
  const s = safeSid(sid); if (!s) return false
  if (on) gbMap()[s] = new Date().toISOString()   // 存时间而不是 true：排查时能看出是什么时候放行的
  else delete gbMap()[s]
  saveGbMap()
  return !!on
}
const clearGateBypass = (sid) => { const s = safeSid(sid); if (gbMap()[s]) { delete _gbMap[s]; saveGbMap() } }

const sessionModule = (sid) => moduleMap()[safeSid(sid)] || "chat"   // 未登记的老会话一律按 chat
const bindSessionModule = (sid, modId) => { moduleMap()[safeSid(sid)] = modId; saveModuleMap() }
const unbindSessionModule = (sid) => { if (moduleMap()[safeSid(sid)]) { delete moduleMap()[safeSid(sid)]; saveModuleMap() } }
// ---- 会话的工作流状态（表单值 + 步骤进度）----
// 落在【会话产物目录】而不是全局表：它天然随会话建、随会话删（删会话会整目录清掉），
// 也跟着产物一起被打包/迁移。下划线前缀 → dirState 不过滤下划线，所以这里额外在产物列表里排掉它，
// 免得用户在"产出"侧栏看到一个莫名其妙的 json。
// 【谁写】服务端。进度由"产物文件出现了没有"反推（见 wfSyncDone），不依赖模型自觉汇报。
// 【不是防篡改边界】这个文件就在会话产物目录里，agent 有 shell、对该目录有写权，它想改就能改
// （把 done 全填上、或把 form.deidDone 置真把脱敏步从自己的剧本里剔掉）。这不构成提权——技能白名单
// 来自 MODULE_DEFS，压根不看这个文件——但别把它当权威账本用。真正的强制在事件流那道闸上。
// 故 wfLoad 对形状做基本校验：坏数据（如 done 写成字符串）会被 new Set("abc") 拆成 ["a","b","c"] 写回。
const WF_STATE = "_workflow.json"
const wfLoad = (outDir) => {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(outDir, WF_STATE), "utf8"))
    if (!st || typeof st !== "object" || Array.isArray(st)) return null
    if (typeof st.module !== "string") return null
    if (!Array.isArray(st.done)) st.done = []
    else st.done = st.done.filter((x) => typeof x === "string")
    if (!st.form || typeof st.form !== "object" || Array.isArray(st.form)) st.form = {}
    return st
  } catch { return null }
}
const wfSave = (outDir, st) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, WF_STATE), JSON.stringify(st, null, 2)) }
  catch (e) { console.warn(`[workflow] 状态写入失败：${e.message}`) }
}
/**
 * 表单值（intake + 各步 form 合并成一张平表，供 when 条件判定与跨步继承）。
 * 【要求传 modId 并核对】这个文件落在会话产物目录里，而 agent 对该目录有读写权（它有 shell）。
 * 不核对的话，一份 module 对不上的簿子会被拿去裁剪【另一个模块】的步骤链，前言就成了胡话。
 * 这不是权限问题（技能白名单来自 MODULE_DEFS，不看这个文件），但足以让剧本失效且极难排查。
 */
// 表单值（含 intake 里声明的默认值）。★ 必须过 withDefaults：跳过表单直接打字这条路
// 服务端拿到的是 {}，而所有 when 条件按"字段未填"求值 —— refcheck 会因此退化成【零步骤】
// （没有任何闸），humanize 则丢掉"带角标整句不动"的默认保护。两处都是界面看不出来的哑失败。
const wfValues = (outDir, modId) => {
  const st = wfLoad(outDir)
  return WF.withDefaults(modId, (st && st.module === modId && st.form) ? st.form : {})
}
/**
 * 质量闸的报告到底判没判过。
 * 只认【明确写出的否定结论】，其余一律当通过 —— 宁可漏判也不能误判：把一份其实通过了的稿子
 * 标成"需返工"，用户会白白多跑一轮。所以这里的词表是各技能报告里真实用的定论措辞，不做泛化匹配。
 */
// 判据分两层，都是踩出来的：
// ① 单看关键词会【反向误报】—— peer-review 的报告哪怕结论是通过，也照样有一节标题叫
//    "### Critical（不改会被拒/结论不成立）"。拿裸 critical 判失败，等于每份评审报告都标"需返工"。
// ② 只列书面词又会【漏判】—— 模型实际写的是「裁定：**闸不过（回退 #1）**」「条件性通过（需返工）」，
//    这两句都不含"不通过"三个字。
// 所以：无歧义的定论词全文匹配；容易误伤的词（reject / 不通过 / critical）只在【结论行】上算数，
// 而"结论行"要排除 markdown 标题 —— 小节标题里出现"结论"二字太常见（上面那个 Critical 标题就是）。
// 否定前缀：这些词一旦被否定，含义就反过来了 —— 「无需返工」「未发现假引用」「无未通过项」
// 都是【通过】的意思。纯子串匹配会把它们全判成红（实测 7 条真实通过措辞全中招）。
// 用变长负向后顾把它们挡掉。宁可漏判也不能误判：假红会让用户白跑一轮，还会把交付物警示变成狼来了。
// ★ 英文同样要挡，而且【不能只挡紧挨着的那个词】。实测（判据直接从本文件抠出来跑）：
//   `Decision: Accept as is. No major revision required.` 被判红 —— "major revision" 前面那个
//   英文 No 不在词表里，一个字都挡不住。11 条"其实通过"的英文写法里 6 条中招。
//   而真实写法还有 `does not require major revision` 这种否定词与裁定语之间隔着动词的，
//   所以英文这一支允许中间夹最多 24 个【非句末】字符（句号/分号/问号/换行不跨，免得把上一句的
//   否定算到下一句头上）。
// ★ 中文那一支保持"紧邻"不变：中文里"不/未"与裁定语之间基本不插词，放宽反而会把
//   "未做敏感性分析，需返工"这类【否定在前、裁定在后】的句子误放行 —— 那是两件事，不是否定。
const NEG_PREFIX = "(?<!无|不|未|毋|没|没有|未见|未发现|不存在|未出现|无任何|不含|零" +
  "|\\b(?:no|not|none|without|free of)\\b[^.;!?\\n]{0,24})"
const GATE_FAIL_SURE = new RegExp(NEG_PREFIX +
  // ★ 「不通过」后面必须跟句读或行尾。医学写作里它极常见地当【普通动宾】用 ——
  //   "不通过血脑屏障""不通过静脉给药"，实测踩到的原句是预注册文件里的假设：
  //   "缺氧**不通过**甲基化改变促进复发"。而 GATE_FAIL_SURE 是全文匹配、不限行，
  //   于是新颖性闸被判红、界面显示「✕ 需返工」，而报告裁定明明是"进入标书起草"、
  //   模型也在对话里说"闸1 通过" —— 界面与对话直接打架，还是往最吓人的方向打。
  //   裁定语本来就有 未通过 / 不予通过 / 闸不过 覆盖，这一条只需堵住动宾用法。
  //   收尾字符里【必须带上 markdown 标记】：真实写法是「本闸判定 **不通过**」，
  //   `不通过` 后面紧跟的是 `**` 而不是句读 —— 漏了它就会把一条真裁定放过去（既有测试当场抓住）。
  "(闸不过|闸未过|不予通过|未通过|不通过(?=[\\s，。；、）)\\]】*_`~]|$)|需返工|需要返工|退回返工|条件性通过|major\\s*revision|需要?重大修改" +
  "|假引用|伪造引用|编造的?引用|查无此文|未能核实|该文献不存在)", "i")
// 否定写在裁定语【后面】的写法：`Major revision: none` / `Major revision — N/A` /
// `Major revision is not necessary.` / `需返工：无`。GATE_FAIL_SURE 是纯前缀否定（NEG_PREFIX），
// 这四句实测【全判红】，而它们全是通过。所以再加一道后缀否定，由 sureFailed 逐行配合使用。
// 距离限制 16 字符且不跨句读（`;`/`。`/`.` 都在排除集里）—— 不限的话，
// `Major revision required; none of the analyses account for clustering` 会被后半句的 none 放行。
const SURE_TAIL_NEG = /^[^。.;!?\n]{0,16}(无|没有|none|n\/?a|unnecessary|not\s+(required|necessary|needed|warranted|recommended)|0\s*[条项个]?\s*$)/i
// GATE_FAIL_SURE 的实际用法：【逐行】判，并放过后缀被否定掉的那一行。
// 为什么改成逐行：原来是整篇 test 一次，于是"哪一行命中的"这个信息拿不到，也就无从判断
// 后面跟的是不是否定。裁定语不会跨行，所以逐行与整篇在检出侧等价，只是多了否定的判断余地。
const sureFailed = (t) => {
  for (const ln of t.split(/\r?\n/)) {
    const m = ln.match(GATE_FAIL_SURE)
    if (!m) continue
    if (SURE_TAIL_NEG.test(ln.slice(m.index + m[0].length))) continue
    return true
  }
  return false
}
// g 标志是给下面【逐个匹配、逐个查否定】用的（见 gateFailed 末尾那段）：整行 test 一下就返回红，
// 会把 `Recommendation: Accept. No critical issues.` 这类【否定过的】判成未通过。用前必须归零 lastIndex。
const GATE_FAIL_CTX = /(reject|critical|严重问题|硬伤)/gi
// 「这个词是不是被否定掉了」：只看它【前面】那一小段。中英都收；`[^。.;!?\n]{0,24}` 限制作用距离，
// 且不跨句 —— 不限距离的话，"未做敏感性分析。结论：存在硬伤"会被上一句的"未"放行。
const NEG_NEAR = /(无|没有|未见|未发现|不存在|未出现|不含|零|\b(?:no|not|none|without|free of)\b)[^。.;!?\n]{0,24}$/i
// reference-check / data-integrity 的裁定是结构化词，不是散文。两种真实写法：
//   统计行  `RETRACTED 1，FABRICATED 2，NOT_FOUND 1，MISMATCH 1`（全绿时是 0，不能裸匹配）
//   表格行  `| [7] | … | **FABRICATED** | 高 |`
// ★ CHECK 必须在列表里。verify_refs.py 现在对「没有 DOI/PMID 且按标题没查到」的条目
//   判 CHECK 而不是 NOT_FOUND —— 因为中文期刊 / 老文献 / 会议摘要大量不在检索库里，
//   一口咬定"疑似虚构"是误报，代价是用户去删一条真实存在的文献。但**闸照样要红**：
//   一条没人能确认真假的引用，正是最该让作者自己去核的东西。漏了 CHECK 就等于把这个改动
//   变成"把假引用悄悄放行"。（_verdict_with_meta 因年份/首作者不符降级出的 CHECK 同理。）
// ★ UNVERIFIED 必须在列表里，且不能只认"UNVERIFIED n"这一种写法。实测踩过：
//   报告统计行写的是 `统计：UNVERIFIED 3`，正文里技能自己还加了一句
//   「⚠️ 本次有 3/3 条只验证了标识符存在、没有比对标题…**不要据此宣布「引用核查全绿 / 质量闸通过」**」，
//   而闸照样判绿 —— 技能作者已经把警告写进报告了，网关却把它读成绿灯，正是这套代码
//   在别处反复防的 fail-open。
// ★ 按词分成两条，是因为大小写敏感性不能一刀切：
//   · 这几个词不会在散文里当普通词用，保留 i —— 模型转述统计行时写成 `unverified 3` 也要认。
const GATE_FAIL_COUNT = /(FABRICATED|RETRACTED|MISMATCH|NOT[_\s]?FOUND|UNVERIFIED)\s*[:：=]?\s*[1-9]/i
//   · CHECK / ERROR 则是英文散文里的日常词，带 i 就会把 `Check 1: sample size reported`
//     （英文报告里再普通不过的编号清单）读成"有 1 条待核引用"→ 整份报告判红（实测中招）。
//     它们在真报告里只以【全大写机器裁定词】出现（verify_refs.py 吐的），所以限定大写。
const GATE_FAIL_COUNT_CAPS = /\b(CHECK|ERROR)\s*[:：=]?\s*[1-9]/
// 技能在报告里主动写的"别据此宣布通过"——它比任何计数都更明确，直接认。
const GATE_SELF_WARN = /不要据此宣布|不能据此宣布|不应据此宣布|别据此宣布/
const GATE_FAIL_CELL = /\|\s*\*{0,2}(FABRICATED|RETRACTED|MISMATCH|NOT[_\s]?FOUND|CHECK)\*{0,2}\s*\|/i
const VERDICT_LINE = /(判定|裁定|结论|总体评价|总评|倾向|建议|verdict|recommendation|decision)/i
// 报告里【明确写出的通过裁定】。出现它时，正文里的 Major/Critical 条目不再单独把闸判红。
//
// 【为什么让位】评审报告里的 Major 有相当一部分根本不是稿件的方法学缺陷，而是"用户还没交的材料"
// —— 伦理批号、注册号、原始记录、代表作清单。这类条目的措辞五花八门，靠词表（待补充 / to be
// provided by…）永远补不全，补不到的那些就把用户锁死在出不了件的状态里。既然报告自己已经把
// 总裁定写成"通过"，那就以裁定为准。
// 【让位的边界，三条都要】
//   ① 只有【明确的通过裁定】才让位。总评被写软（实测「Minor to moderate revision」而正文 4 条
//      **Major**）不算通过，照旧按条目判红 —— 那正是"只认总评就被绕过"的原始教训。
//   ② 只让位给【条目计数】这一条。sureFailed（未通过/需返工/假引用…）、机器统计行、
//      GATE_SELF_WARN、结论行的 reject 一律照旧 —— 报告同时写"已通过"和"需返工"时，否定的那句说了算。
//   ③ 「通过」前面不能是 未/不。`(?<![未不])` 就为此 —— 否则「评审闸未通过」会被读成通过裁定，
//      直接把闸变成永远绿的摆设。
const GATE_PASS_SURE = new RegExp(
  "(闸\\s*(?:已|均|全部)?\\s*(?<![未不])通过" +
  "|(?:判定|裁定|结论|总评|总体评价)\\s*[:：]?\\s*\\**\\s*(?:已|均)?\\s*(?<![未不])通过" +
  "|(?:verdict|recommendation|decision)\\s*[:：]\\s*\\**\\s*(?:accept|pass)\\b)", "i")
// 「信号型」闸的判据。data-integrity 是唯一一个【被铁律明令禁止写裁定语】的闸
// （signal not verdict：只出待核信号、不下造假结论）。而上面那四条判据全都在找裁定语
// （未通过 / 需返工 / major revision / FABRICATED n / 结论行+硬伤）—— 两个设计天然互斥，
// 结果不是"偶尔漏判"，是【这道闸永远判不了红】。
// 实测：模型自己在对话里说"三道全红，不建议在现状下排版出件"，报告里列了 6 条硬性不自洽
// （含生理不可能的 eGFR=1220、3 对完全相同的生物标志物行、死亡数 8 vs 9），
// 而步骤条上「数据完整性」照打绿勾，导出的 Word 上也不会提到"你的原始数据有 6 处对不上"。
// 所以按【信号条数】判，不按措辞判：
//   · audit/REPORT.md 的机器统计行 `信号统计：🟡 Medium 2，🔵 Low 1`（High/Medium 才算）
//   · integrity_report.md 的人工核对条目 `★1 …`
// Low 单独出现不拦：那一档大量是良性提示（实测 paperconan 对二分类结局列报"值重复"）。
const SIGNAL_MED_HIGH = /(High|Medium|高|中)\s*[:：]?\s*([1-9]\d*)/g
// ★ 条目锚点必须写宽。原来是 /^\s*★\s*\d+/m，只认【裸行开头】的 `★1` —— 实测模型真实写出来的
//   两版报告一次都没命中过：一版是 `### ★1. 死亡例数：…`（★ 前面有 "### "），另一版压根没用 ★，
//   写的是 `## 🔴 重大信号（5 项，须作者核实原始记录）` + `### 1. …`。
//   于是那两轮判红全靠另外两条【偶然】命中（audit 的 Medium 计数行、模型碰巧写了"未通过"），
//   把偶然去掉就还原成绿 —— 等于这道闸仍然是靠运气。
// 两条锚点并列，别只留一条：
//   ① 条目符号（★/⭐），允许前面有 markdown 标题号、列表符、加粗；
//   ② 小节计数短语（"重大信号（5 项）" / "需核对 3 条" / "待核信号：2 项"）——
//      不依赖模型这次挑了哪个符号，比 ① 稳。
const SIGNAL_ITEM = /(^|\n)\s*(?:#{1,6}\s*)?(?:[-*•]\s*)?(?:\*\*\s*)?[★⭐]\s*\d+/
// 分隔符要连空格一起收：模型写的既有"重大信号（5 项）"也有"需核对 3 条"。
// 数字只认 1-9 开头 → "0 项"天然不算。再挡一次否定式（"无需核对…"/"未发现需核对…"）。
const SIGNAL_COUNT_PHRASE = /(?<![无未没])(重大信号|严重信号|待核信号|需核对|需要核对|待核对|人工核对)[^\n]{0,12}?[（(：:\s]\s*([1-9]\d*)\s*[项条个]/
function signalGateFailed(t) {
  if (SIGNAL_ITEM.test(t) || SIGNAL_COUNT_PHRASE.test(t)) return true
  let m
  SIGNAL_MED_HIGH.lastIndex = 0
  while ((m = SIGNAL_MED_HIGH.exec(t))) {
    // 只在"信号统计"这类计数行上算数，避免把正文里的"中位数 3"之类误读成信号数
    const line = t.slice(t.lastIndexOf("\n", m.index) + 1, t.indexOf("\n", m.index) < 0 ? undefined : t.indexOf("\n", m.index))
    if (/信号|signal|统计|统计：/i.test(line)) return true
  }
  return false
}
function gateFailed(outDir, step, files, fstate) {
  for (const g of step.emits || []) {
    // ★ 一个通配 emits（如 reference_check*.md）下有多份报告时，【只认最新的那一份】。
    //   原来是逐个读、任一判红就整体判红 —— 而模型第二轮换个文件名写新报告
    //   （reference_check_round2.md）是完全合规的，第一轮那份红报告就永远躺在目录里：
    //   闸永久卡红、重跑不管用，而拦截文案明说"重跑那道闸才算通过"。界面又没有删单个产物的入口，
    //   唯一出路是「仍要出件」—— 一个明说"闸没转绿"的降级出口。这正是本函数注释里
    //   反复要避免的"把人带进死胡同"。
    //   ★ 只在【同一个 pattern 内】取最新，不跨 pattern：像 novelty 那样 emits 里并列着
    //     novelty_report.md（裁定书）与 preregistration.md（另一份文档）的，跨组取最新会读到
    //     不含裁定的那份 → 闸静默变绿，那是 fail-open，比卡红严重得多。
    //     精确文件名各成一组、永远单独评判，塌缩只发生在通配组里。
    let cand = files.filter((f) => WF.globMatch(g, f) && /\.(md|txt)$/i.test(f))
    if (cand.length > 1 && /[*?]/.test(g)) {
      const newest = cand.reduce((a, b) => ((fstate?.[b] || 0) > (fstate?.[a] || 0) ? b : a))
      const dropped = cand.filter((f) => f !== newest)
      if (dropped.length) console.warn(`[workflow] 闸 ${step.id}：${g} 命中多份报告，以最新的 ${newest} 为准（忽略 ${dropped.join("、")}）`)
      cand = [newest]
    }
    for (const f of cand) {
      if (!/\.(md|txt)$/i.test(f)) continue   // 只读文本报告
      try {
        // ★ 实测 kimi 把 reference_check_report.md 写成了同名【目录】，里面才是真报告。
        //   直接 readFileSync 会抛 EISDIR → 落进下面的 catch → "读不到就按通过处理" → 闸静默变绿。
        //   命中目录就往里找一层文本报告，找不到再放弃。
        let fp = path.join(outDir, f)
        if (fs.statSync(fp).isDirectory()) {
          const inner = fs.readdirSync(fp).filter((x) => /\.(md|txt)$/i.test(x))
          if (!inner.length) { console.warn(`[workflow] 闸产物 ${f} 是个空目录，无法裁定`); continue }
          fp = path.join(fp, inner[0])
        }
        const t = fs.readFileSync(fp, "utf8").slice(0, 20000)
        // 信号型闸（data-integrity）：它被铁律禁止写裁定语，只能按信号条数判 —— 见 signalGateFailed。
        // 仍然把下面几条通用判据一并跑一遍：万一模型确实写了"未通过"，没有理由放过。
        if (step.gateBy === "signals" && signalGateFailed(t)) return true
        if (sureFailed(t) || GATE_FAIL_COUNT.test(t) || GATE_FAIL_COUNT_CAPS.test(t)
            || GATE_FAIL_CELL.test(t) || GATE_SELF_WARN.test(t)) return true
        // 正文里的严重条目：结论行的措辞可能被模型写软（实测正文 4 条 **Major**，总评却是
        // "Minor to moderate revision"），只认总评就被绕过。只数【条目行】，标题行不算。
        // 带否定的条目（"无 Major 问题"）不计 —— 同 P0 的教训。
        let sev = 0
        for (const ln of t.split(/\r?\n/)) {
          if (/^\s*#/.test(ln)) continue
          if (!/^\s*([-*•]|\d+[.)]|\|)/.test(ln)) continue
          // ★ 严重度标记不能要求"这个词【单独】被加粗"。实测 peer-review 真实写出来的是
          //   **整行加粗的表头式条目**：`**M1 | Critical | H18 改革试点段第②部分 | 缺乏申请人自己的科学证据**`
          //   —— `**Critical**` 这种形态一次都没出现，于是一份含 2 条 Critical + 4 条 Major 的报告
          //   被判成通过，标书七步全打绿勾，而医生正是靠这条进度条判断"能不能交稿"。
          //   收两种形态：① 行内任一加粗段里出现该词；② 表格单元格 `| Critical |`。
          if (!/\*\*[^*\n]*\b(major|critical)\b[^*\n]*\*\*/i.test(ln)
              && !/\*\*[^*\n]*严重[^*\n]*\*\*/.test(ln)
              && !/\|\s*\**\s*(major|critical|严重)\s*\**\s*\|/i.test(ln)) continue
          // ★ 放宽检出侧之后，【否定侧必须同步放宽】，否则就是不对称的误报机器。
          //   实测一份总评 A、闸结论写"✅ 通过"的报告被判红，触发句是这几类：
          //     · `- 未发现 **Major** 问题`      ← 否定词与严重度词之间隔了一个 `**` 就失配
          //     · `- 无 **Critical** 问题，仅 4 条 Minor`
          //   同一句话加不加粗结果相反，这种不对称最难被发现。允许中间夹 markdown 标记。
          if (/(无|没有|未发现|未见|不存在|none|no|not|without)\s*[*_`]*\s*(major|critical|严重)/i.test(ln)) continue
          // 否定词也可能在标记【之后】：`- 本节 **Major** 问题：无` / `Critical: none` / `严重问题：0`
          if (/[:：]\s*[*_`]*\s*(无|没有|none|n\/?a|0)\s*[条项个]?\s*$/i.test(ln)) continue
          // ★ 分级说明 / 图例行不是条目。三级并列出现（Critical、Major、Minor 同在一行）
          //   就是在解释severity 分级，不是在报告一条问题。peer-review 的技能文档本身就要求
          //   "每条按五元组写：**严重度（Critical / Major / Minor）| 位置 | …**"，
          //   模型复述这句模板就会踩中，而那一行恰恰说明它【还没开始】列问题。
          if (/critical/i.test(ln) && /major/i.test(ln) && /minor/i.test(ln)) continue
          // ★★ 「等用户补事实」不是稿件缺陷，不能计入。这条是加了服务端硬拦【之后】才致命的：
          //   AGENTS.md §五 明令不许编造伦理批号，所以 AI 协助写的稿子【几乎必然】以
          //   "伦理批号待补充"收尾；而一个称职的投稿前评审【必然】把"缺伦理批准"标成 Critical。
          //   于是这条链稳定复现：不编造(对) → 评审标 Critical(对) → 闸判红(按规则也对)
          //   → render 被硬拦 → **用户永远拿不到 Word**。实测：模型完整照做了解锁流程
          //   （改稿 → 重跑引用核查 3/3 OK → 重跑自审并写出新报告、总评"修订后可投"），
          //   仍然出不了件，而被拦时的文案还在说"重跑那道闸即可"—— 把人带进死胡同。
          //   闸该量的是【稿件本身的方法学缺陷】，不是【用户还没交的材料】。后者拦不出质量，
          //   只会把交付卡死；它照样留在报告里，用户看得到、也知道投稿前必须补。
          if (/(待补充|待填|需你|只能由你|无法代为编造|不能代填|由你(方|们)?提供|需(用户|作者|申请人)提供|投稿前(必办|补齐|填入))/.test(ln)) continue
          // ★ 同一条豁免的英文写法。少了它，这条豁免在英文报告里【整个失效】：实测
          //   `- **Critical** — IRB approval number to be provided by the applicant` 照样计入严重度，
          //   于是"不编造伦理批号 → 评审标 Critical → 闸判红 → 出不了件"这条死链在英文稿上原样复现，
          //   而中文稿早就修好了。闸量的是稿件的方法学缺陷，不是用户还没交的材料 —— 与语言无关。
          if (/\b(to be (provided|supplied|filled|completed|confirmed|obtained|added)|pending (irb|ethic|approval|registration|submission)|awaiting (irb|ethic|approval)|not yet (provided|obtained|available)|tbd|to be determined|only you can provide)\b/i.test(ln)) continue
          // ★ 计数为零的表格行放行：`| Critical | 不改则拒 | 0 |`、`| Major | … | 无 |`
          //   这是严重度图例表，在评审报告里非常常见，命中数写的就是 0。
          if (/^\s*\|/.test(ln) && /\|\s*\**\s*(0|无|未使用|未命中|none)\s*[条项个]?\s*\**\s*\|?\s*$/i.test(ln)) continue
          sev++
        }
        // ★ 报告已经明确写了"通过"裁定 → 条目计数让位（见 GATE_PASS_SURE 的三条边界）。
        //   Major 里混着"用户还没交的材料"是常态，而那类条目的措辞穷举不完。
        if (sev && !GATE_PASS_SURE.test(t)) return true
        for (const ln of t.split(/\r?\n/)) {
          if (/^\s*#/.test(ln)) continue                       // markdown 标题不是结论行
          if (!VERDICT_LINE.test(ln)) continue
          // ★★ 否定必须在这里也认。这条判据原来是裸的"结论行里出现 reject/critical 就红"——
          //   而结论行恰恰是最爱写否定式的地方，实测四句【全是通过】的话全被判红：
          //     `Recommendation: Accept. No critical issues were identified.`
          //     `Verdict: Pass. No rejection grounds found.`（reject 是 rejection 的子串）
          //     `结论：未发现严重问题，可以出件。`  `建议：接收，不存在严重问题。`
          //   逐个匹配、逐个查它前面有没有否定词；全被否定掉才算这行没问题。
          GATE_FAIL_CTX.lastIndex = 0
          let m
          while ((m = GATE_FAIL_CTX.exec(ln))) if (!NEG_NEAR.test(ln.slice(0, m.index))) return true
        }
      } catch { /* 读不到就别拦，按通过处理 */ }
    }
  }
  return false
}
/** 按"产物文件是否已出现"反推已完成的步骤（权威判据，不问 agent）*/
// 「送审件」类技能：出 Word/PDF 的那两个。闸红着时只拦它们，不拦 markdown ——
// 用户永远拿得到稿件内容，所以闸误判也不会把人锁死，重跑那道闸即可解锁。
const DELIVERY_SKILLS = new Set(["render-docx", "render-pdf-doc"])

/**
 * 本会话当前【真正红着】的闸。必须现算，不能读上一轮落盘的 failed ——
 * 实测那次违规就发生在同一轮内：闸报告 16:25:46 写出、docx 16:26:21 生成，
 * 而上一轮的 failed 里当然还没有它。wfSyncDone 每次都重新裁定闸（见其注释），
 * 顺带把步骤条也刷新了，正好一举两得。
 */
async function failedGatesFor(sid, modId) {
  try {
    const out = await sessionOut(sid)
    return wfSyncDone(out, modId)?.failed || []
  } catch { return [] }
}

/** 把闸的 step-id 换成步骤名，给用户看的文案用。
 *
 * ★ 必须按【这个会话真实的表单】裁剪步骤去查名字，不能拿空表单查（原来两处出件拦截文案都是
 *   `WF.stepsFor(modId, {})`）。红闸的 id 来自 wfSyncDone —— 那边是按真实 form 裁的，
 *   空表单裁掉的闸在这里就查不到名字，于是提示里直接甩一个裸 id：
 *   「"integrity" 当前判定为未通过」而不是「源数据完整性自查」（paper / stats / refcheck 都命中，
 *   humanize 则会把「引用兜底核查」显示成 refcheck）。用户根本不知道该去看哪一步。
 */
async function gateNames(sid, modId, ids) {
  let form = {}
  try { form = (wfLoad(await sessionOut(sid)) || {}).form || {} } catch { /* 读不到就退回空表单，至少不比原来差 */ }
  const steps = WF.stepsFor(modId, form) || []
  return ids.map((id) => steps.find((s) => s.id === id)?.name || id)
}
/** 这些闸判红后该退回哪几步（onFail 指向的步骤名，去重）。
 *  ★ onFail 一直在数据里、也一直下发给前端，但两边都没人读过：拦截文案只说"重跑那道闸"，
 *    不说改哪 —— 而重跑闸并不会让红字消失，用户最自然的反应恰恰是又点一次重跑。 */
async function gateBackNames(sid, modId, ids) {
  let form = {}
  try { form = (wfLoad(await sessionOut(sid)) || {}).form || {} } catch {}
  const steps = WF.stepsFor(modId, form) || []
  const out = []
  for (const id of ids) {
    const back = steps.find((s) => s.id === id)?.onFail
    const nm = back && back !== id ? steps.find((s) => s.id === back)?.name : ""
    if (nm && !out.includes(nm)) out.push(nm)
  }
  return out
}

function wfSyncDone(outDir, modId) {
  let st = wfLoad(outDir)
  // ★ 状态簿不存在就地建一份。它此前只在两条路上被写出来：用户填了首屏表单、或提交了某步表单。
  //   而【直接在输入框打字】是最常见的路径（表单本来就设计成可跳过），那条路下这个文件永远不存在
  //   → 本函数直接返回 null → 进度永远是空的 → 步骤条从第一步纹丝不动。
  //   实测后果：综述跑完了检索、筛选、成文，screening_log.md / included.csv / review.md 全都在，
  //   而用户看到条还停在"文献检索"，以为 AI 把中间几步全跳了。
  //   "产物反推进度、不依赖 agent 自觉"这条设计，不 seed 就只对填了表单的人生效，等于废了一半。
  if (!st) { st = { module: modId, form: {}, done: [] }; wfSave(outDir, st) }
  if (st.module !== modId) return st   // 簿子记的是别的模块（agent 乱写过）→ 不拿它算，也不覆盖
  const fstate = dirState(outDir)
  const files = Object.keys(fstate)
  const done = new Set(st.done || [])
  const failed = new Set()
  // ★ 一份文件算不算某一步的产物：emits 命中【且】不在 emitsNot 里。
  //   加 emitsNot 是因为 emits 的通配互相重叠，一份文件会被算给排在前面的那一步、让它凭空变绿。
  //   最真实的一例：用户自带初稿只想润色，产物只有 manuscript_humanized.md —— 它同时命中
  //   润色步的 `*_humanized.md` 和撰写步的 `manuscript_*.md`，于是 AI 一个字没写，
  //   「撰写正文 ✓已完成」。（globMatch 对不含 / 的 glob 是按 basename 比的，所以躲不开。）
  const emitHit = (s, f) => (s.emits || []).some((g) => WF.globMatch(g, f))
    && !(s.emitsNot || []).some((g) => WF.globMatch(g, f))
  for (const s of WF.stepsFor(modId, st.form || {})) {
    // ★ 闸【每次都重新裁定】，不能吃 done 的缓存。
    //   闸的 emits 里往往既有中间机器产物、也有最终裁定报告，两者可能差好几分钟；用户在这中间
    //   刷新一次页面（切会话 / F5 都会打 /api/workflow/state），这一步就被写进 done 并落盘，
    //   而后 agent 才写出「本闸判定 不通过」—— 闸再也不看了，进度条永远是绿的。实测踩到过两次。
    //   非闸步骤仍吃缓存：它们没有"结论"可翻，重算只是白读文件。
    if (done.has(s.id) && !s.gate) continue
    if (!files.some((f) => emitHit(s, f))) continue
    // ★ 质量闸不能"有文件就算过"。实测：peer-review 报告白纸黑字写着「倾向 Major revision」
    //   并列了一条 Critical，步骤条照样打绿勾 —— 而医生正是靠这条进度条判断"能不能交稿"。
    //   读一眼报告结论：判为未通过的标成 failed（界面显示"需返工"），不计入 done。
    if (s.gate) {
      // ★ 闸还得【有一份可裁定的文本报告】才谈得上"过"。gateFailed 只读 md/txt，一份候选都没有时
      //   它返回 false —— 于是闸只要落下任何一个机器产物就被记成 done、打绿勾。实测两条真实路径：
      //   ① data-integrity 先出 audit/scan.json、之后才写 audit/REPORT.md：REPORT 还没写出来
      //      （或写失败）的窗口里，`audit/*` 已匹配 → 「源数据完整性自查 ✓已完成」；
      //   ② verify_refs.py 先写 reference_check.csv 再写 .md，而 paper 的 emits 收了 csv →
      //      CSV 里明明写着 3 条 FABRICATED，闸照样绿。
      //   这和本函数反复防的 fail-open 是同一类，只是从"措辞"维度换到了"文件类型"维度。
      //   没有报告就【不记 done】（停在未开始，等报告），绝不记成通过。
      //   注：这只修显示。出件硬拦看的是 failed（红），灰着的闸本来就不拦 —— 那条策略不动，
      //   因为"闸还没跑就把人拦死"正是这套代码一直在避免的死胡同。
      const hasReport = files.some((f) => emitHit(s, f) && /\.(md|txt)$/i.test(f))
      if (!hasReport) continue
      if (gateFailed(outDir, s, files, fstate)) { failed.add(s.id); done.delete(s.id); continue }
    }
    done.add(s.id)
  }
  // ★ 单调补齐：后面的步骤已完成 ⇒ 它前面的非闸步骤也一定跑过了。
  //   【为什么必须补】进度是靠"产物文件出现没有"反推的，而有些步骤**成功时也可能不产出文件**：
  //   实测零结果那轮 —— 检索认真跑了 10 轮、逐级放宽、正确得出"确实一篇都没有"的结论，
  //   但 evidence_table.csv / refs.bib 天然不会有，于是「文献检索」停在未完成，
  //   而后面的「研读综述」（有 research_scan.md）打了绿勾。用户看到的是
  //   "第一步没做、第三步做完了"，会以为结论是凭空来的。零结果是**成功**，不是未完成。
  //   同理适用于可选步在无对象时（如没有全文可下）。
  //   **闸不补**：闸的结论只能由它自己写出的报告得出，凭"后面做完了"推断闸通过，
  //   正是这套代码在别处反复防的那种 fail-open。
  // ★ 补齐的步骤单独记进 implied，界面上与"真有产物"的步骤区分显示。
  //   【为什么不能都打绿勾】补齐的成因有两种，服务端分不清：① 步骤真跑了但成功时没有产物
  //   （零结果检索）；② 用户明说"这两步别做了"，它确实没做。实测后者：用户要求跳过领域扫描与
  //   选题收敛，产物目录里也确实没有这两步的文件，界面却把它们打成绿勾 —— 那是在告诉用户
  //   "做过了"，而其实没有。两种都标成中性的"无产物"，比一律绿勾诚实。
  const implied = new Set()
  const ordered = WF.stepsFor(modId, st.form || {})
  // ★ 闸红之后，排在它后面、产物却【早于闸报告】的步骤要标成"已过期"，不能继续打绿勾。
  //   实测：一份综述先干净跑完出了 review.docx（22:46），随后用户加进两条假引用、闸转红
  //   （reference_check.md 23:00）。模型行为是对的 —— 它拒绝重新出件；但界面同时显示
  //   「引用核查 ✗ 未通过」和「排版出件 ✓ 已完成」，读起来就是"闸红了还是出了件"。
  //   done 纯靠"产物文件在不在"反推，不比时间戳，旧 docx 还躺在那儿就恒判完成。
  //   这与本函数注释里反复防的 fail-open 是同一类问题，只是换了个时间维度。
  const stale = new Set()
  const newestOf = (s) => {
    let t = 0
    for (const f of files) if (emitHit(s, f)) t = Math.max(t, fstate[f] || 0)
    return t
  }
  // ★ 判据是"这道闸【现在】红着"，而不是"下游产物比闸报告旧"。
  //   只判旧的那一半漏掉了更危险的另一半：闸已经红了、下游【之后】还是跑了。
  //   实测：闸报告 09:40:49 判红，review.docx 09:41:38 生成（晚于闸报告），
  //   步骤条照样是「引用核查 ✕ 需返工」+「✓ 排版出件」，与改动前观感一模一样，
  //   只是这次 Word 是新的 —— 而"闸红着还把件出了"恰恰比"拿旧件充数"更要命。
  //   闸红着的时候，它下游的任何产物都不能算数，不论先后。
  ordered.forEach((g, gi) => {
    if (!failed.has(g.id)) return
    for (let i = gi + 1; i < ordered.length; i++) {
      const s = ordered[i]
      if (!done.has(s.id)) continue
      if (!newestOf(s)) continue          // 这一步压根没有产物 → 交给下面的 implied 处理
      done.delete(s.id); stale.add(s.id)
    }
  })
  // ★ 另一半：【上游改过之后没重做】。上面那条只在"闸现在红着"时生效，闸一转绿，时间维度的信息
  //   就全丢了。实测两个假绿：
  //   ① 出了 docx(t400) → 改稿(t500) → 重跑闸转绿(t600)：步骤条整排绿，而用户拿到的 Word
  //      是【含假引用的那一版】；
  //   ② 闸绿(t300) 之后稿子又改了(t500)：「引用核查 ✓」纹丝不动 —— 闸绿的是另一份稿子。
  //   newestOf 早就算好了时间戳，却只被当布尔用过一次。按流水线顺序累计"上游最新产物时间"，
  //   某步的产物比它旧 = 这一步是拿旧输入做的 → 标过期（不打绿勾，但也不算红：闸没判它不合格）。
  //   单独记进 staleUp，好让界面把原因说准（"闸红后未重做" vs "上游改过之后没重做"是两回事）。
  const staleUp = new Set()
  let upstreamNewest = 0
  for (const s of ordered) {
    const t = newestOf(s)
    if (!t) continue                                  // 无产物的步骤不参与（implied 那条线管它）
    if (done.has(s.id) && upstreamNewest && t < upstreamNewest) {
      done.delete(s.id); stale.add(s.id); staleUp.add(s.id)
    }
    if (t > upstreamNewest) upstreamNewest = t
  }
  // ★ 判据必须是"这一步有没有产物"，【不能】写成"它还不在 done 里"。
  //   done 在函数开头就用上一次落盘的 st.done 播种，补齐过的步骤第二次进来已经在 done 里，
  //   于是永远进不了 implied；接着空的 implied 被覆盖写回文件，标记就被永久擦除了。
  //   实测：用户开会话、刷页面各触发一次 state 读取，所以「·无产物」几乎没人看得到 ——
  //   连查三次，第一次有、后两次恒为 []。按产物判则是幂等的，与"进度靠产物反推"的原设计一致。
  const hasArtifact = (s) => files.some((f) => emitHit(s, f))
  let lastDone = -1
  ordered.forEach((s, i) => { if (done.has(s.id)) lastDone = i })
  for (let i = 0; i < lastDone; i++) {
    const s = ordered[i]
    // 排除 stale：那一步刚被上面从 done 里摘出去（闸红着），这里再原样加回来还打上「·无产物」，
    // 会把一个明明有 22KB 产物的步骤标成"没有产物"，同时把"已过期"的提示挤掉。
    if (!s.gate && !failed.has(s.id) && !stale.has(s.id) && !hasArtifact(s)) { done.add(s.id); implied.add(s.id) }
  }
  const arr = [...done], farr = [...failed], iarr = [...implied], sarr = [...stale], uarr = [...staleUp]
  // ★ 完成即退位。st.cur 只有 /api/workflow/form 提交表单时写入，全仓库【没有任何清除点】——
  //   那一步跑完之后 cur 仍然钉在它身上，此后每轮收尾广播、每次刷新、每次切回会话都把它送回前端，
  //   于是一个早已跑完的格子被同时画成"当前步"，而真正在跑的那步是灰的（进度条还会自动滚回去）。
  //   产物出来了就说明那步过了，当前位置交给前端的兜底（第一个未完成步）去推，比一个陈旧的值准。
  const curStale = !!st.cur && done.has(st.cur)
  if (curStale || arr.length !== (st.done || []).length || farr.join() !== (st.failed || []).join()
      || iarr.join() !== (st.implied || []).join() || sarr.join() !== (st.stale || []).join()
      || uarr.join() !== (st.staleUp || []).join()) {
    // 落盘前重读一次再只覆盖 done：本函数在【轮次收尾】跑，而用户可能正好在同一时刻提交下一步表单
    //（/api/workflow/form 也写这个文件）。拿本函数开头那份旧快照整体写回，会把刚提交的表单值抹掉。
    const fresh = wfLoad(outDir) || st
    fresh.done = arr; fresh.failed = farr; fresh.implied = iarr; fresh.stale = sarr; fresh.staleUp = uarr
    // 重读之后再判一次：中间用户可能刚提交了下一步的表单，此时 fresh.cur 是新的、不该清
    if (fresh.cur && done.has(fresh.cur)) fresh.cur = null
    wfSave(outDir, fresh)
    return fresh
  }
  return st
}

// 受限模块的会话前言：与工作区前言同一个块注入（中间不能有空行——stripPreamble 按"第一个空行"剥离）
// 【三段】① 技能白名单（硬边界，网关强制）② 步骤链剧本 ③ 产物文件名契约。
// 为什么要 ②③：技能集从"手写几个"变成"按 pipeline 展开的一整条"之后，光靠白名单已经区分不出
// 模块了（paper 的技能集几乎覆盖全部）。真正让模块成其为模块的是剧本 —— 走哪几步、哪几步是闸、
// 闸不过退到哪。产物契约则是界面能把结果渲染成表格/文献卡片的前提。
/**
 * 「本模块之外的需求该去哪个模块」的对照表，注入进模块前言。
 *
 * 【为什么必须注入】此前前言里把目的地写死成「自由对话」。而 `skillHome()` 早就能算出正确归属，
 * 它只挂在【硬闸】那条路上（agent 真去调了越权技能才触发）。实测最常见的路径根本不是硬闸 ——
 * 模型看了前言就【主动拒绝、一个工具都没调】，于是用户拿到的永远是那句写死的错指路：
 *   · 在「文章润色」里要求画投稿级图 → 被指去「自由对话」，而正确答案是「数据统计与分析」；
 *   · 在「文稿核查与审校」里要求去 AI 味 → 被指去「自由对话」，而正确答案是「文章润色」。
 * 用户照做，等于放弃了专为这件事做的模块（连同它的表单与流程）。
 *
 * 另外只列 `moduleUsable()` 为真的模块：多用户部署里 `ALLOWED_MODULES` 可以不含 chat，
 * 那时"请到自由对话"是条死路 —— 指一个用户根本打不开的地方，比不指还糟。
 */
const moduleMapLine = (curMod) => {
  const rows = Object.entries(MODULE_DEFS)
    .filter(([id, m]) => id !== curMod && id !== "chat" && moduleUsable(id) && m.skills?.length)
    .map(([, m]) => `「${m.name}」=${m.skills.join("、")}`)
  const fallback = curMod !== "chat" && moduleUsable("chat")
    ? "表里都没有的技能才说「自由对话」"
    : "表里都没有的就如实说本账号暂时没开通那项能力，**不要**指向用户打不开的模块"
  return rows.length ? `（技能→模块对照：${rows.join("；")}；${fallback}）。` : `（${fallback}）。`
}

const modulePreamble = (modId, outDir) => {
  const m = MODULE_DEFS[modId]
  if (!m || !m.skills) return ""
  const list = m.skills.map((s) => `\`${s}\``).join("、")
  const vals = outDir ? wfValues(outDir, modId) : {}
  return `\n- **【模块限制，最高优先级，覆盖 AGENTS.md 的一切路由规则】本会话是「${m.name}」专用模块**：你【只允许】调用这些技能——${list}（其中 \`${m.primary}\` 是主技能，其余按需配套），禁止调用任何其它技能。\n- **本会话【没有】子代理 / task 工具**（不只是"禁止拿它调技能"——是整个工具不可用，调了本轮会被立即中止）。技能文档里凡是写"派调研子代理""并行分头查"的地方，一律改走它给的**串行兜底**：主流程自己顺序查完（web 搜索/抓取，或 \`.venv\` 的 requests/beautifulsoup4）。别先试一次再说，那一轮会白白作废。\n- 只在本模块职责范围内推进，不越界做别的模块的事；缺信息就直接向用户要。\n- 用户的需求超出「${m.name}」范围时，明确告知本模块做不了，并**按下面这张表把他指到对的模块**去新开会话，不要自己徒手代替其它技能去做${moduleMapLine(modId)}\n- 网关会强制校验技能调用：一旦调用上述清单之外的技能，本轮会被立即中止。${WF.settingsLine(modId, vals)}${WF.pipelineLine(modId, vals)}${WF.artifactLine(modId, vals)}`
}

// HTTP 响应头只能承载 latin1：中文文件名直接塞进 Content-Disposition 会 ERR_INVALID_CHAR → 下载必 500。
// 按 RFC 5987 同时给两份：ASCII 兜底名（老客户端读它；剔掉引号、反斜杠、控制字符与非 ASCII 字节）
// 与 filename*=UTF-8''<百分号编码>（现代浏览器优先读它，中文名原样还原）。
// ★ 纯文本响应必须声明 charset。这些报错文案是【中文】，而前端下载走的是 <a href="api/download…">
// 直接导航 —— 浏览器对没有 charset 的 text/plain 默认按 windows-1252 解码，
// 于是这句精心写的中文提示在用户眼里就是一串乱码，等于白写。
const TEXT_UTF8 = "text/plain; charset=utf-8"
// 产物/上传取不到时的统一文案（下载、原文、预览三处共用）
const FILE_GONE = "这个文件不在本会话的产出或上传里——可能还没生成、名字对不上，或这个会话已被清理过。回到对话里让它重新生成一次即可。"

const contentDisposition = (name) => {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").trim() || "download"
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

// ---- 每日成本额度（USD）----
// 用 opencode 的 session.cost（已含 DeepSeek 缓存折扣）累计每轮增量；跨日自动清零。
// 持久化分两种形态：多用户部署记到【宿主账本】（见下方 REMOTE_QUOTA，防容器内 agent 篡改），
// 单机/本地部署记到 ocdata 卷的 quota.json（重启不丢，与旧行为一致）。
// DAILY_COST_LIMIT=0 或空 = 不限额。达上限即拦截新对话；进行中的轮到限也会被中途掐断（见 startJob 的 updateRunning）。
// 被 abort / 被掐断的那一步 opencode 记 cost=0，由估算兜底补账（见下方"轮内实时成本估算"），否则可无限重试绕过额度。
// 额度解析（fail-closed，与 manager.mjs parseLimit 同款策略）：空/未设/合法 0 → 0（=故意不限额，行为不变）；
// 合法正数 → 该上限；非空但非有限 ≥0 数字（NaN/负数/Infinity，如乱码 env）→ 判为【配置错误】。
// 此前 Number("abc")=NaN、`x>0` 恒 false → 门形同虚设可无限烧钱（要治的 fail-open）。兜底：返回极小正数哨兵
// QUOTA_BAD + 响亮日志，所有既有 `>0 &&` 判断无需改动即近似 fail-closed；哨兵是有限正数 → toFixed 不崩、
// 前端 `if(!limit)` 判真 → 显示 ~$0.00 而绝不回退成"不限"。代价：触底前首个请求可能漏过。
const QUOTA_BAD = 1e-9
const parseLimit = (raw) => {
  if (raw === undefined || raw === null || raw === "") return 0
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return n
  console.warn(`[quota] 额度配置非法 ${JSON.stringify(raw)} → fail-closed（按已超限处理），请修正容器 env`)
  return QUOTA_BAD
}
const DAILY_COST_LIMIT = parseLimit(process.env.DAILY_COST_LIMIT)
const QUOTA_FILE = path.join(os.homedir(), ".local", "share", "opencode", "quota.json")
const todayKey = () => new Date().toISOString().slice(0, 10)   // UTC 日期
const loadQuota = () => { try { const q = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8")); if (q && q.day === todayKey()) return q } catch {} return { day: todayKey(), cost: 0 } }
const saveQuota = (q) => { try { fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true }); fs.writeFileSync(QUOTA_FILE, JSON.stringify(q)) } catch {} }
// ---- 权威账本放宿主（防篡改）----
// 容器里跑的是能执行任意命令的 agent（与网关同 uid、同容器），QUOTA_FILE 对它就是一个可写文件——
// "把 quota.json 里今天的数清零"一句话就能绕过每日额度。配了 QUOTA_API_URL（多用户部署由
// render-compose.sh 注入，指向宿主 manager 的记账端点）时：权威账本在宿主文件系统上，本进程
// 只在内存记账 + 异步上报增量；QUOTA_FILE 降级为镜像缓存，仅在「启动后尚未从宿主播种到读数」
// 的窗口期作回退。上报凭据 QUOTA_TOKEN 虽然 agent 同样读得到（env 对它不设防），但宿主端
// 只接受【正增量】——拿它伪造只能给自己多记账，减不了、清不了。
// 未配 QUOTA_API_URL（单机 / 本地 / 老容器）完全保持原来的本地文件行为。
const QUOTA_API = (process.env.QUOTA_API_URL || "").replace(/\/+$/, "")
const QUOTA_TOKEN = process.env.QUOTA_TOKEN || ""
const QUOTA_USER = (process.env.BASE_PATH || "").replace(/^\//, "").split("/")[0]
const REMOTE_QUOTA = !!(QUOTA_API && QUOTA_TOKEN && QUOTA_USER)
const rq = { day: todayKey(), cost: 0, pending: 0, seeded: false, flushing: false }
// 跨日：已入账部分清零；尚未上报出去的增量（pending）是真实花费，顺延计入新的一天
const rqRoll = () => { if (rq.day !== todayKey()) { rq.day = todayKey(); rq.cost = rq.pending } }
const rqFetch = (p, opt) => fetch(QUOTA_API + p, { ...opt, headers: { "x-quota-token": QUOTA_TOKEN, ...(opt?.headers || {}) }, signal: AbortSignal.timeout(5000) })
// 把累计未上报的增量推给宿主账本。失败不丢：pending 保留，10s 定时器兜底重试；
// 唯独 400（宿主明确拒收，如金额不合法）放弃该笔并响亮记日志，否则会无限重试卡死队列。
async function rqFlush() {
  if (rq.flushing || !(rq.pending > 0)) return
  rq.flushing = true
  const amt = rq.pending
  try {
    const r = await rqFetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: QUOTA_USER, add: amt }) })
    if (r.ok) rq.pending = Math.max(0, rq.pending - amt)
    else if (r.status === 400) { rq.pending = Math.max(0, rq.pending - amt); console.warn(`[quota] 宿主拒收上报 $${amt.toFixed(4)}（HTTP 400），该笔放弃：${await r.text().catch(() => "")}`) }
  } catch { /* 宿主暂不可达：pending 留待定时器重试 */ } finally { rq.flushing = false }
}
// 向宿主要权威读数：启动播种 + 周期校准（宿主端管理员手工调账也会被吸收进来）。
// 叠加 pending 是因为宿主读数不含尚未上报的部分；flush 在途的短暂窗口可能小幅高估，方向安全（宁多算不少算）。
async function rqSync() {
  try {
    const r = await rqFetch(`/today?user=${encodeURIComponent(QUOTA_USER)}`)
    if (!r.ok) return
    const j = await r.json()
    rqRoll()
    rq.cost = (j && j.day === todayKey() ? Number(j.cost) || 0 : 0) + rq.pending
    rq.seeded = true
    saveQuota({ day: rq.day, cost: rq.cost })   // 镜像到本地缓存：下次启动若宿主不可达，作回退读数
  } catch { /* 播种定时器会再试；期间 quotaUsed 用本地缓存回退 */ }
}
if (REMOTE_QUOTA) {
  rqSync()
  setInterval(() => { if (!rq.seeded) rqSync() }, 15_000).unref()          // 没播种成功就一直试
  setInterval(() => { rqSync() }, 5 * 60_000).unref()                      // 周期校准
  setInterval(() => { if (rq.pending > 0) rqFlush() }, 10_000).unref()     // 上报兜底重试
}
const addCost = (delta) => {
  if (!(delta > 0)) return
  if (!REMOTE_QUOTA) { const q = loadQuota(); q.cost += delta; saveQuota(q); return }
  rqRoll(); rq.cost += delta; rq.pending += delta
  saveQuota({ day: rq.day, cost: rq.cost })   // 本地镜像仅作回退缓存，权威在宿主
  rqFlush()
}
const quotaUsed = () => {
  if (!REMOTE_QUOTA) return loadQuota().cost
  rqRoll()
  // 播种前用本地镜像回退，取较大者：镜像里可能有上次进程已入账、宿主也已收到的花费——宁多算不少算
  return rq.seeded ? rq.cost : Math.max(rq.cost, loadQuota().cost)
}
// 正在跑的各轮实时成本（sid -> 本轮已花）。轮内成本要到收尾才 addCost 进持久额度，
// 若判断额度时不算上它们，两轮并发会各自以为额度还够、最坏花到上限的约 2 倍；
// 算上后合计一到顶各轮就中止，超支收敛到「一条消息」的粒度。
const runningCost = new Map()
const runningTotal = () => { let t = 0; for (const v of runningCost.values()) t += v; return t }
const quotaUsedLive = () => quotaUsed() + runningTotal()   // 今日已入账 + 各在跑轮的实时成本
// 面向用户的额度文案一律换算成积分（1 积分 = $0.01）。前端 index.html 明写"用户面前【不出现美元】"，
// 而额度用尽时弹出的这两条恰恰是容器形态用户唯一一次看到真实上限的地方 —— 顶栏写着
// "今日已用 42 / 150 积分"，撞限时却弹 "$0.42 / $1.50"，当面打架。取整方向与前端一致（少显示不多显示）。
const CREDIT_USD_SRV = 0.01
const creditsText = (usd) => {
  const c = (Number(usd) || 0) / CREDIT_USD_SRV
  return c > 0 && c < 0.1 ? "<0.1" : String(Math.round(c * 10) / 10)
}
const quotaOver = () => DAILY_COST_LIMIT > 0 && quotaUsedLive() >= DAILY_COST_LIMIT

// ---- 轮内实时成本估算（供中途封顶 + abort 结算兜底）----
// 实测（2026-07-20，抓 /global/event 原始流 + one-api 账）：opencode 一条 assistant 消息 = 一个
// LLM step，只在 step 完成时才记 cost/tokens；流式过程中恒 0，被 abort 的消息【永远】是 0——
// 而上游连 abort 后都会把该请求跑完并全额扣费（实测 abort 后 51.6s、2063 completion tokens 照记）。
// 故：完成的消息用真实 cost（session.cost 增量天然包含，含被 abort 轮里已完成的步），
// cost=0 的消息按「流出内容估算的输出 + 上一步实测的输入侧成本」补账。估算取向：宁可高估。
// token 估算按字符类别（DeepSeek 系：中文 ≈0.6 token/字、英文 ≈0.3 token/字符，这里各上浮些）。
const EST_IN_TOKENS = Number(process.env.OC_EST_INPUT_TOKENS || 15000)   // 新会话首步的输入侧估计；实测本部署系统上下文首步 input+cache ≈ 14.9k tokens
const estDeltaTokens = (s) => {
  let t = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    t += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) ? 0.7 : 0.35
  }
  return t
}
// sid -> 该会话最近一个完成 step 的真实输入侧成本（USD）。同会话下一步的输入 ≈ 上一步 + 少量增量，
// 拿它当"被 abort 的那一步"的输入侧估计，比只算流出文本准一个数量级（实测输入占一步成本的 ~95%）。
const sessInCost = new Map()
const estInCost = (sid) => sessInCost.get(sid) ?? (EST_IN_TOKENS * _modelCost().input) / 1e6

// ---- /api/model/test 的 SSRF 护栏 ----
// 这个接口让【已登录用户】指定任意 URL、由容器去请求，等于一个内网探测原语（容器网络里能打到
// one-api 网关、宿主服务、兄弟容器）。默认只放行公网地址；确有自建局域网/本机模型网关的部署，
// 可设 ALLOW_PRIVATE_MODEL_URL=1 放开（那时请自行确保容器网络里没有不该被探测的东西）。
const ALLOW_PRIVATE_MODEL_URL = process.env.ALLOW_PRIVATE_MODEL_URL === "1"
const isPrivateHost = (host) => {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true
  if (h === "0.0.0.0" || h === "metadata.google.internal") return true
  // 任何以 :: 开头的 IPv6 一律拒：涵盖 ::1(回环)、::(未指定)、::ffff:x(IPv4-mapped，会真连到内嵌的 v4 地址)、
  // ::<v4>(IPv4-compatible)。注意 new URL 会把 [::ffff:127.0.0.1] 归一成十六进制的 ::ffff:7f00:1，
  // 只比对点分写法必然漏（实测确认过）。正经公网模型端点不会写成这种形式，整类拒掉最稳。
  if (h.startsWith("::")) return true
  const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m4) {
    const a = Number(m4[1]), b = Number(m4[2])
    if (a === 127 || a === 10 || a === 0) return true                 // 回环 / 私网A / 本网
    if (a === 192 && b === 168) return true                            // 私网C
    if (a === 172 && b >= 16 && b <= 31) return true                   // 私网B（docker 网桥常在此段）
    if (a === 169 && b === 254) return true                            // link-local（含 AWS/GCP 元数据 169.254.169.254）
    if (a === 100 && b >= 64 && b <= 127) return true                  // CGNAT（阿里云元数据 100.100.100.200 在此段）
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true    // IPv6 ULA / link-local
  return false
}

// ---- 每用户存储上限（uploads + outputs 之和）----
// STORAGE_LIMIT_MB=0 或空 = 不限。达上限拦截新上传；前端到 90% 提示。删除会话会清掉其目录（见 /api/session/delete）。
const STORAGE_LIMIT_MB = parseLimit(process.env.STORAGE_LIMIT_MB)
// 统一的文件下发：createReadStream 的 'error' 【必须】挂监听器。进程里没有 uncaughtException 兜底
// （刻意不加：那会把真正的 bug 掩盖成"还能跑"），一个没人接的 'error' 就是整容器退出、opencode 一起没。
// 触发它不需要攻击，日常就够：TOCTOU（existsSync 通过后文件被 prunePreviewCache / 删会话并发删掉 → ENOENT）、
// 磁盘 IO 错误、以及曾经的 EISDIR。响应头此时多半已发出，只能断流，但至少不该拖垮整个容器。
// 自定义模型 baseURL 的 SSRF 校验。返回 null=放行，否则返回要下发的 JSON 错误串。
// 【必须两个入口都用】：此前护栏只装在 /api/model/test 上，而真正生效的是 POST /api/model ——
// 用户完全可以跳过"测试"直接保存，baseURL 未经任何校验就写进 opencode 配置并重启，
// 此后每轮对话都去打那个地址，上游报错还会经 promptErr 回显进聊天框（截 200 字），
// 等于一个比 test 更好用的内网探测通道，而 test 那边刚特意把响应体和 errno 都隐掉了。
const modelUrlReject = (baseURL) => {
  try {
    const pu = new URL(baseURL)
    if (!/^https?:$/.test(pu.protocol)) return JSON.stringify({ ok: false, err: "只支持 http/https 地址" })
    if (!ALLOW_PRIVATE_MODEL_URL && isPrivateHost(pu.hostname))
      return JSON.stringify({ ok: false, err: "出于安全考虑，不允许指向内网 / 本机 / 云元数据地址；请填公网可访问的 API 地址" })
    return null
  } catch { return JSON.stringify({ ok: false, err: "API URL 格式不正确" }) }
}
const pipeFile = (f, res) => {
  const rs = fs.createReadStream(f)
  rs.on("error", (e) => {
    console.warn(`[download] 读取失败 ${f}: ${e?.code || e?.message || e}`)
    if (!res.headersSent) { try { return send(res, 404, TEXT_UTF8, "not found") } catch {} }
    try { res.destroy() } catch {}
  })
  return rs.pipe(res)
}
const dirSize = (dir) => {
  let total = 0
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      // .preview 是服务端自己生成的预览缓存（docx→html、pptx→pdf），用户在界面上既看不见也删不掉，
      // 却按目录递归被算进配额 —— 等于拿用户看不见的缓存去挤他的额度。它是派生数据，不计入。
      if (e.isDirectory()) { if (e.name !== ".preview") walk(p) }
      // 只跳过【网关自己生成】的临时名（"." + 12位hex + ".part"，见 /api/upload 的 tmp）。
      // 原来是无条件跳过一切 .part —— 而落盘名完全由 ?name= 决定，用户传 ?name=x.part 就能让文件
      // 正常落盘、正常出现在列表里，却在存储计量里恒为 0 → STORAGE_LIMIT_MB 形同虚设，卷可被写满。
      else if (!/^\.[0-9a-f]{12}\.part$/.test(e.name)) { try { total += fs.statSync(p).size } catch {} }   // 在传中的临时文件另由 inflightUploadBytes 计
    }   // .part 是上传中的临时文件，用 inflightUploadBytes 单独计，别在此重复计
  }
  walk(dir); return total
}
const storageUsed = () => dirSize(UPLOADS) + dirSize(OUTPUTS)      // 字节（不含在写的 .part）
const storageLimitBytes = () => STORAGE_LIMIT_MB * 1024 * 1024
// 所有正在写、尚未改名就位的上传字节合计。并发上传各自只盯自己的 size 会互相看不见 →
// 剩 150MB 时两个 100MB 同传都以为够、双双落盘超限。用这个全局量让并发上传彼此可见（与 runningCost 同构）。
let inflightUploadBytes = 0
// 不需登录即可访问的路径。/api/health 必须在这里：它的用途就是给 manager / compose healthcheck /
// monitor 这些【没有登录票据】的探针用；放在门禁后面只会拿到 302 到登录页，等于这个端点白做。
// 它只回两个布尔（网关活着 / opencode 就绪），不含任何敏感信息。
const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/health"])
const isLocal = (req) => {
  const a = req.socket.remoteAddress || ""
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1" || a.startsWith("127.")
}
const cookieOf = (req, key) => {
  const raw = req.headers.cookie || ""
  for (const kv of raw.split(";")) { const [k, ...v] = kv.trim().split("="); if (k === key) return decodeURIComponent(v.join("=")) }
  return null
}
// ---- 无状态签名登录 cookie（不再靠内存 tokens Set）----
// 容器按需停机/冷启动会清空内存，随机 token 一停就失效、无法"5 天免登录"。改用 HMAC 签名：
// cookie = <过期时间ms>.<HMAC(LAN_PASSWORD, "lan|过期时间")>，容器只验签+验没过期，无需存储，重启后老 cookie 仍有效。
// 用 LAN_PASSWORD 作签名密钥：每容器稳定、且改密码即让旧会话失效（合理）。
const AUTH_TTL_MS = 5 * 24 * 60 * 60 * 1000                    // 5 天免登录
// 自助改密码：新密码存 ocdata 卷的 override 文件（随容器持久、随备份走）；用 base=旧env密码的hash 绑定——
// 管理员在 env 改密并重建容器后 base 不再匹配，override 自动失效、以新 env 密码为准（管理员始终能覆盖）。
const PW_OVERRIDE = path.join(os.homedir(), ".local", "share", "opencode", "auth-override.json")
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex")
const effectivePassword = () => {
  try { const o = JSON.parse(fs.readFileSync(PW_OVERRIDE, "utf8")); if (o && o.base === sha(LAN_PASSWORD) && typeof o.password === "string" && o.password) return o.password } catch {}
  return LAN_PASSWORD
}
const b64u = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
// 签名密钥用「当前有效密码」：改密码后旧 cookie 立即失效（合理）
const signAuth = (exp) => b64u(crypto.createHmac("sha256", "lan-auth|" + effectivePassword()).update("lan|" + exp).digest())
const makeAuthCookie = () => { const exp = Date.now() + AUTH_TTL_MS; return exp + "." + signAuth(exp) }
const validAuth = (val) => {
  if (!val) return false
  const i = val.indexOf("."); if (i < 0) return false
  const exp = Number(val.slice(0, i)), sig = val.slice(i + 1)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const good = signAuth(exp)
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))
}
const authed = (req) => !AUTH_ENABLED || isLocal(req) || validAuth(cookieOf(req, "lan_auth"))
// ---- 登录 cookie 的组装：Secure 只在【真的走 https】时才贴 ----
// 【为什么不能无条件贴 Secure】浏览器会**静默丢弃** http 上带 Secure 的 cookie：
// /api/login 明明返回 200（密码是对的），cookie 却一个都没存下，下一个请求没凭据 → 门禁把人
// 打回 /login，界面上不报任何错。表现就是"点了登录又回到登录框"，无限循环。
// 局域网/开发部署（同事用 http://192.168.x.x:3000 访问）正好撞这个，实测复现。
// 生产在 Caddy 后面是 https（转发时带 X-Forwarded-Proto: https）→ 照旧贴 Secure，强度不变。
// 注：这个头由前置代理写，攻击者伪造只影响他自己那次请求的 cookie 属性，构不成对他人的降级。
const isHttps = (req) =>
  req.socket?.encrypted === true ||
  String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https"
const setAuthCookie = (req) =>
  `lan_auth=${makeAuthCookie()}; Path=${BASE_PATH}/; HttpOnly; ${isHttps(req) ? "Secure; " : ""}SameSite=Lax; Max-Age=${AUTH_TTL_MS / 1000}`
// 清 cookie 时属性要和下发时一致，否则浏览器认为是另一个 cookie、删不掉（登出等于没登出）
const clearAuthCookie = (req) =>
  `lan_auth=; Path=${BASE_PATH}/; HttpOnly; ${isHttps(req) ? "Secure; " : ""}SameSite=Lax; Max-Age=0`

// ---- 后台生成任务：一轮生成 = 一个挂在 sid 上的 job，SSE 连接只是"订阅者" ----
// 切会话/关页面 → 只是退订，生成继续跑；回来用 /api/chat/attach 先重放快照再续直播。
// 真正终止走 POST /api/chat/abort（前端"终止"按钮）。job 完成即从表里删除，历史由 opencode 持久化。
// ---- 文档预览转换：docx→HTML（.venv 的 mammoth）、pptx/ppt/odp/doc/odt→PDF（LibreOffice）----
// 解释器优先级：SCI_PYTHON 显式覆盖 > 项目根 .venv（镜像里由 Dockerfile 创建，也是各技能的统一约定）
//                > PATH 上的 python3（依赖包在系统 python 里也是齐的）。
// 【惰性探测 + 缓存】而非模块加载时一次性求值：.venv 可能是网关起来【之后】才建好的（env-setup 场景），
// 若在加载时就定死，进程整个生命周期都会用系统 python3、再也切不回去。与下面的 soffice() 同构。
let _pyexe
const PYEXE = () => {
  if (_pyexe !== undefined) return _pyexe
  if (process.env.SCI_PYTHON) { _pyexe = process.env.SCI_PYTHON; return _pyexe }
  const inVenv = process.platform === "win32" ? path.join(ROOT, ".venv/Scripts/python.exe") : path.join(ROOT, ".venv/bin/python")
  try { _pyexe = fs.existsSync(inVenv) ? inVenv : null } catch { _pyexe = null }
  if (!_pyexe) _pyexe = process.platform === "win32" ? "python" : "python3"
  return _pyexe
}
// mammoth 直出的是一段【裸 HTML 片段】：没有 <html>/<head>，一行样式也没有。
// 工作台的通用预览是 innerHTML 注入的，还能吃到 .pv-body img{max-width:100%}；而 reader 壳
// （文稿核查与审校 / 文献研读）左栏是 <iframe src=api/preview>，父页 CSS 一点也进不去 ——
// 于是两个只在 reader 里暴露的毛病：
//   ① mammoth 丢掉 docx 的显示尺寸（wp:extent），图片按【原始像素】渲染：Word 里 8cm 宽、
//      源图 1600px 的插图，在 400 多像素宽的左栏里铺 1600px，撑爆版面、只看得见左上角一块；
//   ② Word 里粘贴的 Excel 图表 / 公式 / Visio 在 docx 里存的是 EMF/WMF，mammoth 照样
//      base64 塞进 <img src="data:image/x-emf;...">，浏览器一律裂图。mammoth 自己会发
//      "unlikely to display in web browsers" 的告警，但旧代码只取 .value，把 .messages
//      整个丢了，服务端日志里连条线索都没有。
// 所以这里：套完整 HTML 文档 + 内联样式（CSP 里 style-src 'unsafe-inline' 是放行的，
// 但 <link> 不行，故只能内联）；非 web 格式的图换成看得懂的占位说明；告警写 stderr 供网关记日志。
const MAMMOTH_PY = `
import sys, base64, mammoth, mammoth.html as H

# 浏览器真能渲染的格式；其余（EMF/WMF/TIFF…）一律换占位说明，别摆个裂图让人以为文件坏了
WEB_OK = ("image/png", "image/gif", "image/jpeg", "image/jpg", "image/bmp", "image/webp", "image/svg+xml")

HEAD = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>文档预览</title><style>
:root{color-scheme:light}
body{margin:0;padding:24px 28px;background:#fff;color:#1f2328;overflow-wrap:break-word;
     font:15px/1.85 -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif}
img{max-width:100%;height:auto;display:block;margin:12px auto}
p{margin:0 0 10px}
h1,h2,h3,h4,h5,h6{margin:1.4em 0 .6em;line-height:1.4}
h1{font-size:1.6em}h2{font-size:1.35em}h3{font-size:1.15em}
table{border-collapse:collapse;max-width:100%;margin:12px 0}
td,th{border:1px solid #d6dae0;padding:5px 9px;vertical-align:top}
pre{white-space:pre-wrap;background:#f6f7f9;padding:10px;border-radius:6px}
blockquote{margin:10px 0;padding:2px 14px;border-left:3px solid #d6dae0;color:#57606a}
.noimg{display:block;margin:12px 0;padding:10px 14px;border:1px dashed #c9ced6;border-radius:8px;
       background:#f6f7f9;color:#57606a;font-size:.92em}
</style></head><body>"""
TAIL = "</body></html>"

def convert_image(image):
    ct = (image.content_type or "").lower()
    if ct in WEB_OK:
        with image.open() as fh:
            src = "data:" + ct + ";base64," + base64.b64encode(fh.read()).decode("ascii")
        attrs = {"src": src}
        if image.alt_text:
            attrs["alt"] = image.alt_text
        return [H.element("img", attrs)]
    kind = (ct.split("/")[-1] or "unknown").replace("x-", "").upper()
    note = "［这里有一张 " + kind + " 格式的图片，网页预览显示不了；点右上角「原文」下载原件即可正常查看］"
    if image.alt_text:
        note = note + "  " + image.alt_text
    # 用 span 而不是 div：图片在 docx 里是段落的行内内容，占位块会落在 <p> 里 ——
    # <p><div> 是非法嵌套，浏览器会当场把 <p> 截断，把一段话劈成两半。
    return [H.element("span", {"class": "noimg"}, [H.text(note)])]

src, out = sys.argv[1], sys.argv[2]
with open(src, "rb") as fh:
    r = mammoth.convert_to_html(fh, convert_image=convert_image)
with open(out, "w", encoding="utf-8") as fh:
    fh.write(HEAD); fh.write(r.value); fh.write(TAIL)
# 告警只进服务端日志、不打扰用户（Result.messages 已去重，同一种问题不会刷屏）
for m in r.messages:
    sys.stderr.write(str(getattr(m, "type", "warning")) + ": " + str(getattr(m, "message", m)) + "\\n")
`
let _soffice   // 惰性探测并缓存（LibreOffice 可能在网关启动后才装好）
const soffice = () => {
  if (_soffice !== undefined) return _soffice
  const cands = process.env.SOFFICE ? [process.env.SOFFICE] : (process.platform === "win32"
    ? ["C:/Program Files/LibreOffice/program/soffice.com", "C:/Program Files/LibreOffice/program/soffice.exe", "C:/Program Files (x86)/LibreOffice/program/soffice.com"]
    : ["/usr/bin/soffice", "/usr/bin/libreoffice", "/opt/libreoffice/program/soffice"])
  _soffice = cands.find((c) => { try { return fs.existsSync(c) } catch { return false } }) || null
  if (!_soffice) { try { _soffice = execSync(process.platform === "win32" ? "where soffice" : "command -v soffice", { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString().trim().split(/\r?\n/)[0] || null } catch { _soffice = null } }
  return _soffice
}
const execFileAsync = promisify(execFile)

// ---- Zotero 本地库（单机 / 桌面部署：网关与用户 Zotero 同机，脚本打 127.0.0.1:23119）----
// 中心多用户服务器上探测必然失败（服务器摸不到每个用户机器上的 Zotero），接口照样可达，
// 只是回 {ok:false,...} 的结构化错误，前端显示"未运行"，不影响其它功能。
const ZOT_READ = path.join(ROOT, ".opencode/skills/zotero-library/references/zotero_read.py")
// 跑一个 Python 脚本，返回 {code, stdout, stderr}；非零退出【不抛】——脚本用退出码 + JSON 表达失败。
// PYEXE 是惰性函数（.venv 可能是网关起来之后才建的），故在调用点求值而非模块加载时。
const runPy = async (args, timeout = 180_000) => {
  try {
    const { stdout, stderr } = await execFileAsync(PYEXE(), ["-X", "utf8", ...args], { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    return { code: 0, stdout: stdout || "", stderr: stderr || "" }
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || String(e) }
  }
}
// 脚本没吐 stdout（没装 python / 脚本被删 / 超时被杀）也要回一个合法 JSON，别让前端 r.json() 炸掉
const zotJson = (r) => (r.stdout || "").trim() || JSON.stringify({ ok: false, error: "no_output", detail: (r.stderr || "").slice(0, 300) })

// ---- 数据表速览：前 N 行 + 逐列画像（表头下拉、变量自动对应都吃它）----
//
// 【为什么值得起一个 Python 进程】此前 /api/data/headers 只用 JS 读 csv，xlsx 一律回
// "读不了，请手动填列名"——而医院里导出的表【绝大多数是 xlsx】。于是本套件最要紧的那个控件
// （六个列名下拉）对多数用户直接降级成六个空输入框，让他手打列名，比不做还糟。
// 更要紧的是：只有表头认不出「哪一列是分组、哪一列是终点事件」，那需要看见【取值】。
// 一次进程（~1–2s，且按文件缓存）换来"机器先认列、用户只核对"，这笔账很划算。
//
// 缓存键带 mtime+size：用户传了同名新表（很常见——改完再传一次）必须重读，否则他会对着
// 上一版的列名做对应，而界面上一个字都不会提示。
const TABLE_PREVIEW_PY = path.join(ROOT, ".opencode/skills/data-analysis/scripts/table_preview.py")
const _tpCache = new Map()
const TP_CACHE_MAX = 64
async function tablePreview(file, { rows = 5 } = {}) {
  let key = file
  try { const st = fs.statSync(file); key = `${file}|${st.mtimeMs}|${st.size}|${rows}` } catch {}
  if (_tpCache.has(key)) return _tpCache.get(key)
  const r = await _tablePreviewRaw(file, rows)
  if (_tpCache.size >= TP_CACHE_MAX) _tpCache.delete(_tpCache.keys().next().value)
  _tpCache.set(key, r)
  return r
}
async function _tablePreviewRaw(file, rows) {
  const ext = path.extname(file).toLowerCase()
  // ① 首选 Python（pandas）：只有它能读 xlsx，也只有它给得出列画像
  if (fs.existsSync(TABLE_PREVIEW_PY)) {
    const r = await runPy([TABLE_PREVIEW_PY, "--input", file, "--rows", String(rows)], 45_000)
    let j = null
    try { j = JSON.parse((r.stdout || "").trim()) } catch {}
    if (j && j.ok) return { ...j, via: "python" }
    // 脚本明确说"这张表读不出来"（编码坏、0 列）时，它的话比 JS 那条降级路径更准，直接如实回
    if (j && j.error && [".xlsx", ".xlsm", ".xls", ".xlsb", ".ods"].includes(ext))
      return { ok: false, headers: null, reason: j.error, via: "python" }
    // 其余情况（没装 pandas / 没建 .venv / 超时）落到 ② —— csv 仍然能靠纯 JS 读出表头
  }
  // ② 纯 JS 兜底：只认文本表，只给表头（没有取值就没有列画像，automap 会自动降级成"只按列名认"）
  if (![".csv", ".tsv", ".txt"].includes(ext))
    return { ok: false, headers: null, via: "js",
      reason: `${ext || "该格式"} 需要 pandas 才能读（本机还没建 .venv 或缺 pandas），这里先手动填列名即可` }
  try {
    const fd = fs.openSync(file, "r")
    const buf = Buffer.alloc(64 * 1024)                   // 只读头部：表可能很大，不整读进内存
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const h = WF.parseHeaders(buf.slice(0, n), ext, { partial: n === buf.length })
    if (!h.headers) return { ok: false, headers: null, reason: h.reason, via: "js" }
    // raw/dupes 一并带上：headers 是消歧后的【显示名】，界面存进 values 的必须是真列名，
    // 丢了它前端就只能退回"第 N 列"。python 那条路（table_preview.py）同样回这两项。
    return { ok: true, headers: h.headers, raw: h.raw, dupes: h.dupes, rows: [], cols: [], sheets: [], note: "", via: "js" }
  } catch (e) {
    return { ok: false, headers: null, via: "js", reason: `读表头失败：${String(e.message || e).slice(0, 120)}` }
  }
}

// UserInstallation profile 用【固定持久目录】，不再每次新建又删掉。
// 为什么改：空 profile 会让 LibreOffice 走一遍"首次运行"初始化，实测冷启一次 153 秒——比原先
// 写死的 90 秒超时还长。而"每次新建 profile"等于每次都是冷启，于是 pptx 预览稳定超时
// （实测 3 次里 2 次 500）。复用同一个 profile 后只有第一次慢，之后是热启（秒级）。
// 容器同样受益：容器里每次预览也都是冷启。
// 并发安全：本进程所有 soffice 调用都经下面的 withSoffice 串行闸，同一时刻只有一个 LibreOffice
// 在用这个 profile，不存在 profile 锁争用（这也是敢复用的前提）。
// 位置放 homedir/.local/share/opencode/ 下，与 quota.json / module-map.json 等状态文件同族
// （容器里该目录是每用户独占的持久卷，桌面版是当前用户的家目录）。
const LO_PROFILE = path.join(os.homedir(), ".local", "share", "opencode", "lo-profile")
// outDir 仍用【每次唯一】的临时子目录，而不是共享的 cacheDir：
// soffice 的输出名由【源文件基名】决定（a.pptx → a.pdf），直接写进 cacheDir 的话，
// "report.pptx" 与 "audit/report.pptx" 会争同一个 .preview/report.pdf。
// 而串行闸只包住 execFileAsync，改名发生在闸【释放之后】，且 /api/preview 是直接调用、
// 不进 _warmQueue —— 于是存在这样的交错：A 转完退出→闸放行→B 启动并开始写同一个中间文件
// →A 才执行改名，把 B 写了一半的 PDF 认领成自己的缓存（用户看到损坏文件），
// 随后 B 找不到自己的产物 → 报 "no pdf produced"。
// 把中间产物隔离到唯一目录后，这条竞态从根上消失，与闸的释放时机无关。
// 放在 cacheDir 之下（而非 os.tmpdir()）是为了保证与 out 同一文件系统，rename 才是原子的、
// 也不会踩 EXDEV。prunePreviewCache 只统计 isFile()，这个临时目录不会被它当成缓存。
const sofficeJob = (src, cacheDir) => {
  fs.mkdirSync(LO_PROFILE, { recursive: true })
  // 上一次若是超时被 SIGKILL 掉的，profile 里会留下 .lock，LibreOffice 下次启动会把它当成
  // "另一个实例正在跑"。串行闸保证此刻没有别的 soffice 在用它 → 看到的锁一定是残留，删掉。
  try { fs.rmSync(path.join(LO_PROFILE, ".lock"), { force: true }) } catch {}
  const outDir = path.join(cacheDir, ".conv-" + crypto.randomBytes(6).toString("hex"))
  fs.mkdirSync(outDir, { recursive: true })
  return { outDir, args: ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, src, "-env:UserInstallation=file:///" + LO_PROFILE.replace(/\\/g, "/")] }
}
// ★ 全局串行闸：同一时刻只允许【一个】LibreOffice 在跑。
// 单个 soffice headless 转 pptx 峰值 300–600MB，而容器 mem_limit 只有 1400–1750m；
// 一旦并发起两个就可能触发 OOM-kill —— 被杀的是【整个容器】（opencode + 网关一起没），
// 而不只是这次预览失败。而后台预热虽有 _warmQueue 串行，/api/preview 却是直接调用、
// 不进那个队列：用户点预览时预热正好在跑、或两个标签页同时点，就凑齐了两个进程。
// 故把闸做在最底层，无论谁调用都得排队。
let _sofficeGate = Promise.resolve()
const withSoffice = (fn) => {
  const run = _sofficeGate.then(fn, fn)   // 前一个无论成败都放行下一个
  _sofficeGate = run.then(() => {}, () => {})
  return run
}

// .preview 已不计入用户配额（它是派生缓存，用户看不见也删不掉），那就必须自己有上限，
// 否则「配额没满、卷先写爆」：活跃会话里每个新文件名都会生成一份缓存 PDF（数 MB），只在删会话时才整目录清。
// 每次写完缓存后按 mtime 做一次 LRU 裁剪，超出上限就从最旧的开始删。
const PREVIEW_CACHE_MAX = Number(process.env.PREVIEW_CACHE_MAX_MB || 200) * 1024 * 1024
// keep：本次刚生成、马上就要读的那个文件，必须排除在裁剪之外。
// 否则当单个产物本身就大于 PREVIEW_CACHE_MAX（一个大 pptx 转出的 PDF 达到这个量级并不罕见）时，
// 循环会一路删到把刚写好的 out 也删掉，而 ensurePreviewCache 照常 return { out } →
// 紧接着的 createReadStream 拿到 ENOENT。用户点预览，看到的是"刚生成就消失"的诡异失败。
function prunePreviewCache(cacheDir, keep) {
  try {
    const keepReal = keep ? path.resolve(keep) : null
    const items = fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => { const p = path.join(cacheDir, e.name); const st = fs.statSync(p); return { p, size: st.size, mtime: st.mtimeMs } })
      .filter((x) => !keepReal || path.resolve(x.p) !== keepReal)
    let total = items.reduce((s, x) => s + x.size, 0)
    if (total <= PREVIEW_CACHE_MAX) return
    for (const it of items.sort((a, b) => a.mtime - b.mtime)) {   // 最旧的先删
      if (total <= PREVIEW_CACHE_MAX) break
      try { fs.unlinkSync(it.p); total -= it.size } catch {}
    }
  } catch { /* 裁剪失败不影响预览本身 */ }
}

// 生成/复用文档预览缓存到 <dir>/.preview/；docx→HTML、pptx/ppt/odp/doc/odt→PDF。
// 异步（不阻塞网关主线程），按源文件 mtime 缓存。命中缓存直接返回，未命中才转换。
// 返回 { out, ctype } 供内联响应；不支持的类型返回 null；转换失败 throw 带 .code 的错误。
// /api/preview（点开即看）与产物落地后的后台预热共用本函数，确保两边缓存路径/新鲜度判定完全一致。
async function ensurePreviewCache(dir, name) {
  // 与下载/内联同一条防线：name 现在可含子目录（pdfs/a.docx），必须做包含性校验而非拼接了事。
  const src = safeUnder(dir, name)
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) { const e = new Error("not found"); e.code = "no-src"; throw e }
  const ext = path.extname(name).toLowerCase()
  const cacheDir = path.join(dir, ".preview"); fs.mkdirSync(cacheDir, { recursive: true })
  // 缓存文件名不能直接拼 name："pdfs/a.docx" 会变成 .preview/pdfs/a.docx.html，
  // 而上面只 mkdir 了 .preview 本身 → 写入必然 ENOENT。
  // 也不能简单把分隔符替换成 "__"：那是【不可逆映射】—— 顶层文件 "pdfs__a.docx" 与子目录文件
  // "pdfs/a.docx" 会压成同一个缓存名，而 fresh() 只比 mtime，于是先转好的那个会被判成后一个的
  // "新鲜缓存" → 预览 B 时看到的是 A 的内容，且没有任何提示。改为带路径哈希，保证一一对应。
  // 哈希取【规范化后的相对路径】而非原始 name：否则 "pdfs/a.docx"、"./pdfs/a.docx"、"pdfs//a.docx"
  // 指向同一个文件却生成三份内容相同的缓存，白转三次、占三份空间。
  const relKey = path.relative(path.resolve(dir), src).split(path.sep).join("/")
  const flat = crypto.createHash("sha1").update(relKey).digest("hex").slice(0, 12) + "__" + path.basename(src)
  const srcMtime = fs.statSync(src).mtimeMs
  const fresh = (out) => fs.existsSync(out) && fs.statSync(out).mtimeMs >= srcMtime

  if (ext === ".docx") {
    const out = path.join(cacheDir, flat + ".html")
    if (!fresh(out)) {
      // maxBuffer 显式给足：脚本现在会把 mammoth 的告警写 stderr，样式复杂的稿件能攒出不少行，
      //   而 execFile 默认 1MB 上限一旦撑爆是【直接杀进程】→ 整个预览失败在一条日志上，太亏。
      try {
        const { stderr } = await execFileAsync(PYEXE(), ["-X", "utf8", "-c", MAMMOTH_PY, src, out], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
        // 告警不外泄给用户（界面上只会是噪音），但服务端必须留痕：EMF 图为什么变成占位块、
        // 哪些样式没映射上，出问题时全靠这条日志定位。
        if (stderr && stderr.trim()) console.warn(`[preview] docx 转换告警（${src}）：\n${stderr.trim().slice(0, 2000)}`)
      }
      catch (err) {
        // 别把 String(err) 直接当文案：execFile 的 message 是 "Command failed: <完整命令行>"，
        // 而命令行里塞的是整段 MAMMOTH_PY —— 200 字截断后剩下的全是脚本头几行，
        // 真正的原因（ModuleNotFoundError: No module named 'mammoth' 之类）在 stderr 尾部，一个字都看不到。
        // 与上面 LibreOffice 分支同一口径：完整命令行 + stderr 只进服务端日志，给前端的是最后几行人话。
        console.error(`[preview] docx 转换失败（${src}）：${err?.message || err}${err?.stderr ? "\n[preview] stderr: " + String(err.stderr).slice(0, 2000) : ""}`)
        const tail = String(err?.stderr || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join("；")
        const e = new Error(tail ? tail.slice(0, 300) : "转换进程异常退出，详见服务端日志")
        // 缺依赖是【运维可修】的一类，单独给一句可行动的提示，别让用户对着 traceback 猜。
        if (/No module named ['"]?mammoth/.test(String(err?.stderr || ""))) e.hint = "服务端 .venv 缺 mammoth 包（pip install mammoth），装好即可预览。"
        e.code = "docx-fail"
        throw e
      }
    }
    prunePreviewCache(cacheDir, out)
    return { out, ctype: "text/html; charset=utf-8" }
  }
  if ([".pptx", ".ppt", ".odp", ".doc", ".odt"].includes(ext)) {
    const out = path.join(cacheDir, flat.replace(/\.[^.]+$/, "") + ".pdf")
    if (!fresh(out)) {
      if (!soffice()) { const e = new Error("no LibreOffice"); e.code = "no-soffice"; throw e }
      const job = sofficeJob(src, cacheDir)
      // killSignal: SIGKILL —— 默认超时发的是 SIGTERM，而 soffice headless 在解析大 pptx 时
      // 未必立刻响应。串行闸是在 promise settle 那一刻放行下一个的：若第一个只是"超时被 SIGTERM
      // 但还没死"，第二个就会启动，两个 300–600MB 的进程同时存在于 1400m 的容器里 ——
      // 正是这道闸要防的整容器 OOM-kill。SIGKILL 保证 settle 时进程真的没了。
      // 240s：profile 固定后一般是热启（秒级），但【第一次】仍要走一遍 LibreOffice 首次运行初始化，
      // 实测冷启 153 秒——原来的 90 秒必然把首跑掐死，而首跑正是用户装好后点的第一次预览。
      try { await withSoffice(() => execFileAsync(soffice(), job.args, { timeout: 240_000, killSignal: "SIGKILL", windowsHide: true })) }   // 排队，绝不并发起两个 LO
      catch (err) {
        // 完整命令行与 stderr 只进服务端日志：原先直接把 String(err) 当错误文案回给前端，界面上就是
        // "预览失败：转换失败：Error: Command failed: C:/Program Files/LibreOffice/program/soffice.com --headless …"
        // ——把内部路径和参数原样泄给用户，用户也看不懂。给前端的换成人话（见 /api/preview 的 office-fail 分支）。
        console.error(`[preview] LibreOffice 转换失败（${src}）：${err?.message || err}${err?.stderr ? "\n[preview] stderr: " + String(err.stderr).slice(0, 2000) : ""}`)
        const e = new Error("LibreOffice 转换失败")
        e.code = "office-fail"
        e.timedOut = err?.killed === true || err?.signal === "SIGKILL"   // 超时被 SIGKILL 与真失败，给用户的话术不同
        throw e
      }
      // soffice 按【源文件基名】决定输出名（a.pptx → a.pdf），而我们的缓存名是带哈希的，
      // 两者必然不同，所以要从这次专属的中间目录里把它搬到 out。
      // 中间目录唯一 → 不同请求各写各的，与串行闸的释放时机无关（见 sofficeJob 的说明）。
      try {
        const produced = path.join(job.outDir, path.basename(src).replace(/\.[^.]+$/, "") + ".pdf")
        if (fs.existsSync(produced)) fs.renameSync(produced, out)
      } finally { try { fs.rmSync(job.outDir, { recursive: true, force: true }) } catch {} }
      if (!fs.existsSync(out)) { const e = new Error("no pdf produced"); e.code = "no-pdf"; throw e }
    }
    prunePreviewCache(cacheDir, out)
    return { out, ctype: "application/pdf" }
  }
  return null   // 该类型不支持文档转换预览（md/pdf/csv/txt/html 等在前端直接渲染，不走这里）
}

// 产物落地后台预热：把本轮新产出的 office/docx 文档提前转好缓存，用户点预览即秒开。
// 串行执行（一次只跑一个 LibreOffice），best-effort，失败静默——点开时 /api/preview 会照常再试并如实报错。
let _warmQueue = Promise.resolve()
const WARM_MAX = 20   // 一轮最多预热多少个：一次产出几百个 doc 时别把 LibreOffice 队列堵死几十分钟
function warmPreviews(dir, names) {
  const CONV = /\.(pptx?|odp|odt|doc|docx)$/i
  let n = 0
  for (const name of (names || [])) {
    if (!CONV.test(name)) continue
    // 不再 basename：changedSince 现在给的是 "audit/report.docx" 这种相对路径，
    // 砍掉目录后会去顶层找 → no-src → 被 .catch 静默吞掉 → 子目录里的文档【永远不预热】
    // （用户点开时才现转，首次要等几十秒）；顶层若有同名文件还会重复预热错的那个。
    if (++n > WARM_MAX) break
    _warmQueue = _warmQueue.then(() => ensurePreviewCache(dir, name).catch(() => {}))
  }
}

// ---- 注入给 agent 的"工作区前言"：写入与剥离必须共用同一个标记 ----
// 【上传目录那句为什么措辞要宽】原来写的是"用户上传的【数据】文件在 …"。实测模型把它读成
// "这条只管 .csv/.xlsx"，于是拿着稿件名（.md/.docx）去【产物目录】里翻，一次要白花 2–3 次
// glob/bash（最慢 32 秒），界面上还多出一张红色的 read 报错卡。改成"上传的文件都在…"并把
// 三类文件都点名，配合任务卡里已经拼成绝对路径的 files 字段（WF.taskCard 的 upDir），两处口径一致。
// 【为什么要共用常量】原来这两处各写各的字面量：注入端是 `【本会话工作区，务必遵守】`，
// 而 /api/history 的剥离正则却还在找旧文案 `【本会话专属目录`（我改注入端时漏改了剥离端）。
// 后果：实时流式输出正常（不走剥离），但用户【重开或切回会话】时，整段内部指令会被当成
// 他自己发的话显示出来，还带着 /app/outputs/ws_xxx 这种容器绝对路径。因为只在"回看"时才犯，
// 一直没被发现。改成从同一个常量派生，杜绝再次漂移。
const PREAMBLE_MARK = "【本会话工作区，务必遵守】"
const PREAMBLE_MARK_LEGACY = "【本会话专属目录"   // 老会话里存的是旧文案，回看时同样要剥掉
const _reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// 结尾用 \n\n+ 贪婪吃掉【连续】空行：前言尾部拼的是
// `…${chat?skillsPreamble():modulePreamble()}${zoteroPreamble()}${autoOn?…:""}\n\n`，
// 而不受限的 chat 会话这几个插值全是空串。只要有人给某条 bullet 末尾多留一个 \n，
// 尾部就变成三个换行，非贪婪的 \n\n 只吃两个，第三个留在用户原话前面 ——
// 表现为 chat 的用户气泡全部多一个前导空行（实测过，且只有 chat 会中招，很难联想到前言）。
const PREAMBLE_RE = new RegExp("^(?:" + _reEsc(PREAMBLE_MARK) + "|" + _reEsc(PREAMBLE_MARK_LEGACY) + ")[\\s\\S]*?\\n\\n+")
// Zotero 面板注入的"检索范围"指示：拼在用户原话【最前面】（见前端 zScopePrefix），
// 与工作区前言是两段独立注入，回看历史时也要一并剥掉，否则用户看见自己"说"了一句没说过的话。
// 顺序：先剥工作区前言，再剥范围指示（注入时前言在前、范围指示紧跟其后、再是原话）。
const ZSCOPE_RE = /^【检索范围：[^\n]*】\n/
// 工作流表单注入的"任务卡"：同样拼在用户原话最前面（见前端 wfCardPrefix），回看历史时剥掉，
// 否则用户看到自己"说"了一大段带【以上为用户通过表单勾选提交…】的话——那是给 agent 的，不是他打的。
// 卡片结构固定：以【任务卡 · 开头，到那段以【以上为用户通过表单…】结尾的说明为止（含其后的空行）。
const WFCARD_RE = /^【任务卡 · [\s\S]*?【以上为用户通过表单[\s\S]*?】\n*/
const stripPreamble = (t) => t.replace(PREAMBLE_RE, "").replace(ZSCOPE_RE, "").replace(WFCARD_RE, "")

// ---- 网络错误的"人话化" ----
// undici 的 fetch 失败一律抛 `TypeError: fetch failed`，真正的原因藏在 `.cause`（可能再套一层）。
// 只报外壳的话，用户和排查的人都只能看到一句"本轮出错：fetch failed" —— 说了等于没说：
// 到底是模型服务没起来、上游超时、被墙、还是连接被重置，四种处置方式完全不同。
/** 把 error.cause 链摊平成一行，供服务端日志（含 code，排查全靠它）*/
const errChain = (e) => {
  const out = []
  for (let x = e, i = 0; x && i < 5; x = x.cause, i++)
    out.push(`${x.name || "Error"}: ${x.message || x}${x.code ? ` (${x.code})` : ""}`)
  return out.join(" ← ")
}
/** 给用户看的一句话：认得出的原因给处置建议，认不出的至少把 cause 带上，别只留个空壳 */
const explainNetErr = (e) => {
  const chain = errChain(e)
  const code = (() => { for (let x = e, i = 0; x && i < 5; x = x.cause, i++) if (x.code) return String(x.code) })() || ""
  if (/HEADERS_TIMEOUT|BODY_TIMEOUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code + chain))
    return "等模型响应超时了。长流程（综述 / 标书 / 论文）单轮本来就慢，多半是上游这一次特别久或网络不稳；直接重发一次通常就好。若反复如此，换个模型或分几步来。"
  if (/ECONNREFUSED/i.test(code + chain))
    return "连不上后台模型服务（opencode）—— 它可能没起来或已退出。等几十秒重试；若一直如此请联系管理员。"
  if (/ECONNRESET|SOCKET|EPIPE/i.test(code + chain))
    return "与模型服务的连接被中途切断。多半是上游或网络抖了一下，重发一次即可；若每次都在同一处断，多半是这一轮太长，试着拆成几步。"
  if (/ENOTFOUND|EAI_AGAIN|CERT|SSL|TLS/i.test(code + chain))
    return "解析或连接模型服务的域名失败（DNS / 证书 / 被阻断）。检查网络与代理设置后重试。"
  return chain.slice(0, 200)   // 认不出也要把 cause 链给出来，绝不再只留一句 "fetch failed"
}

// ---- 最近一次失败（每会话，落盘）----
// broadcast() 只写【当下挂着的 SSE 订阅者】，finish() 一到就 jobs.delete —— 于是 failed/notice
// 一个字节都不落盘。用户关掉页面、或网络断一下，回来时 /api/history 里只有他自己那条消息，
// 没有回复、也没有任何解释，第一反应是"我是不是没点发送"，然后重发，双倍时间与额度。
// 存一份最近失败，/api/history 在"这一轮没留下助手回复"时把它补到末尾。
// 落在会话产物目录（随会话建、随会话删），不进产物列表（下划线前缀已在 dirState 排除同名文件）。
const ERR_FILE = "_lasterror.json"
const noteError = async (sid, message) => {
  try {
    const dir = await sessionOut(sid)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, ERR_FILE), JSON.stringify({ at: Date.now(), message: String(message).slice(0, 500) }))
  } catch (e) { console.warn(`[error] 失败记录写不进去（不影响本轮报错）：${e.message}`) }
}
const lastError = (sid) => {
  try {
    const dir = dirCache.get(safeSid(sid)); if (!dir) return null   // 没解析过目录就别为这个去打 opencode
    const j = JSON.parse(fs.readFileSync(path.join(dir, ERR_FILE), "utf8"))
    return (j && j.message) ? j : null
  } catch { return null }
}
const clearError = async (sid) => {
  try { const dir = await sessionOut(sid); fs.unlinkSync(path.join(dir, ERR_FILE)) } catch { /* 本就没有 */ }
}

const jobs = new Map()   // sid -> 进行中的 job
// ---- 首事件看门狗的超时（ms）----
// 为什么要有：opencode 打不通上游模型时（API 地址填错 / DNS 解析不了 / 地址黑洞丢包 / 上游连上了
// 但永不回应），它的 session.prompt 这个 await 可能【十几分钟都不返回】（实测 11 分钟仍 running），
// 期间网关既不收场也不回显任何错误——前端只剩无限转圈，用户分不清是"模型慢"还是"配置错"，
// 只有手动点「终止」才救得回来。这道闸把那种假死转成一条人话错误。
// 【守的是"模型的第一个输出"，不是"本轮的第一个事件"】——这条是实测校准出来的（抓 /global/event 原始流）：
//   +3.8s session.updated / message.updated(role=user)
//   +6.1s message.updated(role=assistant, cost=0)   ← 消息壳子，此时【请求还没发给上游】
//   +28s  session.status                            ← 这一刻请求才真正发出
//   之后上游若挂着不回应，事件流【一条都不再来】
// 所以拿 assistant 消息的创建当"活着"的证据是错的（上游黑洞时它照样出现，看门狗会被白白撤掉，
// 假死原样漏回来——这正是第一版的实测失败）。只有真正的模型输出才算数：
// 正文/思考增量、非空的 text/reasoning part、工具调用、step-finish、或带 cost/completed 的消息更新。
// 首个输出一到就撤掉看门狗，之后无论跑多久（长工具执行、几分钟不出字）都不再干预。
// 默认 180s：这段时间要盖住"opencode 组装提示词并发出请求"（本机负载重时实测 28–100s）+ 上游首 token
// （大上下文实测可达 60–90s）。宁可慢报也别错杀；机器更慢的部署用 OC_FIRST_EVENT_TIMEOUT_MS 调大。
const FIRST_EVENT_TIMEOUT_MS = Number(process.env.OC_FIRST_EVENT_TIMEOUT_MS || 180_000)
// 在跑的轮数。三处要用同一个判据：/api/busy（manager 停机/腾位前探它）、以及切模型的两条路径
// （/api/model、/api/model/pick）——它们会 restartOpencode()，把所有在跑的轮连根拔掉。
const runningRounds = () => [...jobs.values()].filter((j) => j.running).length

// ---- /api/password 的失败限流（模块级：状态必须跨请求存活）----
// 这是【已登录】才够得着的接口，攻击面是"cookie 被偷/会话被借用"下的密码盲猜：拿到 cookie 的人
// 本就能读会话，但不知道当前密码就改不走账号——而该接口会如实回答"当前密码不正确"，
// 等于一个不限速的密码预言机。manager 那层的图形验证码/限流/审计管不到这里（请求打的是容器自己的
// 3000 端口，不经 manager）。容器是单用户的，所以全局一个计数器就够，无需按 IP 分桶。
const PW_MAX_FAILS = 5, PW_LOCK_MS = 15 * 60 * 1000
const pwGuard = { fails: 0, lockedUntil: 0 }
const titledSessions = new Set()   // 已确认过标题的会话（每会话只查/改一次），见 /api/chat 的自动补名
// 会话标题统一取"首条提问"：上传先于对话建的会话是占位标题 "web"，收到首条消息时改名。
// 只对占位标题改名，避免"断点续问"旧会话时把原标题冲掉。
async function ensureSessionTitle(sid, q) {
  if (!q || titledSessions.has(sid)) return
  titledSessions.add(sid)   // 无论成败都只尝试一次，别每条消息都打 API
  try {
    const s = un(await client.session.get({ path: { id: sid } }))
    const t = (s?.title || "").trim()
    if (t === "" || t === "web") await client.session.update({ path: { id: sid }, body: { title: q.slice(0, 40) } })
  } catch { /* 改名失败不影响对话 */ }
}
// 自愈残留的“半回退”：编辑历史消息是两段式（/api/revert 暂存回退点 → 下一条 prompt 提交）。
// 若那次重发没走完（僵尸轮/报错/被吞），暂存的回退就永远提交不了，会话被钉在带 revert 标记的
// 半回退态：opencode 之后只返回不一致的回退视图，导致再次编辑必然失败（悬空 messageID）。
// 判据：有 revert 标记 且 该会话没有正在跑的 job → 一定是残留（成功的一次编辑会把标记清成 null），
// 用 unrevert 清掉。只在“打开会话 / 开始新一次编辑”时调用，绝不碰正在提交的正常编辑流程。
//
// 但这个判据本身分不出「真残留」和「刚暂存、正等用户敲完编辑重发」——后者同样是有标记且无 job。
// 修前实况：revert 之后、重发之前，任何一次 /api/history 读取都会把回退撤销（典型：双开标签页，
// 另一页切回该会话触发 resumeSession 拉历史），编辑就静默退化成【追加】。所以用内存表登记
// 「待提交回退」：网关是单进程、合法 revert 只出自 /api/revert 一处，登记内存态就够。
// 新鲜期内（TTL 30 分钟，够用户改完一段长文）history 读取不自愈；提交（下一条 prompt 起轮，
// opencode 收到新消息会自己清标记）或再次 /api/revert 都会摘掉登记；过期/网关重启 → 表空 →
// 退回「一律按残留自愈」的旧行为，正好兜住点了编辑又弃走的会话。
const pendingReverts = new Map()   // sid -> 暂存时刻 (ms)
const REVERT_PENDING_TTL = 30 * 60_000
const revertPendingFresh = (sid) => {
  const t = pendingReverts.get(sid)
  return !!t && Date.now() - t < REVERT_PENDING_TTL
}
async function clearStaleRevert(sid) {
  if (!sid || jobs.get(sid)?.running) return   // 正在生成 → 可能是合法的进行中状态，别动
  if (revertPendingFresh(sid)) return          // 新鲜的待提交回退 ≠ 残留，别撤
  pendingReverts.delete(sid)   // 过期条目顺手摘掉，走下面的残留自愈
  try {
    const s = un(await client.session.get({ path: { id: sid } }))
    // await 之后必须【重查】登记表：session.get 让出期间，另一请求的 /api/revert 可能恰好
    // 完成暂存并登记（双开标签页毫秒窗口）。只查入口那一次的话，这里拿着 revert 标记就 unrevert，
    // 把刚暂存的回退撤了——本函数要防的 bug 从窄窗口原样漏回来（复审抓出的 TOCTOU）。
    if (revertPendingFresh(sid)) return
    if (s?.revert) { await client.session.unrevert({ path: { id: sid } }); return true }
  } catch { /* 自愈失败不阻断主流程 */ }
  return false
}
const sseWrite = (res, ev, data) => { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`) } catch {} }

/**
 * 把 opencode 挂在助手消息上的 error 翻成用户能照着做事的一句话。
 *
 * 【为什么值得单独写一个函数】上游故障里最常见的几种（余额不足、key 失效、限流）对用户的
 * 后续动作完全不同：余额要找管理员充值/换供应商，key 失效要改配置，限流是等一会儿。
 * 原样甩一句英文 provider 报错（甚至什么都不甩）等于让用户自己猜。
 *
 * route 决定"该找谁"：走平台（cloud/gateway）的用户改不了上游，只能找管理员；
 * 用自己 API 的（custom）则要去 api-config 里自查。
 */
export function describeModelError(err, route) {
  const d = (err && err.data) || {}
  const raw = String(d.message || d.responseBody || "").replace(/\s+/g, " ").trim()
  const code = Number(d.statusCode) || 0
  const who = route === "custom"
    ? "请在对话框输入 api-config 检查你自己的 API 配置。"
    : "请联系管理员（可在后台「模型供应商」页换一家或充值）。"
  const tail = raw ? `（上游原话：${raw.slice(0, 160)}）` : ""
  // 云端网关自己的两个"排队排不上"错误码：它们既不是配置问题也不是上游故障，用户该做的
  // 只有"稍后再试"，别把人指去 api-config 白折腾一遍。
  if (/QUEUE_TIMEOUT/.test(raw)) return "云端排队超时：此刻同时使用的人太多，本轮未能开始。请稍后重试（管理员可在后台「并发与排队」调大上限）。"
  if (/QUEUE_FULL/.test(raw)) return "云端排队已满：此刻同时使用的人太多，本轮未能开始。请稍等几分钟再试。"
  if (/UPSTREAM_RATE_LIMITED/.test(raw)) return "上游模型服务正在限速，本轮未能生成。稍等片刻再试即可（这不是你的额度问题）。"
  // 上游【额度耗尽】：同样是 429，但和上面那条限速的建议完全相反 —— 它要等到某个时刻或要充值，
  // 现在重试一次都不会成功。实测（2026-08-07 生产）火山方舟额度打光就回这个，而修前全被当成
  // 限速：客户端显示"正在等待重试、请不要重发"、看门狗又被无限续命，用户守着转圈到放弃。
  // 云端已把恢复时刻写进 message（那是唯一有用的信息，只存在于上游原话里），直接用它。
  if (/UPSTREAM_QUOTA_EXCEEDED/.test(raw)) {
    let msg = ""
    try { msg = JSON.parse(raw.slice(raw.indexOf("{"))).error?.message || "" } catch {}
    return (msg || "平台的上游模型额度已用尽（不是你的积分），本轮未能生成。现在重试不会成功，请联系管理员充值或换一家供应商。")
      + "（你自己的积分没有被扣。）"
  }
  // 平台积分用尽（云端 429 QUOTA_EXCEEDED）。它同样是 429，但落到下面那条通用限流分支上就全错了：
  // "稍等片刻再试"对日积分来说要等到 UTC 0 点，对月积分更是要等下个月，用户会一直重试到放弃。
  // 云端已经把该说的话（哪条线、上限多少、什么时候恢复）写在 message 里，直接用它。
  if (/QUOTA_EXCEEDED/.test(raw)) {
    let msg = ""
    try { msg = JSON.parse(raw.slice(raw.indexOf("{"))).error?.message || "" } catch {}
    return (msg || "平台积分已用尽，本轮未能生成。日积分每天 0 点(UTC)重置，月积分每月 1 日(UTC)重置")
      + "。顶栏的「剩余积分」可随时查看；需要更多请联系管理员调整档位。"
  }
  const balance = code === 402 || /insufficient|balance|欠费|余额|arrears|payment|billing/i.test(raw)
  if (balance) return `上游模型账户余额不足或已欠费，本轮未能生成。${who}${tail}`
  // 平台这边的登录票据失效（管理员改了档位/重置了口令/停用又启用 → key_epoch 变了 → KEY_REVOKED；
  // 或续期票据本身失效 → REFRESH_INVALID）。这类【只需要用户自己重登一次】就好了，此前却落到
  // 下面那条"上游模型服务拒绝了密钥（无效或无权限）。请联系管理员…"上 —— 对着一句自己看不懂的
  // 话去找管理员，而管理员也无从下手，真正该做的那一步（退出重登）反倒一个字都没说。
  // 【为什么连 message 一起认】code 只在结构化错误里有，opencode 转手时常常只剩一句原话。
  // （只对走平台的路由成立：用自己 API 的人压根没有平台票据这回事，别把他指去退出重登。）
  if (route !== "custom" && (/KEY_REVOKED|REFRESH_INVALID|KEY_EXPIRED|KEY_INVALID|KEY_MISSING/.test(raw) ||
      ((code === 401 || code === 403) && /重新登录|重登|登录已(失效|过期)|账号信息已变更/.test(raw))))
    return "你的登录状态已失效（多半是管理员刚调整过你的账号，或这台设备的登录太久了），本轮未能生成。"
      + "请点左下角的「用户」→「退出登录」，再用原来的账号密码登录一次，就能接着用了（会话与产物都不会丢）。"
  if (code === 401 || code === 403 || err?.name === "ProviderAuthError")
    return `上游模型服务拒绝了密钥（无效或无权限）。${who}${tail}`
  if (code === 429 || /rate limit|too many requests|限流/i.test(raw))
    return `上游模型服务限流或额度已满，稍等片刻再试。${who}${tail}`
  if (code === 404 || /model not found|unknown model|无此模型/i.test(raw))
    return `上游没有这个模型（模型名或地址不对）。${who}${tail}`
  if (code >= 500) return `上游模型服务异常（HTTP ${code}）。稍后重试；持续如此请${who}${tail}`
  if (err?.name === "MessageOutputLengthError") return "本轮输出超出模型的长度上限，已被截断中止。可以让它分几次写，或换一个上下文更长的模型。"
  return `本轮模型调用出错${code ? `（HTTP ${code}）` : ""}。${who}${tail}`
}

// ==== 无人值守模式（autopilot）================================================
//
// 用户在输入框旁勾选「自动推进」后：
//   ① 起轮 preamble 多注入一段自主指令（autoPreamble）：编号选项自行采用推荐项（第 1 项）、
//      缺事实性输入标「待补充」继续、只有全部交付完成才在回复末尾单独一行输出 [FINAL] 哨兵；
//   ② 每轮【正常收尾】后由网关判定要不要自动续跑（autoDecide）：没见哨兵就把「按推荐方向
//      继续」当用户消息再起一轮 —— 出错 / 用户终止 / 越权 / 额度封顶的轮一律不续。
//
// 判定以哨兵为主：模型自己声明「我交付了」远比网关猜"这段话像不像问句"可靠。各技能与
// AGENTS.md §六 要求提问一律给编号选项且推荐项放第 1 个，所以「继续」的语义就是"选 1"。
// 护栏（缺一不可，ralph-loop 最大的坑是原地打转烧钱）：
//   · 连续轮数上限 OC_AUTO_MAX_ROUNDS（默认 15）；
//   · 停滞检测：连续两轮文本归一化后一模一样 → 停；
//   · 每轮续跑前查当日额度（quotaOver），进行中的额度中途封顶照常生效；
//   · abort / 删会话即清态（见 job.abort 与 /api/session/delete）。
// 状态只在内存：进程重启后自然熄火，用户重发一条勾选消息即从第 1 轮重计——不值得持久化。
const AUTO_MAX_ROUNDS = Math.max(1, Number(process.env.OC_AUTO_MAX_ROUNDS || 15))
const AUTO_SENTINEL = "[FINAL]"
const autoStates = new Map()   // sid -> { rounds, lastText }

// 只认【结尾】的哨兵：正文中途出现 [FINAL]（比如模型复述规则）不算完成
export const autoHasSentinel = (t) => /\[FINAL\]$/.test(String(t || "").trimEnd())
// 展示前剥掉哨兵：它是网关与模型之间的协议标记，不是给用户看的正文
export const autoStripSentinel = (t) => String(t || "").replace(/\n?[ \t]*\[FINAL\]\s*$/, "")
const _autoNorm = (t) => String(t || "").replace(/\s+/g, " ").trim()

/** 纯判定（导出供测试）：收下这轮文本后要不要续跑。不改状态、不看额度。 */
export function autoVerdict(finalText, st) {
  const t = String(finalText || "")
  if (autoHasSentinel(t)) return { go: false, why: "final" }
  if (!t.trim()) return { go: false, why: "empty" }          // 空文本多半是上游异常，别拿它续跑烧钱
  if ((st?.rounds || 0) >= AUTO_MAX_ROUNDS) return { go: false, why: "cap" }
  if (st?.lastText && _autoNorm(t) === st.lastText) return { go: false, why: "stalled" }
  return { go: true, why: "continue" }
}
const AUTO_STOP_NOTES = {
  cap: () => `无人值守：已连续自动推进 ${AUTO_MAX_ROUNDS} 轮仍未见完成标记，为防失控已停止。请检查目前的产物后手动继续。`,
  stalled: () => "无人值守：连续两轮输出几乎相同（疑似原地打转），已停止自动推进。请检查产物后手动继续。",
  quota: () => "无人值守：额度/积分已用尽，自动推进停止；恢复后可手动继续（日额度每日 0 点(UTC) 重置）。",
  empty: () => "无人值守：本轮没有文本输出（多半是上游异常），自动推进停止。",
}
/** 一轮正常收尾后调用：要续跑则推进状态并返回 {go:true, round}；停下返回 {go:false, note?}；未开无人值守返回 null */
function autoDecide(sid, finalText) {
  const st = autoStates.get(sid)
  if (!st) return null
  const v = autoVerdict(finalText, st)
  // 两条额度线都要看：本机 env 额度（容器部署）与云端账号积分（打包版）。少看一条就会在触顶后
  // 继续自动续跑，每轮都撞回 429 —— 无人值守正好没人在旁边看着，能空转到轮数上限。
  if (v.go && (quotaOver() || cloudQuotaBlocked())) { v.go = false; v.why = "quota" }
  if (!v.go) {
    st.rounds = 0; st.lastText = ""   // 开关本身保留：用户下一条勾选消息从第 1 轮重新计
    if (v.why === "final") console.log(`[auto] 会话 ${sid}：检测到完成哨兵，自动推进收官`)
    else console.warn(`[auto] 会话 ${sid}：自动推进停止（${v.why}）`)
    return { go: false, note: AUTO_STOP_NOTES[v.why]?.() }
  }
  st.rounds++; st.lastText = _autoNorm(finalText)
  console.log(`[auto] 会话 ${sid}：未见完成哨兵，自动续跑第 ${st.rounds}/${AUTO_MAX_ROUNDS} 轮`)
  return { go: true, round: st.rounds }
}
// ---- 分享：把整个会话导出成一个自包含 HTML ----
//
// 【★ 别拿前端 DOM 去序列化 ★】这是本功能唯一一个致命坑，踩了看不出来：
//   /api/history 只留 `p.type === "text"` 的 part —— reasoning 与 tool 一个都不回。
//   于是界面上的「思考过程」「工具调用」两块，【只有本页 SSE 直播过的那几轮】才有 DOM 节点；
//   用户刷新一下、或从左侧列表切回一个旧会话，历史是走 /api/history 重建的，那些轮次在 DOM 里
//   压根没有思考与工具。照 DOM 导出的话：刚聊完的会话看着完全正常，任何回看过的会话导出来
//   思考与工具全空，而界面上看不出任何异常。所以导出必须在服务端重新拉一次【完整】part 列表。
//
// 分轮口径与界面一致：一条 user 消息 + 其后所有 assistant 消息 = 一轮
// （opencode 每个 LLM step 落一条 assistant 消息，界面把它们并进同一个回合渲染）。
// 正文按 text part 顺序拼（与直播的 emitLive 同口径），思考按 reasoning part 顺序拼。
/** 会话消息 → 分享用的轮次数组（导出供测试；不碰文件产出，见 share-export.mjs 顶部注释②）*/
export function shareTurns(msgs) {
  const scrub = (t) => scrubShare(t, { root: ROOT, home: os.homedir() })
  const turns = []
  let cur = null
  const open = (ask) => { cur = { ask, answer: "", reasoning: "", tools: [], skills: [], error: "" }; turns.push(cur); return cur }
  // 【必须判 isArray，不能只 `msgs || []`】会话 id 不存在时 opencode 回 404 而 SDK【不抛】：
  // un() 把 `{name:"NotFoundError",data:{message:...}}` 里的 data 拆出来交过来 —— 一个对象。
  // 只写 `|| []` 的话它是 truthy，for...of 当场 TypeError，导出变成 500。实测踩到过。
  for (const m of Array.isArray(msgs) ? msgs : []) {
    const role = m.info?.role
    const parts = m.parts || []
    if (role === "user") {
      // 【先剥后 trim，不能反过来】前言/任务卡的正则都以「\n\n」收尾，先 trim 掉尾部空行的话，
      // 一条【只有前言没有正文】的消息就剥不掉了，整段内部指令会原样进分享件。
      const raw = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("\n")
      open(scrub(stripPreamble(raw).trim()))
      continue
    }
    if (role !== "assistant") continue
    if (!cur) open("")           // 没有对应 user 消息的助手输出（如无人值守续跑轮）也要收
    const text = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("\n")
    if (text.trim()) cur.answer += (cur.answer ? "\n" : "") + text
    const think = parts.filter((p) => p.type === "reasoning").map((p) => p.text || "").filter(Boolean)
    if (think.length) cur.reasoning += (cur.reasoning ? "\n\n" : "") + think.join("\n\n")
    for (const p of parts) {
      if (p.type !== "tool" || !p.state?.status) continue
      // 技能与其它工具分开：界面上技能是常显徽章、其余进折叠列表，分享件照搬这个分法
      if (p.tool === "skill") {
        const name = p.state?.input?.name || p.state?.title || ""
        if (name && !cur.skills.includes(name)) cur.skills.push(name)
        continue
      }
      // 只记「调了什么」，【不记 state.output】：工具输出里是整份文件内容、整张数据表，
      // 那既是「文件产出」又是最容易夹带患者数据的地方。界面本身也只显示 tool + title。
      cur.tools.push({ tool: p.tool, title: scrub(p.state.title || ""), status: p.state.status })
    }
    if (m.info?.error) cur.error = scrub(String(m.info.error.message || m.info.error.name || m.info.error)).slice(0, 300)
  }
  for (const t of turns) {
    t.answer = scrub(autoStripSentinel(t.answer).trim())   // 哨兵是网关与模型的协议标记，与直播/历史同口径不外露
    t.reasoning = scrub(t.reasoning.trim())
  }
  return turns.filter((t) => t.ask || t.answer || t.reasoning || t.tools.length || t.skills.length || t.error)
}
/** 会话消息 → 完整分享 HTML（导出供测试：路由就是调它，测到这里等于测到出口）*/
export function shareHtmlFromMessages(msgs, opts = {}) {
  return renderShareHtml({ title: opts.title, exportedAt: opts.exportedAt, turns: shareTurns(msgs), flow: opts.flow })
}
// 下载名：去掉文件系统与 HTTP 头都嫌麻烦的字符；长标题会被截断（有些会话标题是整段任务卡）
const shareFileName = (title) => {
  const d = new Date()
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
  const base = String(title || "会话记录").replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "会话记录"
  return `${base}-${day}.html`
}

// 注入进首轮 preamble 的自主指令。与【本会话工作区】同一块注入，故同样【不得含空行】
// （stripPreamble 按第一个空行剥离，见 skillsPreamble 处的同款约束）。
const autoPreamble = () => `\n- 【无人值守模式已开启】用户不在电脑前：全程不要向用户提问、不要停下等确认。遇到要选择的地方（单步还是完整流程、选哪条 pipeline、选题、方案、期刊……），直接采用你本要推荐的那一项（相当于用户回了「1」），并在正文用一行说明「已自动采用：xxx」。缺少无法自行获得的事实性信息（数据文件、伦理批号、作者名单等）就标「待补充」，继续完成其余部分，别停下来要。\n- 【完成哨兵】只有当本次目标已全部交付（成稿/成品文件已写盘、该跑的质量闸已跑完）时，才在回复最后单独一行输出 ${AUTO_SENTINEL} 。尚未完成时绝不能输出它（提前输出=任务被腰斩）；反之只要不输出它，系统就会自动让你继续下一轮，所以也不必问"是否继续"。`
/** 自动续跑轮发给模型的用户消息 */
const autoContinueText = (round) => `【无人值守·自动续跑 第 ${round} 轮】继续按你的推荐方向推进：上一轮若列了编号选项，视为用户选了第 1 项（推荐项）；若在等待确认，视为已确认。缺的事实性信息标「待补充」继续。全部交付完成时在回复末尾单独一行输出 ${AUTO_SENTINEL}；未完成就继续干活，不要输出该标记。`

/** 上一轮"非正常收场"停在哪一步、为什么停 —— 写进状态簿，供步骤条画成「中断」态。
 *
 * ★ 为什么必须有这个：终止 / 超时 / 卡死 / 积分用尽 / 越权 / 报错六种收场，在步骤条上原本是
 *   同一张脸——【蓝色进行中】，悬停气泡还写着"当前进行到这一步"。聊天里的文案分得很细，
 *   条子和文案说的不是一回事。更别扭的是：轮末同步补齐之后，被终止那一步会立刻按【半成品文件】
 *   打绿勾——一个只写了引言就被掐断的 review.md 显示成"综述成文 ✓已完成"。
 *   记一条 halted，界面就能说实话："这一步没跑完，因为你终止了它"。
 * ★ 生命周期：下一轮开跑即清（startJob）。它描述的永远是【最近一次】非正常收场。
 */
const wfMarkHalted = async (sid, stepId, reason) => {
  try {
    const dir = await sessionOut(sid)
    const st = wfLoad(dir); if (!st) return
    st.halted = { step: stepId || null, reason: reason || "error", at: Date.now() }
    wfSave(dir, st)
  } catch (e) { console.warn(`[workflow] 中断标记写不进去（不影响本轮报错）：${e.message}`) }
}
const wfClearHalted = async (sid) => {
  try {
    const dir = await sessionOut(sid)
    const st = wfLoad(dir); if (!st || !st.halted) return
    delete st.halted
    wfSave(dir, st)
  } catch { /* 没有簿子就没什么可清 */ }
}

function startJob(sid, sentText, modId) {
  clearError(sid)   // 新一轮开跑 → 上一次的失败记录作废，别让它一直挂在历史末尾
  wfClearHalted(sid)   // 同理：上一轮的「中断」标记作废（它描述的是最近一次非正常收场）
  // 新一轮 prompt 就是回退的提交动作（opencode 收到新消息会把 revert 标记清成 null），
  // 待提交登记到此结束；之后再出现的 revert 标记就真是残留了，交还给 clearStaleRevert 自愈。
  pendingReverts.delete(sid)
  // 模块闸的判据：受限模块只允许它那一组技能；null = 非受限模块（chat / 未传 modId 的兼容路径）
  const modSkills = MODULE_DEFS[modId]?.skills || null
  // 本轮实际生效的技能白名单：受限模块锁本模块技能组（+env-setup 基础设施），且仍要过账号级白名单
  //（管理员单独收掉组里某个技能时，那个技能在本模块里也用不了；主技能被收掉时整个模块已在入口被挡）；
  // chat 用账号级白名单；null=不限。账号级白名单取【env ∩ 云端档案】：运营后台收权后这一轮就按新授权强制，不用等重启
  const acctSkills = effectiveSkillSet()
  const skillGate = modSkills
    ? new Set([...modSkills.filter((s) => !acctSkills || acctSkills.has(s)), "env-setup"])
    : acctSkills
  const job = {
    sid, running: true, finished: false, subs: new Set(),
    // 本轮发出去的用户原话（剥掉注入前言）。/api/history 靠它判断"最后一条 user 消息是不是本轮的"，
    // 判错了会把上一轮的回答整段删掉（见该处注释）。
    sentUser: stripPreamble(sentText).trim(),
    // 增量快照：text 是累积全文、reasoning 按 id、tool 按 callID 各存最新一条，attach 时按序重放即可还原界面
    text: "", reasoning: new Map(), tools: new Map(), skills: new Map(),
    // notice 也要进快照。它是本轮唯一的"非致命但必须知道"的通道，最典型的一条是
    //「你已手动放行质量闸：闸仍判未通过，这次出件不再拦截」—— 不重放的话，用户刷新一下
    // 或断线重连，这句警告就没了，最后看到的是一份干净的回答 + 一个没过闸的 Word。
    notices: [],
  }
  jobs.set(sid, job)
  // 事件流的取消句柄：每轮都会 client.event.subscribe() 新开一条到 opencode 的长连接，
  // 若不主动取消，for-await 只有等"下一个任意事件到达"才会看到 job.finished 而 break ——
  // 末轮的订阅可能整夜不释放。SDK 的 subscribe(options) 会把 options.signal 一路透传到
  // createSseClient → fetch(url,{signal})，abort 后重试循环顶部的 `if (signal.aborted) break` 会终止它。
  const evAbort = new AbortController()
  const broadcast = (ev, data) => {
    if (ev === "text") job.text = data
    else if (ev === "reasoning") job.reasoning.set(data.id, data)
    else if (ev === "tool") { if (data.tool === "skill") { if (data.skill) job.skills.set(data.skill, data) } else if (data.callID) job.tools.set(data.callID, data) }
    // ★ 失败一律落盘（在这一处收口，六个报错点全覆盖，将来新增的也自动覆盖）。
    //   下面这行 for 循环只写【当下挂着的】订阅者：页面关了、网断了、切走了会话，这条报错就永远
    //   消失了 —— 用户回来只看到自己那条消息，没有任何解释。落一份，/api/history 会补回末尾。
    else if (ev === "failed" && data?.message) noteError(sid, data.message)
    else if (ev === "notice" && data?.message) job.notices.push(data)   // 进快照，attach 时重放（见 job.notices）
    if (ev === "done" || ev === "failed" || ev === "aborted") job.ended = true   // 本轮已有结论，finish 不必再补
    for (const r of job.subs) sseWrite(r, ev, data)
  }
  // 首输出看门狗的句柄（守的是"模型第一个输出"，不是"第一个事件"）：定义在 finish 之前，好让 finish 无条件把它清掉
  // （正常完成 / 用户终止 / 出错收场都走 finish，一处清理覆盖全部路径，绝不留悬空定时器）。
  // noteModelOutput() 只在【确认是模型真的产出了东西】时调用，别拿消息壳子当活证据（见 FIRST_EVENT_TIMEOUT_MS 注释）。
  let sawOutput = false, watchdog = null
  const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null } }
  const noteModelOutput = () => { if (sawOutput) return; sawOutput = true; clearWatchdog() }
  const finish = () => {
    if (job.finished) return
    // ★ 本轮【没有任何终止事件】就收场 —— 必须补一条，否则用户什么都看不到。
    //   实测（两个独立测试各中一次）：一轮跑到一半，SSE 只有 reasoning/text/tool，
    //   没有 final / done / failed / notice，连接直接被 end()；前端 onerror 把整轮 DOM 丢掉、
    //   重连拿到 idle、回放历史 —— 用户只看到助手说了半句话就没了，不知道该重发还是该等。
    //   上游返回空 choices、opencode 侧消息 parts 为空而 info.error 又是 null 时会走到这里。
    //   注意：正常收尾（done/aborted）与已报错的路径都设了 ended，不会被这条覆盖。
    if (!job.ended && !job.aborting) {
      const msg = "本轮没有正常结束（后台没有给出结果，也没有报错）。这通常是上游模型服务这一次返回异常；直接重发一次通常就好。"
      try { for (const r of job.subs) sseWrite(r, "failed", { message: msg }) } catch {}
      noteError(sid, msg)
    }
    job.finished = true; job.running = false; jobs.delete(sid); runningCost.delete(sid)   // 本轮成本已由 addCost 入账，撤掉实时占位
    clearWatchdog()
    try { evAbort.abort() } catch {}   // 立刻掐掉本轮的 opencode 事件流，别留着空转到下一个事件
    for (const r of job.subs) { try { r.end() } catch {} }
    job.subs.clear()
  }
  job.abort = async () => {
    if (job.finished) return
    job.aborting = true          // 让 prompt 的报错分支知道这是用户终止，别再广播 failed
    autoStates.delete(sid)       // 用户主动终止 = 无人值守也熄火，绝不能 abort 完又自动续一轮
    broadcast("aborted", {})     // 先告知订阅者（保证前端能收到"已终止"），再实际掐断
    // ★ 终止也要落盘。aborted 不进 _lasterror.json，于是刷新之后【连"我掐过它"都看不到】：
    //   用户看到的是一段说到一半戛然而止的回答，加上一个（按半成品文件反推出来的）绿格子 ——
    //   最自然的读法是"它做完了"。写一条，/api/history 会把它补到末尾。
    noteError(sid, "你在这一轮中途点了「终止」，本轮没有跑完；这一步的产物可能只写了一半。")
    try { await client.session.abort({ path: { id: sid } }) } catch {}
    finish()
  }
  // ---- 首输出看门狗（缘由见 FIRST_EVENT_TIMEOUT_MS 的注释）----
  // 终止路径与 /api/chat/abort 完全相同（client.session.abort + finish），差别只在广播的是
  // failed（带原因）而不是 aborted：用户没点终止，得让他知道为什么停了、去哪儿改。
  // failed 是前端已有的展示通道（同 402 余额不足等上游错误），会渲染成 "⚠ …" 并收尾本轮。
  // 不 await session.abort：上游不可达时这条 HTTP 本身也可能慢，广播和收场不能被它拖住。
  // 云端排队时把这条提示推给前端（"正在排队，前面还有 N 个"）。定义在这里是因为要用 broadcast；
  // 触发方是 probeCloudQueue（见「云端排队感知」一节），它按用户维度推给所有在跑的轮。
  job.onQueue = (info) => { if (!job.finished) broadcast("queue", info) }
  // 云端积分在轮内触顶：由 cloudForward 认出 429 QUOTA_EXCEEDED 后推过来（见「云端积分用尽」一节）。
  // 收场方式与首输出看门狗完全一致（广播 failed + abort + finish），只是原因不同；本轮已花的成本
  // 仍会在 session.prompt 返回后照常结算（那段在 job.cloudQuotaHit 的检查之前，见下方）。
  job.onQuotaBlock = (message) => {
    if (job.finished || job.cloudQuotaHit) return
    job.cloudQuotaHit = message   // 让 prompt 返回后的分支知道本轮已收过场，别再广播第二条错误
    console.warn(`[quota] 会话 ${sid}：云端积分已用尽，中途中止本轮`)
    broadcast("failed", { message: `${message}。本轮已在中途自动中止；已经生成的内容与产物都保留。${QUOTA_TAIL}` })
    client.session.abort({ path: { id: sid } }).catch(() => {})
    finish()
  }
  const fire = () => {
    watchdog = null
    if (job.finished || sawOutput) return
    // 【正在云端排队/被上游限速 → 续命，别当成"模型不可达"】排队几分钟是正常的（就是它挤在
    // 别人后面），这时掐掉本轮既浪费了排到的位子，报的原因还是错的（会把人指去改 API 配置）。
    if (cloudQueueBlocking()) { watchdog = setTimeout(fire, 30_000); watchdog.unref?.(); return }
    job.timedOut = true   // 让 prompt 返回后的分支知道本轮已收过场，别再广播第二条错误
    console.error(`[watchdog] 会话 ${sid}：${FIRST_EVENT_TIMEOUT_MS}ms 内未收到本轮任何模型事件，判定模型服务不可达，自动中止本轮`)
    broadcast("failed", { message: `连接模型服务失败或超时（${Math.round(FIRST_EVENT_TIMEOUT_MS / 1000)} 秒内模型无任何响应），本轮已自动中止。请检查 API 设置（在对话框输入 api-config 打开）后重试。` })
    client.session.abort({ path: { id: sid } }).catch(() => {})
    finish()
  }
  watchdog = setTimeout(fire, FIRST_EVENT_TIMEOUT_MS)
  if (typeof watchdog.unref === "function") watchdog.unref()   // 纯守护定时器，别让它拖住进程退出
  ;(async () => {
    // 【必须订阅 /global/event 而非 /event】实测（裸 curl 对照抓包）：本部署把每个会话建在
    // outputs/<ws>/ 子目录，不带 directory 参数的 /event 只收得到 server.* 心跳，一条消息事件都没有
    // ——原先这个循环从未收到过任何 message.*，中途封顶、流式转发全是死代码（前端只在轮末收到 final）。
    // /global/event 才是全量总线；它的每条事件外面包一层 {directory, project, payload}，用时拆开。
    const events = await client.global.event({ signal: evAbort.signal })   // finish() 里 abort，避免订阅泄漏
    const jobT0 = Date.now()   // 开轮时刻（网关与 opencode 同容器同钟）：滤掉上一轮消息的迟到收尾事件
    const PRICE = _modelCost()
    // 本轮各 assistant 消息（= 各 LLM step）的计费状态：real 是 opencode 给的真实 cost（step 完成才有，
    // 已含在 session.cost 里）；estTok 是按流式增量累计的输出 token 估算（real 缺位时的替身）。
    const perMsg = new Map()
    const partMeta = new Map()   // partID -> { type, messageID, text }：text/reasoning 的增量重组，供直播与估算
    job.perMsg = perMsg          // 容器停机时 gracefulExit 的结算要用（见文件末尾）
    const msgEst = (m) => (m.real > 0 ? m.real : m.estTok > 0 ? estInCost(sid) + (m.estTok * PRICE.output) / 1e6 : 0)
    job.estExtra = () => { let x = 0; for (const m of perMsg.values()) if (!(m.real > 0) && m.estTok > 0) x += estInCost(sid) + (m.estTok * PRICE.output) / 1e6; return x }
    // 中途额度封顶：一旦「今日已入账 + 所有在跑轮的实时成本」达上限，立即中止本轮，避免单轮跑到底大幅超支。
    // 实时成本 = 已完成步的真实 cost + 进行中那一步的估算——后者让"单条长文本生成"也能被中途掐断
    // （原实现只看 message.updated 的 info.cost，而它在 step 完成前恒为 0，长生成全程封不住）。
    // 用全局 runningCost（而非本轮开始时的快照）：并发的几轮互相看得见对方已花的钱，合计到顶各轮都会中止。
    let lastCapCheck = 0
    const updateRunning = () => {
      let rc = 0; for (const m of perMsg.values()) rc += msgEst(m)
      runningCost.set(sid, rc)
      // 封顶判断节流 250ms：quotaUsedLive 每次都同步读盘（loadQuota），不能跟着每条 delta 跑；
      // 封顶精度本来就是"一条消息"粒度，250ms 不损失什么。runningCost 的内存更新不节流。
      const now = Date.now()
      if (DAILY_COST_LIMIT > 0 && !job.quotaHit && now - lastCapCheck > 250) {
        lastCapCheck = now
        if (quotaUsedLive() >= DAILY_COST_LIMIT) {
          job.quotaHit = true
          client.session.abort({ path: { id: sid } }).catch(() => {})
        }
      }
    }
    // 直播是"整段替换"语义：逐 delta 全量推送会 O(n²) 字节，节流到 ~4 次/秒；快照/收尾时强推。
    const dirtyParts = new Set()
    let lastEmit = 0
    const emitLive = (force) => {
      const now = Date.now()
      if (!force && now - lastEmit < 250) return
      lastEmit = now
      let textChanged = false
      for (const pid of dirtyParts) {
        const meta = partMeta.get(pid)
        if (!meta) continue
        if (meta.type === "text") textChanged = true
        else if (meta.type === "reasoning") broadcast("reasoning", { id: pid, text: meta.text })
      }
      dirtyParts.clear()
      if (textChanged) broadcast("text", [...partMeta.values()].filter((x) => x.type === "text").map((x) => x.text).join("\n"))
    }
    ;(async () => {
      for await (const w of events.stream) {
        if (job.finished) break
        const e = w?.payload ?? w
        if (e?.type === "message.updated") {
          const info = e.properties?.info
          if (info?.sessionID === sid && info.role === "assistant") {
            // 只收编【本轮】新建的消息：上一轮被 abort 的消息可能在本轮订阅建立后补发收尾事件
            // （cost=0 + 全文快照），照单全收会让它在本轮再被估算补账一次（上一轮结算已补过）。
            // 按创建时间过滤；缺 created 字段则放行（宁可失误于收编，也别把正常消息挡在外面——
            // 挡错了 = 估算/封顶/直播对该消息全体失效，回到修复前的死状态）。
            if (!perMsg.has(info.id) && info.time?.created && info.time.created < jobT0) continue
            // 【上游报的错就挂在这个字段上，必须收】opencode 遇到 provider 错误（余额不足 402、
            // key 失效 401、限流 429…）不会让 session.prompt 抛异常：它把错误写进助手消息的
            // error 字段，正文为空，然后正常收场。此前这里从没读过它 —— 于是真实故障的表现是
            // 「前端一个空气泡、没有任何提示」，用户只能干等着以为模型在想。踩过一次：DeepSeek
            // 余额耗尽，全站输出空白，前端与日志都没有一句话说明。
            // MessageAbortedError 不算故障（用户点了终止 / 额度封顶自己 abort 的），照旧走 aborted 那条路。
            if (info.error && info.error.name !== "MessageAbortedError") job.modelError = info.error
            const m = perMsg.get(info.id) || { real: 0, estTok: 0 }
            m.real = Math.max(m.real, info.cost || 0)   // 后到的无 cost 事件别把已知真实成本打回 0（那会让封顶退回估算值）
            perMsg.set(info.id, m)
            // 只有【带成本或已完成】的消息更新才算模型真出了东西（非流式上游可能只在末尾报一次）；
            // 光是消息被创建（cost=0、未完成）不算——那在请求发出前就有了，见 FIRST_EVENT_TIMEOUT_MS 注释。
            if ((info.cost || 0) > 0 || info.time?.completed) noteModelOutput()
            updateRunning()
          }
          continue
        }
        if (e?.type === "message.part.delta") {   // 流式增量：{sessionID, messageID, partID, field:"text", delta:"块"}
          const d = e.properties
          if (d?.sessionID !== sid || d.field !== "text" || typeof d.delta !== "string") continue
          const meta = partMeta.get(d.partID)
          const m = meta && perMsg.get(meta.messageID)
          if (!m) continue   // 只认本轮 assistant 消息的内容（其 message.updated 先于 parts 到达，实测）
          noteModelOutput()   // 有正文增量流出 = 上游确实在回应 → 撤看门狗
          meta.text += d.delta
          m.estTok += estDeltaTokens(d.delta)
          dirtyParts.add(d.partID)
          emitLive(false)
          updateRunning()
          continue
        }
        const p = e?.properties?.part; if (!p) continue
        if (p.sessionID && p.sessionID !== sid) continue
        if (p.type === "step-finish") {
          noteModelOutput()   // 一步已经跑完 = 上游给过东西了
          // 本步完成，真实 tokens 已知 → 记下输入侧真实成本，作本会话后续步（含被 abort 步）的输入估计
          const t = p.tokens
          if (t && perMsg.has(p.messageID)) {
            if (sessInCost.size > 500) sessInCost.clear()   // 有界：会话数远到不了这，纯防御
            sessInCost.set(sid, ((t.input || 0) * PRICE.input + (t.cache?.read || 0) * PRICE.cache_read + (t.cache?.write || 0) * PRICE.cache_write) / 1e6)
          }
          emitLive(true)
        } else if ((p.type === "text" || p.type === "reasoning") && perMsg.has(p.messageID)) {
          // 快照事件（part 创建时 len=0、part 结束/abort 时全文）。用户消息的回显 part 进不来：
          // 它的 messageID 是 user 消息，不在 perMsg 里 —— 这同时替代了旧的 `p.text !== sentText` 滤重。
          const meta = partMeta.get(p.id) || { type: p.type, messageID: p.messageID, text: "" }
          partMeta.set(p.id, meta)
          if (typeof p.text === "string" && p.text.length > meta.text.length) {
            noteModelOutput()   // 快照里【真有文字】才算输出：part 刚创建时是空的（len=0），那不算
            perMsg.get(p.messageID).estTok += estDeltaTokens(p.text.slice(meta.text.length))   // 快照比累计长 = 漏了 delta，差额补进估算
            meta.text = p.text
            dirtyParts.add(p.id)
          }
          emitLive(true)
          updateRunning()
        } else if (p.type === "tool" && p.state?.status) {
          noteModelOutput()   // 模型已经发出工具调用 = 上游在回应（长工具执行期的静默由此不再被误杀）
          // ---- 模块/技能闸（强制层，不靠提示词自觉）----
          // 技能调用只放行白名单内的：受限模块 = 绑定的那一个技能；chat = 账号级技能白名单。
          // 受限模块还禁 task 子代理绕道（子代理的技能调用发生在子会话里，本循环按 sessionID 过滤
          // 看不见，所以整个 task 工具都得禁；tools:{task:false} 已在 prompt 参数里禁掉，这里是双保险。
          // chat 不禁 task——禁了会破坏正常流水线，子会话逃逸是已接受的取舍，见 ALLOWED_SKILLS 注释）。
          // 违规立即 abort 本轮，prompt 返回后统一广播报错（见下方 moduleHit 分支）。
          // ★ 第三条判据：bash 里直接跑白名单外的技能脚本。
          //   前言本来就教 agent 用 `${REPO_ROOT}/.venv/bin/python ${REPO_ROOT}/.opencode/skills/<技能>/xxx.py`
          //   跑脚本，于是受限模块里"顺手跑一个隔壁模块的脚本"是条【真实且高频】的绕道路径，而它
          //   走的是 bash 工具、压根不经过上面那条 skill 判据。技能集扩成整条 pipeline 后这个口子更大。
          //   绕过面（变量拼接、cd 进去用相对路径、base64）堵不死 —— 与本文件既有口径一致：
          //   这是产品分权闸，不是对抗边界。堵住顺手绕道就已经拿到绝大部分收益。
          // ★ 死循环护栏：同一条命令反复调用 = agent 已经卡住了，再跑下去只是烧时间和配额。
          //   判据、阈值理由，以及"为什么必须按【调用】而不是按事件计数"（曾误杀 pip install）
          //   都在 WF.loopGuardStep —— 纯函数，回归测试见 test/loop-guard.test.mjs。
          //   job.loop.out 存着被中止那次调用的真实输出，闸触发时要交给用户（见下方 loopHit 分支）。
          if (WF.loopGuardStep(job.loop ||= {}, p)) {
            job.loopHit = job.loop.hit
            console.warn(`[loop] 会话 ${sid}：同一条命令已被调用 ${job.loop.repeat} 次，判定卡死，中止本轮：${job.loopHit}`)
            client.session.abort({ path: { id: sid } }).catch(() => {})
          }
          // ★ 闸红着就不许出【送审件】。这条必须在服务端强制，不能继续靠 agent 自觉 ——
          //   实测：peer-review 报告白纸黑字写着「推荐倾向：Major revision」+1 条 Critical+5 条 Major，
          //   模型改完稿子【没有重跑那道闸】，35 秒后照样出了 manuscript.docx，还在聊天区宣布
          //   "质量闸全部跑完 ✅、Critical/Major 意见均已修订"，与步骤条上的「✗ 需返工」正面冲突。
          //   前言里三条硬规矩（结论只能由重跑得出 / 闸没跑完不许出件 / 不许用话术放行）同时被违反。
          //   模型换一个就可能再犯，而用户拿到的是一份看起来完全正常的送审稿。
          //   【只拦 docx/pdf 这类"送审件"】——markdown 稿件照常产出，用户永远拿得到内容，
          //   所以这不是死锁：闸误判时他仍有稿子，重跑那道闸即可解锁出件。
          if (!job.gateBlock && modSkills) {
            // skill 工具与 bash 直呼脚本 / 裸 pandoc 都要认 —— 只认前者等于留了一条大路
            const called = WF.isDeliveryCall({ tool: p.tool, input: p.state.input })
            if (called) {
              const red = await failedGatesFor(sid, modId)
              // 用户在流程条上手动放行过这个会话 → 不拦（理由见 GATE_BYPASS_FILE 头注）。
              // 但【必须说】：件出来了、闸没过。静默放行会让用户以为问题已经解决。
              // job.gateBypassNoted：一轮里可能连着出 docx 和 pdf，提示只给一次。
              if (red.length && gateBypassed(sid)) {
                if (!job.gateBypassNoted) {
                  job.gateBypassNoted = true
                  const names = await gateNames(sid, modId, red)
                  console.warn(`[gate] 会话 ${sid}：闸 ${red.join("、")} 仍未过，但用户已手动放行，${called} 照常执行`)
                  broadcast("notice", { message:
                    `你已手动放行质量闸：「${names.join("、")}」当前仍判定为未通过，这次的出件不再拦截。\n` +
                    `注意闸没有转绿——报告里列的问题仍然在那儿，流程条上也照旧标着未通过。` +
                    `送审前请自己确认那是判据误伤（英文报告、或只剩"等你补材料"的条目最容易被误判），而不是真的方法学硬伤。` })
                }
              } else if (red.length) {
                job.gateBlock = { skill: called, gates: red }
                console.warn(`[gate] 会话 ${sid}：闸 ${red.join("、")} 未过就调用 ${called}，中止本轮`)
                client.session.abort({ path: { id: sid } }).catch(() => {})
              }
            }
          }
          if (skillGate && !job.moduleHit) {
            const bad = WF.gateViolation({ tool: p.tool, input: p.state.input, skillGate, restricted: !!modSkills })
            if (bad) {
              job.moduleHit = bad
              console.warn(`[modules] 会话 ${sid}（模块 ${modId}）调用了越权技能/工具：${bad}，中止本轮`)
              client.session.abort({ path: { id: sid } }).catch(() => {})
            }
          }
          broadcast("tool", {
            callID: p.callID, tool: p.tool, status: p.state.status,
            title: p.state.title || "",
            skill: p.tool === "skill" ? (p.state.input?.name || null) : null,   // 技能名（running/completed 才有）
          })
        }
      }
    })().catch((e) => {
      // 事件流是估算/封顶/直播的共同前提，异常死亡绝不能静默——上次这条链路无声死掉（/event 订阅
      // 收不到任何事件）就是零观测才拖了这么久。主动取消（finish 里 evAbort.abort）不算异常。
      if (!job.finished) console.warn(`[events] 本轮事件流异常中断（sid=${sid}），封顶与直播退化、abort 估算只含已收到的部分：${e?.message || e}`)
    })
    const outDir = await sessionOut(sid)                 // 本会话的绝对产物目录（= agent 的工作目录）
    const before = dirState(outDir)   // 记录本轮开始前本会话产物状态，用于算增量
    let cost0 = 0; try { cost0 = un(await client.session.get({ path: { id: sid } }))?.cost || 0 } catch {}   // 本轮前累计成本，用于算增量
    job.cost0 = cost0   // 挂到 job 上：容器停机时 gracefulExit 要用它把本轮已花的钱结算掉（见文件末尾）
    let result, promptErr = null
    try {
      // 受限模块：从工具层面禁掉 task 子代理（子会话里的技能调用逃逸出上面的模块闸，索性不让开子代理）
      result = un(await client.session.prompt({ path: { id: sid }, body: { model: MODEL, parts: [{ type: "text", text: sentText }], ...(modSkills ? { tools: { task: false } } : {}) } }))
    } catch (err) { promptErr = err }
    // 无论正常结束 / 被额度中止 / 被用户终止，都把本轮成本记进今日额度——否则中止的轮不计费，用户可无限重试绕过额度。
    // 真实增量（session.cost 只含完成步）+ 估算兜底（cost=0 的消息 = 被 abort 的那一步，opencode 对它记
    // cost=0/tokens=0，而上游实测已全额扣费）。估算前先问 opencode 该消息的权威状态：若它其实正常完成了
    // （只是我们没赶上它的 cost 事件），成本已在真实增量里，绝不能再叠加估算——宁可漏这一条也不重复计费。
    const settleEstimate = async () => {
      let extra = 0
      for (const [mid, m] of perMsg) {
        if (m.real > 0 || !(m.estTok > 0)) continue
        try {
          const info = un(await client.session.message({ path: { id: sid, messageID: mid } }))?.info
          if (info && ((info.cost || 0) > 0 || (!info.error && info.time?.completed))) continue
        } catch { continue }   // 权威状态都查不到时放弃这条估算：宁可少算，不冒双重计费的险
        extra += estInCost(sid) + (m.estTok * PRICE.output) / 1e6
      }
      return extra
    }
    if (!job.settled) {   // 容器停机时 gracefulExit 可能已替本轮结算过（它随后 abort 会让上面的 prompt 立刻返回、走到这里）——别结第二次
      job.settled = true
      try {
        const c1 = un(await client.session.get({ path: { id: sid } }))?.cost || 0
        addCost(c1 - cost0 + (await settleEstimate()))
      } catch {
        // session.get 都失败时真实增量拿不到了，至少把内存里的估算记上（比整轮漏账好；settled 已占坑，不会双记）
        try { addCost(job.estExtra?.() || 0) } catch {}
      }
    }
    // ★ 轮末同步（产物侧栏 + 步骤进度）抽成一函数，因为【异常收场也必须做】。
    //   原来下面九条早退分支（终止 / 超时 / 卡死 / 云端积分 / 闸拦截 / 越权 / 日额度 / prompt 出错 /
    //   模型出错）全是 `return finish()`，把这段整个跳过 —— 后果实测：
    //   ① 这一轮写出来的产物一个都不进侧栏（积分耗尽那条文案还写着"已生成的产物都保留"，
    //      而用户当下一个新文件都看不到）；
    //   ② 步骤条冻在蓝色"进行中"，直到用户刷新才跳变；
    //   ③ 最要命的是闸拦截：闸报告与出件在同一轮时，报错文案叫用户"点流程条右上角的「仍要出件」"，
    //      而那个按钮只在 liveFailed 非空时才挂 —— 不广播 workflow，它此刻根本不存在。
    const syncTail = async () => {
      const changed = changedSince(outDir, before)
      broadcast("files", changed)
      // ★ 更深层文件数也要【直播时】给。原来它只在 /api/outputs 里回，SSE 这条路上前端拿的是
      //   上一次的值（默认 0）—— 而 agent 把图写进 figures/panel/fig1.png 的那一刻，正是用户
      //   盯着屏幕的时候：侧栏既不列它、也不挂那句"另有 N 个更深层文件"，要刷新才知道有。
      //   单发一个事件而不是改 files 的载荷形状：files 一直是裸字符串数组，老界面包直接吃它。
      try { broadcast("filesmeta", { deeper: dirStateDeep(outDir).deeper }) } catch { /* 数不出来就不发，不影响正文 */ }
      const rendered = changed.map((n) => ({ name: n, render: WF.rendererFor(n) })).filter((x) => x.render)
      if (rendered.length) broadcast("artifacts", rendered)
      if (modId !== "chat") {
        try {
          const st = wfSyncDone(outDir, modId)
          if (st) broadcast("workflow", { cur: st.cur || null, done: st.done || [], failed: st.failed || [], implied: st.implied || [], stale: st.stale || [], staleUp: st.staleUp || [], halted: st.halted || null, gateBypass: gateBypassed(sid) })
        } catch (e) { console.warn(`[workflow] 进度同步失败：${e.message}`) }
      }
      warmPreviews(outDir, changed)
    }
    // 异常收场：先记下"停在哪一步、为什么"，再补齐轮末同步，最后才走各自的报错分支。
    // 顺序要紧：halted 必须在 syncTail 之前落盘，syncTail 广播的 workflow 事件才带得上它 ——
    // 否则界面要等到下一次刷新才知道这一步是被中断的，中间那段时间它是个绿格子。
    const haltReason = job.aborting ? "aborted" : job.timedOut ? "timeout"
      : job.cloudQuotaHit || job.quotaHit ? "quota" : job.loopHit ? "loop"
      : job.gateBlock ? "gate" : job.moduleHit ? "denied"
      : promptErr || job.modelError ? "error" : null
    if (haltReason) {
      // 停在哪一步 = 本轮【第一个】技能对应的那一步，与直播/回放的分组口径一致（第一个说了算）。
      let hitId = null
      try {
        const first = [...job.skills.keys()][0]
        if (first && modId !== "chat") {
          const form = (wfLoad(await sessionOut(sid)) || {}).form || {}
          const own = (s) => s.skill === first || (s.skillAlias || []).includes(first)
          hitId = (WF.stepsFor(modId, form) || []).find(own)?.id || null
        }
      } catch { /* 认不出就只记原因，界面退回"本轮被中断"的通用说法 */ }
      if (modId !== "chat") await wfMarkHalted(sid, hitId, haltReason)
      try { await syncTail() } catch (e) { console.warn(`[tail] 异常轮收尾同步失败：${e.message}`) }
    }
    if (job.aborting) return finish()                       // 用户显式终止：job.abort 已广播 aborted
    if (job.timedOut) return finish()                       // 首事件看门狗已收场并广播过原因（prompt 此刻才姗姗返回/报错），别再报一遍
    if (job.cloudQuotaHit) return finish()                  // 云端积分用尽已收场并广播过原因（同上），别再报一遍
    if (job.loopHit) { broadcast("failed", { message:
      `本轮检测到卡死并已中止：同一条命令被【重新调用】了 8 次以上（\`${job.loopHit}\`），说明它撞上了一个自己看不出来的错误（工具被中止时不会把已产生的输出交给 agent，它每次都是瞎的）。再跑下去只会白烧时间与额度。` +
      (job.loop?.out ? `\n\n最后一次执行的真实输出（末 800 字，网关抓到的）：\n\`\`\`\n${job.loop.out.slice(-800)}\n\`\`\`\n把上面这段连同你的要求一起重发，agent 就能对症下药。` : `\n\n这条命令一个字的输出都没有，多半是路径不存在或解释器没找到。请手动跑一次拿到报错，或换一种做法重发。`) }); return finish() }
    if (job.gateBlock) {
      const g = job.gateBlock
      const names = await gateNames(sid, modId, g.gates)
      const backs = await gateBackNames(sid, modId, g.gates)
      broadcast("failed", { message:
        `质量闸未过就出件，本轮已中止：「${names.join("、")}」当前判定为未通过，而你调用了「${g.skill}」。\n` +
        // ★ 必须说清【回哪一步改】。只说"重跑那道闸"的话，用户最自然的反应就是再点一次重跑 ——
        //   而闸不会因为重跑变绿，稿子没改它还是红的。onFail 数据里一直有，这里第一次用上。
        (backs.length ? `先回到「${backs.join("」/「")}」把问题改掉，再重跑这道闸。\n` : "") +
        `报告里写着什么就是什么——改完稿子【必须重新跑一遍那道闸】、让它写出新报告，才算通过；` +
        `拿上一版报告、或自己在报告里标注"已处理"，都不算。\n` +
        `Markdown 稿件不受影响、照常产出，你随时能看到内容；只有 Word/PDF 送审件要等闸转绿。\n` +
        `如果重跑之后仍被拦，去看新报告里还剩哪几条 Critical/Major：` +
        `**只剩"等用户补事实"（伦理批号、注册号、方案细节待补充）的话不该拦**，` +
        `把这类条目写成"待补充/只能由你提供"的措辞即可，闸不会把它们算成稿件缺陷；` +
        `若剩的是真的方法学硬伤，那就还得改稿。\n` +
        // ★ 出口必须写在这条消息里。判据是关键词匹配、必有误判（英文报告尤甚），被误判的用户看到的
        //   就是这段文案 —— 不告诉他有放行开关，他面前就是一堵没有尽头的墙，而重跑闸并不会让墙消失。
        `**如果你判断这是误判**（报告通篇英文、或结论其实是"接收/无严重问题"却被读成红），` +
        `点流程条右上角的「仍要出件」就能放行本会话的拦截，闸的红字照旧保留、你自己心里有数即可。` })
      return finish()
    }
    if (job.moduleHit) { broadcast("failed", { message: modSkills
      ? `模块限制：本会话是「${MODULE_DEFS[modId]?.name || modId}」专用模块，只能使用「${modSkills.join("、")}」技能；检测到调用「${job.moduleHit}」，本轮已中止。${skillHome(job.moduleHit, modId) || "此类需求请到「自由对话」模块新开会话。"}`
      : `技能未开通：你的账号未开通「${job.moduleHit}」技能，本轮已中止。如需使用请联系管理员开通。` }); return finish() }
    if (job.quotaHit) { broadcast("failed", { message: `本轮已达今日额度上限（${creditsText(DAILY_COST_LIMIT)} 积分），已自动中止；明日 0 点(UTC)恢复。` }); return finish() }
    if (promptErr) {
      if (job.finished) return finish()
      // 出错时【绝不】新建空会话重放消息——会丢光多轮上下文；如实报错，真失效时用户点「新对话」。
      const msg = String(promptErr?.message || promptErr)
      const gone = /not found|no such session|does not exist|404/i.test(msg)
      console.warn(`[prompt] 会话 ${sid} 本轮失败：${errChain(promptErr)}`)   // 服务端留全链，前端只看人话
      broadcast("failed", { message: gone ? "该会话已失效，请点「新对话」重新开始。" : ("本轮出错：" + explainNetErr(promptErr) ) })
      return finish()
    }
    if (job.finished) return finish()
    const finalText = (result?.parts ?? []).filter(x => x.type === "text").map(x => x.text).join("\n")
    // 上游把这一轮判错了：先把已经流出来的半截正文定稿，再如实报错收尾。
    // 【不能只 final 一下就 done】那正是"空气泡"的来源：用户看不出是出错还是模型没话说。
    if (job.modelError) {
      if (finalText) broadcast("final", { text: autoStripSentinel(finalText) })
      broadcast("failed", { message: describeModelError(job.modelError, currentRoute()) })
      return finish()
    }
    broadcast("final", { text: autoStripSentinel(finalText) })   // 哨兵是无人值守的协议标记，不渲染给用户
    // 没报错也没正文：不常见，但同样不能默默收场（多半是上游返回了空 choices）。
    // 用 notice（气泡内提示）而不是 failed：本轮技术上确实正常结束了，产物/工具结果还在。
    if (!finalText.trim()) broadcast("notice", { message: "模型这一轮没有返回任何文本。若反复如此，多半是上游模型服务异常，请换个模型或联系管理员。" })
    // 产物侧栏（只推本轮新建/改动的）+ 结构化渲染器 + 步骤进度（产物出现 = 该步完成，不问 agent）。
    // 放在正文广播之后，别让簿子出问题拖累正文。异常收场那几条分支在上面已经调过同一个函数。
    await syncTail()
    // ★ 复检一次「用户是不是刚点了终止」。上面那些早退判定是在 await 之【前】做的，而 syncTail
    //   现在是 async（原来那段轮末同步是同步代码，中间没有让出事件循环的机会）—— 这一个 await
    //   就给终止开了一道缝：判定通过 → 让出 → 用户点终止 → 回来照样往下走，于是【终止之后
    //   又自动续了一轮】。autoStates.delete 拦不住它，因为 autoDecide 已经在下面一行了。
    //   实测：autopilot 的「循环中终止：立即停且不再自动续跑」间歇性失败（终止后多注入 1 条）。
    if (job.aborting || job.finished) return finish()
    // ---- 无人值守：只有走到这里的轮（正常收尾）才考虑续跑；出错/终止/越权/封顶都在上面 return 了 ----
    const av = autoDecide(sid, finalText)
    if (av && !av.go && av.note) broadcast("notice", { message: av.note })
    if (av?.go) broadcast("auto", { round: av.round, max: AUTO_MAX_ROUNDS })   // 前端据此在 done 后自动接流下一轮
    broadcast("done", {})
    finish()
    // finish() 已把本轮从 jobs 表摘除；同一 tick 里同步起下一轮 —— /api/busy 与前端 attach 都无空窗，
    // 也不给并发的 /api/chat/start 留下双开同会话的缝（那边的 running 检查到 startJob 是全同步区）。
    if (av?.go && !jobs.get(sid)?.running) startJob(sid, autoContinueText(av.round), modId)
  })().catch(() => { try { broadcast("failed", { message: "本轮出错（网关内部异常）" }) } catch {} finish() })
  return job
}
// 给一个 SSE 连接订阅 job：先重放快照（技能/工具/思考/已生成文本），再接后续直播；断开只退订
function attachJob(job, req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
  sseWrite(res, "session", { id: job.sid })
  for (const d of job.skills.values()) sseWrite(res, "tool", d)
  for (const d of job.tools.values()) sseWrite(res, "tool", d)
  for (const d of job.reasoning.values()) sseWrite(res, "reasoning", d)
  if (job.text) sseWrite(res, "text", job.text)
  for (const d of job.notices || []) sseWrite(res, "notice", d)   // 见 job.notices：放行警告这类不能因为刷新就没
  job.subs.add(res)
  req.on("close", () => job.subs.delete(res))
}

// ==== 云端积分用尽：让"额度触顶"看得见 =======================================
//
// 本机 env 额度（DAILY_COST_LIMIT）那条链路本来是完整的：起轮前 quotaOver() 拦下、轮内
// updateRunning() 中途封顶、收尾广播一条说清原因的 failed。但【打包版走的是云端账号积分】，
// 它的 DAILY_COST_LIMIT 通常压根没设（见 /api/quota 处的注释），于是那三道对它全部形同不存在：
//   · 起轮前不拦 —— 明知积分已用尽也照发；
//   · 轮内没人认得云端回的 429 QUOTA_EXCEEDED —— cloudForward 只是把它原样透传给 opencode；
//   · 而 opencode 把 429 当"限流"退避重试，此刻首输出看门狗【已经被撤掉】了（轮内触顶意味着
//     前面已经出过字，sawOutput=true），于是没有任何超时会来收场。
// 三道都不响，用户看到的就是：转圈圈一直转到自己放弃，一个字的提示都没有。这一节就是治它。
//
// 修法：在唯一能第一时间看见真相的地方 —— cloudForward 收到 429 且 code=QUOTA_EXCEEDED ——
// 当场记一笔，并像本机封顶那样掐掉在跑的轮、广播说清"哪条线用尽、什么时候恢复"的 failed。
//
// 【为什么当场广播而不是只置标记、等 session.prompt 返回】opencode 认为 429 是限流，会先退避
// 睡一会儿再重试，退避期间 abort 未必立刻生效 —— 等它就等于让转圈继续。所以照首输出看门狗
// 那套办法办：当场报错收场（本轮已花的成本仍会在 prompt 返回后正常结算，与看门狗同一条路）。
// 【为什么要连带 abort】积分是按账号算的：这一步撞了 429，本轮后续每一步都会照样撞回来。
// 【为什么记一段"封顶态"而不是只报这一轮】用户被拦下后第一反应是再发一条。留着这段判定，
// 下一条消息就能立刻拒收（并附上云端原话），不必再赔一轮转圈。
// 两种"发不出去"的封顶，机制相同、对用户的话完全不同，用 kind 区分：
//   · user     —— 你自己的平台积分用尽（云端 QUOTA_EXCEEDED）：等日/月重置或找管理员升档；
//   · upstream —— 平台的上游模型额度用尽（云端 UPSTREAM_QUOTA_EXCEEDED，如火山方舟 5 小时配额
//                 打光）：跟用户的积分【无关】，他一分钱没花掉，只能等恢复或管理员充值/换供应商。
// 把 upstream 说成"你的积分用尽"会招来一堆"我明明还有积分"的质问，反过来也一样糟。
let cloudQuotaBlock = null                   // { kind, message, scope, at }
// 新鲜期分开：用户积分要等 UTC 零点/月初，判定放 5 分钟很安全（起轮前还会再问云端确认）；
// 上游额度随时可能被管理员充值/加一家供应商救活，所以只压 60 秒，过期就让它真去试一次。
const BLOCK_TTL = { user: 5 * 60_000, upstream: 60_000 }
const cloudQuotaBlocked = () => {
  if (!cloudQuotaBlock) return null
  return Date.now() - cloudQuotaBlock.at < (BLOCK_TTL[cloudQuotaBlock.kind] || 60_000) ? cloudQuotaBlock : null
}
/** 仅供测试与排障 */
export const cloudQuotaState = () => cloudQuotaBlocked()

// 每条提示都带上这句：用户此刻最需要知道的是"去哪儿看还剩多少"和"找谁能加"。
const QUOTA_TAIL = "顶栏的「剩余积分」可随时查看；需要更多请联系管理员调整档位。"

/**
 * 与云端网关同一个判据（【美元】口径，不是积分）：这条线是不是真的用尽了。
 * 积分是 floor 过的（见 server/lib/credits.mjs 的取整说明），按"剩余积分 = 0"拒收会连
 * 云端其实还放行的调用一起拒掉（floor 掉的零头还够跑一小步），那就成了我们自己造的假触顶。
 */
const lineExhausted = (l) => !!l && !l.unlimited && Number(l.limitUsd) > 0 && Number(l.usedUsd) >= Number(l.limitUsd)
const cloudQuotaExhausted = (q) => !!q && (lineExhausted(q.daily) || lineExhausted(q.monthly))

/**
 * 云端 429 的 error 体 → 给用户的一句话。
 * 优先用云端原话：哪条线、上限多少积分、什么时候恢复，那边都已经算好写在 message 里了
 * （见 server/lib/gateway.mjs 的额度闸）。只有它缺失时才退回本地兜底措辞。
 */
export function quotaBlockMessage(err) {
  const m = String(err?.message || "").replace(/\s+/g, " ").trim()
  if (m) return m
  if (err?.scope === "monthly") return "本月平台积分已用尽（每月 1 日 0 点(UTC)重置）"
  if (err?.scope === "daily") return "今日平台积分已用尽（每日 0 点(UTC)重置）"
  return "平台积分已用尽（日积分每日 0 点(UTC)重置，月积分每月 1 日重置）"
}

/** 上游额度耗尽时给用户的一句话（云端已把恢复时刻算进 message，那是唯一真正有用的信息）。 */
export function upstreamBlockMessage(err) {
  const m = String(err?.message || "").replace(/\s+/g, " ").trim()
  const base = m || "平台的上游模型额度已用尽（不是你的积分），现在重试不会成功，请联系管理员充值或换一家供应商"
  return base + (m ? "" : "。") + "你自己的积分没有被扣。"
}

/**
 * cloudForward 认出云端的 429 时调用：记下封顶态 + 掐掉在跑的各轮。
 * kind="user" 是用户自己的积分用尽；kind="upstream" 是平台的上游额度用尽（与他的积分无关）。
 */
function noteCloudQuotaExceeded(err, kind = "user") {
  const message = kind === "upstream" ? upstreamBlockMessage(err) : quotaBlockMessage(err)
  const first = !cloudQuotaBlocked()
  cloudQuotaBlock = { kind, message, scope: String(err?.scope || ""), at: Date.now() }
  // 只有"用户积分用尽"才要刷顶栏：上游额度耗尽时用户的积分没变，把缓存清掉只是白问一次云端。
  if (kind === "user") clearCloudQuotaCache()
  if (first) console.warn(kind === "upstream"
    ? `[cloud] 上游模型额度已用尽：${message}`
    : `[cloud] 云端积分已用尽（${cloudQuotaBlock.scope || "?"}）：${message}`)
  // 推给所有在跑的轮：两种封顶都是账号/平台级的，这台机器上任何一轮都撞在同一条线上。
  for (const j of jobs.values()) { if (j.running && j.onQuotaBlock) { try { j.onQuotaBlock(message) } catch {} } }
}

// ==== 云端排队感知 ===========================================================
//
// 云端的并发闸（sci-auth 的 queue.mjs）满了以后，请求会在服务端排队等位。这段时间 HTTP 上
// 什么都看不到——响应头还没回——用户面对的就是一个不动的转圈，既不知道在等什么也不知道要
// 等多久，而这一等可能好几分钟。
//
// 所以：只要有请求"已发出、还没回响应头"超过 1.2 秒，就每两秒问一次云端的 /api/queue，
// 把「正在排队，前面还有 N 个」推给前端（chat 流的 queue 事件），同时给首输出看门狗续命 ——
// 否则排队超过 OC_FIRST_EVENT_TIMEOUT_MS 会被误判成"模型服务不可达"而中止本轮。
//
// 【为什么不让云端在排队时先回一段通知】/llm 那条是标准 OpenAI 协议，先塞自定义内容就把协议
// 弄脏了（opencode 与各家 SDK 都会当成畸形响应）。分开一个只读内存的小口最干净。
//
// 【为什么推给"所有在跑的轮"】云端的闸是按用户/全站算的：这台机器上任何一轮撞上排队，同一
// 用户其它在跑的轮也一样在争同一批位子，所以这条提示对它们都成立。桌面版通常也只有一轮在跑。
const CLOUD_Q_PROBE_DELAY_MS = 1200      // 发出多久还没回响应头才开始问队况（正常调用远快于此）
const CLOUD_Q_PROBE_EVERY_MS = 2000
const CLOUD_Q_STALE_MS = 15_000          // 探到的"正在排队"多久算过期（看门狗据它续命）
let cloudInflight = 0                    // 已发往云端、还没拿到响应头的请求数
let cloudQTimer = null
let cloudQBlockedUntil = 0               // 在这个时刻之前，认为"慢是因为在排队/被限速"
let cloudQLast = null                    // 最近一次探到的队况（仅用于日志去重）

/** 此刻是不是"在云端排队/被上游限速"——看门狗用它判断该不该续命而不是掐掉本轮 */
const cloudQueueBlocking = () => Date.now() < cloudQBlockedUntil

/** 仅供测试与排障：当前探到的队况。前端不读这里（它收 chat 流的 queue 事件）。 */
export const cloudQueueState = () => ({ inflight: cloudInflight, blocking: cloudQueueBlocking(), last: cloudQLast })

function broadcastQueue(info) {
  for (const j of jobs.values()) { if (j.running && j.onQueue) { try { j.onQueue(info) } catch {} } }
}

async function probeCloudQueue() {
  if (cloudInflight <= 0) return
  let q = null
  try { const r = await Cloud.fetchQueue(); if (r.ok) q = r.queue } catch { /* 纯附加信息，问不到就算了 */ }
  if (!q || cloudInflight <= 0) return
  const queued = (q.waitingMine || 0) > 0
  const limited = !!q.rateLimited
  if (!queued && !limited) {
    // 刚才在排、现在轮到了 → 明确告诉前端一声，好把"排队中"的提示换回"等待模型输出"
    if (cloudQLast) { cloudQLast = null; broadcastQueue({ queued: false }) }
    return
  }
  cloudQBlockedUntil = Date.now() + CLOUD_Q_STALE_MS
  const info = {
    queued: true, position: q.position || 0, waiting: q.waiting || 0, running: q.running || 0,
    limit: q.limit || 0, etaMs: q.etaMs || 0, waitedMs: q.waitedMs || 0,
    rateLimited: q.rateLimited || null,
  }
  if (!cloudQLast) console.log(`[cloud] 云端正忙：${limited ? "上游限速中" : `排队第 ${info.position} 位（共 ${info.waiting} 个在等，${info.running} 个在跑）`}`)
  cloudQLast = info
  broadcastQueue(info)
}

/** 包住一次云端调用：在途期间开着探测器，回来就关 */
async function withQueueWatch(fn) {
  cloudInflight++
  if (!cloudQTimer) {
    // 【用 setTimeout 自我续期而不是 setInterval】探测本身是异步的，setInterval 在网络慢时会
    // 把请求叠起来；而且 inflight 归零后要能干净停掉。
    const tickQ = async () => {
      cloudQTimer = null
      if (cloudInflight <= 0) return
      await probeCloudQueue()
      if (cloudInflight > 0) { cloudQTimer = setTimeout(tickQ, CLOUD_Q_PROBE_EVERY_MS); cloudQTimer.unref?.() }
    }
    cloudQTimer = setTimeout(tickQ, CLOUD_Q_PROBE_DELAY_MS)
    cloudQTimer.unref?.()
  }
  try { return await fn() }
  finally {
    cloudInflight--
    if (cloudInflight <= 0) {
      if (cloudQTimer) { clearTimeout(cloudQTimer); cloudQTimer = null }
      if (cloudQLast) { cloudQLast = null; broadcastQueue({ queued: false }) }
    }
  }
}

// ==== 云端账号转发 =========================================================
// 把 opencode 打到本机 /cloud/v1/* 的请求，贴上当前 access key 转给 sci-auth 的 /llm/*。
// 计量、额度、模型强制、技能白名单全在服务端做，这里只做三件事：贴 key、透传、过期重试。
const CLOUD_BODY_LIMIT = 32 * 1024 * 1024
async function cloudForward(req, res, u) {
  const base = Cloud.cloudBase()
  if (!base) return send(res, 503, "application/json", JSON.stringify({ error: { message: "未配置云端地址" } }))

  // body 要完整读进来：过期重试时得原样重发一次
  let body
  try {
    const chunks = []; let n = 0
    for await (const c of req) {
      n += c.length
      if (n > CLOUD_BODY_LIMIT) return send(res, 413, "application/json", JSON.stringify({ error: { message: "请求体过大" } }))
      chunks.push(c)
    }
    body = Buffer.concat(chunks)
  } catch { return send(res, 400, "application/json", JSON.stringify({ error: { message: "读取请求体失败" } })) }

  // /cloud/<rest> → 云端的 /llm/<rest>；例外是生图与图片识字，它们在云端各是一条独立通道
  // （/img 按张限额、/ocr 按次限额，都不按 token 计费，见 server/lib/imagegen.mjs 与
  // server/lib/ocrspace.mjs），别把它们套进 /llm 里去。
  const rest = u.pathname.slice(CLOUD_PROXY_PREFIX.length - 1)
  const passthru = rest.startsWith("/img/") || rest.startsWith("/ocr/")
  const fwdPath = (passthru ? rest : "/llm" + rest) + u.search

  const once = async (force) => {
    const a = await Cloud.currentAccess({ force })
    if (!a.ok) return { authFail: a }
    const headers = { "content-type": req.headers["content-type"] || "application/json", authorization: "Bearer " + a.token }
    if (req.headers["x-skill"]) headers["x-skill"] = req.headers["x-skill"]
    headers["x-client-version"] = process.env.APP_VERSION || "dev"
    // 不设超时：推理首字节可以很慢，误杀比挂着更糟（与 sci-auth 侧同一口径）
    return { r: await fetch(base + fwdPath, { method: req.method, headers, body: body.length ? body : undefined }) }
  }

  let out
  try { out = await withQueueWatch(() => once(false)) } catch (e) { return send(res, 502, "application/json", JSON.stringify({ error: { message: "连不上云端：" + (e?.message || "网络错误") } })) }
  if (out.authFail) {
    const err = out.authFail.error || {}
    return send(res, 401, "application/json", JSON.stringify({ error: { code: err.code, message: err.message || "云端账号未就绪" } }))
  }
  let r = out.r
  // 票据在途中过期/被吊销 → 强制续一次再重试。只重试一次，避免账号被停用时打成死循环。
  if (r.status === 401) {
    let code = ""
    try { code = (await r.clone().json())?.error?.code || "" } catch {}
    if (code === "KEY_EXPIRED" || code === "KEY_INVALID" || code === "KEY_MISSING") {
      try {
        const again = await withQueueWatch(() => once(true))
        if (again.authFail) {
          const err = again.authFail.error || {}
          return send(res, 401, "application/json", JSON.stringify({ error: { code: err.code, message: err.message || "登录已失效，请重新登录" } }))
        }
        r = again.r
      } catch { /* 续期本身失败就把原响应透传下去 */ }
    }
  }

  const h = { "content-type": r.headers.get("content-type") || "application/json" }
  const ce = r.headers.get("cache-control"); if (ce) h["cache-control"] = ce

  // ---- 积分用尽就在这里认出来（唯一第一时间知道真相的地方，缘由见「云端积分用尽」一节）----
  // 【为什么整块读下来而不是 r.clone()】这条通道正常情况下是长 SSE 流，clone 会为两个读者
  // 缓冲整条流；而 429 的体只是一小段 JSON，读完再原样写回去没有任何代价。
  // 认出来了也照旧把 429 透传给 opencode：本函数只是【多】做一件事（让用户看见），
  // 协议层的行为一个字节都不改（老客户端与 /cloud 的其它调用方不受影响）。
  if (r.status === 429) {
    const txt = await r.text().catch(() => "")
    let e = null
    try { e = JSON.parse(txt)?.error || null } catch { /* 不是我们的结构化错误（网关外的 429）→ 只透传 */ }
    if (e?.code === "QUOTA_EXCEEDED") noteCloudQuotaExceeded(e, "user")
    // 上游额度耗尽同样要当场收场：opencode 把 429 当限速会退避重试很久，而这个 429
    // 等到恢复时刻之前【一次都不会成功】—— 等它就是让用户白转圈（实测过的第二条入口）。
    else if (e?.code === "UPSTREAM_QUOTA_EXCEEDED") noteCloudQuotaExceeded(e, "upstream")
    res.writeHead(429, h)
    return res.end(txt)
  }
  // 又调通了 = 跨了重置时刻或管理员调高了档位 → 撤掉封顶态，别让旧判定继续拦新消息
  if (r.ok && cloudQuotaBlock) cloudQuotaBlock = null

  res.writeHead(r.status, h)
  if (!r.body) return res.end()
  try {
    // 流式透传：一块来一块走，别攒包（SSE 攒住就没有"边生成边显示"了）
    for await (const chunk of r.body) {
      if (res.writableEnded) break
      res.write(Buffer.from(chunk))
    }
    res.end()
  } catch (e) {
    console.error("[cloud] 上游流中断：" + (e?.message || e))
    try { res.destroy() } catch {}
  }
}

// ==== 下一步输入建议（前端的"接下来可以问"气泡）===========================
// 每轮结束后，前端把「最后一问一答」送来这里，换回 2–3 条用户口吻的短指令；点一下填进输入框
// （【不自动发送】——用户还要改），省去从零打字。
//
// 【为什么不让主 agent 顺带把建议写在答案末尾】主 agent 挂着全套技能与长前言，让它多写一段
// ① 拖慢正文收尾、② 它会把"下一步"当成任务真去执行（实测过 question 工具那类翻车）、
// ③ 建议混在 markdown 正文里没法做成可点气泡。故走一次独立的小请求：不带工具、max_tokens 很小，
// 与主流程完全解耦，失败就当没有建议（前端什么都不显示），绝不影响正文与会话状态。
const SUGGEST_ENABLED = process.env.SUGGEST_ENABLED !== "0"     // 运维可一键关（省额度）
const SUGGEST_MAX_IN = 1200                                     // 一问一答各截多少字送进提示词（成本可控）
const SUGGEST_TIMEOUT_MS = Number(process.env.SUGGEST_TIMEOUT_MS || 20000)
const SUGGEST_MODEL = (process.env.SUGGEST_MODEL || "").trim()   // 想用更便宜的小模型出建议就配它（与上面几个开关一样：改了要重启才生效）
const SUGGEST_MAX_CONC = 3                                      // 同时在途的建议请求上限（防连点刷额度）
let suggestInFlight = 0

/** 建议请求用哪套 API：跟着当前路由走（云端账号 / 静态网关 / 用户自设），可用 SUGGEST_MODEL 换个便宜模型 */
function suggestProvider() {
  const route = currentRoute()
  let p = null
  if (route === "custom") {
    const s = loadModelCfg()
    if (!s?.baseURL || !s?.apiKey || !s?.modelID) return null
    p = { route, baseURL: s.baseURL, apiKey: s.apiKey, modelID: s.modelID }
  } else if (route === "cloud" || route === "gateway") {
    const g = platformProvider()
    if (!g.baseURL || !g.apiKey || !g.modelID) return null
    p = { route, baseURL: g.baseURL, apiKey: g.apiKey, modelID: g.modelID }
  }
  if (!p) return null
  // 换模型要过档位白名单：云端形态下选一个档位没开通的模型，网关会静默打回，白花一次往返
  if (SUGGEST_MODEL && (p.route !== "cloud" || modelAllowed(SUGGEST_MODEL))) p.modelID = SUGGEST_MODEL
  return p
}

const SUGGEST_SYS = [
  "你是科研写作平台的输入助手。根据用户与助手的最近一轮对话，猜用户下一步最可能想让助手做什么，写成可以直接发送的短指令。",
  "要求：",
  "1) 用【用户对助手说话】的口吻（祈使句），不要写成对用户的建议，不要出现“你可以…”“建议您…”。",
  "2) 每条 8–24 个字，具体、可执行；不要“继续”“好的”“再说说”这类空话。",
  "3) 恰好 3 条，方向互不重复：一般是「把当前结果做深一步」「推进到流程下一步」「换个角度检查/补充」各一条。",
  "4) 贴着这段对话的真实内容与已产出的文件说，不要编造不存在的数据、文件名或结论。",
  "5) 只输出一个 JSON 字符串数组，例如 [\"...\",\"...\",\"...\"]；不要解释、不要编号、不要代码块。",
].join("\n")

/** 从模型回复里抠出建议数组：优先当 JSON 解析，退化成按行拆（模型不听话时也别整轮作废） */
function parseSuggestions(text) {
  let s = String(text || "").trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  let arr = null
  const i = s.indexOf("["), j = s.lastIndexOf("]")
  if (i >= 0 && j > i) { try { arr = JSON.parse(s.slice(i, j + 1)) } catch {} }
  if (!Array.isArray(arr)) arr = s.split("\n")
  const out = []
  for (const x of arr) {
    const t = String(x == null ? "" : x)
      .replace(/\s+/g, " ")
      .replace(/^\s*(?:[-*·—]|\d+[.、)）])\s*/, "")          // 行首的项目符号/编号
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")                 // 包裹的引号
      .trim()
    if (t.length < 4 || t.length > 40) continue               // 太短没信息、太长不像气泡（多半是模型在解释）
    if (out.includes(t)) continue
    out.push(t)
    if (out.length >= 3) break
  }
  return out
}

/**
 * 要一批建议。返回 { list, err }：err 只用于日志/调试，前端拿不到建议就静默不显示。
 * 成本按 usage 自己入账（这条请求不经 opencode，session.cost 里没有它，不记就等于绕开每日额度）。
 */
async function suggestNext({ q, a, modName }) {
  const p = suggestProvider()
  if (!p) return { list: [], err: "no-provider" }
  const cut = (s, n) => { const t = String(s || "").trim(); return t.length > n ? t.slice(0, n) + "…（略）" : t }
  const user = [
    modName ? `【当前功能模块】${modName}——本会话只做这一类事，3 条建议都必须落在该范围内。` : "",
    `【用户刚才说】\n${cut(q, SUGGEST_MAX_IN) || "(空)"}`,
    `【助手的回答（节选）】\n${cut(a, SUGGEST_MAX_IN) || "(空)"}`,
    "请给出 3 条下一步指令（JSON 数组）。",
  ].filter(Boolean).join("\n\n")
  const url = p.baseURL.replace(/\/+$/, "") + "/chat/completions"
  // 【必须关思考】平台档位里的火山 deepseek/doubao 系是思考模型：默认先在 reasoning_content 里
  // 推理，真实一问一答下推理轻松吃满 max_tokens，content 空着回来（finish=length）——前端解析出
  // 空数组，「正在想下一步…」气泡闪两秒就撤，且 err 为空连日志都不留。出 3 条短建议不值得思考，
  // 用火山的 OpenAI 兼容扩展字段显式关掉（网关 rewriteBody 只改 model、其余原样透传）。
  // 自设路由可能指向严格校验参数的供应商（OpenAI 之类见到不认识的字段直接 400）→ 去掉该字段重试一次。
  const attempt = (noThink) => fetch(url, {
    method: "POST",
    redirect: "manual",                                    // 与 /api/model/test 同口径：不跟随跳转
    signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),       // 每次尝试各自计时（fetch 不能复用已超时的 signal）
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + p.apiKey },
    body: JSON.stringify({
      // max_tokens 500：给「上游不认 thinking 字段却又要思考」的模型留点余量，思考短的还能把答案挤出来
      model: p.modelID, stream: false, temperature: 0.7, max_tokens: 500,
      ...(noThink ? {} : { thinking: { type: "disabled" } }),
      messages: [{ role: "system", content: SUGGEST_SYS }, { role: "user", content: user }],
    }),
  })
  try {
    let r = await attempt(false)
    if (r.status === 400 || r.status === 422) r = await attempt(true)
    if (!r.ok) return { list: [], err: "http-" + r.status }
    const j = await r.json().catch(() => null)
    const content = j?.choices?.[0]?.message?.content || ""
    // 入账：走的是同一条计费通道，漏记就是给"无限点建议"开了个不花钱的口子
    try {
      const price = (p.route === "cloud" ? costOfModel(p.modelID) : null) || _modelCost()
      const inTok = Number(j?.usage?.prompt_tokens) || 0, outTok = Number(j?.usage?.completion_tokens) || 0
      const cost = inTok / 1e6 * (price.input || 0) + outTok / 1e6 * (price.output || 0)
      if (cost > 0) addCost(cost)
    } catch {}
    const list = parseSuggestions(content)
    // 空手而归也要留下线索：过去「content 为空 / 解析不出」err 是空串，一行日志都没有，
    // 排查只能靠去上游账单里数 completion_tokens —— 这次就是这么破的案（思考吃满 max_tokens）。
    return { list, err: list.length ? "" : (content.trim() ? "unparsable-content" : "empty-content") }
  } catch (e) {
    return { list: [], err: e?.name === "TimeoutError" ? "timeout" : (e?.message || "fetch-failed") }
  }
}

// ---- 变量对应：模型修正那一段（规则版在 workflows.mjs 的 guessVarMap，那是先验也是兜底）----
//
// 【它比规则强在哪】规则只认列名字面 + 取值形状，认不出【语义】：
//   · 「术后1年状态」= 终点事件（规则的关键词表里没有"术后1年"）；
//   · 「T1/T2/T3/T4」那一列是分期而不是分组；
//   · 一张表里同时有「入院日期」「出院日期」「随访月数」时，谁是随访时长。
// 【它必须被关住的地方】模型很容易顺手"造一个更合理的列名"。所以这里【只收列名，不收自由发挥】，
// 收回来还要逐个对着真表头核，越界的一律丢弃 —— 一个编出来的列名会一路灌进任务卡，
// 而"列名对不上"正是这整套控件要根治的失败模式本身。
const PREVIEW_ROWS = Number(process.env.PREVIEW_ROWS || 5)      // 抽几行给用户看 / 给模型看
const AUTOMAP_TIMEOUT_MS = Number(process.env.AUTOMAP_TIMEOUT_MS || 25000)
const AUTOMAP_ENABLED = process.env.AUTOMAP_ENABLED !== "0"     // 关掉就只剩离线规则（照样能用）
const AUTOMAP_ROLES = [
  ["groupCol", "分组列：区分组别的那一列（治疗组/对照组、术式…）。不是性别、不是分期，除非表里真的拿它当分组"],
  ["outcomeCol", "结局列：要解释或预测的那个结果（是否复发、住院天数）"],
  ["timeCol", "随访时间列：从起点到终点事件或末次随访的【时长】。日期列不算——那是某一天，不是多久"],
  ["eventCol", "终点事件列：1=事件发生（死亡/复发），0=删失。必须是两值列"],
  ["testCol", "待评价指标列（ROC 用）：要评价诊断效能的那个连续检测值"],
  ["goldCol", "金标准列（ROC 用）：公认的确诊依据（病理结果…），两值列"],
  ["covars", "需要校正的协变量（数组）：年龄、性别、分期这类要放进模型的因素"],
].map(([k, d]) => `- ${k} —— ${d}`).join("\n")
const AUTOMAP_SYS = [
  "你在帮一位不熟悉统计术语的临床医生，把他表格里的列对应到分析要用的角色上。",
  "你会看到每一列的画像（类型、取值个数、实际取值与例数）和表的前几行原样。",
  "要对应的角色：",
  AUTOMAP_ROLES,
  "铁律：",
  "1) 只能填【给定表头里原样出现过的列名】，一个字都不能改，更不许编一个表里没有的列名。",
  "2) 认不准就【不要填这个角色】（留空或省略），空着比填错好得多——填错不会报错，只会产出一份看着很正常的错结果。",
  "3) 标识列（住院号/编号/ID）不能充当任何角色。",
  "4) why 里写你的依据，一句话，要引用【看得见的证据】（列名、取值与例数），不要写“通常”“一般来说”。",
  "5) conf 只能是 high 或 med：列名与取值形状都对上了才是 high。",
  '6) 只输出一个 JSON 对象，形如 {"map":{"groupCol":"组别","covars":["年龄","性别"]},"why":{"groupCol":"..."},"conf":{"groupCol":"high"},"notes":["..."]}；不要解释、不要代码块。',
].join("\n")

// 模型那一版的结果缓存（键 = 文件身份 + 勾了哪些分析）。**只缓存成功的那次**：
// 超时 / 网关 429 / 解析不出都不入缓存，否则一次抖动就把"只有规则版"钉死到进程结束，
// 而用户唯一能做的补救是重传文件 —— 与 index.html 表头缓存那处踩过的是同一个坑。
const _amCache = new Map()
const AM_CACHE_MAX = 64
const AUTOMAP_MAX_CONC = 2      // 同时在途的自动认列请求上限。它由页面装载触发（多标签/多用户
let automapInFlight = 0         // 很容易并发），而每一个都会起一个 pandas 进程——容器内存就那么点
async function automapCached(file, analyses, run) {
  let key = file
  try { const st = fs.statSync(file); key = `${file}|${st.mtimeMs}|${st.size}` } catch {}
  key += "|" + (Array.isArray(analyses) ? analyses.join(",") : "")
  if (_amCache.has(key)) {
    const hit = _amCache.get(key)
    if (!hit.__negUntil || Date.now() < hit.__negUntil) return hit
    _amCache.delete(key)                  // 负缓存到期：可以再试一次了
  }
  const r = await run()
  if (r?.used) {
    if (_amCache.size >= AM_CACHE_MAX) _amCache.delete(_amCache.keys().next().value)
    _amCache.set(key, r)
  } else if (r) {
    // ★ 失败也要短暂记一笔。原来只缓存 used===true 的结果，于是模型持续超时 / 返垃圾时，
    //   【每次装载面板都重打一次】—— 进模块一次、切表一次、刷新一次、恢复会话又一次，
    //   每次都要等满 AUTOMAP_TIMEOUT_MS 才回落到规则版，用户对着"正在读表、自动认列…"干等。
    //   60 秒负缓存：既不至于把一次网络抖动钉死，也挡住了连点。
    if (_amCache.size >= AM_CACHE_MAX) _amCache.delete(_amCache.keys().next().value)
    _amCache.set(key, { ...r, __negUntil: Date.now() + 60_000 })
  }
  return r
}

/** 让模型看同一份画像去修正规则版。返回 { map, why, conf, notes, used, err }；失败一律静默回退到规则版。 */
async function automapLLM(pv, base, analyses) {
  if (!AUTOMAP_ENABLED) return { used: false, err: "disabled" }
  const p = suggestProvider()
  if (!p) return { used: false, err: "no-provider" }
  const want = Array.isArray(analyses) && analyses.length ? `\n\n【用户勾了这些分析】${analyses.join("、")}——和它们无关的角色可以不填。` : ""
  const user = [
    WF.describeCols(pv.cols, pv.rows || [], pv.headers),
    `\n【合法列名（只能从这里面选，原样照抄）】\n${pv.headers.join(" | ")}`,
    `\n【规则先验（按列名与取值形状粗判的，你可以推翻）】\n${JSON.stringify(base.map)}`,
    want,
    "\n请给出你的对应结果（JSON）。",
  ].join("\n")
  const url = p.baseURL.replace(/\/+$/, "") + "/chat/completions"
  // 关思考：与 suggestNext 同一个坑——火山那几档是思考模型，推理会吃满 max_tokens 让 content 空着
  // 回来（finish=length），前端解析出空对象、还什么日志都不留。不认这个字段的上游会 400，去掉重试一次。
  const attempt = (noThink) => fetch(url, {
    method: "POST", redirect: "manual",
    signal: AbortSignal.timeout(AUTOMAP_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + p.apiKey },
    body: JSON.stringify({
      model: p.modelID, stream: false, temperature: 0, max_tokens: 900,
      ...(noThink ? {} : { thinking: { type: "disabled" } }),
      messages: [{ role: "system", content: AUTOMAP_SYS }, { role: "user", content: user }],
    }),
  })
  try {
    let r = await attempt(false)
    if (r.status === 400 || r.status === 422) r = await attempt(true)
    if (!r.ok) return { used: false, err: "http-" + r.status }
    const j = await r.json().catch(() => null)
    const content = j?.choices?.[0]?.message?.content || ""
    // 入账：与 suggestNext 同一条计费通道，漏记等于给这个接口开了个不花钱的口子
    try {
      const price = (p.route === "cloud" ? costOfModel(p.modelID) : null) || _modelCost()
      const inTok = Number(j?.usage?.prompt_tokens) || 0, outTok = Number(j?.usage?.completion_tokens) || 0
      const cost = inTok / 1e6 * (price.input || 0) + outTok / 1e6 * (price.output || 0)
      if (cost > 0) addCost(cost)
    } catch {}
    let obj = null
    const s = content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim()
    const i = s.indexOf("{"), k = s.lastIndexOf("}")
    if (i >= 0 && k > i) { try { obj = JSON.parse(s.slice(i, k + 1)) } catch {} }
    if (!obj || typeof obj !== "object") return { used: false, err: content.trim() ? "unparsable" : "empty-content" }
    const notes = Array.isArray(obj.notes) ? obj.notes.map(String).filter((x) => x && x.length < 200).slice(0, 4) : []
    return { used: true, map: obj.map || {}, why: obj.why || {}, conf: obj.conf || {}, notes, err: "" }
  } catch (e) {
    return { used: false, err: e?.name === "TimeoutError" ? "timeout" : (e?.message || "fetch-failed") }
  }
}

// 导出供自动化测试拿端口/关闭；生产路径不受影响（下面照常 listen）
export const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost")
  try {
    // 登录页：未登录的局域网访客看到它；已登录/本机则直接跳回主页
    if (req.method === "GET" && u.pathname === "/login") {
      if (authed(req)) { res.writeHead(302, { Location: BASE_PATH + "/" }); return res.end() }
      // 多用户部署（BASE_PATH 非空 = 前面有 manager）：容器自带的登录页是条死路——
      // manager 的 POST /<user>/api/login 强制校验图形验证码，而本容器的 login.html 根本不发验证码，
      // 从这里提交必然「验证码错误」。故送去 manager 的验证码门户（LOGIN_URL 已按 BASE_PATH 取好）。
      // 单机/局域网部署（BASE_PATH 为空、无 manager）仍用本地 login.html。
      if (BASE_PATH) { res.writeHead(302, { Location: LOGIN_URL, "Cache-Control": "no-store" }); return res.end() }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      return res.end(fs.readFileSync(path.join(__dirname, "login.html")))
    }
    // 校验密码 → 发 token Cookie
    if (req.method === "POST" && u.pathname === "/api/login") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let user = "", pw = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); user = (b.username || "").trim(); pw = (b.password || "").trim() } catch {}
      // 与 /api/password 共用同一把锁。此前只给改密加了限流，而这里【完全没有】——
      // 而 pwGuard 的理由是"能打到容器 3000 端口的人可以盲猜密码"，那个前提对本接口同样成立，
      // 且这里猜中直接拿到合法 cookie，比改密更直接。只给改密限流等于锁了后门开着前门。
      // 共用一把锁也让两条路径的失败次数合并计数，攻击者无法靠换接口重置计数。
      if (Date.now() < pwGuard.lockedUntil) {
        const mins = Math.ceil((pwGuard.lockedUntil - Date.now()) / 60000)
        return send(res, 429, "application/json", JSON.stringify({ ok: false, err: `尝试次数过多，请 ${mins} 分钟后再试` }))
      }
      if (user !== LAN_USER || pw !== effectivePassword()) {
        pwGuard.fails++
        if (pwGuard.fails >= PW_MAX_FAILS) { pwGuard.lockedUntil = Date.now() + PW_LOCK_MS; pwGuard.fails = 0 }
        await new Promise((r) => setTimeout(r, 600))
        return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "账号或密码错误" }))
      }
      pwGuard.fails = 0
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": setAuthCookie(req) })
      return res.end(JSON.stringify({ ok: true }))
    }
    // 退出登录：签名 cookie 无服务端状态，清掉浏览器 cookie 即可（本人登出足够）
    if (req.method === "POST" && u.pathname === "/api/logout") {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": clearAuthCookie(req) })
      return res.end(JSON.stringify({ ok: true }))
    }
    // ---- 云端账号转发：opencode → 本机 /cloud/v1/* → sci-auth /llm/* ----
    // 必须在门禁【之前】：调用方是本机 opencode，它没有 lan_auth cookie。
    // 但绝不能因此变成公开代理 —— 两道闸：① 只收回环来源；② 必须带本进程本次启动生成的
    // CLOUD_LOCAL_TOKEN。否则同一台机上的其他程序（或局域网访客经某种转发）就能白嫖你的云端额度。
    if (u.pathname.startsWith(CLOUD_PROXY_PREFIX)) {
      if (!isLocal(req)) return send(res, 403, "application/json", JSON.stringify({ error: { message: "仅限本机" } }))
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s*/i, "").trim()
      if (bearer !== CLOUD_LOCAL_TOKEN) return send(res, 401, "application/json", JSON.stringify({ error: { message: "本机转发令牌不正确" } }))
      return cloudForward(req, res, u)
    }

    // 门禁：其余路径若未登录 → 页面跳登录页、接口回 401
    if (!PUBLIC_PATHS.has(u.pathname) && !authed(req)) {
      if (req.method === "GET" && (req.headers.accept || "").includes("text/html")) {
        // 多用户部署直接送到站点根的统一登录页（带验证码），少一跳、也避开容器 login.html 那条死路
        res.writeHead(302, { Location: LOGIN_URL, "Cache-Control": "no-store" }); return res.end()
      }
      return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "unauthorized" }))
    }
    // ↓↓↓ 以下路由都已过门禁：未登录的请求走不到这里 ↓↓↓

    // 忙碌探针：宿主的 manager 在「空闲停机 / 满员腾位」前问一句「这容器还有活在跑吗」。
    // 本网关的设计是「关页面 = 只退订，生成继续跑」（见 /api/chat/attach），但 manager 只看得见
    // HTTP 连接：页面一关 SSE 就断、conns 归 0，它便会把正在跑十几分钟的流水线连容器一起停掉。
    // 故这里把「有无在跑的 job」暴露给它。manager 用 docker exec 从容器【内部】打 127.0.0.1 来问，
    // 命中 isLocal 免鉴权 —— 不必把本接口放进 PUBLIC_PATHS：容器彼此在同一 docker 网络里互通，
    // 而每个容器里跑的正是能执行任意代码的 agent，公开它等于让 alice 能探到 bob 在不在干活。
    if (req.method === "GET" && u.pathname === "/api/busy") {
      const running = runningRounds()
      return send(res, 200, "application/json", JSON.stringify({ busy: running > 0, running }))
    }

    // 自助改密码（须已登录 —— 必须留在门禁【之后】）：校验当前密码 → 写 override → 用新密码重签 cookie。
    // 放门禁前等于开了个密码预言机：未登录者能凭「当前密码不正确 / 新密码至少 6 位」两种回包无限盲猜密码，
    // 且绕开 manager 的图形验证码、限流与审计日志。
    if (req.method === "POST" && u.pathname === "/api/password") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let cur = "", nw = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); cur = String(b.current || ""); nw = String(b.new || "") } catch {}
      if (Date.now() < pwGuard.lockedUntil) {
        const mins = Math.ceil((pwGuard.lockedUntil - Date.now()) / 60000)
        return send(res, 429, "application/json", JSON.stringify({ ok: false, err: `尝试次数过多，请 ${mins} 分钟后再试` }))
      }
      if (cur !== effectivePassword()) {
        pwGuard.fails++
        if (pwGuard.fails >= PW_MAX_FAILS) { pwGuard.lockedUntil = Date.now() + PW_LOCK_MS; pwGuard.fails = 0 }
        await new Promise((r) => setTimeout(r, 600))   // 恒定延时：既压猜测速率，也不因"错得快/慢"泄露信息
        return send(res, 401, "application/json", JSON.stringify({ ok: false, err: "当前密码不正确" }))
      }
      pwGuard.fails = 0   // 猜对即清零，避免正常用户偶尔手滑被累计到锁定
      if (nw.length < 6) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "新密码至少 6 位" }))
      try { fs.mkdirSync(path.dirname(PW_OVERRIDE), { recursive: true }); fs.writeFileSync(PW_OVERRIDE, JSON.stringify({ base: sha(LAN_PASSWORD), password: nw })) }
      catch { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: "保存失败" })) }
      // 签名密钥就是「当前有效密码」，改密后旧 cookie 立即失效 → 必须当场用新密码重签一张下发，
      // 否则改密成功的用户下一次请求就被自己踢回登录页。override 已落盘，effectivePassword() 此刻返回新密码。
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": setAuthCookie(req) })
      return res.end(JSON.stringify({ ok: true }))
    }
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })   // 每次取最新页面，避免浏览器缓存旧版
      return res.end(fs.readFileSync(path.join(__dirname, "index.html")))
    }
    // 登录后的模块选择页（工作台）。login.html 登录成功后会先 GET 探测本路由：老版 server.mjs
    // 没有这条 → 404 → login.html 回落直接进 './'，所以界面包先于安装包发布也不会把老客户端跳崩。
    if (req.method === "GET" && u.pathname === "/workspace.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      return res.end(fs.readFileSync(path.join(__dirname, "workspace.html")))
    }
    // 文献研读的专用界面（左原文 / 右助手 / 最右模式条）。它不是 index.html 的一个视图，而是
    // 一个独立页面 —— 那个模块的形状（一篇文献 × 四种模式）与通用壳的"表单 + 步骤条"完全不同。
    // 与 workspace.html 同款容错：老 server.mjs 配新界面包时这里会 404，跳转方那侧要能兜住
    //（见 workspace.html 的 enter() 与 index.html 的 readerRedirect）。
    // 生成器界面（科研作图）。同上：模块的形状（写一句 → 看一张图 → 改一句再来一版）与通用壳
    // 和阅读器壳都对不上，所以自己一页。两条路由并成一条按 ui 名取文件 ——
    // ★ 白名单必须写死。虽然 ui 值来自我们自己的 WORKFLOWS，但这里是 fs.readFileSync 拼路径，
    //   用变量当文件名是路径穿越的经典入口，不给它这个机会。
    const SHELLS = { "/reader.html": "reader.html", "/figure.html": "figure.html" }
    if (req.method === "GET" && SHELLS[u.pathname]) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      return res.end(fs.readFileSync(path.join(__dirname, SHELLS[u.pathname])))
    }

    if (req.method === "POST" && u.pathname === "/api/upload") {
      let sid = u.searchParams.get("sid") || null
      if (!sid) sid = await createSession("web")   // 上传先于对话则现建会话（createSession 会把 directory 定到会话产物目录）
      const ws = await ensureWs(sid)
      // ★ 点号开头的名字要改掉，不能原样存。/api/uploads 列表会 filter 掉 `.` 开头的文件
      //   （那条是给 .preview 这类派生缓存用的），于是拖一个 .DS_Store / .env 进来的结果是：
      //   界面报"✅ 已上传 1 个文件"，而列表里没有、删不掉、还占着配额 —— 传上去就人间蒸发。
      const name = path.basename(u.searchParams.get("name") || "upload.bin").replace(/^\.+/, "_")
      // 流式落盘（不整包缓冲进内存，大文件不再有 ~2×文件大小的内存尖峰）：
      // ① 有 Content-Length 就先预检存储余量（浏览器上传都带），拦在收数据之前；
      // ② 边写临时隐藏文件边累计大小（兜底 chunked 上传），超限即中止并删除；③ 成功才改名就位。
      // 余量始终算上 inflightUploadBytes（其它在传的上传），并发上传彼此可见、不会合谋超限。
      const lim = storageLimitBytes()
      const overMsg = () => JSON.stringify({ ok: false, err: `存储空间不足：已用 ${(storageUsed() / 1048576).toFixed(0)}MB / 上限 ${STORAGE_LIMIT_MB}MB。请删除旧会话或文件后再传。` })
      // storageUsed() 是【同步递归遍历】uploads+outputs 两棵树。chunked 上传（无 Content-Length，
      // fetch 带 ReadableStream body 就是这种）原本每收一个 chunk 就调一次 wouldExceed →
      // 传 100MB 约 1500+ 次全盘遍历，一个有几千产物的卷单次就是几十毫秒 → 事件循环被反复钉死，
      // 同容器的 SSE 直播卡顿、/api/busy 探测超时（manager 会据此误判该容器空闲而回收它）。
      // 故给一个 1 秒 TTL 的缓存：判超限只需要"够不够准"，不需要每字节都精确。
      let _suCache = 0, _suAt = 0
      const storageUsedCached = () => { const t = Date.now(); if (t - _suAt > 1000) { _suCache = storageUsed(); _suAt = t } return _suCache }
      const wouldExceed = (extra) => lim > 0 && storageUsedCached() + inflightUploadBytes + extra > lim
      const declared = Number(req.headers["content-length"])
      const hasLen = Number.isFinite(declared) && declared >= 0
      // 有 Content-Length（浏览器上传都有）：读 body 前就判，超限直接回干净 413（不会在半程掐断连接让浏览器报“Failed to fetch”）；
      // 通过则【预占】declared 到 inflightUploadBytes——并发的下一个上传立刻看得见这份占用，也在读 body 前被干净拦下。
      if (hasLen && wouldExceed(declared)) return sendClose(res, 413, "application/json", overMsg())   // 不收正文就拒 → 必须关连接，否则残留 body 堵死这条 keep-alive
      let reserved = 0
      if (hasLen) { reserved = declared; inflightUploadBytes += reserved }
      const release = () => { inflightUploadBytes -= (hasLen ? reserved : size) }   // 成功改名(计入真实 storageUsed)或失败删除后，把占用撤出
      const dest = path.join(ws.up, name)
      const tmp = path.join(ws.up, "." + crypto.randomBytes(6).toString("hex") + ".part")   // 隐藏 .part：文件列表/产物快照/存储计量都会跳过
      let size = 0, stopped = false   // stopped：chunked 超限掐断后，别再让 data 监听器给 inflight 加字节（否则 release 后仍累加→永久泄漏）
      try {
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(tmp)
          // 无 Content-Length 的 chunked 上传：没法预占，只能边写边把字节计入全局并逐块判超限（超了半程掐断）。
          req.on("data", (c) => {
            if (stopped) return
            size += c.length
            if (!hasLen) { inflightUploadBytes += c.length; if (wouldExceed(0)) { stopped = true; const e = new Error("over"); e.code = "over"; req.unpipe(ws); ws.destroy(e) } }
          })
          req.on("close", () => { if (!req.complete) { const e = new Error("客户端中断上传"); e.code = "aborted"; reject(e) } })
          req.on("error", reject)
          ws.on("error", reject)
          ws.on("finish", resolve)
          req.pipe(ws)
        })
      } catch (e) {
        release(); try { fs.unlinkSync(tmp) } catch {}
        // 这两条都发生在【半程掐断】：客户端可能还在上传，body 必然没读完 → 一律关连接
        if (e.code === "over") return sendClose(res, 413, "application/json", overMsg())
        return sendClose(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e?.message || e).slice(0, 200) }))
      }
      // renameSync 必须包起来：它抛了（dest 已存在同名【目录】→ EISDIR/EPERM、EACCES、跨设备等）
      // 而 release() 在其后 → 本次预占的字节永久留在 inflightUploadBytes 里。累积几次后 wouldExceed()
      // 恒真，该容器【此后所有上传】都回"存储空间不足"，而 /api/storage 显示的用量却完全正常
      // （它读 storageUsed()，不含 inflight）→ 用户和运维都无从判断，只有重启进程能清。
      try { fs.renameSync(tmp, dest) }
      catch (e) {
        release(); try { fs.unlinkSync(tmp) } catch {}
        return send(res, 500, "application/json", JSON.stringify({ ok: false, err: `保存失败：${String(e?.message || e).slice(0, 200)}` }))
      }
      release()
      return send(res, 200, "application/json", JSON.stringify({ ok: true, sid, path: `${relFromRoot(dest)}`, size: fs.statSync(dest).size }))
    }

    if (req.method === "GET" && u.pathname === "/api/files")
      return send(res, 200, "application/json", JSON.stringify([]))   // 页面初始不预载历史产物，只在对话后显示本轮新产物

    // 列出本会话 uploads/ 里已上传的文件（含大小），用于侧栏“上传空间”的常驻展示
    if (req.method === "GET" && u.pathname === "/api/uploads") {
      const sid = u.searchParams.get("sid") || ""
      const dir = sid ? await sessionUp(sid) : UPLOADS
      if (!fs.existsSync(dir)) return send(res, 200, "application/json", "[]")
      const list = fs.readdirSync(dir)
        .filter((f) => !f.startsWith("."))
        .map((f) => { const st = fs.statSync(path.join(dir, f)); return st.isFile() ? { name: f, size: st.size, mtime: st.mtimeMs } : null })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)   // 最新上传在前
      return send(res, 200, "application/json", JSON.stringify(list))
    }

    // 删除本会话某个已上传文件
    if (req.method === "POST" && u.pathname === "/api/upload/delete") {
      const sid = u.searchParams.get("sid") || ""
      const name = path.basename(u.searchParams.get("name") || "")
      const f = path.join(sid ? await sessionUp(sid) : UPLOADS, name)
      if (!name || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "application/json", JSON.stringify({ ok: false }))
      try { fs.unlinkSync(f) } catch (e) { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e) })) }
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    // 会话列表 + 项目分组（排除子 agent 会话，按更新时间倒序）。前端据此分组渲染、算临期提醒。
    if (req.method === "GET" && u.pathname === "/api/sessions") {
      const all = un(await client.session.list()) || []
      const sessions = all
        .filter((s) => !s.parentID)
        .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
        .map((s) => {
          const mod = sessionModule(s.id)
          const m = META.sessions[s.id] || {}
          const projectId = projectOf(s.id)
          // 模块徽标（HEAD 原有）与 项目/钉（会话管理）两组信息都要，前端各用各的。
          // permanent/expiresAt 是 TTL 时代的字段：本身已无意义，但仍固定回「永久」——
          // 界面包可单独热更新，老 index.html 配新 server.mjs 是真实组合，它读这两个字段
          // 决定徽标与临期提醒条；给 true/null 让它显示"永久"、提醒条恒空，不会吓唬用户。
          return { id: s.id, title: s.title || "(未命名)", updated: s.time?.updated || 0, running: !!jobs.get(s.id)?.running,
            module: mod, moduleName: MODULE_DEFS[mod]?.name || mod,
            projectId, pinned: !!m.pinned, permanent: true, expiresAt: null }
        })
      const projects = [...META.projects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((p) => ({ id: p.id, name: p.name, order: p.order ?? 0 }))
      return send(res, 200, "application/json", JSON.stringify({ projects, sessions }))
    }

    // 会话重命名：写回 opencode（title 非 ""/"web" 时自动补名逻辑不会再覆盖它）
    if (req.method === "POST" && u.pathname === "/api/session/rename") {
      const id = u.searchParams.get("id") || ""
      const title = (u.searchParams.get("title") || "").slice(0, 80).trim()
      if (!id || !title) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      try { await client.session.update({ path: { id }, body: { title } }); titledSessions.add(id) }
      catch (e) { return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e) })) }
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    // 钉/取消钉：置顶分组标记（会话永久保留，钉与存活期无关）
    if (req.method === "POST" && u.pathname === "/api/session/pin") {
      const id = u.searchParams.get("id") || ""
      const pinned = u.searchParams.get("pinned") !== "0"
      if (!id) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      sessMeta(id).pinned = pinned
      saveMeta()
      return send(res, 200, "application/json", JSON.stringify({ ok: true, pinned }))
    }

    // 续期：TTL 时代的接口，会话已永久保留 → 保留为空操作，只为老界面包（可单独热更新）调用时不报错
    if (req.method === "POST" && u.pathname === "/api/session/renew") {
      return send(res, 200, "application/json", JSON.stringify({ ok: true, noop: true }))
    }

    // 会话归属项目（拖拽落点）：projectId 传空串/none = 移出项目
    if (req.method === "POST" && u.pathname === "/api/session/project") {
      const id = u.searchParams.get("id") || ""
      let pid = u.searchParams.get("projectId") || ""
      if (!id) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      const m = sessMeta(id)
      if (!pid || pid === "none") delete m.projectId
      else { if (!META.projects.some((p) => p.id === pid)) return send(res, 404, "application/json", JSON.stringify({ ok: false, err: "no such project" })); m.projectId = pid }
      saveMeta()
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    // 新建项目
    if (req.method === "POST" && u.pathname === "/api/project/create") {
      const name = (u.searchParams.get("name") || "新项目").slice(0, 60).trim() || "新项目"
      const p = { id: newId("p_"), name, created: Date.now(), order: META.projects.length }
      META.projects.push(p); saveMeta()
      return send(res, 200, "application/json", JSON.stringify({ ok: true, project: { id: p.id, name: p.name, order: p.order } }))
    }

    // 项目重命名
    if (req.method === "POST" && u.pathname === "/api/project/rename") {
      const id = u.searchParams.get("id") || ""
      const name = (u.searchParams.get("name") || "").slice(0, 60).trim()
      const p = META.projects.find((x) => x.id === id)
      if (!p || !name) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      p.name = name; saveMeta()
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    // 删除项目（只删分组，不删会话；组内会话变回普通会话，照样永久保留）
    if (req.method === "POST" && u.pathname === "/api/project/delete") {
      const id = u.searchParams.get("id") || ""
      const idx = META.projects.findIndex((x) => x.id === id)
      if (idx < 0) return send(res, 404, "application/json", JSON.stringify({ ok: false }))
      META.projects.splice(idx, 1)
      for (const sid of Object.keys(META.sessions)) { const m = META.sessions[sid]; if (m.projectId === id) delete m.projectId }
      saveMeta()
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }


    // 某会话的历史消息（user/assistant 正文），用于断点续问时回显上下文
    if (req.method === "GET" && u.pathname === "/api/history") {
      // 兼容 sid：本接口用 id=，而 /api/outputs、/api/job、/api/download 全用 sid= ——
      // 这种不一致本身就是踩坑源，两个都收下，别让调用方因为传错参数名而拿到"空会话"。
      const id = u.searchParams.get("id") || u.searchParams.get("sid") || ""
      // 错误体【不能】是 []：那是一个能被 r.json() 正常解析的合法空结果，调用方不看状态码就会
      // 把"读取失败"渲染成"这个会话是空的"，用户以为对话丢了。回一个明显不是结果的对象。
      if (!id) return send(res, 400, "application/json", JSON.stringify({ err: "缺少会话 id" }))
      await clearStaleRevert(id)   // 打开会话即自愈：清掉上次编辑遗留的半回退标记，让历史与后续编辑基于完整消息列表
      // 同上：会话被别处删掉时这里拿到的是错误对象而非数组。回 404 说清「会话没了」，
      // 别让它掉进 catch 变成 500「服务异常」—— 两者用户该做的事完全不同。
      const rawMsgs = un(await client.session.messages({ path: { id } }))
      if (!Array.isArray(rawMsgs)) return send(res, 404, "application/json", JSON.stringify({ err: "找不到这个会话（可能已被删除）" }))
      const msgs = rawMsgs
      // 每条消息属于工作流的哪一步：前端据此把对话按步骤分组回显（口径与实现见 WF.stepOfParts）。
      // 拿不到步骤集就退化成不分组 —— 绝不能因为算不出分组而让历史读不出来。
      let hSteps = []
      try {
        const hMod = sessionModule(id)
        if (hMod && hMod !== "chat") hSteps = WF.stepsFor(hMod, (wfLoad(await sessionOut(id)) || {}).form || {})
      } catch { hSteps = [] }
      const stepSeen = new Set()
      let curStep = null
      let turnFixed = false          // 本轮认过步骤没有（与前端 turnStepFixed 同口径）
      const out = []
      for (const m of msgs) {
        const role = m.info?.role
        if (role !== "user" && role !== "assistant") continue
        if (role === "user") turnFixed = false          // user 消息 = 新一轮的边界
        // ★ 步骤要在下面 `if (!text) continue` 【之前】认：只调了工具、一个字都没写的助手消息
        //   在历史里会被丢掉，而它恰恰常常就是这一步开始的标志 —— 漏认的话整步没有归属。
        // ★ 但【一轮只认一次、第一个说了算】，必须与直播口径一致（index.html 的 turnStepFixed）。
        //   原来这里每条都覆盖 curStep，于是一轮跨两个技能时两边分歧：实测 paper 的
        //   data-analysis（只调工具没写字）→ clinical-stats（写了正文"基线表做好了"），
        //   直播把这段归到「数据体检与统计分析」，刷新后归到「基线表 Table 1」——
        //   同一段对话，刷新前后挂在不同的步骤下。grant 的 topic-selection → grant-proposal 同病。
        //   注意仍要【对每条都调】stepOfParts：stepSeen 得继续累积，否则后面几轮会认错步。
        if (role === "assistant") {
          const st = WF.stepOfParts(m.parts, hSteps, stepSeen)
          if (st && !turnFixed) { curStep = st; turnFixed = true }
        }
        let text = (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim()
        text = stripPreamble(text)   // 剥掉注入的工作区前言，只回显真正对话
        if (role === "assistant") text = autoStripSentinel(text)   // 无人值守的完成哨兵与直播口径一致：不给用户看
        if (!text) continue
        // ★ 连续的 assistant 合成一条：opencode 一轮回答常落成多条消息（文字 → 调工具 →
        //   接着文字），一条一个气泡的话，刷新后同一轮回答会碎成好几块。直播时它们是累加进
        //   同一个 .answer 的，所以这个分歧只有刷新 / 切回旧会话才现形 —— 同一段对话两种长相。
        //   「一轮」的边界只有服务端看得到完整消息序列，所以在这里合，别推给前端。
        //   与分享导出的 shareTurns 同口径。
        const prev = out[out.length - 1]
        // 合并进来的这段若带出了步骤、而合并目标还没有归属，就补给它（同一轮只认一次，先来的不覆盖）
        if (role === "assistant" && prev?.role === "assistant") {
          prev.text += "\n\n" + text
          if (!prev.step && curStep) { prev.step = curStep.id; prev.stepName = curStep.name }
        }
        else out.push({ role, text, ...(curStep ? { step: curStep.id, stepName: curStep.name } : {}) })
      }
      WF.fillUserSteps(out)   // 用户提问归到它引出的那一步（理由见函数头注）
      // 这一轮还在生成中：末尾未完成的助手输出交给续流（/api/chat/attach）直播，从历史里剔除避免重复。
      // ★ 但必须先确认【最后一条 user 消息就是本轮发出的那条】。opencode 落盘有延迟，在那个窗口里
      //   lastUser 指向的是【上一轮】的 user 消息，于是上一轮全部 assistant 回复会被当成
      //   "本轮未完成输出"删掉 —— 用户点完发送刷新一下，上一条回答就凭空消失了（实测 4 次命中 2 次）。
      //   对不上就一条都不删：多显示一点未完成输出，远好过让用户以为对话丢了。
      const running = jobs.get(id)
      if (running?.running) {
        let lastUser = -1
        out.forEach((m, i) => { if (m.role === "user") lastUser = i })
        const lastUserText = lastUser >= 0 ? out[lastUser].text.trim() : ""
        const isThisRound = !running.sentUser || lastUserText === running.sentUser
        if (isThisRound)
          return send(res, 200, "application/json", JSON.stringify(out.filter((m, i) => i <= lastUser || m.role === "user")))
        return send(res, 200, "application/json", JSON.stringify(out))
      }
      // ★ 把最后一次失败补回历史末尾。
      //   此前所有 failed/notice 都只走实时 SSE（broadcast 只写当下挂着的订阅者），finish() 一到
      //   jobs.delete 就什么都不剩 —— 用户关了页面去查个房，回来只看到自己那条消息、没有任何回复、
      //   也不知道该不该重发（实测：一轮跑了 10 分钟异常收场，history 里 assistant 零条）。
      //   只在"这一轮确实没留下助手回复"时补，避免与正常回复重复。
      //   ★ 但"末条是 assistant"不等于"这一轮好好结束了"：本轮被系统中止（闸拦、越权、卡死）
      //   之前，模型往往已经吐了一段文字。实测那次被闸拦下的轮，历史末条是
      //   「…自审闸通过。现在排版 Word 送审版。」——然后什么都没有，用户刷新回来只看到它
      //   宣布要排版却没排，完全不知道是被拦了。这类"系统中止"的原因必须补进去，
      //   哪怕这一轮已经有助手回复：它不是"没有回复"，是"被拦了"。
      //   用时间戳判重，避免同一条错误被重复补（历史会被反复拉取）。
      const le = lastError(id)
      const lastMsg = out[out.length - 1]
      const already = lastMsg?.isError && lastMsg?.at === le?.at
      if (le && !already && (!out.length || lastMsg.role === "user" || le.at >= (lastMsg.at || 0)))
        out.push({ role: "assistant", text: `⚠ 上一轮没有正常结束：${le.message}`, isError: true, at: le.at })
      return send(res, 200, "application/json", JSON.stringify(out))
    }

    // 分享：把整个会话导出成一个自包含 HTML（思考与工具调用默认折叠；产出文件一概不带）。
    // 为什么走服务端而不是前端序列化 DOM —— 见 shareTurns 上方那段注释，那是本功能唯一的致命坑。
    if (req.method === "GET" && u.pathname === "/api/share/export") {
      const id = u.searchParams.get("sid") || u.searchParams.get("id") || ""
      // 错误一律回 HTML/纯文本而不是 JSON：这个 URL 是【直接导航】过去的（要触发浏览器下载），
      // 出错时用户看到的就是这个页面本身，回一坨 JSON 等于让他自己解码。
      if (!id) return send(res, 400, "text/plain; charset=utf-8", "缺少会话 id")
      let msgs, title = ""
      try {
        msgs = un(await client.session.messages({ path: { id } }))
        title = un(await client.session.get({ path: { id } }))?.title || ""
      } catch (e) { return send(res, 502, "text/plain; charset=utf-8", `读取会话失败：${explainNetErr(e)}`) }
      // id 不存在时 SDK 不抛，回的是 NotFoundError 的 data —— 与「会话是空的」是两回事，分开说
      if (!Array.isArray(msgs)) return send(res, 404, "text/plain; charset=utf-8", "找不到这个会话（可能已被删除）")
      const turns = shareTurns(msgs)
      if (!turns.length) return send(res, 404, "text/plain; charset=utf-8", "这个会话还没有内容，没什么可分享的")
      // ★ 把流程与闸的结论一并存进导出件。不带的话，一份"闸没过、用户点了「仍要出件」才产出"
      //   的稿子导出去，收件人（导师 / 合作者 / 编辑）看不出闸没过 —— 放行警告是 notice 不落盘，
      //   拦截解释在 _lasterror.json 里下一轮就被清。这是状态不是文件，不违反"产出一概不进分享"。
      let flow = null
      try {
        const fmod = sessionModule(id)
        if (fmod && fmod !== "chat") {
          const fst = wfSyncDone(await sessionOut(id), fmod)
          if (fst) flow = { steps: WF.workflowFor(fmod, fst.form || {})?.steps || [],
            done: fst.done || [], failed: fst.failed || [], implied: fst.implied || [], stale: fst.stale || [],
            bypass: gateBypassed(id) }
        }
      } catch (e) { console.warn(`[share] 流程状态读不到，导出件不带这一块：${e.message}`) }
      const html = shareHtmlFromMessages(msgs, { title: title.split("\n")[0].slice(0, 60) || "会话记录", flow })
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": contentDisposition(shareFileName(title.split("\n")[0])) })
      return res.end(html)
    }

    // 删除一个会话（连同 outputs/uploads 目录与元数据一并清；进行中的生成先终止）
    if (req.method === "POST" && u.pathname === "/api/session/delete") {
      const id = u.searchParams.get("id") || ""
      if (!id) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      // ★ 如实回报分段结果。原来无条件 {ok:true}：删目录成功、删 opencode 会话失败时，
      //   界面收到"成功"，而会话原样回到列表 —— 用户看到"没删掉"就再点一次，
      //   可十天的稿子在第一次点的时候就已经没了。
      const r = await hardDeleteSession(id)   // 目录解析次序等要紧逻辑已并入该函数
      if (r.ok) return send(res, 200, "application/json", JSON.stringify({ ok: true }))
      return send(res, 200, "application/json", JSON.stringify({ ok: false, ...r,
        err: !r.ocOk ? "后台没能删掉这个会话（它还会留在列表里）；产物文件已经清掉了，请稍后重试。"
                     : "会话已删除，但它的产物目录没能清掉（后台暂时不可用），空间稍后才会释放。" }))
    }

    // 编辑历史消息：回退到第 uindex 个用户消息（含）之前，opencode 会丢弃其后的消息；
    // 之后前端把编辑后的内容当新消息重发。uploads/ 与 outputs/ 均在 .gitignore 里，
    // opencode 基于 git 快照的回退不会动它们 —— 满足“文件不变”。
    if (req.method === "POST" && u.pathname === "/api/revert") {
      const sid = u.searchParams.get("sid") || ""
      const uindex = Number(u.searchParams.get("uindex"))
      if (!sid || !Number.isInteger(uindex) || uindex < 0) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      // 该会话正在生成 → 拒绝回退：此刻 opencode 正往消息列表写，revert 会把状态搅乱、本轮收尾行为未定义。
      // （前端 activeES 一般已拦，但双开/attach 失败时前端拦不住，这里兜底。）
      if (jobs.get(sid)?.running) return send(res, 409, "application/json", JSON.stringify({ ok: false, err: "本轮生成进行中，无法编辑，请等结束后再试" }))
      pendingReverts.delete(sid)   // 重新发起编辑 → 上一次未提交的暂存作废，让下面的自愈把它撤干净再重算
      await clearStaleRevert(sid)   // 先清掉上一次没提交的残留回退，确保 uindex→messageID 对着完整消息列表算，而非回退视图
      const rawMsgs = un(await client.session.messages({ path: { id: sid } }))
      if (!Array.isArray(rawMsgs)) return send(res, 404, "application/json", JSON.stringify({ ok: false, err: "找不到这个会话（可能已被删除）" }))
      const msgs = rawMsgs
      const target = msgs.filter((m) => m.info?.role === "user")[uindex]   // 按顺序取第 uindex 个用户消息
      if (!target?.info?.id) return send(res, 404, "application/json", JSON.stringify({ ok: false, err: "message not found" }))
      // 【先登记后 revert】：若反过来（revert 落地后才登记），并发 history 的 clearStaleRevert
      // 在它自己的 session.get 返回后重查登记表时可能还查不到（revert 已在 opencode 落地、
      // 这里的 set 还没执行），照样把新回退撤掉。先登记则重查必命中，窗口闭合；revert 失败再摘掉。
      pendingReverts.set(sid, Date.now())
      try { await client.session.revert({ path: { id: sid }, body: { messageID: target.info.id } }) }
      catch (e) { pendingReverts.delete(sid); return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e) })) }
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
    }

    // 文件取不到时给人话。裸 "not found" 既是英文、又把三种成因说成一种：文件本来就没生成过、
    // 名字对不上、会话被清理过。医生点了下载看到这四个字母，只会以为系统坏了。
    if (req.method === "GET" && u.pathname === "/api/download") {
      const sid = u.searchParams.get("sid") || ""
      const name = u.searchParams.get("name") || ""   // 可含一层子目录（如 pdfs/a.pdf），由 safeUnder 做包含性校验
      const up = u.searchParams.get("dir") === "up"   // dir=up 时取上传目录，否则取产出目录
      const root = sid ? (up ? await sessionUp(sid) : await sessionOut(sid)) : (up ? UPLOADS : OUTPUTS)   // 无 sid 回退共享目录（兼容）
      const f = safeUnder(root, name)
      // isFile 不能省：只判 existsSync 时，?name=.preview（服务端自己在每个产物目录里建的预览缓存目录，
      // 必然存在）会让 createReadStream 异步抛 EISDIR，而进程没有 uncaughtException 兜底 → 整个容器崩、
      // opencode 一起没。任意已登录用户一个 URL 即可打崩。/api/raw 本来就有这个判断，这里漏了。
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, TEXT_UTF8, FILE_GONE)
      // 下载文件名只取最后一段：带上 "pdfs/" 前缀的话，浏览器保存时会把斜杠当非法字符或造出怪名字
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": contentDisposition(path.basename(name)) })
      return pipeFile(f, res)
    }

    // 内联查看（供聊天框里 <img> 预览 / 在新标签打开），带正确 MIME、不强制下载
    if (req.method === "GET" && u.pathname === "/api/raw") {
      const sid = u.searchParams.get("sid") || ""
      const name = u.searchParams.get("name") || ""   // 可含一层子目录，交给 safeUnder 校验
      const up = u.searchParams.get("dir") === "up"
      const root = sid ? (up ? await sessionUp(sid) : await sessionOut(sid)) : (up ? UPLOADS : OUTPUTS)
      const f = safeUnder(root, name)
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, TEXT_UTF8, FILE_GONE)
      const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".pdf": "application/pdf",
        ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
        ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8" }
      const ext = path.extname(name).toLowerCase()
      const head = { "Content-Type": MIME[ext] || "application/octet-stream" }
      // ★ 给个验证器 + 短缓存。正文里嵌的图走这条路，而流式渲染是【整块重绘】的：
      //   每 250ms 一帧都会生成一个全新的 <img>，一个响应头都不发的话浏览器启发式新鲜度为 0，
      //   一张 300dpi 的出版图（2–5MB）在一段还要再写一分钟的回答里可能被重取上百次。
      //   max-age 取 60 秒：产物会被 agent 覆盖重写，缓存久了用户看到的是旧图；
      //   带 ETag（mtime+size）让重新验证走 304，改了立刻生效。private：产物是会话私有的。
      try {
        const st = fs.statSync(f)
        head["Cache-Control"] = "private, max-age=60, must-revalidate"
        head["ETag"] = `W/"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`
        if (req.headers["if-none-match"] === head.ETag) { res.writeHead(304, head); return res.end() }
      } catch { /* stat 不到就不给缓存头，照常整发 */ }
      // 产物 HTML/SVG 可能含脚本：无论 iframe 内嵌还是直开新标签，都沙箱化、不接触本站源（cookie/localStorage）
      if (ext === ".html" || ext === ".htm" || ext === ".svg") head["Content-Security-Policy"] = "sandbox allow-scripts"
      res.writeHead(200, head)
      return pipeFile(f, res)
    }

    // 文档预览转换：docx→HTML、pptx/ppt/odp/doc/odt→PDF；缓存到 <产物目录>/.preview/（与后台预热共用 ensurePreviewCache）
    if (req.method === "GET" && u.pathname === "/api/preview") {
      const sid = u.searchParams.get("sid") || ""
      // 不能再 basename：侧栏现在会给出 "audit/report.docx" 这种名字，砍掉目录后
      //  ① 子目录文档预览一律 404；
      //  ② 更糟——顶层若也有同名的 report.docx，就会【静默预览另一份文件】，而预览面板标题
      //     显示的仍是 audit/report.docx，用户完全看不出被掉包了。
      // 包含性校验交给 ensurePreviewCache 内部的 safeUnder（此前因为这里先 basename 过，
      // 那道 safeUnder 一直是空转的死代码）。
      const name = u.searchParams.get("name") || ""
      // dir=up 取【上传目录】。文献研读要在左栏原地显示用户刚传上来的 .docx —— 那是上传文件，
      // 不是产物，而本接口此前写死了只看产物目录 → 一律 404「这个文件不在本会话的产出或上传里」，
      // 而报错文案还提了"上传"，更让人以为是文件没传上去。与 /api/raw、/api/download 的
      // dir=up 保持同一套口径（安全边界仍是 ensurePreviewCache 内部那道 safeUnder）。
      const dir = sid ? (u.searchParams.get("dir") === "up" ? await sessionUp(sid) : await sessionOut(sid)) : OUTPUTS
      let r
      try { r = await ensurePreviewCache(dir, name) }
      catch (e) {
        if (e.code === "no-src") return send(res, 404, TEXT_UTF8, FILE_GONE)
        // 转义再插进 HTML：e.message 里含被转换文件的路径/文件名，而文件名是 agent 产出的、可含尖括号。
        // 影响仅限用户自己（一人一容器），但顺手堵掉，别留个会往 HTML 里塞未转义内容的口子。
        if (e.code === "docx-fail") {
          const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          return send(res, 500, "text/html; charset=utf-8",
            `<p style="color:#b91c1c">DOCX 预览转换失败：${esc(e.hint || e.message)}</p><p style="color:#57606a;font-size:.92em">可点右上角「原文」下载后在本地打开。</p>`)
        }
        if (e.code === "no-soffice") return send(res, 501, TEXT_UTF8, "服务器未安装 LibreOffice，无法预览此类型（装好后即可）")
        // 人话 + 可行动的下一步；完整命令行/stderr 已在 ensurePreviewCache 里 console.error，不外泄。
        if (e.code === "office-fail") return send(res, 500, TEXT_UTF8, e.timedOut
          ? "文档转换超时（首次转换要启动办公组件，会慢一些）。可先下载文件在本地打开；稍后重试通常会快很多。"
          : "文档转换失败，可下载文件后在本地打开。")
        if (e.code === "no-pdf") return send(res, 500, TEXT_UTF8, "转换未产出 PDF")
        return send(res, 500, TEXT_UTF8, "转换失败：" + e.message)
      }
      if (!r) return send(res, 415, TEXT_UTF8, "该类型不支持预览")
      // docx 转出来的 HTML 是 mammoth 直出的：它保留原文档里的超链接，且【不过滤 javascript: 协议】。
      // 这条路径以前因为 mammoth 没装、docx 预览 100% 失败而从没真正跑过，装上后才第一次生效 → 补上沙箱。
      // 与 /api/raw 对 html/svg 的处理保持一致：不允许脚本、不接触本站源。
      const head = { "Content-Type": r.ctype }
      if (String(r.ctype).startsWith("text/html")) head["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"
      res.writeHead(200, head)
      return pipeFile(r.out, res)
    }

    // 健康检查：网关活着不等于能用——opencode 起不来时网关照样监听端口、
    // 前端也照常渲染，用户要等发出第一条消息才发现整站是坏的（manager 只探端口，也会误判为健康）。
    // 暴露真实依赖状态，供 manager/monitor 与前端横幅使用。
    if (req.method === "GET" && u.pathname === "/api/health") {
      // quick=1：只回答"网关本身活着吗"，不去探 opencode。
      // 桌面壳的启动页用它判就绪：不带 quick 时这里要先等 ocHealthy（最长 2.5s），
      // 而 opencode 起得慢恰恰是现场最常见的故障——就成了"网关早已 listen，启动页却一直转"。
      // 探活语义不该被下游的慢拖住；opencode 的死活由页面横幅单独去报。
      if (u.searchParams.get("quick"))
        return send(res, 200, "application/json", JSON.stringify({ gateway: true }))
      const ocOk = await ocHealthy()
      // 只回布尔，不带模型名——这是个公开端点（见 PUBLIC_PATHS 的说明），没必要对外透露用的哪个模型
      return send(res, ocOk ? 200 : 503, "application/json", JSON.stringify({ gateway: true, opencode: ocOk }))
    }
    // 功能模块清单：全部模块 + 本账号是否开通（前端据此渲染模块选择卡；未开通的置灰）
    if (req.method === "GET" && u.pathname === "/api/modules") {
      // 模块可用 = 模块本身获授权 且 其绑定技能未被技能白名单收权（chat 无绑定技能，只看模块授权）
      // ui：这个模块用哪个界面壳（null = index.html 通用壳；"reader" = 专用的 reader.html）。
      // 必须随清单一起下发 —— 工作台点卡片时就要知道往哪儿跳，不能等进了聊天页再拉工作流定义，
      // 那样用户会先看见一闪而过的通用表单再被弹走。
      const list = Object.entries(MODULE_DEFS).map(([id, m]) => ({ id, name: m.name, desc: m.desc, group: m.group || "skills", ui: WF.WORKFLOWS[id]?.ui || null, skill: modPrimarySkill(id), skills: m.skills || null, allowed: moduleUsable(id) }))
      // entRev 一起回：前端在公告轮询里发现它变了就重取本接口，两处用同一个摘要才不会来回打转
      return send(res, 200, "application/json", JSON.stringify({ modules: list, entRev: entRev() }))
    }
    // 某模块的工作流：首屏表单 schema + 步骤链。前端只当渲染器，schema 全由这里下发 ——
    // 改流程走「界面包」热更新即可，不用重发桌面安装包。
    if (req.method === "GET" && u.pathname.startsWith("/api/modules/") && u.pathname.endsWith("/workflow")) {
      const modId = decodeURIComponent(u.pathname.slice("/api/modules/".length, -"/workflow".length))
      if (!MODULE_DEFS[modId]) return send(res, 404, "application/json", JSON.stringify({ err: `未知模块：${modId}` }))
      if (!moduleUsable(modId)) return send(res, 403, "application/json", JSON.stringify({ err: "你的账号未开通该模块" }))
      const wf = WF.workflowFor(modId)
      if (!wf) return send(res, 200, "application/json", JSON.stringify({ workflow: null }))   // chat：没有工作流，前端照旧
      return send(res, 200, "application/json", JSON.stringify({ workflow: { ...wf, name: MODULE_DEFS[modId].name } }))
    }
    // 本会话的工作流状态（表单值 + 已完成步骤）。切会话 / 刷新页面靠它恢复到当前步。
    if (req.method === "GET" && u.pathname === "/api/workflow/state") {
      const sid = u.searchParams.get("sid") || ""
      if (!sid) return send(res, 200, "application/json", JSON.stringify({ state: null }))
      const modId = sessionModule(sid)
      if (modId === "chat") return send(res, 200, "application/json", JSON.stringify({ state: null, module: "chat" }))
      // ★ 同族接口（/api/modules/<id>/workflow、/api/workflow/form、/api/chat/start）都查了授权，
      //   唯独这条没查。后果是模块被回收之后，步骤条照常渲染、进度照常显示，界面看起来一切正常，
      //   只有用户打完一整段需求点发送的那一刻才吃 403 —— 典型的"闸的下游全绿、上游已红"。
      if (!moduleUsable(modId))
        return send(res, 403, "application/json", JSON.stringify({ err: `本会话绑定的「${MODULE_DEFS[modId]?.name || modId}」模块当前不可用（可能是授权被调整）。请联系管理员，或到「自由对话」新开会话。` }))
      const out = await sessionOut(sid)
      const st = wfSyncDone(out, modId) || { module: modId, form: {}, done: [] }
      // steps 按已填表单值裁剪后回：条件不成立的步骤（如"数据已脱敏"→不需要脱敏步）不该出现在进度条上
      return send(res, 200, "application/json", JSON.stringify({
        state: st, module: modId, name: MODULE_DEFS[modId]?.name || modId,
        steps: WF.workflowFor(modId, st.form || {})?.steps || [],
        gateBypass: gateBypassed(sid),   // 用户手动放行了质量闸 → 流程条上要显示这个状态（且可撤销）
      }))
    }
    // 手动放行/恢复质量闸拦截。只改"拦不拦"，不动闸的结论（failed 仍按报告实际内容显示）。
    // 【为什么是独立接口而不是塞进 /api/workflow/form】那条路会顺带拼任务卡、写会话簿子；
    // 这里只翻一个服务端开关，且必须是【用户】翻的 —— 走表单口会让 agent 也能顺着同一条路自解锁。
    if (req.method === "POST" && u.pathname === "/api/workflow/gate-bypass") {
      const b = await readJson(req).catch(() => null)
      if (!b) return sendClose(res, 400, "application/json", JSON.stringify({ ok: false, err: "请求体不是合法 JSON" }))
      const sid = b.sid ? String(b.sid) : ""
      if (!sid || !safeSid(sid)) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "缺少会话 id" }))
      const on = setGateBypass(sid, !!b.on)
      console.warn(`[gate] 会话 ${sid}：用户${on ? "手动放行了质量闸拦截" : "恢复了质量闸拦截"}`)
      return send(res, 200, "application/json", JSON.stringify({ ok: true, on }))
    }
    // 提交某一步的表单 → 存进状态簿 + 回一段任务卡文本，由前端拼在这条消息前面发出。
    // 【为什么不在这里直接发消息】发消息那条路（/api/chat/start）有一整套并发/额度/绑定判定，
    // 不该复制一份。这里只负责"把勾选变成文本"，发送仍走原来的口。
    if (req.method === "POST" && u.pathname === "/api/workflow/form") {
      // sendClose 而非 send：超限时 body 还没读完就回包，不声明关闭连接的话残留 body 会把这条
      // keep-alive 彻底堵死（同一连接的下一个请求永不返回）。/api/upload、/api/chat/start 同款。
      const b = await readJson(req).catch(() => null)
      if (!b) return sendClose(res, 400, "application/json", JSON.stringify({ ok: false, err: "请求体不是合法 JSON 或超过大小上限" }))
      const modId = String(b.module || "")
      const stepId = b.step ? String(b.step) : ""       // 空 = 首屏 intake
      const values = (b.values && typeof b.values === "object") ? b.values : {}
      const wf = WF.WORKFLOWS[modId]
      if (!wf) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: `模块 ${modId} 没有工作流` }))
      if (!moduleUsable(modId)) return send(res, 403, "application/json", JSON.stringify({ ok: false, err: "你的账号未开通该模块" }))
      const step = stepId ? wf.steps.find((s) => s.id === stepId) : null
      if (stepId && !step) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: `未知步骤：${stepId}` }))
      const fields = step ? (step.form || []) : wf.intake
      const title = step ? step.name : (wf.intakeTitle || "开始")
      const sid = b.sid ? String(b.sid) : ""
      // ---- 落卡之前先体检：缺必填、指了不存在的文件 ----
      // 【为什么必须在服务端也做】必填此前只有前端拦（index.html 的 buildFormCard），接口自己
      // 一律回 200 —— 纵深防御缺口。而**文件不存在**更要紧：那不是用户的选择，是事实错误
      // （选了文件但上传失败、或换了会话），实测服务端照拼任务卡、照发，模型花两分半连开 4 次
      // glob/find 全仓库扫，最后只能回一句"没找到，请重新上传" —— 白烧一整轮真实模型调用。
      // 两者都只回 warnings、**都不挡**：
      //   · 本接口同时也是一个纯粹的"把表单值序列化成任务卡"的函数（测试与工具都这么用它），
      //     对缺字段回 400 会把这个契约改掉 —— 而缺必填本来就有前端的友好拦截兜着，
      //     真漏到模型那里也不至于出事：前言明令"未填写的项一律标注待补充并向用户索要"，
      //     实测模型确实会开口要，而不是编一个。
      //   · 文件不存在同理不挡：用户完全可能先填表单再补传，硬拦会把一个能自愈的顺序问题变成死路。
      //     但**必须报**——实测服务端照拼任务卡照发，模型花两分半连开 4 次 glob/find 全仓库扫，
      //     最后只能回"没找到，请重新上传"，白烧一整轮真实模型调用。
      const vals = values
      const warnings = (fields || [])
        .filter((f) => WF.visible(f, vals) && WF.isRequired(f, vals))
        .filter((f) => { const v = vals[f.id]; return v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) })
        .map((f) => `必填项「${f.label}」还没填——不补的话我只能标成"待补充"再向你要`)
      // 数值区间的合法性：上下限倒挂、超出 schema 声明的 min/max。
      // ★ 这段【不能】放进下面那个 `if (sid)` 里——它跟上传目录毫无关系，放进去就又变成
      //   "只有已建会话才检查"，与刚修掉的那个 bug 同一形态。
      // 实测：影响力区间填 `90 – 5`（下限比上限大）原样进任务卡，模型只在思考里嘀咕一句
      //   "this is a weird range (90 to 5)"，系统一句没说；schema 写着 0–100 的字段填 9999 也照过。
      // 同样只提示不挡：用户可能正填到一半就点了提交，硬拦一个"填反了"比提示它更烦人。
      for (const f of fields || []) {
        if (!WF.visible(f, vals)) continue
        const v = vals[f.id]
        if (f.type === "range" && v && typeof v === "object") {
          const { min, max } = v
          if (min !== undefined && max !== undefined && Number(min) > Number(max))
            warnings.push(`「${f.label}」的区间填反了：下限 ${min} 比上限 ${max} 还大`)
          for (const [k, n] of [["下限", min], ["上限", max]]) {
            if (n === undefined) continue
            if (f.min !== undefined && Number(n) < f.min) warnings.push(`「${f.label}」的${k} ${n} 小于允许的最小值 ${f.min}`)
            if (f.max !== undefined && Number(n) > f.max) warnings.push(`「${f.label}」的${k} ${n} 超过允许的最大值 ${f.max}`)
          }
        } else if (f.type === "number" && v !== undefined && v !== "" && Number.isFinite(Number(v))) {
          if (f.min !== undefined && Number(v) < f.min) warnings.push(`「${f.label}」填的 ${v} 小于允许的最小值 ${f.min}`)
          if (f.max !== undefined && Number(v) > f.max) warnings.push(`「${f.label}」填的 ${v} 超过允许的最大值 ${f.max}`)
        }
      }
      // ★ 这里【只能】判 sid，不能再加 `sessionModule(sid) === modId`。
      //   模块绑定发生在 /api/chat/start，而真实顺序是 **上传（现建一个未绑定会话）→ 填首屏表单
      //   → 发第一条消息**；`sessionModule()` 对未登记会话一律回 "chat"，于是首屏提交时条件恒假。
      //   后果很讽刺：文件体检唯一的意义就是挡住"选了文件但没传上去、白烧一整轮"，
      //   而那个场景 100% 发生在首轮 —— 恰恰是它唯一守不到的时刻（两个测试员各自独立复现了这条）。
      //   "这个文件在不在上传目录里"跟会话绑没绑模块本来就没关系。
      //   下面写 _workflow.json 那段【保留】模块核对：那条是防串模块写簿子的，两件事不该共用一个 if。
      let upDir = ""
      if (sid) {
        try {
          upDir = await sessionUp(sid)
          const have = new Set(fs.existsSync(upDir) ? fs.readdirSync(upDir) : [])
          for (const f of fields || []) {
            if (f.type !== "files" || !WF.visible(f, vals)) continue
            for (const n of (Array.isArray(vals[f.id]) ? vals[f.id] : [vals[f.id]]).filter(Boolean))
              if (!have.has(String(n))) warnings.push(`「${f.label}」里的 ${n} 在本会话的上传里找不到，可能上传失败了`)
          }
          // columns 型字段：用户填的列名在真实表头里存不存在。
          // 【为什么要查】实测：任务卡写着「分组列：手术方式」，而表里根本没有这一列（真名叫「组别」），
          // 模型自己认定"手术方式 → 就是组别"，拿组别跑完全程，**全程一个字都没告诉用户它换了列**。
          // 这次它猜对了纯属侥幸 —— 真实表里同时有「手术方式」（术式）和「组别」（试验/对照）两列极常见，
          // 静默替换会产出一份【看起来完全正常、实际分错了组】的 Table 1。
          // 同一个进程里 parseHeaders 已经能从同一个 upDir 读出真表头（/api/data/headers 走的就是它），
          // 成本几乎为零。同样只 warning 不挡：表头读不出来的情况太多（xlsx、宽表降级），硬拦会误伤。
          const headCache = new Map()
          // ★ 走 tablePreview 而不是只认 csv/tsv/txt 的 parseHeaders。
          //   变量对应改版之后，automap 专门为「医院导出的表绝大多数是 xlsx」起了 pandas ——
          //   xlsx 从此是主战场，而这道"你填的列在不在表里"的体检当时还把它整个跳过（cols=null →
          //   continue）。于是 xlsx 上机器认错列时，下拉之外再没有任何校验，
          //   用户拿到一份看着完全正常、实际分错了组的 Table 1。
          //   tablePreview 自带 mtime+size 缓存（同一请求内几乎零成本），csv 也照旧能走 JS 兜底。
          // ★ 拿【真列名】比，不是消歧后的显示名：前端存进 values 的已经是真列名，
          //   若这里用 headers（带"（重名 2）"后缀），两边就都在用同一份被污染的数据，
          //   `cols.includes("组别（重名 2）")` 恒为真 —— 双保险同源失效，等于没有保险。
          //   顺带认「第 N 列」：无列名的列前端就是这么存的。
          const headersOf = async (fname) => {
            if (headCache.has(fname)) return headCache.get(fname)
            let cols = null
            try {
              const fp = path.join(upDir, path.basename(fname))
              if (fs.existsSync(fp)) {
                const pv = await tablePreview(fp, { rows: 1 })
                if (pv.ok && pv.headers?.length)
                  cols = (pv.raw || pv.headers).map((h, i) => (String(h || "").trim() || `第 ${i + 1} 列`))
              }
            } catch { cols = null }
            headCache.set(fname, cols)
            return cols
          }
          for (const f of fields || []) {
            if (f.type !== "columns" || !f.source || !WF.visible(f, vals)) continue
            // ★ 必须先认前端的文件切换器。多表时 index.html 把"这个字段的列名读自哪张表"存在
            //   `__src_<字段id>` 里；服务端若仍恒取 dataFiles[0]，用户明明在界面上选对了第二张表的列，
            //   却会收到一条"这一列不存在"的红字 —— 一个纯粹由两处各说各话造出来的假警报，
            //   而它出现在一个专门用来提高可信度的提示里，比不提示更糟。
            const srcs = (Array.isArray(vals[f.source]) ? vals[f.source] : [vals[f.source]]).filter(Boolean)
            const picked = vals["__src_" + f.id]
            const src = (picked && srcs.includes(picked)) ? picked : srcs[0]
            if (!src) continue
            const cols = await headersOf(String(src))
            if (!cols || !cols.length) continue          // 读不出表头就别判（没装 pandas 的 xlsx / 编码认不出）
            for (const n of (Array.isArray(vals[f.id]) ? vals[f.id] : [vals[f.id]]).filter(Boolean))
              if (!cols.includes(String(n)))
                warnings.push(`「${f.label}」填的是「${n}」，但 ${src} 的表头里没有这一列（实际列名：${cols.slice(0, 8).join("、")}${cols.length > 8 ? "…" : ""}）`)
          }
        } catch { /* 读不到上传目录就别体检，正常发卡 */ }
      }
      const card = WF.taskCard(MODULE_DEFS[modId]?.name || modId, title, fields, values,
        { footnote: step ? "" : (wf.footnote || ""), upDir })
      // 有 sid 才落盘（首屏表单是在会话建立【之前】填的，此时还没有 sid —— 那份值由
      // /api/chat/start 建完会话后补写，见那里的 wfSeed）
      if (sid && sessionModule(sid) === modId) {
        const out = await sessionOut(sid)
        const st = wfLoad(out) || { module: modId, form: {}, done: [] }
        st.module = modId
        // 跨步继承：立项卡填的目标期刊，后面各步直接复用。
        // ★ 但 `__src_<字段id>`（多表时列名读自哪张表）是【纯前端的界面状态】、不是表单值：
        //   原样落盘会作为 seed 继承进后面每一步的卡片、在会话簿子里越积越多，落盘前滤掉。
        // ★★ 但 `__vars*` 【必须落盘】，别一起剥掉。`__varsBy` 记的是"这一格是机器认的还是用户
        //   指定的"、`__varsOK` 记的是"用户核对过了"—— 剥掉之后刷新一次，reader 那边
        //   `if (has) by[id] = by[id] || "user"` 会把机器猜的列【全部改判成 user】，
        //   于是发给模型的提示词从"机器认的，请你核"升级成「以我指定的为准」——
        //   正是 varsBlock 头注写明不许发生的那件事：给一个可能认错的列名披上用户的权威。
        //   （反方向也有：用户点过"就按这个来"后不发消息就刷新，__varsOK 丢失、确认白点。）
        const KEEP = /^__vars/
        const persist = Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith("__") || KEEP.test(k)))
        st.form = { ...(st.form || {}), ...persist }
        if (stepId) st.cur = stepId
        wfSave(out, st)
      }
      return send(res, 200, "application/json", JSON.stringify({ ok: true, card, warnings }))
    }
    // 读某个已上传数据表的表头，供 columns 型字段做真实列名下拉。
    // ★ 这是 stats/paper 表单最值钱的一环："列名猜错/写错"是当前最高频的失败模式，从真实表头选能根治。
    if (req.method === "GET" && u.pathname === "/api/data/headers") {
      const sid = u.searchParams.get("sid") || ""
      const name = u.searchParams.get("name") || ""
      const dir = sid ? await sessionUp(sid) : UPLOADS
      const f = safeUnder(dir, name)
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "application/json", JSON.stringify({ err: "文件不存在" }))
      // xlsx 也要能读：医院导出的表【绝大多数是 xlsx】，此前它一律降级成"手动填列名"，
      // 等于本套件最要紧的控件对多数用户根本没生效。走 tablePreview（pandas 优先、JS 兜底）。
      // rows 与 /api/data/preview 保持一致，两条路才共用同一份缓存（否则同一张表要起两次 python）
      const pv = await tablePreview(f, { rows: PREVIEW_ROWS })
      // raw/dupes 必须透出去：前端按钮上显示 headers（消歧后的名字），存进 values 的是 raw（真列名）。
      // 只回 headers 的话，界面会把"（重名 2）""（第 3 列·无列名）"这种表里不存在的名字送给模型。
      return send(res, 200, "application/json", JSON.stringify(
        pv.ok ? { headers: pv.headers, raw: pv.raw || null, dupes: pv.dupes || [], note: pv.note || "" }
              : { headers: null, reason: pv.reason }))
    }
    // 前 N 行 + 逐列画像。「变量对应」面板用它把真表摆给用户看（对着 5 行真数据核对列，
    // 比对着六个光秃秃的下拉靠谱得多），automap 也复用同一份结果。
    if (req.method === "GET" && u.pathname === "/api/data/preview") {
      const sid = u.searchParams.get("sid") || ""
      const name = u.searchParams.get("name") || ""
      const dir = sid ? await sessionUp(sid) : UPLOADS
      const f = safeUnder(dir, name)
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "application/json", JSON.stringify({ err: "文件不存在" }))
      const pv = await tablePreview(f, { rows: PREVIEW_ROWS })
      return send(res, 200, "application/json", JSON.stringify(pv))
    }
    // ---- 变量对应自动填：机器先认列，用户只核对 ----
    // 【这个接口在解决什么】「分组列 / 结局列 / 随访时间列 / 终点事件列…」这一排下拉，是本套件里
    // 用户最不知所云的地方——医生看到「终点事件列」四个字第一反应是"这是啥"，而填错不会报错，
    // 只会安静地产出一条看着很正常的错 KM 曲线。所以顺序要反过来：先抽 5 行让机器认，用户只确认。
    // 【两段式，且规则在前】先跑离线规则（guessVarMap，不花钱、不联网、结论稳定），再让模型看
    // 同一份画像去修正。模型这一段【只允许改成表里真有的列名】，越界的一律丢弃回退到规则版 ——
    // 一个编出来的列名会一路灌进任务卡，而"列名对不上"恰恰是这整套控件要根治的失败模式本身。
    if (req.method === "POST" && u.pathname === "/api/data/automap") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      const sid = String(body.sid || "")
      const name = String(body.name || "")
      const dir = sid ? await sessionUp(sid) : UPLOADS
      const f = safeUnder(dir, name)
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile())
        return send(res, 200, "application/json", JSON.stringify({ ok: false, reason: "文件不存在" }))
      const pv = await tablePreview(f, { rows: PREVIEW_ROWS })
      if (!pv.ok || !pv.headers?.length)
        return send(res, 200, "application/json", JSON.stringify({ ok: false, reason: pv.reason || "这张表读不出结构" }))
      const base = WF.guessVarMap(pv.cols, { headers: pv.headers })
      // ★ 额度闸与并发封顶：这是除 /api/suggest 之外的第二个模型调用口，而它此前两道都没有。
      //   它由【页面装载】触发（进模块、切表、刷新、恢复会话各一次），比用户主动点更容易连发；
      //   而 reader / figure 两个壳根本没有额度顶栏 —— 在 stats 的唯一界面里，这笔钱花了也看不见。
      //   额度尽了就只回规则版：功能不断，只是不再花钱请模型修正。
      const canLLM = !quotaOver() && automapInFlight < AUTOMAP_MAX_CONC
      // 【模型那一段必须缓存】前端每次装载「变量对应」面板都会打这个接口：进模块一次、切一次表一次、
      // 刷新页面一次、恢复会话又一次。不缓存的话同一张表会被反复送去问模型 —— 每次都花钱，
      // 而答案必然一样（输入完全相同）。缓存键含 mtime+size：重传同名新表会重算。
      const ai = canLLM
        ? await automapCached(f, body.analyses, async () => {
            automapInFlight++
            try { return await automapLLM(pv, base, body.analyses) } finally { automapInFlight-- }
          })
        : { used: false, err: quotaOver() ? "今日额度已用尽，这次只按列名规则认列（不影响你自己改）" : "同时在认列的请求过多，这次只按列名规则认列" }
      // 合并：模型给的、且列名在真表头里的才采纳；其余保留规则版。by 记下每一项是谁填的，
      // 前端要把它显示出来——用户有权知道这一格是"照列名规则填的"还是"模型看了数据填的"。
      const map = { ...base.map }, why = { ...base.why }, conf = { ...base.conf }
      const by = {}
      for (const k of Object.keys(map)) by[k] = "rule"
      for (const [k, v] of Object.entries(ai.map || {})) {
        const ok = Array.isArray(v) ? v.every((x) => pv.headers.includes(x)) : pv.headers.includes(v)
        if (!ok || (Array.isArray(v) && !v.length)) continue
        map[k] = v; by[k] = "ai"
        if (ai.why?.[k]) why[k] = ai.why[k]
        conf[k] = ai.conf?.[k] || conf[k] || "med"
      }
      // ★ map 里的值到这里为止都是【显示名】（guessVarMap 吃的就是消歧后的 pv.headers，
      //   模型那一段也是拿 pv.headers 校验的）。统一在服务端换回真列名再下发 ——
      //   否则每个前端都得各转一遍，而 reader 那侧压根没有 raw 的概念，一转就漏。
      //   why 里的列名不换：那是给人读的句子，显示名反而更好对上界面。
      if (pv.raw?.length === pv.headers.length) {
        const d2r = new Map(pv.headers.map((h, i) => [h, String(pv.raw[i] ?? "").trim() || `第 ${i + 1} 列`]))
        const toRaw = (v) => (Array.isArray(v) ? v.map((x) => d2r.get(x) ?? x) : (d2r.get(v) ?? v))
        for (const k of Object.keys(map)) map[k] = toRaw(map[k])
      }
      return send(res, 200, "application/json", JSON.stringify({
        ok: true, map, why, conf, by,
        notes: [...(base.notes || []), ...(ai.notes || [])],
        source: ai.used ? "ai+rule" : "rule",
        aiErr: ai.err || "",
        // ★ raw / dupes 必须一起回。前端按钮上显示 headers（消歧后的名字）、存进 values 的是
        //   raw（真列名）—— 而现在【没有任何前端还在调 /api/data/headers】，两个壳都走这条路，
        //   所以只回 headers 等于让那套真列名契约整个空转：用户点一下，表里根本不存在的
        //   「年龄（重名 2）」就进了任务卡，而服务端的列名体检拿真列名比，还会对系统自己填的值
        //   报一句"表头里没有这一列"——自相矛盾的红字。
        headers: pv.headers, raw: pv.raw || null, dupes: pv.dupes || [],
        rows: pv.rows || [], cols: pv.cols || [],
        note: pv.note || "", sheets: pv.sheets || [], scanned: pv.scanned || 0, truncated: !!pv.truncated,
      }))
    }
    // 前端顶栏的额度显示。两种形态各有各的权威账本，一个口子同时回：
    //   · used/limit：本机 env 额度（容器部署 / 单机自用），美元，含在跑轮的实时成本；
    //   · cloud：云端账号的【积分】视图（打包版用户看的就是它）——日、月两条线，权威在服务端。
    // 打包版走云端账号时 DAILY_COST_LIMIT 通常没设（limit=0 → 前端不显示本机那条），
    // 于是顶栏显示的就是 cloud 这份。两者都不设 = 不限额，顶栏整块隐藏（与改动前一致）。
    if (req.method === "GET" && u.pathname === "/api/quota") {
      // fresh=1：一轮对话刚结束时前端会带上它，跳过缓存直接问云端 —— 用户此刻正想看
      // "这轮花了多少"，给他一个最多 20 秒前的旧数就白刷新了。
      const cloud = await cloudQuota(u.searchParams.get("fresh") === "1")
      return send(res, 200, "application/json", JSON.stringify({ used: quotaUsedLive(), limit: DAILY_COST_LIMIT, cloud }))
    }
    if (req.method === "GET" && u.pathname === "/api/storage") {   // 前端显示存储用量（uploads+outputs）
      return send(res, 200, "application/json", JSON.stringify({ used: storageUsed(), limit: storageLimitBytes() }))
    }

    // ---- Zotero 本地库：探测 / 列分类 / 会话小库导入 / 回列 / 回写（单机·桌面部署）----
    // 全部走技能脚本 zotero_read.py（stdlib，打 127.0.0.1:23119）。脚本自己用 JSON 表达失败，
    // 所以这里一律回 200 + 结构化结果：Zotero 没开也只是 {ok:false}，不该把前端整块面板打成红叉。
    // 探测本机 Zotero 是否在跑
    if (req.method === "GET" && u.pathname === "/api/zotero/status") {
      // 带上部署形态：Zotero 只在【用户自己那台机器】上跑，而本进程探的是【自己的】127.0.0.1。
      // 多用户部署时网关在服务器上，永远探不到用户笔记本上的 Zotero —— 此时前端必须换一套说法，
      // 否则就是让用户反复去开一个根本不会被看见的 Zotero（这条提示原本一直是误导的）。
      const raw = zotJson(await runPy([ZOT_READ, "probe"], 8_000))
      let obj = {}
      try { obj = JSON.parse(raw) } catch { obj = { ok: false, error: "probe_failed" } }
      obj.deployment = BASE_PATH ? "multiuser" : "local"
      return send(res, 200, "application/json", JSON.stringify(obj))
    }
    // 列出 Zotero 分类（供前端下拉选导入范围）
    if (req.method === "GET" && u.pathname === "/api/zotero/collections") {
      return send(res, 200, "application/json", zotJson(await runPy([ZOT_READ, "collections"], 12_000)))
    }
    // 列出本会话已导入的小库条目（读 <会话产物目录>/zotero_lib/zotero_refs.json）
    if (req.method === "GET" && u.pathname === "/api/zotero/lib") {
      const sid = u.searchParams.get("sid") || ""
      if (!sid) return send(res, 200, "application/json", JSON.stringify({ ok: true, refs: [] }))
      try {
        const f = path.join(await sessionOut(sid), "zotero_lib", "zotero_refs.json")
        if (!fs.existsSync(f)) return send(res, 200, "application/json", JSON.stringify({ ok: true, refs: [] }))
        return send(res, 200, "application/json", JSON.stringify({ ok: true, refs: readJsonFile(f) }))
      } catch { return send(res, 200, "application/json", JSON.stringify({ ok: true, refs: [] })) }
    }
    // 从 Zotero 导入到本会话小库：把选中文献的 PDF 复制进 <会话产物目录>/zotero_lib/
    if (req.method === "POST" && u.pathname === "/api/zotero/import") {
      let sid = u.searchParams.get("sid") || null
      // 建会话/解析目录都要问 opencode，opencode 不可达时会抛，而这两句原先【在 try 之外】：
      // 异常直落全局处理器 → 回 500 + 原始堆栈（含服务器绝对路径），前端 r.json() 当场炸成
      // "SyntaxError: Unexpected token 'T'"，正好违背本段开头"一律回 200 + 结构化结果"的约定。
      let ws
      try {
        if (!sid) sid = await createSession("web")   // 导入先于对话则现建会话（directory 会定到会话产物目录）
        ws = await ensureWs(sid)
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: "session_unavailable", hint: "无法建立/定位会话工作目录（opencode 未就绪），请稍后重试或先发一条消息建会话。", detail: String(e).slice(0, 200) }))
      }
      const chunks = []; for await (const c of req) chunks.push(c)
      let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      const to = path.join(ws.out, "zotero_lib")
      const args = [ZOT_READ, "materialize"]
      if (body.items) args.push("--items", String(body.items))
      else if (body.collection_key) args.push(String(body.collection_key))
      else args.push("--top")
      args.push("--to", to)
      const r = await runPy(args, 300_000)
      let out = {}; try { out = JSON.parse(zotJson(r)) } catch { out = { ok: false, error: "parse", detail: (r.stderr || "").slice(0, 300) } }
      out.sid = sid
      return send(res, 200, "application/json", JSON.stringify(out))
    }
    // 回写到 Zotero（本套接口里【唯一的写操作】）：把小库题录存进运行中的 Zotero 当前选中分类
    if (req.method === "POST" && u.pathname === "/api/zotero/push") {
      const sid = u.searchParams.get("sid") || ""
      if (!sid) return send(res, 400, "application/json", JSON.stringify({ ok: false, error: "no_sid" }))
      let ws
      try { ws = await ensureWs(sid) }   // 同上：opencode 不可达时别把原始堆栈甩给前端
      catch (e) { return send(res, 200, "application/json", JSON.stringify({ ok: false, error: "session_unavailable", hint: "无法定位会话工作目录（opencode 未就绪），请稍后重试。", detail: String(e).slice(0, 200) })) }
      const chunks = []; for await (const c of req) chunks.push(c)
      let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      const refs = body.refs
      if (!Array.isArray(refs) || !refs.length) return send(res, 400, "application/json", JSON.stringify({ ok: false, error: "empty_refs" }))
      const tmp = path.join(ws.out, ".push_refs.json"); fs.writeFileSync(tmp, JSON.stringify(refs))
      return send(res, 200, "application/json", zotJson(await runPy([ZOT_READ, "push", "--refs", tmp], 12_000)))
    }
    // 发起一轮生成。【POST，正文在 body】——原先是 GET /api/chat?q=...，两个毛病：
    //   ① GET 带副作用（发消息 + 扣额度），而 cookie 是 SameSite=Lax：跨站顶层 GET 导航会带上凭据，
    //      诱导点一个链接就能替用户跑一轮长生成、烧掉当天额度（浏览器/代理的链接预取也可能误触发）。
    //   ② 长正文塞进 URL 会撞 Node 默认 16KB 请求头上限 → 431/断连，而前端的 SSE onerror 会把它
    //      当成网络抖动去重连，消息就【静默丢失】了（粘贴一段稿件即可复现）。
    // 起轮成功后，前端再用 GET /api/chat/attach?sid= 订阅直播（EventSource 只能发 GET，故拆成两步）。
    if (req.method === "POST" && u.pathname === "/api/chat/start") {
      const chunks = []; let total = 0
      for await (const c of req) {
        total += c.length
        if (total > 4_000_000) return sendClose(res, 413, "application/json", JSON.stringify({ ok: false, sent: false, err: "消息过长（超过 4MB）" }))   // 从 for-await 里提前 return → body 未读完，必须关连接
        chunks.push(c)
      }
      let q = "", sid = null, reqMod = "", autoReq, wfSeed = null
      // wfSeed：首屏表单的值。表单是在【会话还不存在】的时候填的（用户还没发第一条消息），
      // 所以那份值没法在 /api/workflow/form 里落盘，只能随第一条消息捎进来，建完会话再写。
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); q = String(b.q ?? ""); sid = b.sid ? String(b.sid) : null; reqMod = String(b.module || ""); if (typeof b.auto === "boolean") autoReq = b.auto; if (b.wfForm && typeof b.wfForm === "object") wfSeed = b.wfForm } catch {}
      if (!q.trim()) return send(res, 400, "application/json", JSON.stringify({ ok: false, sent: false, err: "消息为空" }))
      // ---- 模块裁定 ----
      // 续会话：绑定在创建时已定死，忽略前端传值（防伪造请求把受限会话"升级"成 chat）。
      // 新会话：用请求的模块（缺省 chat），必须是已知且授权的模块。
      // 授权在这里查而不是只在创建时查：管理员收权后容器会被重建（env 变更即重建），
      // 老会话若绑着已收权的模块，续聊也要挡住。
      // ★ 例外：会话已存在但【从未绑定过】—— 这不是"续会话"，是"会话被上传接口提前建出来了"。
      //   /api/upload 在没有 sid 时会现建一个会话并把 id 回给前端；而 stats/refcheck/humanize
      //   三个模块的规定流程就是"先传文件、再填表单、再发第一条消息"，必然走这条路。
      //   不补绑的话：modId 落成 chat → 没有模块前言、没有技能闸、表单值不落盘、步骤条永不出现，
      //   而 AI 照常回答，用户完全看不出流程已经失效（哑失败）。账号若没开通 chat 更会直接 403。
      //   安全方向是收紧不是放宽：未绑定(=chat) → 受限模块，只会让能用的技能变少。
      const unbound = sid && !moduleMap()[safeSid(sid)]
      let modId = sid ? (unbound && MODULE_DEFS[reqMod] ? reqMod : sessionModule(sid)) : (reqMod || "chat")
      if (!MODULE_DEFS[modId]) return send(res, 400, "application/json", JSON.stringify({ ok: false, sent: false, err: `未知模块：${modId}` }))
      if (!moduleUsable(modId))
        return send(res, 403, "application/json", JSON.stringify({ ok: false, sent: false, err: `你的账号未开通「${MODULE_DEFS[modId].name}」模块${sid ? "（本会话绑定于该模块）" : ""}，请联系管理员开通。` }))
      // 新会话要先向 opencode 建会话；它没起来时这里会抛，此前会被外层 catch 变成一个带堆栈的 500，
      // 用户只看到"发送失败"，根本不知道是后台模型服务没起来。这里单独兜住并给人话。
      // 上传接口提前建出来的会话：在这里补登记绑定（见上面 unbound 的说明）
      if (unbound && modId !== "chat") bindSessionModule(sid, modId)
      if (!sid) {
        try { sid = await createSession(q.slice(0, 40)); titledSessions.add(sid); if (modId !== "chat") bindSessionModule(sid, modId) }
        catch {
          const ocOk = await ocHealthy()
          return send(res, 503, "application/json", JSON.stringify({ ok: false, sent: false,
            err: ocOk ? "无法创建会话，请稍后重试" : "后台模型服务（opencode）尚未就绪，请稍等几十秒后重试；若持续如此请联系管理员" }))
        }
      }
      const ws = await ensureWs(sid)
      // 首屏表单值落盘。必须在下面拼 preamble 之前 —— modulePreamble 要读它来裁剪步骤链
      //（例如"数据已脱敏"会把脱敏那步整个剔掉，剧本里就不该再出现它）。
      if (wfSeed && modId !== "chat" && WF.WORKFLOWS[modId]) {
        const st = wfLoad(ws.out) || { module: modId, form: {}, done: [] }
        st.module = modId
        // 与 /api/workflow/form 同一口径：`__src_*`（纯界面状态）不落盘，`__vars*`（谁填的 / 核过没）要落。
        // 两条写盘路径此前口径相反 —— 表单口剥掉全部 `__`，这条一个都不剥。
        st.form = { ...(st.form || {}), ...Object.fromEntries(Object.entries(wfSeed).filter(([k]) => !k.startsWith("__") || /^__vars/.test(k))) }
        wfSave(ws.out, st)
      }
      // ensureSessionTitle 里有 await（打 opencode 网络）——必须放在“检查 running → startJob”这段【全同步】区之前。
      // 否则同 sid 的两个并发请求会在这个 await 处双双让出、都看到没有 running job、各自 startJob，
      // 后者 jobs.set 覆盖前者 → 两轮 prompt 并发打同一会话、先收尾的把另一轮从表里删成无法 attach/abort 的孤儿。
      await ensureSessionTitle(sid, q)
      if (jobs.get(sid)?.running)   // 该会话已有进行中的一轮（双开页面/连点）→ 不重复发起，让前端去续流
        return send(res, 200, "application/json", JSON.stringify({ ok: true, sid, sent: false, running: true, notice: "上一轮仍在进行中，本条消息未发送；请等本轮结束后重发。" }))
      if (quotaOver())
        return send(res, 200, "application/json", JSON.stringify({ ok: false, sid, sent: false, err: `今日额度已用尽（已用 ${creditsText(quotaUsedLive())} / 上限 ${creditsText(DAILY_COST_LIMIT)} 积分），明天恢复。` }))
      // 云端积分已被判定用尽 → 别再起一轮白转圈（打包版的额度就是这条线，本机那条通常没设）。
      // 【拒收前必须再问一次云端】旧判定可能已经过时：跨了 UTC 零点、管理员刚调高档位。确认还有
      // 余额就把判定撤掉照常发；云端这会儿问不到（q 为 null）也照常发 —— 宁可让本轮走到真实报错，
      // 也别凭一个问不到的判定甩用户一句"积分已用尽"，那种误报最难解释。
      {
        const blk = cloudQuotaBlocked()
        if (blk?.kind === "upstream") {
          // 上游额度耗尽：【不能】拿用户的积分去确认——他积分好得很，问了也只会得出"没用尽"
          // 从而放行一轮必然失败的对话。这里只靠判定本身，而它的新鲜期只有 60 秒
          // （管理员充值/加供应商后最多等一分钟就会真去试一次）。
          return send(res, 200, "application/json", JSON.stringify({ ok: false, sid, sent: false, err: blk.message }))
        }
        if (blk) {
          const cq = await cloudQuota(true)   // 别叫 q —— 本作用域里的 q 是用户这条消息的正文
          if (cloudQuotaExhausted(cq))
            return send(res, 200, "application/json", JSON.stringify({ ok: false, sid, sent: false, err: `${blk.message}。${QUOTA_TAIL}` }))
          if (cq) cloudQuotaBlock = null
        }
      }
      // ---- 无人值守开关：以每条消息带来的勾选态为准 ----
      // 勾着 → （重）置状态、连续轮数从 0 重计；没勾 → 清态熄火。老前端不带 auto 字段 → 不动现状。
      // 放在 running/quota 检查之后：消息被拒收时不该动开关状态。
      if (autoReq === true) autoStates.set(sid, { rounds: 0, lastText: "" })
      else if (autoReq === false) autoStates.delete(sid)
      const autoOn = autoStates.has(sid)
      // 给 agent 注入本会话专属目录，覆盖技能默认的 outputs/，实现多用户/多会话隔离
      // 注意：本会话的工作目录（cwd）已在建会话时通过 opencode 的 session.directory 定在【会话产物目录】，
      // 所以 agent 的所有工具默认就在正确的地方读写，preamble 只需说清"当前目录就是产物目录"与几个绝对路径。
      const preamble = `${PREAMBLE_MARK}\n- **你的当前工作目录就是本会话的产物目录**（\`${ws.out}\`）。所有产物（图表 PNG/PDF、CSV/Excel、md/docx 等）**直接写到当前目录即可**，用相对文件名如 \`fig1.png\`、\`manuscript.md\`，不要再自己拼 \`outputs/xxx\` 前缀。\n- 临时脚本、中间文件同样写当前目录（要归拢可用 \`./.scratch/\`）。\n- **用户上传的文件都在 \`${ws.up}/\`**：稿件（.md/.docx/.pdf）、数值表（.csv/.xlsx）、附件全都在这里，读任何用户给的文件都用这个绝对路径。\n- **跑本套件的脚本，python 用这个绝对路径**：\`${PY_BIN || "（本机还没建 .venv，先跑 env-setup 技能）"}\`，技能脚本在 \`${ROOT}/.opencode/skills/<技能>/\` 下。**照抄这两个路径，不要自己拼 \`\${REPO_ROOT:-/app}\`，也不要用 \`python\`/\`python3\`裸命令**——本机 PATH 里的 python 可能是个不能用的占位程序（跑起来没有任何输出），你会看不出它坏了。当前目录不是仓库根，写 \`.venv/...\` 这种相对路径同样找不到。\n- 正文里嵌入图片直接用文件名：\`![图注](fig1.png)\`（图和稿件都在当前目录，渲染也从当前目录跑）。\n- **不要把产物写到仓库根或 \`\${REPO_ROOT:-/app}\` 下**：那是所有会话共享的，会互相覆盖，也不会出现在界面的"产出"侧栏。\n- **上面这些路径与文件名是给你用的，不要说给用户**：他用的是图形界面，看不到也进不去 \`uploads/ws_.../\`、\`outputs/\`、\`.venv\`、\`AGENTS.md\` 这些东西。要他传文件就说"点输入框旁边的上传按钮"；提产物就只说文件名（\`table1.csv\`），别带目录。让用户照抄一个他根本打不开的路径，等于把他卡在那里。\n- **答复用用户说话的语言**（他用中文你就用中文），并且**只写最终结论**：查了什么、下一步打算干什么这类过程叙述不要写进答复正文——界面已经把工具调用一条条显示出来了，正文里再复述一遍，用户要在一堆过程碎片里翻找真正的结论。${modId === "chat" ? skillsPreamble() : modulePreamble(modId, ws.out)}${zoteroPreamble(ws.out)}${autoOn ? autoPreamble() : ""}\n\n`
      startJob(sid, preamble + q, modId)   // 同步建 job（jobs.set 在函数首行）→ 返回后前端 attach 必能接上
      return send(res, 200, "application/json", JSON.stringify({ ok: true, sid, sent: true, module: modId }))
    }

    // 重新订阅某会话进行中的一轮（切回会话/重开页面时续流）；没有进行中的轮次则回 idle
    if (req.method === "GET" && u.pathname === "/api/chat/attach") {
      const sid = u.searchParams.get("sid") || ""
      const job = jobs.get(sid)
      if (!job || !job.running) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
        sseWrite(res, "idle", {})   // 前端收到后改走历史回显（含刚完成的最终答案）
        return res.end()
      }
      return attachJob(job, req, res)
    }

    // 显式终止某会话进行中的一轮（前端"终止"按钮；断开连接不再意味着终止）
    if (req.method === "POST" && u.pathname === "/api/chat/abort") {
      // sid 两处都收：前端用 query，脚本化调用习惯放 body。只认 query 的话 body 调用会拿到
      // {ok:true, aborted:false} —— 看起来成功、实际没停，是个哑坑。
      const sid = u.searchParams.get("sid") || ""
      const job = jobs.get(sid)
      autoStates.delete(sid)   // 没有在跑的轮也要清：无人值守可能正停在两轮之间的判定瞬间
      if (job) await job.abort()
      return send(res, 200, "application/json", JSON.stringify({ ok: true, aborted: !!job }))
    }

    // 下一步输入建议：前端在一轮结束后送来「最后一问一答」，换回 2–3 条可点即填的短指令。
    // 【失败一律回 200 + 空数组】这是纯锦上添花的功能，任何错误都不该在界面上冒出红字打断用户；
    // 前端拿到空数组就什么都不画。err 字段只是给排查用，前端不显示。
    if (req.method === "POST" && u.pathname === "/api/suggest") {
      const nope = (err) => send(res, 200, "application/json", JSON.stringify({ ok: false, suggestions: [], err }))
      if (!SUGGEST_ENABLED) return nope("disabled")
      const chunks = []; let total = 0
      for await (const c of req) {
        total += c.length
        if (total > 200_000) return sendClose(res, 413, "application/json", JSON.stringify({ ok: false, suggestions: [], err: "too-large" }))
        chunks.push(c)
      }
      let sq = "", sa = "", sid = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); sq = String(b.q ?? ""); sa = String(b.a ?? ""); sid = b.sid ? String(b.sid) : "" } catch {}
      if (!sq.trim() && !sa.trim()) return nope("empty")
      if (quotaOver()) return nope("quota")                       // 额度已尽：别再为锦上添花的功能烧钱
      if (suggestInFlight >= SUGGEST_MAX_CONC) return nope("busy")   // 连点/多开页面时封顶，防被当成免费刷额度的口子
      suggestInFlight++
      try {
        const modId = sid ? sessionModule(sid) : "chat"   // 受限模块的会话，建议也只能落在该模块能干的事上
        const { list, err } = await suggestNext({ q: sq, a: sa, modName: modId === "chat" ? "" : (MODULE_DEFS[modId]?.name || "") })
        if (err) console.warn(`[suggest] 取建议失败：${err}`)
        return send(res, 200, "application/json", JSON.stringify({ ok: list.length > 0, suggestions: list }))
      } finally { suggestInFlight-- }
    }

    // 某会话是否有进行中的一轮（切会话/重开页面时决定要不要续流）
    if (req.method === "GET" && u.pathname === "/api/job") {
      return send(res, 200, "application/json", JSON.stringify({ running: !!jobs.get(u.searchParams.get("sid") || "")?.running }))
    }

    // 列出本会话 outputs/ 里的产物文件（重开页面/切会话时回显"产出"侧栏，产物随会话持久）
    if (req.method === "GET" && u.pathname === "/api/outputs") {
      const sid = u.searchParams.get("sid") || ""
      const dir = sid ? await sessionOut(sid) : OUTPUTS
      if (!fs.existsSync(dir)) return send(res, 200, "application/json", "[]")
      // 【必须与 dirState 同样递归一层】这条接口是 resumeSession 回显侧栏的唯一来源。
      // 只改 dirState 而漏了这里的话：本轮 SSE 推的 files 事件能列出 pdfs/a.pdf，
      // 但用户一刷新页面 / 切走再切回，子目录里的产物又全部消失 —— 症状与改动前一模一样，
      // 等于这次改造只在"当前这一轮"有效。（上面的 /api/uploads 不需要改：写入接口只收
      // basename，上传目录里天然不会出现子目录。）
      const { map, deeper } = dirStateDeep(dir)
      const list = Object.entries(map)
        .map(([rel, mtime]) => { try { return { name: rel, size: fs.statSync(path.join(dir, rel)).size, mtime } } catch { return null } })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
      // ★ 更深层的文件数走响应头，不动数组结构（这条接口的返回值是【裸数组】，改成对象会
      //   把所有既有调用方一起打翻）。前端据此在侧栏尾部挂一行灰字，别让它们无声消失。
      res.writeHead(200, { "Content-Type": "application/json", "X-Deeper-Files": String(deeper) })
      return res.end(JSON.stringify(list))
    }

    // ==== 云端账号（桌面版）====================================================
    if (req.method === "GET" && u.pathname === "/api/cloud/status") {
      return send(res, 200, "application/json", JSON.stringify({ ok: true, ...Cloud.status(), route: currentRoute() }))
    }
    // 登录 / 改密 / 登出 都会改写 opencode 的 provider → 要重启 opencode，
    // 与切模型同一个危害（拔掉正在跑的轮），故共用 busy → force 二次确认。
    if (req.method === "POST" && (u.pathname === "/api/cloud/login" || u.pathname === "/api/cloud/password" || u.pathname === "/api/cloud/logout")) {
      const chunks = []; for await (const c of req) chunks.push(c)
      let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      // 【同一个账号重新登录不算"切换账号"】前端闲置超时是锁屏而非登出（登录态、正在跑的轮都留着），
      // 解锁走的就是这条 login —— 它写出来的 provider 与正在跑的那份一模一样（地址是本机 /cloud/v1、
      // key 是本进程的 CLOUD_LOCAL_TOKEN、模型也没变；access key 是转发时才贴的，见 cloud-account.mjs），
      // 根本不需要重启。拿"要重启后台"去拦他，等于让"留着跑一轮综述去吃饭"的用户回来解不了锁。
      // 配置真变了（管理员趁这会儿改了他的默认模型）下面还会再判一次 busy，漏不掉。
      const relogin = u.pathname === "/api/cloud/login" && cloudLoggedIn() &&
        !Cloud.status().mustChangePassword &&
        Cloud.status().username === String(b.username || "").trim()
      const busy = runningRounds()
      if (busy > 0 && !b.force && !relogin) {
        return send(res, 409, "application/json", JSON.stringify({ ok: false, busy, needForce: true, err: `有 ${busy} 轮正在生成中，切换账号需重启后台，会中断它们` }))
      }
      let r
      clearNoticeCache()
      clearCloudQuotaCache()    // 换了人就别让上一个账号的剩余积分继续挂在顶栏上
      clearSkillLatestCache()   // 换账号后"最新技能包/relevant"要按新账号重新算
      if (u.pathname === "/api/cloud/login") {
        const username = String(b.username || "").trim(), password = String(b.password || "")
        if (!username || !password) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "请填写账号与口令" }))
        r = await Cloud.login(username, password)
      } else if (u.pathname === "/api/cloud/password") {
        r = await Cloud.changePassword(String(b.oldPassword || ""), String(b.newPassword || ""))
      } else {
        r = await Cloud.logout()
      }
      if (!r.ok) {
        const e = r.error || {}
        return send(res, r.status && r.status >= 400 ? r.status : 400, "application/json",
          JSON.stringify({ ok: false, code: e.code, err: e.message || "操作失败" }))
      }
      // 【还没改密就别动 provider、更别重启 opencode】这个状态下账号本来就调不了模型
      // （云端只发 pwchange 票据），重启纯属让用户在首启时白等三十秒才看到改密框。
      // 等改密成功那一步再配，一次到位。
      if (Cloud.status().mustChangePassword) {
        return send(res, 200, "application/json", JSON.stringify({ ok: true, restarted: false, ...Cloud.status(), route: currentRoute() }))
      }
      // 登录/改密成功后先把档案拉一次：模型名要写进 provider 配置
      if (u.pathname !== "/api/cloud/logout") { try { await Cloud.fetchProfile() } catch {} }
      // 重配路由：登录/改密后走云端账号；登出后回落静态网关 key，都没有就清掉 provider
      if (platformAvailable()) useGatewayRoute()
      else { try { fs.unlinkSync(MODEL_CFG_PATH) } catch {}; removeOcProvider(); MODEL = { providerID: PID, modelID: MID } }
      // 写出来的 provider 与 opencode 正在跑的那份一致 → 重启没有任何意义，只会拔掉在跑的轮。
      // 这正是解锁（同账号重登）的常态。ocLiveProvider 为 null（没接管 opencode / 还没成功重启过）
      // 时两边不会相等，行为与改动前一致。
      let restarted = false
      if (ocProviderOnDisk() !== ocLiveProvider) {
        // 确实要重启：此刻若还有轮在跑（上面对 relogin 放行过），如实回 needForce 让前端二次确认，
        // 别偷偷把它们拔了。
        const busy2 = runningRounds()
        if (busy2 > 0 && !b.force) {
          return send(res, 409, "application/json", JSON.stringify({ ok: false, busy: busy2, needForce: true, err: `有 ${busy2} 轮正在生成中，本次变更需重启后台，会中断它们` }))
        }
        try { restarted = await restartOpencode() } catch {}
      }
      return send(res, 200, "application/json", JSON.stringify({ ok: true, restarted, ...Cloud.status(), route: currentRoute() }))
    }
    // 主动刷新档案（档位/额度/用量）；模型名变了就顺带重配 provider
    if (req.method === "POST" && u.pathname === "/api/cloud/refresh") {
      // 【比的是"最终生效的模型"，不是档案里的默认模型】用户可能自己选了一个模型（picked），
      // 而这次刷新恰好发现管理员把它撤了 —— 只比默认模型的话，这种情况一次都不会重配，
      // 本机会继续拿着一个服务器已经不认的模型名跑，每轮都被网关静默打回默认模型。
      const before = MODEL.modelID
      expireNoticeCache()        // 用户手点「刷新」时，公告也该立刻是最新的，别等缓存到期
      const r = await Cloud.fetchProfile()
      if (!r.ok) {
        const e = r.error || {}
        return send(res, 200, "application/json", JSON.stringify({ ok: false, code: e.code, err: e.message || "刷新失败" }))
      }
      let restarted = false
      if (currentRoute() === "cloud" && platformProvider().modelID !== before) {
        useGatewayRoute()
        try { restarted = await restartOpencode() } catch {}
      }
      return send(res, 200, "application/json", JSON.stringify({ ok: true, restarted, ...Cloud.status(), route: currentRoute() }))
    }

    // 平台公告（站长在云端后台发布）。前端每几分钟问一次这里。
    //
    // 【本机加一层短缓存】前端轮询 + 多标签页 + 窗口重新聚焦时补拉，叠起来可以很密；
    // 而公告是一条全站共享的信息，没必要每次都打云端。60 秒足够让"刚发布"感觉是即时的，
    // 又把上游请求量压到每分钟一次。未登录/未接入云端时直接回空，不产生任何外网请求。
    if (req.method === "GET" && u.pathname === "/api/cloud/notice") {
      // 顺手同步一次云端档案（自身限流 5 分钟）：运营后台改了技能授权 / 档位 / 可选模型后，
      // 客户端就在这条本来就有的轮询里知道，不必等下次登录，也不必新加一个定时器。
      // 【必须在下面那道 loggedOut 判断之前】这次同步本身就可能把登录态清掉（改权限会连
      // refresh 一起吊销）；顺序反了的话，本次仍回一个"看着正常"的包，前端要多等 5 分钟才知道。
      if (cloudLoggedIn()) await syncProfileSoon()
      // loggedOut：接了云端但本机登录态已经没了（多半是管理员改了档位/技能 → epoch++ →
      // 连 refresh 一并作废）。前端据此当场弹登录窗，而不是等用户下一次发消息才被打断。
      if (!cloudLoggedIn())
        return send(res, 200, "application/json", JSON.stringify({ ok: true, notice: null, entRev: entRev(), loggedOut: !!Cloud.cloudBase() }))
      const now = Date.now()
      if (!noticeCache || now - noticeCache.at > 60_000) {
        const r = await Cloud.fetchNotice().catch(() => ({ ok: false }))
        // 【拉失败保留上一份】断网/云端抖动时把已经显示着的公告抹掉，比继续显示旧的更糟：
        // 用户会以为维护通知撤销了。所以失败时只把重试时间往前挪 15 秒，数据原样留着；
        // 也别每次请求都去戳一个已经挂了的云端（前端多标签页轮询能戳得很密）。
        if (r.ok) noticeCache = { at: now, data: { notice: r.notice, digest: r.digest, keepDays: r.keepDays, needUpgrade: r.needUpgrade, clientVersion: r.clientVersion } }
        else noticeCache = { at: now - 45_000, data: (noticeCache && noticeCache.data) || { notice: null, digest: [] } }
      }
      // 技能包 / 界面包的更新检查都搭这趟顺风车（各自限流半小时）。失败回 null = 这次不提示，无害。
      let skillUpdate = null, webUpdate = null
      try { skillUpdate = skillUpdateInfo(await skillLatestSoon()) } catch {}
      try { webUpdate = webUpdateInfo(await webLatestSoon()) } catch {}
      // entRev = 当前生效授权的摘要（档位/模型清单/技能白名单/可用模块）。前端拿它跟上次比，
      // 一变就重取模块清单与模型清单并提示一句——这是"管理员改完，客户端自己就变了"的那条线。
      return send(res, 200, "application/json", JSON.stringify({ ok: true, ...noticeCache.data, entRev: entRev(), skillUpdate, webUpdate }))
    }

    // 公告列表（带正文，近半年）。前端点开「公告」面板时才拉，所以缓存可以长一点。
    //
    // 【为什么不塞进上面那条轮询】那条 5 分钟一次、每个标签页都在打；正文每条最多 2000 字、
    // 半年可能几十条，白搬。轮询只带 digest（id/级别/时间）够算未读红点，正文按需取。
    if (req.method === "GET" && u.pathname === "/api/cloud/notices") {
      if (!cloudLoggedIn())
        return send(res, 200, "application/json", JSON.stringify({ ok: true, notices: [], loggedOut: !!Cloud.cloudBase() }))
      const now = Date.now()
      const force = u.searchParams.get("force") === "1"
      if (force || !noticesCache || now - noticesCache.at > 120_000) {
        const r = await Cloud.fetchNotices().catch(() => ({ ok: false }))
        // 与单条那份同一口径：拉失败保留上一份（面板已经打开时别当场变空），只把重试时间挪近
        if (r.ok) noticesCache = { at: now, data: { notices: r.notices, keepDays: r.keepDays } }
        else if (noticesCache) noticesCache = { at: now - 105_000, data: noticesCache.data }
        else return send(res, 200, "application/json", JSON.stringify({ ok: false, err: "拉不到公告列表（云端不可达）", notices: [] }))
      }
      return send(res, 200, "application/json", JSON.stringify({ ok: true, ...noticesCache.data }))
    }

    // ==== 技能包：本机状态 / 在线更新 / 回退（桌面版；详见 skill-update.mjs 头注）=====
    if (req.method === "GET" && u.pathname === "/api/skillpacks/status") {
      if (!cloudLoggedIn())
        return send(res, 200, "application/json", JSON.stringify({ ok: true, available: false }))
      const latest = await skillLatestSoon(u.searchParams.get("fresh") === "1").catch(() => null) || null
      return send(res, 200, "application/json", JSON.stringify({
        ok: true, available: true,
        current: SkillUp.currentVersion(),       // '' = 出厂版
        local: SkillUp.listLocal(),              // 可回退的本机留存版本
        latest, update: skillUpdateInfo(latest), // update 非空 = 有可提示的更新
      }))
    }
    if (req.method === "POST" && (u.pathname === "/api/skillpacks/update" || u.pathname === "/api/skillpacks/rollback")) {
      if (!cloudLoggedIn() && u.pathname === "/api/skillpacks/update")
        return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "未登录云端账号，无法在线更新技能" }))
      const chunks = []; for await (const c of req) chunks.push(c)
      let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      // 与切模型同一道闸：换技能要重启 opencode，正在跑的轮会被连根拔掉
      const busy = runningRounds()
      if (busy > 0 && !b.force)
        return send(res, 409, "application/json", JSON.stringify({ ok: false, busy, needForce: true, err: `有 ${busy} 轮正在生成中，更新/回退技能需重启后台，会中断它们` }))
      let restarted = false
      try {
        if (u.pathname === "/api/skillpacks/update") {
          const latest = await skillLatestSoon(true)
          if (!latest) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "云端当前没有可用的技能包" }))
          // 只允许装"云端现在的最新版"：旧版一律走本机回退（云端撤下的版本本来就不该再装）
          const dl = await Cloud.downloadSkillPack(latest.version)
          if (!dl.ok) return send(res, 502, "application/json", JSON.stringify({ ok: false, err: (dl.error && dl.error.message) || "下载失败" }))
          // 【先停 opencode 再动技能目录】Windows 上正被占用的文件 rename 不动；
          // opencode 反正要重启才会重扫技能，先停后换名最稳
          if (OC_MANAGED) killPort(OC_PORT)
          SkillUp.installBuffer(dl.buf, { version: latest.version, sha256: latest.sha256 })
        } else {
          const version = String(b.version || "").trim()
          if (!version) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "缺 version" }))
          if (OC_MANAGED) killPort(OC_PORT)
          SkillUp.rollback(version)
        }
      } catch (e) {
        try { restarted = await restartOpencode() } catch {}   // 失败也要把 opencode 拉回来
        return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e.message || e), restarted }))
      }
      try { restarted = await restartOpencode() } catch {}
      clearSkillLatestCache()   // 立刻重查：装完/退完横幅状态要马上正确，别等半小时
      return send(res, 200, "application/json", JSON.stringify({
        ok: true, restarted, current: SkillUp.currentVersion(), local: SkillUp.listLocal(),
      }))
    }

    // ==== 云端 API 通用转发（给"以后只发界面包"留的口）==============================
    //
    // 【为什么要有它】前端只能打本机网关，够不到云端（access key 在本进程手里）。于是每加一个
    // "前端 + 云端新接口"的功能，都得改一次 web/server.mjs —— 而 .mjs 恰恰是界面包发不了的，
    // 等于每个这类小功能都要重发一次安装器。有了这个口，以后那类功能就真能只发前端。
    //
    // 【边界】它不是"任意代理"：
    //   · 只准打本平台自己的云端地址（Cloud.cloudBase()），不是用户给什么地址就打什么；
    //   · 只准 /api/ 下的路径，且【明确排除 /api/auth/*】—— 登录、续期、改密、登出这些动的是
    //     凭证本身，必须走各自那条有专门处理的路（比如续期要 single-flight、改密要清缓存），
    //     从这里绕过去只会把登录态弄坏；
    //   · 路径里出现 .. 或以 // 开头一律拒（别让它拼出别的主机/越界路径）。
    // 这不构成提权：浏览器里的人就是这台机器的用户，本来就能用自己的账号调这些接口。
    if (req.method === "POST" && u.pathname === "/api/cloud/call") {
      if (!cloudLoggedIn()) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "未登录云端账号" }))
      const chunks = []; for await (const c of req) chunks.push(c)
      let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      const p = String(b.path || "")
      if (!/^\/api\/[A-Za-z0-9\-_/.?=&%]*$/.test(p) || p.includes("..") || p.startsWith("//"))
        return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "path 必须是本平台 /api/ 下的路径" }))
      if (/^\/api\/auth\//.test(p))
        return send(res, 403, "application/json", JSON.stringify({ ok: false, err: "凭证类接口不走通用转发（登录/续期/改密各有专门处理）" }))
      const method = b.method === "POST" ? "POST" : "GET"
      const r = await Cloud.callApi(p, { method, body: b.body })
      if (!r.ok) return send(res, r.status && r.status >= 400 ? r.status : 502, "application/json",
        JSON.stringify({ ok: false, err: (r.error && r.error.message) || "云端请求失败", code: r.error && r.error.code }))
      return send(res, 200, "application/json", JSON.stringify({ ok: true, data: r.data }))
    }

    // ==== 用户反馈：把一次会话交给管理员 ==========================================
    //
    // 用户对某次结果满意/不满意，光说一句"不好用"管理员无从复现。这里把【整段对话】连同
    // 赞/踩、一段评论、以及用户**自己勾选**的产出文件打成一个 zip 交上去。
    //
    // 【隐私】会话里可能有患者信息。所以：① 产出文件默认一个都不勾；② 前端弹窗把"会把整段
    // 对话发给管理员"写在最显眼处；③ 服务端只存不看，导出时全程转义。发不发由用户自己决定。
    if (req.method === "GET" && u.pathname === "/api/feedback/preview") {
      const sid = u.searchParams.get("sid") || ""
      if (!sid) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "缺少会话 id" }))
      if (!cloudLoggedIn()) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "未登录云端账号，无法提交反馈" }))
      let title = "", msgs = []
      try { title = (un(await client.session.get({ path: { id: sid } })) || {}).title || "" } catch {}
      try { msgs = await collectTranscript(sid) } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ ok: false, err: "读不到这个会话的记录：" + (e.message || e) }))
      }
      let files = []
      try {
        const dir = await sessionOut(sid)
        if (fs.existsSync(dir)) files = Object.entries(dirState(dir))
          .map(([rel]) => { try { return { name: rel, size: fs.statSync(path.join(dir, rel)).size } } catch { return null } })
          .filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
      } catch {}
      // ★ 按 UTF-8 真实字节算，不是字符数。前端拿它 /1024 报「约 N KB」，而中文一个字 3 字节 ——
      //   5500 字的中文会话界面写"约 5 KB"、真实 16 KB，低估 3 倍。同一个弹窗里产出文件的大小
      //   是真字节，两个"KB"不是一回事，而用户正是拿这个数判断要不要把整段会话交给管理员。
      const chars = msgs.reduce((n, m) => n + Buffer.byteLength(m.text || "", "utf8"), 0)
      return send(res, 200, "application/json", JSON.stringify({ ok: true, title, msgs: msgs.length, chars, files }))
    }

    if (req.method === "POST" && u.pathname === "/api/feedback/send") {
      if (!cloudLoggedIn()) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "未登录云端账号，无法提交反馈" }))
      const chunks = []; for await (const c of req) chunks.push(c)
      let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      const sid = String(b.sid || "")
      if (!sid) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "缺少会话 id" }))
      const comment = String(b.comment || "").slice(0, 4000)
      const vote = Math.sign(Number(b.vote) || 0)
      if (!vote && !comment.trim())
        return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "请至少点个赞/踩，或写一句说明" }))
      let title = "", msgs = []
      try { title = (un(await client.session.get({ path: { id: sid } })) || {}).title || "" } catch {}
      try { msgs = await collectTranscript(sid) } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ ok: false, err: "读不到这个会话的记录：" + (e.message || e) }))
      }
      // 打包：feedback.json + files/<勾选的产出>
      const entries = [{
        name: "feedback.json",
        data: Buffer.from(JSON.stringify({
          sessionId: sid, title, vote, comment, transcript: msgs,
          meta: { model: MODEL.modelID, route: currentRoute(), skills: [...new Set(msgs.flatMap((m) => m.skills || []))] },
        }), "utf8"),
      }]
      const want = Array.isArray(b.files) ? b.files.map(String) : []
      if (want.length) {
        const dir = await sessionOut(sid)
        const known = fs.existsSync(dir) ? new Set(Object.keys(dirState(dir))) : new Set()
        for (const rel of want) {
          // 【只收本会话产物目录里确实存在的相对路径】名字来自前端，拼进 path.join 前必须比对
          if (!known.has(rel)) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: `产出文件不存在：${rel}` }))
          const p = path.join(dir, rel)
          const st = fs.statSync(p)
          if (st.size > 8 * 1024 * 1024)
            return send(res, 400, "application/json", JSON.stringify({ ok: false, err: `${rel} 有 ${(st.size / 1048576).toFixed(1)}MB，超过单个附件 8MB 上限，请取消勾选` }))
          // 【重名要错开】产出可以在子目录里（figures/forest.png），包内一律拍平成文件名；
          // 两个子目录里同名的文件拍平后会互相覆盖 —— 管理员看到两条记录、磁盘上只有一个文件。
          let base = rel.split(/[\\/]/).pop()
          if (entries.some((e) => e.name === "files/" + base)) base = rel.replace(/[\\/]/g, "_")
          entries.push({ name: "files/" + base, data: fs.readFileSync(p) })
        }
      }
      const buf = zipPack(entries)
      if (buf.length > 32 * 1024 * 1024)
        return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "反馈包超过 32MB，请少勾几个产出文件" }))
      const r = await Cloud.sendFeedback(buf)
      if (!r.ok) return send(res, 502, "application/json", JSON.stringify({ ok: false, err: (r.error && r.error.message) || "提交失败" }))
      return send(res, 200, "application/json", JSON.stringify({ ok: true, id: r.id, size: buf.length, files: entries.length - 1 }))
    }

    // ==== 界面包：本机状态 / 在线更新 / 回退（桌面版；详见 web-update.mjs 头注）=========
    //
    // 与技能包最大的不同：**不重启任何进程**。网关每次请求都从磁盘现读 index.html，
    // 所以换完文件让用户刷新一下页面就生效，正在跑的轮一个都不会被打断。
    if (req.method === "GET" && u.pathname === "/api/webpacks/status") {
      if (!cloudLoggedIn())
        return send(res, 200, "application/json", JSON.stringify({ ok: true, available: false }))
      const latest = await webLatestSoon(u.searchParams.get("fresh") === "1").catch(() => null) || null
      return send(res, 200, "application/json", JSON.stringify({
        ok: true, available: true,
        current: WebUp.currentVersion(),        // '' = 出厂版（安装器自带那套界面）
        local: WebUp.listLocal(),               // 可回退的本机留存版本
        latest, update: webUpdateInfo(latest),
      }))
    }
    if (req.method === "POST" && (u.pathname === "/api/webpacks/update" || u.pathname === "/api/webpacks/rollback")) {
      if (!cloudLoggedIn() && u.pathname === "/api/webpacks/update")
        return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "未登录云端账号，无法在线更新界面" }))
      const chunks = []; for await (const c of req) chunks.push(c)
      let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      // 【这里没有"有轮在跑就拦"那道闸】换的是静态文件、不重启后台，正在生成的轮不受影响。
      try {
        if (u.pathname === "/api/webpacks/update") {
          const latest = await webLatestSoon(true)
          if (!latest) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "云端当前没有可用的界面包" }))
          // 只允许装"云端现在的最新版"：旧版一律走本机回退（云端撤下的版本本来就不该再装）
          const dl = await Cloud.downloadWebPack(latest.version)
          if (!dl.ok) return send(res, 502, "application/json", JSON.stringify({ ok: false, err: (dl.error && dl.error.message) || "下载失败" }))
          WebUp.installBuffer(dl.buf, { version: latest.version, sha256: latest.sha256 })
        } else {
          const version = String(b.version || "").trim()
          if (!version) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "缺 version" }))
          WebUp.rollback(version)
        }
      } catch (e) {
        return send(res, 500, "application/json", JSON.stringify({ ok: false, err: String(e.message || e) }))
      }
      clearWebLatestCache()   // 立刻重查：装完/退完提示条状态要马上正确，别等半小时
      return send(res, 200, "application/json", JSON.stringify({
        ok: true, current: WebUp.currentVersion(), local: WebUp.listLocal(),
        // 前端据此提示"刷新一下页面即可看到新界面"——这就是它与技能包更新的全部差别
        reload: true,
      }))
    }

    // 当前后台模型配置（apiKey 不回传，只报是否已设）
    if (req.method === "GET" && u.pathname === "/api/model") {
      const c = loadModelCfg()
      return send(res, 200, "application/json", JSON.stringify({
        providerID: MODEL.providerID, modelID: MODEL.modelID,
        isCustom: MODEL.providerID === CUSTOM_PROVIDER_ID,
        baseURL: c?.baseURL || "", hasKey: !!(c && c.apiKey),
        default: `${PID}/${MID}`, managed: OC_MANAGED,
        gateway: platformAvailable(),   // 有没有平台可走（云端账号 或 静态网关 key）
        route: currentRoute(),          // cloud | gateway | custom | none —— 前端据此显示"当前走哪条路"与切回入口
        gatewayURL: cloudLoggedIn() ? Cloud.cloudBase() : (process.env.OC_GATEWAY_URL || ""),   // 只回地址不回 key
        cloud: Cloud.status(),          // 云端账号摘要（不含任何凭证）
      }))
    }
    // 测试一个 OpenAI 格式的 API（URL + key + 模型）是否可用
    if (req.method === "POST" && u.pathname === "/api/model/test") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let baseURL = "", apiKey = "", modelID = ""
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); baseURL = (b.baseURL || "").trim(); apiKey = (b.apiKey || "").trim(); modelID = (b.modelID || "").trim() } catch {}
      if (!baseURL || !apiKey || !modelID) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "请填写 API URL、API Key、模型 ID" }))
      { const bad = modelUrlReject(baseURL); if (bad) return send(res, 400, "application/json", bad) }
      const url = baseURL.replace(/\/+$/, "") + "/chat/completions"
      const t0 = Date.now()
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 20000)
      try {
        const r = await fetch(url, {
          method: "POST", signal: ac.signal,
          // 不跟随跳转：上面的私网校验只作用于首跳，若自动跟随，攻击者用一个公网地址 302 到
          // http://127.0.0.1:3010 就能绕过整道护栏（响应体虽已不回显，status/耗时仍是可达性信号）。
          // 正经的 OpenAI 兼容端点不会把 POST /chat/completions 重定向走。
          redirect: "manual",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify({ model: modelID, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
        })
        clearTimeout(timer)
        const ms = Date.now() - t0
        if (r.status >= 300 && r.status < 400)
          return send(res, 200, "application/json", JSON.stringify({ ok: false, status: r.status, ms, err: "该地址发生了重定向，出于安全考虑不予跟随；请直接填最终的 API 地址" }))
        const body = await r.text()
        if (!r.ok) {
          // 【不回显上游响应体】：本接口可被指向任意 URL，原样回显 body 等于把探测结果送给调用方。
          // 只给状态码 + 按状态类别的固定说明——够用户排查自己的配置，又不泄露上游内容。
          const hint = (r.status === 401 || r.status === 403) ? "密钥无效或无权限"
            : r.status === 404 ? "地址或模型不存在（检查 API URL 是否需以 /v1 结尾、模型 ID 是否正确）"
            : r.status === 429 ? "上游限流，稍后再试"
            : r.status >= 500 ? "上游服务异常" : "上游返回错误"
          return send(res, 200, "application/json", JSON.stringify({ ok: false, status: r.status, ms, err: `${hint}（HTTP ${r.status}）` }))
        }
        // 成功分支只回模型回复的前 80 字：需要上游返回标准 OpenAI 结构才有值，普通内网服务命不中。
        let reply = ""; try { const j = JSON.parse(body); reply = j.choices?.[0]?.message?.content || "" } catch {}
        return send(res, 200, "application/json", JSON.stringify({ ok: true, status: r.status, ms, reply: String(reply).slice(0, 80) }))
      } catch (e) {
        clearTimeout(timer)
        // 同理不回显底层错误串：ECONNREFUSED / EHOSTUNREACH / ENOTFOUND 的区别本身就是端口扫描的信号，统一成一句话。
        return send(res, 200, "application/json", JSON.stringify({ ok: false, err: e?.name === "AbortError" ? "请求超时（20s 内无响应）" : "无法连接到该地址（检查 API URL 是否正确、是否可公网访问）" }))
      }
    }
    // 切换后台模型：注册自定义 provider → 重启 opencode → 更新当前模型
    if (req.method === "POST" && u.pathname === "/api/model") {
      const chunks = []; for await (const c of req) chunks.push(c)
      let baseURL = "", apiKey = "", modelID = "", force = false
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); baseURL = (b.baseURL || "").trim(); apiKey = (b.apiKey || "").trim(); modelID = (b.modelID || "").trim(); force = !!b.force } catch {}
      if (!baseURL || !apiKey || !modelID) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "请填写 API URL、API Key、模型 ID" }))
      // SSRF 护栏：与 /api/model/test 用同一条判据。这条才是真正写配置并生效的路径。
      { const bad = modelUrlReject(baseURL); if (bad) return send(res, 400, "application/json", bad) }
      // 切模型要 restartOpencode()，会把所有在跑的轮连根拔掉：用户跑了半小时的综述，切个模型就没了，
      // 且此前没有任何提示。改为先挡住并如实说明，前端确认后带 force:true 重发才真切。
      { const busy = runningRounds(); if (busy > 0 && !force) return send(res, 409, "application/json", JSON.stringify({ ok: false, busy, needForce: true, err: `有 ${busy} 轮正在生成中，切换模型需重启后台，会中断它们` })) }
      writeOcProvider({ baseURL, apiKey, modelID })
      saveModelCfg({ route: "custom", baseURL, apiKey, modelID })
      MODEL = { providerID: CUSTOM_PROVIDER_ID, modelID }
      let restarted = false
      try { restarted = await restartOpencode() } catch {}
      if (!restarted) { try { await client.config.update({ body: { provider: { [CUSTOM_PROVIDER_ID]: customProviderCfg({ baseURL, apiKey, modelID }) } } }) } catch {} }
      return send(res, 200, "application/json", JSON.stringify({ ok: true, restarted, providerID: CUSTOM_PROVIDER_ID, modelID }))
    }
    // 平台下可选的模型清单（顶部模型 pill 用它画下拉）。
    //
    // 【为什么清单来自服务器而不是本地写死】管理员在运营后台加一家供应商 / 加一个模型、
    // 把它勾进档位的允许清单之后，这里下一次取就有了 —— 打包版不用重装、不用改配置。
    if (req.method === "GET" && u.pathname === "/api/models") {
      const route = currentRoute()
      const list = route === "cloud" ? cloudModels() : []
      return send(res, 200, "application/json", JSON.stringify({
        ok: true, route,
        current: MODEL.modelID,
        default: Cloud.loadState()?.profile?.model || "",
        models: list.map((m) => ({ model: m.model, label: m.label || m.model, provider: m.providerName || m.provider || "" })),
      }))
    }
    // 用户切换平台下的模型：沿用平台的 baseURL/key，只换模型名（持久化 + 重启 opencode 生效）
    if (req.method === "POST" && u.pathname === "/api/model/pick") {
      // 【两种平台形态都要能切】桌面版走云端账号（本机 /cloud 代理 + 占位 token），
      // 云端多用户容器走注入的静态网关 key。此前这里只认后者，桌面版点了永远是"未接入网关"。
      if (!platformAvailable()) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "未接入平台，无法切换模型" }))
      const chunks = []; for await (const c of req) chunks.push(c)
      let modelID = "", force = false
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); modelID = (b.model || "").trim(); force = !!b.force } catch {}
      if (!modelID) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "缺 model" }))
      // 不在档位允许清单里就当场说清楚。网关那边会静默打回默认模型，客户端要是也跟着静默，
      // 用户只会看到"选了却没换"，还以为是 bug。
      if (currentRoute() === "cloud" && !modelAllowed(modelID))
        return send(res, 400, "application/json", JSON.stringify({ ok: false, err: `当前档位没有开通「${modelID}」，请联系管理员` }))
      // 同 /api/model：这条路径也 restartOpencode()，同样会中断在跑的轮
      { const busy = runningRounds(); if (busy > 0 && !force) return send(res, 409, "application/json", JSON.stringify({ ok: false, busy, needForce: true, err: `有 ${busy} 轮正在生成中，切换模型需重启后台，会中断它们` })) }
      const p = platformProvider()
      const cfg = { baseURL: p.baseURL, apiKey: p.apiKey, modelID, cost: p.route === "cloud" ? costOfModel(modelID) : null }
      writeOcProvider(cfg)
      saveModelCfg({ route: p.route, baseURL: p.baseURL, apiKey: p.apiKey, modelID, picked: modelID })
      MODEL = { providerID: CUSTOM_PROVIDER_ID, modelID }
      let restarted = false; try { restarted = await restartOpencode() } catch {}
      if (!restarted) { try { await client.config.update({ body: { provider: { [CUSTOM_PROVIDER_ID]: customProviderCfg(cfg) } } }) } catch {} }
      return send(res, 200, "application/json", JSON.stringify({ ok: true, restarted, modelID }))
    }
    // 恢复默认模型（清掉自定义 provider）
    if (req.method === "POST" && u.pathname === "/api/model/reset") {
      // 这条同样 restartOpencode()，与 /api/model、/api/model/pick 是同一个危害：
      // 在跑的轮被无声拔掉，且因为走不到 addCost 那步，本轮成本【完全不计费】。前两处加了拦截，这里漏了。
      let rforce = false
      try { const chunks = []; for await (const c of req) chunks.push(c); rforce = !!JSON.parse(Buffer.concat(chunks).toString() || "{}").force } catch {}
      { const busy = runningRounds(); if (busy > 0 && !rforce) return send(res, 409, "application/json", JSON.stringify({ ok: false, busy, needForce: true, err: `有 ${busy} 轮正在生成中，恢复默认模型需重启后台，会中断它们` })) }
      try { fs.unlinkSync(MODEL_CFG_PATH) } catch {}
      // 【接了网关就回网关，而不是回内置默认】默认路由本来就是网关（见启动那段），
      // 这里若照旧 removeOcProvider() 回落到内置 provider，就会出现"点了切回、其实哪也没回，
      // 得把进程重启一次才真的回到网关"这种前后不一致。
      // 用 platformAvailable() 而不是只看环境变量：桌面版的平台入口是【登录后的云端账号】，
      // 环境变量是空的。照旧只判 env 会走进"清掉 provider"那支 —— 路由报着 cloud，
      // 而 opencode 其实什么 provider 都没有，下一次发消息才发现整条链是断的。
      if (platformAvailable()) useGatewayRoute()
      else { removeOcProvider(); MODEL = { providerID: PID, modelID: MID } }
      let restarted = false; try { restarted = await restartOpencode() } catch {}
      return send(res, 200, "application/json", JSON.stringify({
        ok: true, restarted, route: currentRoute(),
        providerID: MODEL.providerID, modelID: MODEL.modelID,
      }))
    }

    send(res, 404, TEXT_UTF8, "not found")
  } catch (err) {
    try { send(res, 500, TEXT_UTF8, String(err?.stack || err)) } catch {}
  }
})
// ---- opencode 生命周期：网关启动时刷新一个干净的 opencode，让它重扫 .opencode/skills/ ----
// opencode 只在“启动那一刻”扫描 skill 目录并缓存，新增/改名的技能不会被运行中的实例识别，
// 必须重启才能生效。默认仅当 OC 在本机时自动接管；OC 指向远端（如 docker-compose 独立服务）时自动跳过。
// 覆盖开关：MANAGE_OC=0 强制关闭；MANAGE_OC=1 强制开启（即使 OC 是远端）。
const ocHealthy = () => new Promise((resolve) => {
  const req = http.get(OC_URL + "/app", (r) => { r.resume(); resolve(true) })   // 任意 HTTP 应答即视为活着
  req.on("error", () => resolve(false))
  req.setTimeout(2500, () => { req.destroy(); resolve(false) })
})
const killPort = (port) => {
  try {
    if (process.platform === "win32")
      execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore", windowsHide: true })
    else
      execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: "ignore" })
  } catch { /* 端口本就空闲 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OC_U = new URL(OC_URL)
const OC_LOCAL = ["127.0.0.1", "localhost", "::1"].includes(OC_U.hostname)
const OC_MANAGED = process.env.MANAGE_OC === "1" || (OC_LOCAL && process.env.MANAGE_OC !== "0")
const OC_PORT = Number(OC_U.port || 80)
// opencode 二进制的定位。
//
// 【为什么不能只靠裸名字】桌面版把 opencode.exe 打进了包，位置完全已知，却按裸名字交给
// cmd.exe 去 PATH 里找 —— 真机上就翻了车：serve.err 里只有一句
// 「'opencode' 不是内部或外部命令」，网关照常起来，用户对着启动页干转。
// 裸名字要同时依赖「PATH 前插生效」+「cmd.exe 能解析」+「文件真在盘上」三件事，
// 而我们本来就知道那个绝对路径。壳通过 OC_BIN 告诉网关，直接按路径起，还省掉 cmd.exe 那一跳。
// OC_BIN 缺省时（开发机、容器、服务器）退回裸名字 + PATH，行为不变。
export function resolveOcBin(env = process.env) {
  const bin = (env.OC_BIN || "").trim()
  if (!bin) return { cmd: "opencode", shell: process.platform === "win32", missing: false }
  // 壳指了路径却不在盘上 —— 多半是安装没解压全，或被杀软当可疑二进制隔离了。
  // 这两种都必须说人话，不能让现场只看到"命令找不到"这种把人引向 PATH 的误导信息。
  return { cmd: bin, shell: false, missing: !fs.existsSync(bin) }
}
function spawnOc() {
  const oc = resolveOcBin()
  if (oc.missing) {
    console.error(`[oc] 找不到 opencode 可执行文件：${oc.cmd}\n` +
      `    包里应当有这个文件。它不在，通常是两种情况：\n` +
      `    1) 安装没有完整解压（装的时候报过错、或中途被打断）——重新安装一次；\n` +
      `    2) 被杀毒软件当成可疑程序隔离了——去杀软的隔离区恢复它，并把安装目录加入信任。`)
    return
  }
  const out = fs.openSync(path.join(ROOT, "serve.out"), "a")
  const err = fs.openSync(path.join(ROOT, "serve.err"), "a")
  const child = spawn(oc.cmd, ["serve", "--port", String(OC_PORT)], {
    cwd: ROOT, detached: true, stdio: ["ignore", out, err], shell: oc.shell,
    // Windows 下 Python 的 stdout 默认走 GBK，技能脚本一打印中文就是乱码。agent 每次都得
    // 绕路（"我把详细信息 dump 到 UTF-8 文件再读"、"写个 wrapper 直接调它的 main"），
    // 一轮白烧 2–4 次 bash 调用，日志里的"乱码"字样还会让用户以为出错了。
    // 桌面版就是 Windows，这两个变量一劳永逸。Linux 上本来就是 UTF-8，设了无副作用。
    // SCI_IMAGE_URL：生图技能（mechanism-figure）该往哪儿打。指向本机这一跳，由 cloudForward
    // 贴上 access key 转给云端 /img —— 生图 key 只在服务器上，客户端一个字节都拿不到
    // （与 LLM 同一条原则）。没走云端账号（自设 API / 容器形态）时不设这个变量，
    // 技能会回退到读本机 QWEN_API_KEY，老用法不受影响。
    env: {
      ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
      // SCI_IMAGE_TOKEN 必须一起给：/cloud/* 那道闸【要求带本进程本次启动生成的转发令牌】
      // （见下方 CLOUD_PROXY_PREFIX 的两道闸），少给这一个就是 401「本机转发令牌不正确」。
      // 不能为了省事把 /cloud/img 从闸里放行 —— 那会让同机任何程序都能白嫖云端生图额度。
      // 令牌本就随 provider 配置交给了 opencode（apiKey: local-…），给技能用是同一层信任。
      // SCI_OCR_URL 同理：ocr 技能（图片识字）也是一把【全体用户共用】的上游 key，
      // 桌面版此前没有任何一处给它赋值 —— 技能一跑就报「缺 OCR_SPACE_API_KEY」，
      // 而容器版靠 render-compose 注入、看不出问题。走代理后 key 只留在服务器，
      // 每人每天的次数与全平台的池子都在服务端算（见 server/lib/ocrspace.mjs）。
      ...(cloudLoggedIn() ? {
        SCI_IMAGE_URL: `http://127.0.0.1:${PORT}${CLOUD_PROXY_PREFIX}img/generate`,
        SCI_IMAGE_TOKEN: CLOUD_LOCAL_TOKEN,
        SCI_OCR_URL: `http://127.0.0.1:${PORT}${CLOUD_PROXY_PREFIX}ocr/parse`,
        SCI_OCR_TOKEN: CLOUD_LOCAL_TOKEN,
      } : {}),
    },
    // 【Windows 必须给】detached + shell 会让 cmd.exe 另开一个控制台窗口，
    // opencode 的启动横幅就直接糊在用户脸上（桌面版尤其突兀：主窗口旁边跳出个黑框）。
    // windowsHide 对应 CREATE_NO_WINDOW，Tauri 壳起 node 时也是这么做的，这里补齐最后一段。
    // 走 OC_BIN 时没有 cmd.exe 这一跳，黑窗风险直接消失，但保留此项无害且覆盖 shell 分支。
    windowsHide: true,
  })
  child.on("error", (e) => console.warn(`[oc] 启动 opencode 失败：${e.message}（命令：${oc.cmd}）`))
  child.unref()
}
async function waitOcHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) { if (await ocHealthy()) return true; await sleep(500) }
  return false
}
// 切换模型后重启 opencode，让它重新读取 opencode.json 里的自定义 provider（仅接管本机 OC 时可用）
async function restartOpencode() {
  if (!OC_MANAGED) return false
  killPort(OC_PORT); await sleep(800); spawnOc()
  const ok = await waitOcHealthy()
  if (ok) ocLiveProvider = ocProviderOnDisk()   // 记下它这次读进去的那一份，见 ocLiveProvider
  return ok
}
async function ensureOpencode() {
  if (!OC_MANAGED) {
    console.log(`[oc] 不接管 opencode（OC=${OC_URL}），直接连它`)
    return
  }
  console.log(`[oc] 重启本机 opencode :${OC_PORT}（让它重扫 .opencode/skills/）...`)
  if (await restartOpencode()) console.log(`[oc] 就绪：${OC_URL}（工作目录=${ROOT}）`)
  else console.warn(`[oc] 30s 内未就绪，仍继续启动网关（排查见 serve.err）`)
}

const lanIPs = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address)

await ensureOpencode()
// 若上一次的网关还占着本端口，先杀掉它再起，避免 EADDRINUSE（重启即用，不必手动清端口）
killPort(PORT)
await sleep(500)
// 兜底：端口仍被别的进程占用时给一句人话提示，而不是抛未捕获的 'error' 事件
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.error(`[gateway] 端口 ${PORT} 仍被占用，无法启动。请手动结束占用进程后重试。`); process.exit(1) }
  else { console.error(`[gateway] 监听出错：${e.message}`); process.exit(1) }
})
// 绑 0.0.0.0：本机与局域网都能访问
server.listen(PORT, "0.0.0.0", () => {
  console.log(`gateway on http://localhost:${PORT}  (opencode=${OC_URL}, model=${MODEL.providerID}/${MODEL.modelID})`)
  for (const ip of lanIPs()) console.log(`  局域网访问：http://${ip}:${PORT}`)
  console.log(AUTH_ENABLED
    // 【不打印明文密码】这行会落进宿主的 docker JSON 日志文件，长期留存在磁盘上，
    // 任何抓容器日志的东西（日志采集、排障时的 docker logs、备份）都会带上它。
    // 多用户部署下每个容器的密码就是该用户的登录凭据，没必要为了启动提示把它写到盘上。
    // 只打掩码：位数信息足够运维确认"密码确实注入了"，又不泄露内容。
    ? `  局域网登录：账号 ${LAN_USER} / 密码 ${LAN_PASSWORD ? "*".repeat(Math.min(LAN_PASSWORD.length, 12)) + `（${LAN_PASSWORD.length} 位，见 users/<用户>.env）` : "(未设置)"}（本机 localhost 免登录；改账号密码用环境变量 LAN_USER/LAN_PASSWORD，关登录用 LAN_AUTH=0）`
    : `  登录已关闭（LAN_AUTH=0）`)
  // 元数据整理（只清残留、不删会话）：启动后延迟跑一次（等 opencode 就绪），之后每小时一次。
  // 两个定时器都 unref：它们不该成为"进程能不能退出"的理由 —— 否则自动化测试里
  // 网关关掉后事件循环仍被这个每小时的 interval 挂住，测试进程永远退不出去。
  setTimeout(pruneOrphanMeta, 15_000).unref?.()
  setInterval(pruneOrphanMeta, 60 * 60 * 1000).unref?.()
})

// ---- 优雅退出 ----
// entrypoint.sh 是 `exec node server.mjs`，所以 node 就是容器的 PID 1。PID 1 在没有注册处理器时，
// 内核【不】执行信号的默认动作 —— SIGTERM 被直接忽略，于是 `docker stop` 每次都白等满 10 秒宽限期
// 再 SIGKILL（实测退出码 137 就是这么来的）。manager 按需停容器/腾位很频繁，每次都多花 10 秒。
// 注册处理器后：立刻停止接受新连接 → 让在跑的轮自己收尾（有上限，不无限等）→ 主动收掉 opencode 子进程。
let shuttingDown = false
// console.log 在 stdout 是管道时（docker logs 正是管道）是【异步】写，紧跟 process.exit() 会把
// 没冲刷完的行直接丢掉——那样这条路径将完全不可观测。退出路径的日志改用同步写。
const exitLog = (s) => { try { fs.writeSync(1, s + "\n") } catch {} }
async function gracefulExit(sig) {
  if (shuttingDown) return
  shuttingDown = true
  exitLog(`[exit] 收到 ${sig}，开始优雅退出（在跑的轮：${runningRounds()}）`)
  try { server.close() } catch {}   // 停止接受新连接；已建立的连接自然收尾
  // 【顺序要紧：先结算、再 abort】
  // 上一版这里写的是 `await job.abort()`，注释说"abort 会走 finish() → addCost"——那条链路
  // 【代码里根本不存在】：finish() 只清状态（job.running=false; jobs.delete），addCost 唯一的
  // 调用点在主 IIFE 里、必须等 session.prompt 返回之后才到得了。于是那版改动的实际效果是：
  // abort → jobs 清空 → runningRounds() 归零 → 下面的排空循环【第一次判断就退出】、6 秒窗口
  // 变成死代码 → process.exit 立刻执行 → 那个还停在 prompt 上的 IIFE 被杀 → 成本永远入不了账。
  // 比不改还差：改之前，能在 6 秒内自然结束的轮次好歹会自己走到 addCost。
  // 现在显式结算：查一次当前累计成本，减去开轮前的 job.cost0，直接 addCost。
  const settleDeadline = Date.now() + 4000
  for (const job of [...jobs.values()]) {
    // 【settled 占坑必须在本 job 的一切 await 之前】与主循环的结算分支（同样是同步 check-and-set）互斥。
    // 否则两个方向都能双记：①主循环结算后、finish() 前（中间隔着 changedSince 的目录遍历）收到 SIGTERM，
    // 这里见 running=true 又结一遍；②这里在 await session.get 时轮子自然跑完，主循环见 settled 未设自己结，
    // 随后这边 await 返回再结。cost0 还没来得及读到的轮（刚起步几毫秒）直接跳过：按 c1-0 结会把
    // 该会话【历史全部成本】当成本轮重记一遍，宁可放过这几毫秒。
    if (!job.running || job.settled || job.cost0 === undefined) continue
    job.settled = true
    try {
      // 给每次查询单独设超时：opencode 若已卡死，这里不能一直等 —— docker 的宽限期只有 10 秒，
      // 拖过去就是 SIGKILL，下面的 killPort 也执行不到，反而留下孤儿 opencode 进程。
      const left = Math.max(500, settleDeadline - Date.now())
      const info = await Promise.race([
        client.session.get({ path: { id: job.sid } }).then(un),
        new Promise((_, rej) => setTimeout(() => rej(new Error("settle timeout")), left)),
      ])
      const c1 = info?.cost || 0
      // 真实增量之外，把"正在流式、还没被真实计费"的那一步按估算补上（job.estExtra 只算 real=0 的消息）。
      // 停机路径没时间逐条问权威状态，竞态窗口里可能极小幅高估——比整步漏账好。
      let est = 0; try { est = job.estExtra?.() || 0 } catch {}
      const delta = c1 - (job.cost0 || 0) + est
      if (delta > 0) { addCost(delta); exitLog(`[exit] 已结算 ${job.sid} 本轮成本 $${delta.toFixed(4)}（含估算 $${est.toFixed(4)}）`) }
    } catch (e) {
      job.settled = false   // 结算失败要还坑：主循环若还活着（比如只是 settle timeout），让它还有机会自己结，别把整轮变漏账
      exitLog(`[exit] 结算 ${job.sid} 失败（本轮可能不计费）：${e?.message || e}`)
    }
    try { await Promise.race([job.abort(), sleep(1500)]) } catch {}   // abort 也别无限等
  }
  // 给收尾留一点时间，但设硬上限——宽限期本身只有 10 秒，超时就没意义了
  const deadline = Date.now() + 3000
  while (runningRounds() > 0 && Date.now() < deadline) await sleep(200)
  if (runningRounds() > 0) exitLog(`[exit] 仍有 ${runningRounds()} 轮未收尾，不再等待`)
  // 宿主账本模式：上面 addCost 只把增量放进 pending（上报是异步的），停机前必须冲刷一次，
  // 否则「manager 空闲回收容器」这条最常见的停机路径每次都会丢掉最后一轮的上报。限时别拖过宽限期。
  if (REMOTE_QUOTA && rq.pending > 0) {
    // 用小循环而非单次调用：结算路径的 addCost 可能已触发一次在途 flush（rqFlush 对并发调用直接返回），
    // 这里要等的是「pending 清零」这个结果，不是某一次调用返回。
    const fDeadline = Date.now() + 2000
    while (rq.pending > 0 && Date.now() < fDeadline) { try { await rqFlush() } catch {}; if (rq.pending > 0) await sleep(150) }
    if (rq.pending > 0) exitLog(`[exit] 仍有 $${rq.pending.toFixed(4)} 未上报到宿主账本（宿主不可达？），该笔将丢失`)
  }
  // opencode 是 detached+unref 的子进程，不主动收会变成孤儿（容器销毁时才被清掉）。
  // 复用 restartOpencode 用的同一把刀：killPort(OC_PORT)（本进程没有留着 child 句柄可用）
  if (OC_MANAGED) { try { killPort(OC_PORT) } catch {} }
  exitLog("[exit] 完成")
  process.exit(0)
}
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { gracefulExit(s) })
