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
// 每日成本额度与中途封顶全部失效。价格由 OC_COST_* 环境变量给（deploy/.env 集中配），缺省按 DeepSeek 常见价。
const _modelCost = () => {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d }
  return { input: n(process.env.OC_COST_INPUT, 0.27), output: n(process.env.OC_COST_OUTPUT, 1.10), cache_read: n(process.env.OC_COST_CACHE_READ, 0.07), cache_write: n(process.env.OC_COST_CACHE_WRITE, 0) }
}
// cost 传了就用传的（云端账号形态下，每个模型的单价由服务器随档案下发——各家价格不同，
// 拿 env 里那套 DeepSeek 价去算别家的模型，本机显示的成本会系统性偏）。没传才回落 env。
const customProviderCfg = ({ baseURL, apiKey, modelID, cost }) => ({
  npm: "@ai-sdk/openai-compatible", name: "Custom (OpenAI 兼容)",
  options: { baseURL, apiKey },
  models: { [modelID]: { name: modelID, tool_call: true, attachment: true, cost: cost || _modelCost() } },   // 开工具调用 + 注入定价（用于算成本额度）
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
  const msgs = un(await client.session.messages({ path: { id: sid } })) || []
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
  const delOut = await sessionOut(id), delUp = await sessionUp(id)
  try { await client.session.delete({ path: { id } }) } catch {}
  try { fs.rmSync(delUp, { recursive: true, force: true }); fs.rmSync(delOut, { recursive: true, force: true }); dirCache.delete(safeSid(id)) } catch {}
  pendingReverts.delete(id)   // 已删会话的待提交登记没人再消费，别驻留到进程重启
  unbindSessionModule(id)     // 模块绑定同样随会话删除，别在持久表里越积越多
  if (META.sessions[id]) { delete META.sessions[id]; saveMeta() }
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
const dirState = (dir, depth = DIRSTATE_DEPTH, prefix = "") => {
  if (!fs.existsSync(dir)) return {}
  const m = {}
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return m }
  for (const e of ents) {
    if (e.name.startsWith(".")) continue          // .preview 等派生缓存不进列表
    if (e.name === "_workflow.json") continue     // 工作流状态是网关自己的簿子，不是用户产物
    const p = path.join(dir, e.name)
    const rel = prefix ? prefix + "/" + e.name : e.name
    let st; try { st = fs.statSync(p) } catch { continue }
    if (st.isFile()) m[rel] = st.mtimeMs
    else if (st.isDirectory() && depth > 0) Object.assign(m, dirState(p, depth - 1, rel))
  }
  return m
}
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
// 【三处同步维护】本表 ↔ deploy/manager.mjs 的 MODULE_TABLE ↔ deploy/scripts/user-modules.sh 的 ALL_MODULES。
// 模块 id 一经发布就不要改：deploy 的 users/<名>.env 里 MODULES= 存的是 id，改名等于把老用户的授权改没。
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
  litread:  { name: "文献研读",       group: "skills",
              desc: "追踪医学领域前沿文献，梳理研究脉络，挖掘研究空白，提炼创新思路，为课题设计、文稿创作提供理论支撑。" },
  refcheck: { name: "文稿核查与审校", group: "skills",
              desc: "校验试验逻辑、专业术语、数据及格式、核验文献与引用来源，识别伪造、篡改与 AI 幻觉内容，输出可信度报告。" },
  humanize: { name: "文章润色",       group: "skills",
              desc: "贴合期刊写作范式，优化行文逻辑、专业表述与段落架构，消除生成式文本痕迹，还原自然学术语感与逻辑节奏。" },
  stats:    { name: "数据统计与分析", group: "skills",
              desc: "一站式医学科研数据服务，涵盖统计建模、基线分析、期刊图表绘制、数据脱敏与源数据核查，完成从数据质控到结果可视化全流程处理。" },
}
// 技能集与主技能由 workflows.mjs 回填（chat 例外：skills 恒为 null = 不受限）。
// 就地写回 MODULE_DEFS 而不是到处调 WF.skillsOf()：下游有十几处读 m.skills，保持它们不用改。
for (const [id, m] of Object.entries(MODULE_DEFS)) {
  if (m.skills === null) continue                     // chat
  m.skills = WF.skillsOf(id)
  m.primary = WF.primaryOf(id)
  if (!m.skills || !m.primary) console.warn(`[modules] 模块 ${id} 在 workflows.mjs 里没有对应工作流 → 该模块将不可用，请补上定义`)
}
/** 模块的主技能（决定该模块是否可用）；chat 无主技能 */
const modPrimarySkill = (id) => MODULE_DEFS[id]?.primary || null
/**
 * 技能 → "该去哪个模块" 的反查，用于越权报错时指路。
 * 只说"请到自由对话"太糊：用户在 SCI 论文模块里被 nature-figure 挡下时，真正该去的是
 * 「数据统计与分析」。找不到归属（如 systematic-review 不属于任何模块）才回落到自由对话。
 */
const skillHome = (skill) => {
  const name = String(skill || "").replace(/（.*$/, "").trim()   // 剥掉 "（bash 直呼技能脚本）" 这类后缀
  const hits = Object.entries(MODULE_DEFS).filter(([, m]) => m.skills?.includes(name)).map(([, m]) => m.name)
  if (!hits.length) return ""
  return `「${name}」属于${hits.map((h) => `「${h}」`).join(" / ")}模块，请到那里新开会话继续。`
}
/** 模块是否可用 = 模块本身获授权 且 主技能未被技能白名单收权 */
const moduleUsable = (id) => ALLOWED_MODULES.includes(id) && (!modPrimarySkill(id) || skillAllowed(modPrimarySkill(id)))
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
const sessionModule = (sid) => moduleMap()[safeSid(sid)] || "chat"   // 未登记的老会话一律按 chat
const bindSessionModule = (sid, modId) => { moduleMap()[safeSid(sid)] = modId; saveModuleMap() }
const unbindSessionModule = (sid) => { if (moduleMap()[safeSid(sid)]) { delete moduleMap()[safeSid(sid)]; saveModuleMap() } }
// ---- 会话的工作流状态（表单值 + 步骤进度）----
// 落在【会话产物目录】而不是全局表：它天然随会话建、随会话删（删会话会整目录清掉），
// 也跟着产物一起被打包/迁移。下划线前缀 → dirState 不过滤下划线，所以这里额外在产物列表里排掉它，
// 免得用户在"产出"侧栏看到一个莫名其妙的 json。
// 【谁写】服务端。agent 只读不写：进度由"产物文件出现了没有"反推（见 wfSyncDone），
// 不依赖模型自觉，也不给它篡改进度的机会。
const WF_STATE = "_workflow.json"
const wfLoad = (outDir) => {
  try { return JSON.parse(fs.readFileSync(path.join(outDir, WF_STATE), "utf8")) || null } catch { return null }
}
const wfSave = (outDir, st) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, WF_STATE), JSON.stringify(st, null, 2)) }
  catch (e) { console.warn(`[workflow] 状态写入失败：${e.message}`) }
}
/** 表单值（intake + 各步 form 合并成一张平表，供 when 条件判定与跨步继承）*/
const wfValues = (outDir) => wfLoad(outDir)?.form || {}
/** 按"产物文件是否已出现"反推已完成的步骤（权威判据，不问 agent）*/
function wfSyncDone(outDir, modId) {
  const st = wfLoad(outDir)
  if (!st || st.module !== modId) return st
  const files = Object.keys(dirState(outDir))
  const done = new Set(st.done || [])
  for (const s of WF.stepsFor(modId, st.form || {})) {
    if (done.has(s.id)) continue
    if ((s.emits || []).some((g) => files.some((f) => WF.globMatch(g, f)))) done.add(s.id)
  }
  const arr = [...done]
  if (arr.length !== (st.done || []).length) { st.done = arr; wfSave(outDir, st) }
  return st
}

// 受限模块的会话前言：与工作区前言同一个块注入（中间不能有空行——stripPreamble 按"第一个空行"剥离）
// 【三段】① 技能白名单（硬边界，网关强制）② 步骤链剧本 ③ 产物文件名契约。
// 为什么要 ②③：技能集从"手写几个"变成"按 pipeline 展开的一整条"之后，光靠白名单已经区分不出
// 模块了（paper 的技能集几乎覆盖全部）。真正让模块成其为模块的是剧本 —— 走哪几步、哪几步是闸、
// 闸不过退到哪。产物契约则是界面能把结果渲染成表格/文献卡片的前提。
const modulePreamble = (modId, outDir) => {
  const m = MODULE_DEFS[modId]
  if (!m || !m.skills) return ""
  const list = m.skills.map((s) => `\`${s}\``).join("、")
  const vals = outDir ? wfValues(outDir) : {}
  return `\n- **【模块限制，最高优先级，覆盖 AGENTS.md 的一切路由规则】本会话是「${m.name}」专用模块**：你【只允许】调用这些技能——${list}（其中 \`${m.primary}\` 是主技能，其余按需配套），禁止调用任何其它技能，也禁止用 task/子代理间接调用其它技能。\n- 只在本模块职责范围内推进，不越界做别的模块的事；缺信息就直接向用户要。\n- 用户的需求超出「${m.name}」范围时，明确告知“本模块只负责${m.name}，其它需求请到「自由对话」模块”，不要自己徒手代替其它技能去做。\n- 网关会强制校验技能调用：一旦调用上述清单之外的技能，本轮会被立即中止。${WF.pipelineLine(modId, vals)}${WF.artifactLine(modId, vals)}`
}

// HTTP 响应头只能承载 latin1：中文文件名直接塞进 Content-Disposition 会 ERR_INVALID_CHAR → 下载必 500。
// 按 RFC 5987 同时给两份：ASCII 兜底名（老客户端读它；剔掉引号、反斜杠、控制字符与非 ASCII 字节）
// 与 filename*=UTF-8''<百分号编码>（现代浏览器优先读它，中文名原样还原）。
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
    if (!res.headersSent) { try { return send(res, 404, "text/plain", "not found") } catch {} }
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
const MAMMOTH_PY = "import sys,mammoth\nsrc,out=sys.argv[1],sys.argv[2]\nf=open(src,'rb');h=mammoth.convert_to_html(f).value;f.close()\nopen(out,'w',encoding='utf-8').write(h)"
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
      try { await execFileAsync(PYEXE(), ["-X", "utf8", "-c", MAMMOTH_PY, src, out], { timeout: 60_000, windowsHide: true }) }
      catch (err) { const e = new Error(String(err).slice(0, 200)); e.code = "docx-fail"; throw e }
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
// 【为什么要共用常量】原来这两处各写各的字面量：注入端是 `【本会话工作区，务必遵守】`，
// 而 /api/history 的剥离正则却还在找旧文案 `【本会话专属目录`（我改注入端时漏改了剥离端）。
// 后果：实时流式输出正常（不走剥离），但用户【重开或切回会话】时，整段内部指令会被当成
// 他自己发的话显示出来，还带着 /app/outputs/ws_xxx 这种容器绝对路径。因为只在"回看"时才犯，
// 一直没被发现。改成从同一个常量派生，杜绝再次漂移。
const PREAMBLE_MARK = "【本会话工作区，务必遵守】"
const PREAMBLE_MARK_LEGACY = "【本会话专属目录"   // 老会话里存的是旧文案，回看时同样要剥掉
const _reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const PREAMBLE_RE = new RegExp("^(?:" + _reEsc(PREAMBLE_MARK) + "|" + _reEsc(PREAMBLE_MARK_LEGACY) + ")[\\s\\S]*?\\n\\n")
// Zotero 面板注入的"检索范围"指示：拼在用户原话【最前面】（见前端 zScopePrefix），
// 与工作区前言是两段独立注入，回看历史时也要一并剥掉，否则用户看见自己"说"了一句没说过的话。
// 顺序：先剥工作区前言，再剥范围指示（注入时前言在前、范围指示紧跟其后、再是原话）。
const ZSCOPE_RE = /^【检索范围：[^\n]*】\n/
// 工作流表单注入的"任务卡"：同样拼在用户原话最前面（见前端 wfCardPrefix），回看历史时剥掉，
// 否则用户看到自己"说"了一大段带【以上为用户通过表单勾选提交…】的话——那是给 agent 的，不是他打的。
// 卡片结构固定：以【任务卡 · 开头，到那段以【以上为用户通过表单…】结尾的说明为止（含其后的空行）。
const WFCARD_RE = /^【任务卡 · [\s\S]*?【以上为用户通过表单[\s\S]*?】\n*/
const stripPreamble = (t) => t.replace(PREAMBLE_RE, "").replace(ZSCOPE_RE, "").replace(WFCARD_RE, "")

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
  quota: () => "无人值守：今日额度已用尽，自动推进停止；明日恢复后可手动继续。",
  empty: () => "无人值守：本轮没有文本输出（多半是上游异常），自动推进停止。",
}
/** 一轮正常收尾后调用：要续跑则推进状态并返回 {go:true, round}；停下返回 {go:false, note?}；未开无人值守返回 null */
function autoDecide(sid, finalText) {
  const st = autoStates.get(sid)
  if (!st) return null
  const v = autoVerdict(finalText, st)
  if (v.go && quotaOver()) { v.go = false; v.why = "quota" }
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
// 注入进首轮 preamble 的自主指令。与【本会话工作区】同一块注入，故同样【不得含空行】
// （stripPreamble 按第一个空行剥离，见 skillsPreamble 处的同款约束）。
const autoPreamble = () => `\n- 【无人值守模式已开启】用户不在电脑前：全程不要向用户提问、不要停下等确认。遇到要选择的地方（单步还是完整流程、选哪条 pipeline、选题、方案、期刊……），直接采用你本要推荐的那一项（相当于用户回了「1」），并在正文用一行说明「已自动采用：xxx」。缺少无法自行获得的事实性信息（数据文件、伦理批号、作者名单等）就标「待补充」，继续完成其余部分，别停下来要。\n- 【完成哨兵】只有当本次目标已全部交付（成稿/成品文件已写盘、该跑的质量闸已跑完）时，才在回复最后单独一行输出 ${AUTO_SENTINEL} 。尚未完成时绝不能输出它（提前输出=任务被腰斩）；反之只要不输出它，系统就会自动让你继续下一轮，所以也不必问"是否继续"。`
/** 自动续跑轮发给模型的用户消息 */
const autoContinueText = (round) => `【无人值守·自动续跑 第 ${round} 轮】继续按你的推荐方向推进：上一轮若列了编号选项，视为用户选了第 1 项（推荐项）；若在等待确认，视为已确认。缺的事实性信息标「待补充」继续。全部交付完成时在回复末尾单独一行输出 ${AUTO_SENTINEL}；未完成就继续干活，不要输出该标记。`

function startJob(sid, sentText, modId) {
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
    // 增量快照：text 是累积全文、reasoning 按 id、tool 按 callID 各存最新一条，attach 时按序重放即可还原界面
    text: "", reasoning: new Map(), tools: new Map(), skills: new Map(),
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
    if (job.aborting) return finish()                       // 用户显式终止：job.abort 已广播 aborted
    if (job.timedOut) return finish()                       // 首事件看门狗已收场并广播过原因（prompt 此刻才姗姗返回/报错），别再报一遍
    if (job.moduleHit) { broadcast("failed", { message: modSkills
      ? `模块限制：本会话是「${MODULE_DEFS[modId]?.name || modId}」专用模块，只能使用「${modSkills.join("、")}」技能；检测到调用「${job.moduleHit}」，本轮已中止。${skillHome(job.moduleHit) || "此类需求请到「自由对话」模块新开会话。"}`
      : `技能未开通：你的账号未开通「${job.moduleHit}」技能，本轮已中止。如需使用请联系管理员开通。` }); return finish() }
    if (job.quotaHit) { broadcast("failed", { message: `本轮已达今日额度上限（$${DAILY_COST_LIMIT.toFixed(2)}），已自动中止；明日 0 点(UTC)恢复。` }); return finish() }
    if (promptErr) {
      if (job.finished) return finish()
      // 出错时【绝不】新建空会话重放消息——会丢光多轮上下文；如实报错，真失效时用户点「新对话」。
      const msg = String(promptErr?.message || promptErr)
      const gone = /not found|no such session|does not exist|404/i.test(msg)
      broadcast("failed", { message: gone ? "该会话已失效，请点「新对话」重新开始。" : ("本轮出错：" + msg.slice(0, 200)) })
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
    const changed = changedSince(outDir, before)
    broadcast("files", changed)   // 只推本会话本轮新建/改动的产物（保持字符串数组：老前端直接吃这个）
    // 结构化产物：按文件名认出渲染器（文献表→文献卡片、核查报告→红黄绿逐条…），认不出的不在此列，
    // 前端照常按普通产物展示 —— 绝不能因为"没匹配上渲染器"就把文件藏起来。
    const rendered = changed.map((n) => ({ name: n, render: WF.rendererFor(n) })).filter((x) => x.render)
    if (rendered.length) broadcast("artifacts", rendered)
    // 步骤进度：产物出现 = 该步完成（权威判据，不问 agent）。放在广播之后，别让簿子出问题拖累正文。
    if (modId !== "chat") {
      try {
        const st = wfSyncDone(outDir, modId)
        if (st) broadcast("workflow", { cur: st.cur || null, done: st.done || [] })
      } catch (e) { console.warn(`[workflow] 进度同步失败：${e.message}`) }
    }
    warmPreviews(outDir, changed)   // 后台把新产出的 office/docx 预转缓存，用户点预览即秒开
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
  job.subs.add(res)
  req.on("close", () => job.subs.delete(res))
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

  const fwdPath = "/llm" + u.pathname.slice(CLOUD_PROXY_PREFIX.length - 1) + u.search

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
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=${makeAuthCookie()}; Path=${BASE_PATH}/; HttpOnly; Secure; SameSite=Lax; Max-Age=${AUTH_TTL_MS / 1000}` })
      return res.end(JSON.stringify({ ok: true }))
    }
    // 退出登录：签名 cookie 无服务端状态，清掉浏览器 cookie 即可（本人登出足够）
    if (req.method === "POST" && u.pathname === "/api/logout") {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=; Path=${BASE_PATH}/; HttpOnly; Secure; Max-Age=0` })
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
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `lan_auth=${makeAuthCookie()}; Path=${BASE_PATH}/; HttpOnly; Secure; SameSite=Lax; Max-Age=${AUTH_TTL_MS / 1000}` })
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

    if (req.method === "POST" && u.pathname === "/api/upload") {
      let sid = u.searchParams.get("sid") || null
      if (!sid) sid = await createSession("web")   // 上传先于对话则现建会话（createSession 会把 directory 定到会话产物目录）
      const ws = await ensureWs(sid)
      const name = path.basename(u.searchParams.get("name") || "upload.bin")
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
      const msgs = un(await client.session.messages({ path: { id } })) || []
      const out = []
      for (const m of msgs) {
        const role = m.info?.role
        if (role !== "user" && role !== "assistant") continue
        let text = (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim()
        text = stripPreamble(text)   // 剥掉注入的工作区前言，只回显真正对话
        if (role === "assistant") text = autoStripSentinel(text)   // 无人值守的完成哨兵与直播口径一致：不给用户看
        if (text) out.push({ role, text })
      }
      // 这一轮还在生成中：末尾未完成的助手输出交给续流（/api/chat/attach）直播，从历史里剔除避免重复
      if (jobs.get(id)?.running) {
        let lastUser = -1
        out.forEach((m, i) => { if (m.role === "user") lastUser = i })
        return send(res, 200, "application/json", JSON.stringify(out.filter((m, i) => i <= lastUser || m.role === "user")))
      }
      return send(res, 200, "application/json", JSON.stringify(out))
    }

    // 删除一个会话（连同 outputs/uploads 目录与元数据一并清；进行中的生成先终止）
    if (req.method === "POST" && u.pathname === "/api/session/delete") {
      const id = u.searchParams.get("id") || ""
      if (!id) return send(res, 400, "application/json", JSON.stringify({ ok: false }))
      await hardDeleteSession(id)   // 目录解析次序等要紧逻辑已并入该函数，TTL 清理走同一条路
      return send(res, 200, "application/json", JSON.stringify({ ok: true }))
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
      const msgs = un(await client.session.messages({ path: { id: sid } })) || []
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

    if (req.method === "GET" && u.pathname === "/api/download") {
      const sid = u.searchParams.get("sid") || ""
      const name = u.searchParams.get("name") || ""   // 可含一层子目录（如 pdfs/a.pdf），由 safeUnder 做包含性校验
      const up = u.searchParams.get("dir") === "up"   // dir=up 时取上传目录，否则取产出目录
      const root = sid ? (up ? await sessionUp(sid) : await sessionOut(sid)) : (up ? UPLOADS : OUTPUTS)   // 无 sid 回退共享目录（兼容）
      const f = safeUnder(root, name)
      // isFile 不能省：只判 existsSync 时，?name=.preview（服务端自己在每个产物目录里建的预览缓存目录，
      // 必然存在）会让 createReadStream 异步抛 EISDIR，而进程没有 uncaughtException 兜底 → 整个容器崩、
      // opencode 一起没。任意已登录用户一个 URL 即可打崩。/api/raw 本来就有这个判断，这里漏了。
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "text/plain", "not found")
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
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "text/plain", "not found")
      const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".pdf": "application/pdf",
        ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
        ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8" }
      const ext = path.extname(name).toLowerCase()
      const head = { "Content-Type": MIME[ext] || "application/octet-stream" }
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
      const dir = sid ? await sessionOut(sid) : OUTPUTS
      let r
      try { r = await ensurePreviewCache(dir, name) }
      catch (e) {
        if (e.code === "no-src") return send(res, 404, "text/plain", "not found")
        // 转义再插进 HTML：e.message 里含被转换文件的路径/文件名，而文件名是 agent 产出的、可含尖括号。
        // 影响仅限用户自己（一人一容器），但顺手堵掉，别留个会往 HTML 里塞未转义内容的口子。
        if (e.code === "docx-fail") return send(res, 500, "text/html; charset=utf-8", `<p style="color:#b91c1c">DOCX 预览转换失败：${String(e.message).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
        if (e.code === "no-soffice") return send(res, 501, "text/plain", "服务器未安装 LibreOffice，无法预览此类型（装好后即可）")
        // 人话 + 可行动的下一步；完整命令行/stderr 已在 ensurePreviewCache 里 console.error，不外泄。
        if (e.code === "office-fail") return send(res, 500, "text/plain", e.timedOut
          ? "文档转换超时（首次转换要启动办公组件，会慢一些）。可先下载文件在本地打开；稍后重试通常会快很多。"
          : "文档转换失败，可下载文件后在本地打开。")
        if (e.code === "no-pdf") return send(res, 500, "text/plain", "转换未产出 PDF")
        return send(res, 500, "text/plain", "转换失败：" + e.message)
      }
      if (!r) return send(res, 415, "text/plain", "该类型不支持预览")
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
      const list = Object.entries(MODULE_DEFS).map(([id, m]) => ({ id, name: m.name, desc: m.desc, group: m.group || "skills", skill: modPrimarySkill(id), skills: m.skills || null, allowed: moduleUsable(id) }))
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
      const out = await sessionOut(sid)
      const st = wfSyncDone(out, modId) || { module: modId, form: {}, done: [] }
      // steps 按已填表单值裁剪后回：条件不成立的步骤（如"数据已脱敏"→不需要脱敏步）不该出现在进度条上
      return send(res, 200, "application/json", JSON.stringify({
        state: st, module: modId, name: MODULE_DEFS[modId]?.name || modId,
        steps: WF.workflowFor(modId, st.form || {})?.steps || [],
      }))
    }
    // 提交某一步的表单 → 存进状态簿 + 回一段任务卡文本，由前端拼在这条消息前面发出。
    // 【为什么不在这里直接发消息】发消息那条路（/api/chat/start）有一整套并发/额度/绑定判定，
    // 不该复制一份。这里只负责"把勾选变成文本"，发送仍走原来的口。
    if (req.method === "POST" && u.pathname === "/api/workflow/form") {
      const b = await readJson(req).catch(() => null)
      if (!b) return send(res, 400, "application/json", JSON.stringify({ ok: false, err: "请求体不是合法 JSON" }))
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
      const card = WF.taskCard(MODULE_DEFS[modId]?.name || modId, title, fields, values,
        { footnote: step ? "" : (wf.footnote || "") })
      // 有 sid 才落盘（首屏表单是在会话建立【之前】填的，此时还没有 sid —— 那份值由
      // /api/chat/start 建完会话后补写，见那里的 wfSeed）
      const sid = b.sid ? String(b.sid) : ""
      if (sid && sessionModule(sid) === modId) {
        const out = await sessionOut(sid)
        const st = wfLoad(out) || { module: modId, form: {}, done: [] }
        st.module = modId
        st.form = { ...(st.form || {}), ...values }     // 跨步继承：立项卡填的目标期刊，后面各步直接复用
        if (stepId) st.cur = stepId
        wfSave(out, st)
      }
      return send(res, 200, "application/json", JSON.stringify({ ok: true, card }))
    }
    // 读某个已上传数据表的表头，供 columns 型字段做真实列名下拉。
    // ★ 这是 stats/paper 表单最值钱的一环："列名猜错/写错"是当前最高频的失败模式，从真实表头选能根治。
    if (req.method === "GET" && u.pathname === "/api/data/headers") {
      const sid = u.searchParams.get("sid") || ""
      const name = u.searchParams.get("name") || ""
      const dir = sid ? await sessionUp(sid) : UPLOADS
      const f = safeUnder(dir, name)
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "application/json", JSON.stringify({ err: "文件不存在" }))
      const ext = path.extname(name).toLowerCase()
      if (![".csv", ".tsv", ".txt"].includes(ext))
        // xlsx 要解析二进制，网关不背这个依赖（Python 侧有 pandas，但为一个下拉框起进程不值）。
        // 如实回"读不了"，前端把 columns 字段降级成手填输入框，而不是给一个空下拉让用户以为没列。
        return send(res, 200, "application/json", JSON.stringify({ headers: null, reason: `${ext || "该格式"} 需要 AI 在分析时读取，这里先手动填列名即可` }))
      try {
        const fd = fs.openSync(f, "r")
        const buf = Buffer.alloc(64 * 1024)                 // 只读头部：表可能很大，不整读进内存
        const n = fs.readSync(fd, buf, 0, buf.length, 0)
        fs.closeSync(fd)
        let line = buf.slice(0, n).toString("utf8").split(/\r?\n/)[0] || ""
        if (line.charCodeAt(0) === 0xfeff) line = line.slice(1)   // 剥 BOM，否则第一列名会带个看不见的字符
        const sep = ext === ".tsv" ? "\t" : (line.split(",").length >= line.split("\t").length ? "," : "\t")
        // 极简 CSV 头解析：够用即可（表头里带逗号的引号字段少见，命中时用户仍可手填）
        const headers = line.split(sep).map((s) => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)
        return send(res, 200, "application/json", JSON.stringify({ headers, sep }))
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ headers: null, reason: `读表头失败：${String(e.message || e).slice(0, 120)}` }))
      }
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
      let modId = sid ? sessionModule(sid) : (reqMod || "chat")
      if (!MODULE_DEFS[modId]) return send(res, 400, "application/json", JSON.stringify({ ok: false, sent: false, err: `未知模块：${modId}` }))
      if (!moduleUsable(modId))
        return send(res, 403, "application/json", JSON.stringify({ ok: false, sent: false, err: `你的账号未开通「${MODULE_DEFS[modId].name}」模块${sid ? "（本会话绑定于该模块）" : ""}，请联系管理员开通。` }))
      // 新会话要先向 opencode 建会话；它没起来时这里会抛，此前会被外层 catch 变成一个带堆栈的 500，
      // 用户只看到"发送失败"，根本不知道是后台模型服务没起来。这里单独兜住并给人话。
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
        st.form = { ...(st.form || {}), ...wfSeed }
        wfSave(ws.out, st)
      }
      // ensureSessionTitle 里有 await（打 opencode 网络）——必须放在“检查 running → startJob”这段【全同步】区之前。
      // 否则同 sid 的两个并发请求会在这个 await 处双双让出、都看到没有 running job、各自 startJob，
      // 后者 jobs.set 覆盖前者 → 两轮 prompt 并发打同一会话、先收尾的把另一轮从表里删成无法 attach/abort 的孤儿。
      await ensureSessionTitle(sid, q)
      if (jobs.get(sid)?.running)   // 该会话已有进行中的一轮（双开页面/连点）→ 不重复发起，让前端去续流
        return send(res, 200, "application/json", JSON.stringify({ ok: true, sid, sent: false, running: true, notice: "上一轮仍在进行中，本条消息未发送；请等本轮结束后重发。" }))
      if (quotaOver())
        return send(res, 200, "application/json", JSON.stringify({ ok: false, sid, sent: false, err: `今日额度已用尽（已用 $${quotaUsedLive().toFixed(3)} / 上限 $${DAILY_COST_LIMIT.toFixed(2)}），明天恢复。` }))
      // ---- 无人值守开关：以每条消息带来的勾选态为准 ----
      // 勾着 → （重）置状态、连续轮数从 0 重计；没勾 → 清态熄火。老前端不带 auto 字段 → 不动现状。
      // 放在 running/quota 检查之后：消息被拒收时不该动开关状态。
      if (autoReq === true) autoStates.set(sid, { rounds: 0, lastText: "" })
      else if (autoReq === false) autoStates.delete(sid)
      const autoOn = autoStates.has(sid)
      // 给 agent 注入本会话专属目录，覆盖技能默认的 outputs/，实现多用户/多会话隔离
      // 注意：本会话的工作目录（cwd）已在建会话时通过 opencode 的 session.directory 定在【会话产物目录】，
      // 所以 agent 的所有工具默认就在正确的地方读写，preamble 只需说清"当前目录就是产物目录"与几个绝对路径。
      const preamble = `${PREAMBLE_MARK}\n- **你的当前工作目录就是本会话的产物目录**（\`${ws.out}\`）。所有产物（图表 PNG/PDF、CSV/Excel、md/docx 等）**直接写到当前目录即可**，用相对文件名如 \`fig1.png\`、\`manuscript.md\`，不要再自己拼 \`outputs/xxx\` 前缀。\n- 临时脚本、中间文件同样写当前目录（要归拢可用 \`./.scratch/\`）。\n- 用户上传的数据文件在 \`${ws.up}/\`（读数据从这里找，用这个绝对路径）。\n- 跑本套件的脚本用 \`\${REPO_ROOT:-/app}\` 前缀定位仓库，例如 \`\${REPO_ROOT:-/app}/.venv/bin/python \${REPO_ROOT:-/app}/.opencode/skills/<技能>/xxx.py\`——因为当前目录不是仓库根，写 \`.venv/...\` 这种相对路径会找不到。\n- 正文里嵌入图片直接用文件名：\`![图注](fig1.png)\`（图和稿件都在当前目录，渲染也从当前目录跑）。\n- **不要把产物写到仓库根或 \`\${REPO_ROOT:-/app}\` 下**：那是所有会话共享的，会互相覆盖，也不会出现在界面的"产出"侧栏。${modId === "chat" ? skillsPreamble() : modulePreamble(modId, ws.out)}${zoteroPreamble(ws.out)}${autoOn ? autoPreamble() : ""}\n\n`
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
      const list = Object.entries(dirState(dir))
        .map(([rel, mtime]) => { try { return { name: rel, size: fs.statSync(path.join(dir, rel)).size, mtime } } catch { return null } })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
      return send(res, 200, "application/json", JSON.stringify(list))
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
      const chars = msgs.reduce((n, m) => n + (m.text || "").length, 0)
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

    send(res, 404, "text/plain", "not found")
  } catch (err) {
    try { send(res, 500, "text/plain", String(err?.stack || err)) } catch {}
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
