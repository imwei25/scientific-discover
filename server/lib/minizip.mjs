// 极简 ZIP 读写 —— 零外部依赖（node:zlib 的 raw deflate + crc32）。
//
// 【为什么自己写而不是引 adm-zip/yauzl】本仓库服务端的立身之本就是"只有 Node 内置模块、
// systemd 直接 node xxx.mjs"（见 db.mjs 头注）；客户端网关同样要在打包环境里跑，
// 少一个原生依赖就少一类"装不上/被杀软拦"的现场问题。技能包只是"一堆小文本文件"，
// 用不到 zip64 / 加密 / 分卷，标准 PKZIP 的最小子集百来行就够，且两端格式完全受控。
//
// 支持范围（超出即明确报错，不静默）：
//   · 压缩方法 0（store）与 8（deflate）
//   · 单卷、≤ 4GB（无 zip64）
//   · 条目名 UTF-8（写入时置 bit-11；读取时无论是否置位都按 UTF-8 解 —— 两端都是本模块）
//
// 【条目名按不可信输入处理】zip-slip（../ 或绝对路径逃出解压目录）是解压器的经典漏洞；
// 这里在【读取层】统一消毒：反斜杠归一为 /（PowerShell 的 Compress-Archive 会写反斜杠），
// 含 ..、以 / 开头、带盘符冒号、含控制字符的条目一律拒绝整包 —— 上传口与客户端解压
// 共用这一层，谁也绕不开。

import zlib from "node:zlib"

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

/** 条目名消毒：返回归一化名，非法则抛错（拒绝整包，不要"跳过坏条目"——那会掩盖恶意包） */
function cleanName(raw) {
  const name = String(raw).replace(/\\/g, "/")
  if (!name || name.startsWith("/") || name.includes("..") || /[\x00-\x1f]/.test(name) || /^[A-Za-z]:/.test(name))
    throw new Error(`zip 条目名非法：${JSON.stringify(raw)}`)
  return name
}

/**
 * 解一个 zip Buffer → [{ name, data }]（目录条目跳过，由文件路径隐含）。
 * maxTotal：解压后总字节上限（zip 炸弹闸；技能包全是文本，默认 256MB 绰绰有余）。
 */
export function unzip(buf, { maxTotal = 256 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("不是有效的 zip 文件（太短）")
  // EOCD 在文件尾部，后面只可能跟注释（≤64KB）：从末尾往前扫签名
  let eocd = -1
  const from = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 文件（找不到目录结尾记录）")
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = []
  let p = cdOffset, total = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("zip 中央目录损坏")
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = cleanName(buf.toString("utf8", p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith("/")) continue                    // 目录条目
    if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方法 ${method}（条目 ${name}）——请用本套件的打包脚本出包`)
    // 数据起点要按【本地头自己的】名字/扩展区长度算，中央目录里的长度可以与之不同
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error(`zip 本地头损坏（条目 ${name}）`)
    const lname = buf.readUInt16LE(localOff + 26)
    const lextra = buf.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lname + lextra
    if (start + csize > buf.length) throw new Error(`zip 数据越界（条目 ${name}）`)
    total += usize
    if (total > maxTotal) throw new Error(`zip 解压后超过 ${Math.round(maxTotal / 1048576)}MB 上限`)
    const rawData = buf.subarray(start, start + csize)
    const data = method === 0 ? Buffer.from(rawData) : zlib.inflateRawSync(rawData)
    if (data.length !== usize) throw new Error(`zip 条目大小不符（条目 ${name}）`)
    if (zlib.crc32(data) !== crc) throw new Error(`zip 条目校验失败（条目 ${name}）——文件已损坏，请重新下载/上传`)
    entries.push({ name, data })
  }
  return entries
}

// DOS 时间戳：固定成一个常量（打包时间已在 pack.json 里，条目时间戳只会破坏"同内容出同包"）
const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1   // 2026-01-01 00:00

/** 打包 [{ name, data }] → zip Buffer。名字统一正斜杠 + UTF-8 标志位。 */
export function zip(entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(cleanName(e.name), "utf8")
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8")
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    // 压不动的（已压缩的图片等）存原样，省得解压端白做功
    const method = deflated.length < data.length ? 8 : 0
    const body = method === 8 ? deflated : data
    const crc = zlib.crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(SIG_LOCAL, 0)
    lh.writeUInt16LE(20, 4)            // version needed
    lh.writeUInt16LE(0x0800, 6)        // flags: UTF-8 名
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, name, body)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(SIG_CENTRAL, 0)
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}
