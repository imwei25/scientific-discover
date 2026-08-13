// 打包专用：把已拷进 staging 的技能目录封成加密的 skills.pak，并删掉明文技能子目录，
// 使安装器里不再含任何可读技能。【本脚本不进客户包】——只在 desktop\bundle.ps1 里被调用一次。
//
//   node packaging/seal-skills.mjs <staged-skill-vault.mjs> <staged-skills-dir>
//
// 复用 staging 里那份 web\skill-vault.mjs（与客户端运行时用的是同一份加解密逻辑与密钥），
// 通过 file URL 动态导入，避免这里再抄一份。ppt-master 等 PLAINTEXT_SKILLS 保持明文不动。
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [, , vaultPath, skillsDir] = process.argv
if (!vaultPath || !skillsDir) {
  console.error("用法: node seal-skills.mjs <skill-vault.mjs 路径> <skills 目录>")
  process.exit(2)
}
if (!fs.existsSync(skillsDir)) { console.error(`技能目录不存在：${skillsDir}`); process.exit(2) }

const V = await import(pathToFileURL(path.resolve(vaultPath)).href)

// 1) 封存（排除 PLAINTEXT_SKILLS，如 ppt-master）→ <parent>\skills.pak，原子写
const bytes = V.sealSkills(skillsDir)

// 2) 删掉明文技能子目录，只留 PLAINTEXT_SKILLS。删完自检：pak 能否解回同样数量的顶层技能。
let removed = 0, kept = []
for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
  if (V.PLAINTEXT_SKILLS.has(e.name)) { kept.push(e.name); continue }
  fs.rmSync(path.join(skillsDir, e.name), { recursive: true, force: true })
  removed++
}

// 3) 封存自检：立刻从 pak 解回内存并数一遍顶层技能，确保封得进、解得出（别把损坏的 pak 发出去）
const pak = fs.readFileSync(V.pakPathFor(skillsDir))
const entries = V.decrypt(pak)                       // GCM 校验：改过一个字节都在这里炸
const { unzip } = await import(pathToFileURL(path.resolve(path.dirname(vaultPath), "minizip.mjs")).href)
const names = new Set(unzip(entries).map((x) => x.name.split("/")[0]))
console.log(`[seal] skills.pak = ${(bytes / 1024 / 1024).toFixed(2)}MB，封入 ${names.size} 个技能；`
  + `删除明文技能 ${removed} 个，保留明文 ${kept.join("、") || "(无)"}`)
if (names.size === 0) { console.error("[seal] pak 里一个技能都没有 —— 封存异常，中止打包"); process.exit(1) }
