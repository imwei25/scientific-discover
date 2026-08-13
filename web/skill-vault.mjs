// 技能金库：把技能目录封成单个加密文件（skills.pak），运行时解密还原到原路径。
//
// 【为什么要它】桌面版把 26 个科研技能以明文 SKILL.md + 脚本平铺在
// app\.opencode\skills\ 下，任何人打开安装目录就能整套读走、拷走。这里给它们上一层
// 对称加密：安装包内、以及软件【关闭后】的文件夹里都只剩一个不可读的 skills.pak。
//
// 【能防到哪、防不到哪（老实说）】opencode 是第三方二进制，只会读【明文】技能文件，所以
// 软件【运行期间】磁盘上必然有一份明文（还原在原路径）。也就是说：
//   · 挡得住「随手翻安装目录 / 解压安装器拷走技能」——这是本功能的目标；
//   · 挡不住会读 JS + 会用 node crypto、或会趁运行时抓明文的技术高手——密钥就在这份
//     .mjs 里（桌面包的 .mjs 本就是明文），对称密钥只能做到【混淆】级别。这条线正是
//     需求设定的门槛：「至少需要技术高手才能破解」。
//
// 【启用判据：pak 是否存在】只有当技能目录旁存在 skills.pak 时才进入金库流程。源码检出 /
// 开发机（没有 pak）行为与从前【完全一致】：明文技能原地不动，不解密、不擦除、零风险。
// 打包脚本（desktop\bundle.ps1）负责生成 pak 并删掉明文技能，安装包里因此没有明文。
//
// 【ppt-master 例外】它是 vendored 的第三方库（~59MB / 12k 文件），不是本方 IP，且体量大
// 到加密会把启动拖慢到 40 秒以上（实测）。它保持明文原样，既不入 pak 也不被擦除。
// 归档（skill-packs\<版本>\skills\）里本就不含 ppt-master（换版时被平移进新现用目录），
// 故归档整份可封。

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { zip, unzip } from "./minizip.mjs"

// pak 布局：magic(9) + iv(12) + gcmTag(16) + 密文（密文明文体是一个 minizip）
const MAGIC = Buffer.from("SCIVAULT1", "ascii")
const IV_LEN = 12, TAG_LEN = 16, HEAD = MAGIC.length + IV_LEN + TAG_LEN

// 保持明文、既不入 pak 也不被擦除的技能（vendored 第三方库；见头注）
export const PLAINTEXT_SKILLS = new Set(["ppt-master"])

// 对称密钥（AES-256）。刻意不写成一条能直接复制的字面量，但这只是【混淆】——
// 密钥可由这份源码确定性重算，对技术高手不构成真正的保密（见头注的门槛设定）。
// 客户端与打包脚本必须算出完全一致的密钥，故只能用固定常量派生，不能掺机器指纹。
function vaultKey() {
  const seed = ["sci", "skill", "vault", "gcm", "v1"].join(":")
  let h = crypto.createHash("sha256").update(seed).digest()
  // 多绕几轮，别让 sha256("sci:skill:...") 这种一眼能猜的中间值直接就是密钥
  for (let i = 0; i < 4096; i++) h = crypto.createHash("sha256").update(h).update(String(i & 0xff)).digest()
  return h   // 32 字节
}

/** 加密一段明文 Buffer → pak Buffer */
export function encrypt(plain) {
  const iv = crypto.randomBytes(IV_LEN)
  const c = crypto.createCipheriv("aes-256-gcm", vaultKey(), iv)
  const enc = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc])
}

/** 解密 pak Buffer → 明文 Buffer（magic / GCM tag 不符即抛错，不静默） */
export function decrypt(pak) {
  if (!Buffer.isBuffer(pak) || pak.length < HEAD || !pak.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error("不是有效的 skills.pak（magic 不符或太短）")
  const iv = pak.subarray(MAGIC.length, MAGIC.length + IV_LEN)
  const tag = pak.subarray(MAGIC.length + IV_LEN, HEAD)
  const d = crypto.createDecipheriv("aes-256-gcm", vaultKey(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(pak.subarray(HEAD)), d.final()])
}

// 递归收集目录下所有文件为 [{name(相对 posix), data}]，跳过 excludeTop 里的顶层名。
function collect(dir, { excludeTop = new Set() } = {}) {
  const out = []
  const walk = (cur) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name)
      const rel = path.relative(dir, full).replace(/\\/g, "/")
      if (excludeTop.has(rel.split("/")[0])) continue
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) out.push({ name: rel, data: fs.readFileSync(full) })
    }
  }
  walk(dir)
  return out
}

/** 把目录封成 pak Buffer（excludeTop：不打包的顶层子目录名集合） */
export function sealDir(dir, { excludeTop = new Set() } = {}) {
  return encrypt(zip(collect(dir, { excludeTop })))
}

/** 解 pak Buffer，把条目写进 destDir（已存在的目录/文件按条目覆盖；不清理 destDir 其它内容） */
export function openPakToDir(pak, destDir) {
  const entries = unzip(decrypt(pak))
  for (const { name, data } of entries) {
    const dst = path.join(destDir, name)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, data)
  }
  return entries.length
}

// 原子写文件（同盘 temp → rename）
function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, file)
}

// ============ 技能目录专用封装（约定 skillsDir 旁边放同名 .pak）============

/** skillsDir 对应的 pak 路径：<parent>/skills.pak */
export function pakPathFor(skillsDir) {
  return path.join(path.dirname(skillsDir), path.basename(skillsDir) + ".pak")
}

/** 该技能目录是否处于金库模式（旁边有 pak） */
export function hasVault(skillsDir) {
  return fs.existsSync(pakPathFor(skillsDir))
}

/** 把 skillsDir（排除 ppt-master 等明文技能）封进 <parent>/skills.pak，原子替换 */
export function sealSkills(skillsDir) {
  const pak = sealDir(skillsDir, { excludeTop: PLAINTEXT_SKILLS })
  writeAtomic(pakPathFor(skillsDir), pak)
  return pak.length
}

/** 从 <parent>/skills.pak 解密还原到 skillsDir（pak 不存在则不动，返回 -1） */
export function materializeSkills(skillsDir) {
  const p = pakPathFor(skillsDir)
  if (!fs.existsSync(p)) return -1
  fs.mkdirSync(skillsDir, { recursive: true })
  return openPakToDir(fs.readFileSync(p), skillsDir)
}

/** 擦除 skillsDir 下除 PLAINTEXT_SKILLS 外的所有顶层项（还原态明文技能）。
 *  仅当 pak 存在时才动手——没有 pak 就没有可还原来源，绝不删。返回删除的顶层项数。 */
export function wipeMaterializedSkills(skillsDir) {
  if (!hasVault(skillsDir) || !fs.existsSync(skillsDir)) return 0
  let n = 0
  for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (PLAINTEXT_SKILLS.has(e.name)) continue
    try { fs.rmSync(path.join(skillsDir, e.name), { recursive: true, force: true }); n++ } catch {}
  }
  return n
}

// ============ 在线更新的版本归档（skill-packs\<版本>\）============
// 归档目录布局：<版本>\skills\**（+ 可选 AGENTS.md）。归档里【不含】ppt-master
// （换版时被平移进新现用目录，见 skill-update.mjs swapIn 注释），故整份可封。
// 封存后原地只留一个 archive.pak，明文 skills\ / AGENTS.md 删掉——保证关闭态归档也不落明文。
const ARCHIVE_PAK = "archive.pak"

/** 把 storeDir 下所有【还有明文 skills\ 的】版本归档封成 <版本>\archive.pak 并删明文。返回封存的版本数。 */
export function sealArchives(storeDir) {
  if (!fs.existsSync(storeDir)) return 0
  let n = 0
  for (const e of fs.readdirSync(storeDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue
    const verDir = path.join(storeDir, e.name)
    if (!fs.existsSync(path.join(verDir, "skills"))) continue   // 无明文可封（已封或空）
    const pak = sealDir(verDir, { excludeTop: new Set([ARCHIVE_PAK]) })  // 收 skills\ + AGENTS.md
    writeAtomic(path.join(verDir, ARCHIVE_PAK), pak)
    try { fs.rmSync(path.join(verDir, "skills"), { recursive: true, force: true }) } catch {}
    try { fs.rmSync(path.join(verDir, "AGENTS.md"), { force: true }) } catch {}
    n++
  }
  return n
}

/** 回退前把某版本归档从 archive.pak 解回明文（skill-update.rollback 要读 <版本>\skills\）。
 *  已是明文返回 0；无 pak 返回 -1；否则返回还原文件数。 */
export function materializeArchive(storeDir, version) {
  const verDir = path.join(storeDir, String(version))
  if (fs.existsSync(path.join(verDir, "skills"))) return 0
  const pak = path.join(verDir, ARCHIVE_PAK)
  if (!fs.existsSync(pak)) return -1
  return openPakToDir(fs.readFileSync(pak), verDir)
}

/** 某版本归档是否可回退（有明文 skills\ 或 archive.pak 之一即可） */
export function archiveExists(storeDir, version) {
  const verDir = path.join(storeDir, String(version))
  return fs.existsSync(path.join(verDir, "skills")) || fs.existsSync(path.join(verDir, ARCHIVE_PAK))
}
