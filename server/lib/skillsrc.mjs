// "从仓库发布"：管理台一键让服务器从主项目仓同步技能并出包 —— git 仓库是唯一源头，
// 管理台只当扳机（决定"发不发、发哪个 commit"），改不了内容，杜绝双源头漂移。
//
// 两个发布源，都走同一条 出包→校验→发布 路径：
//   remote：DATA_DIR/skill-src 下的专用检出，从 SKILL_REPO_URL@SKILL_REPO_REF 同步。
//           这是常规通道（开发机 push → 管理台点同步）。
//   local ：服务器上部署的这份仓库检出本身（CFG.skillsDir 往上两级），只读、不做任何
//           git 写操作。这是兜底通道：GitHub 拉不动时（git push 被拦的前科），照旧用
//           bundle+scp 把仓库推上来，管理台仍能一键发布 —— 单一源头不破。
//
// 【为什么全部 async execFile】本进程同时在给全站转发 LLM 流量；git clone/fetch 动辄
// 几十秒，execSync 会把事件循环整个冻住 —— 所有人的模型请求一起卡死。
//
// 流程是"两步走"：check（同步 + 算预览：待发布 commit、变更技能、下个版本号）→
// publish（带着 check 看到的 sha 来；树若已被别人推动，409 让管理员重新看过再发）。

import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cmpVersion, VERSION_RE } from "./skillpacks.mjs"

const execFileP = promisify(execFile)

/** 跑一条 git。失败时把 stderr 翻成人话错误抛出（git 的报错本身通常够诊断）。 */
async function git(cwd, args, { timeout = 300_000 } = {}) {
  try {
    const { stdout } = await execFileP("git", args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return stdout.trim()
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("服务器上没有 git —— 部署脚本需要装 git，或只用本地检出/手动上传两条通道")
    const msg = String(e.stderr || e.message || "").split("\n").filter(Boolean).slice(-3).join(" ")
    throw new Error(`git ${args[0]} 失败：${msg}`)
  }
}

/** 展示用：把 URL 里的 user:token@ 打码，凭证不进页面/审计 */
export const maskUrl = (u) => String(u || "").replace(/\/\/[^/@]+@/, "//***@")

export const srcConfig = (CFG) => ({
  url: CFG.skillRepoUrl || "",
  ref: CFG.skillRepoRef || "main",
  cloneDir: path.join(CFG.dataDir, "skill-src"),
  // 本地检出：CFG.skillsDir 缺省是 <仓库根>/.opencode/skills，往上两级就是仓库根
  localRoot: path.resolve(CFG.skillsDir, "..", ".."),
})

/** remote 源：克隆/同步专用检出到 origin/<ref> 的最新，返回仓库根 */
async function syncRemote(cfg) {
  if (!cfg.url) throw new Error("未配置 SKILL_REPO_URL（/etc/sci-auth.env），远程同步不可用；可用「本地检出」通道")
  if (!/^[\w./-]+$/.test(cfg.ref)) throw new Error(`SKILL_REPO_REF 不像个引用名：${cfg.ref}`)
  if (!fs.existsSync(path.join(cfg.cloneDir, ".git"))) {
    fs.mkdirSync(path.dirname(cfg.cloneDir), { recursive: true })
    // 不浅克隆：算 changedSkills 要 diff 到上次发布的 commit，浅历史会查不到
    await git(path.dirname(cfg.cloneDir), ["clone", "--no-checkout", cfg.url, cfg.cloneDir])
  }
  await git(cfg.cloneDir, ["fetch", "--force", "origin", cfg.ref])
  // detach 到 FETCH_HEAD：专用检出没有本地改动可言，硬切最省心
  await git(cfg.cloneDir, ["checkout", "--force", "--detach", "FETCH_HEAD"])
  return cfg.cloneDir
}

/** 源树信息：仓库根 + HEAD sha（local 源不是 git 检出时 sha 为 ''，照样能发布，只是算不了 diff） */
export async function resolveSource(CFG, source) {
  const cfg = srcConfig(CFG)
  if (source === "remote") {
    const root = await syncRemote(cfg)
    return { root, sha: await git(root, ["rev-parse", "HEAD"]) }
  }
  const root = cfg.localRoot
  if (!fs.existsSync(path.join(root, ".opencode", "skills")))
    throw new Error(`本地检出里找不到技能目录：${path.join(root, ".opencode", "skills")}`)
  let sha = ""
  try { sha = await git(root, ["rev-parse", "HEAD"]) } catch { /* 不是 git 检出（bundle 解开的裸目录）也允许 */ }
  return { root, sha }
}

/** 上次发布的 commit 到 HEAD 之间：动了哪些技能、AGENTS.md 有没有变、提交说明清单 */
export async function diffSince(root, lastSha) {
  const out = { changedSkills: [], agentsChanged: false, commits: [], known: false }
  if (!lastSha) return out
  try { await git(root, ["cat-file", "-e", `${lastSha}^{commit}`]) } catch { return out }   // 换过仓/首次：查不到就当未知
  out.known = true
  const names = await git(root, ["diff", "--name-only", lastSha, "HEAD", "--", ".opencode/skills", "AGENTS.md"])
  for (const l of names.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (l === "AGENTS.md") { out.agentsChanged = true; continue }
    const m = /^\.opencode\/skills\/([^/]+)\//.exec(l)
    if (m && !out.changedSkills.includes(m[1])) out.changedSkills.push(m[1])
  }
  const log = await git(root, ["log", "--format=%h %s", `${lastSha}..HEAD`, "--", ".opencode/skills", "AGENTS.md"])
  out.commits = log.split("\n").filter(Boolean).slice(0, 50)
  return out
}

/**
 * 自动排版本号：今天的日期（YYYY.M.D）比现有最新版大就用它；否则在最新版上加/进位一段。
 * exists 用于跳过占着号的历史版本（含已撤下的——版本号终身占用，见 db 注释）。
 */
export function nextVersion(latest, exists = () => false, now = new Date()) {
  let v = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`
  if (latest && VERSION_RE.test(latest) && cmpVersion(v, latest) <= 0) {
    const parts = latest.split(".")
    if (parts.length <= 3) v = latest + ".1"
    else { parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1); v = parts.join(".") }
  }
  while (exists(v)) {
    const parts = v.split(".")
    if (parts.length <= 3) v = v + ".1"
    else { parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1); v = parts.join(".") }
  }
  return v
}
