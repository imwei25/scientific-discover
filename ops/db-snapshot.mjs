#!/usr/bin/env node
// SQLite 一致性热备：VACUUM INTO。
//
// 为什么不直接 tar 库文件：WAL 模式下 .db 只是"部分真相"，还有 -wal/-shm，
// 三个文件在不同时刻被 tar 读到就可能拼出一个坏库。VACUUM INTO 由 SQLite 自己
// 在一个读事务里写出完整快照，**不必停服**，产物是单个干净文件（顺带压实）。
//
// 用法：node ops/db-snapshot.mjs <源库> <目标文件>
import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import path from "node:path"

const [src, dst] = process.argv.slice(2)
if (!src || !dst) {
  console.error("用法: node ops/db-snapshot.mjs <源库> <目标文件>")
  process.exit(2)
}
if (!fs.existsSync(src)) { console.error(`!! 源库不存在: ${src}`); process.exit(1) }
fs.mkdirSync(path.dirname(path.resolve(dst)), { recursive: true })
fs.rmSync(dst, { force: true })          // VACUUM INTO 要求目标不存在

const db = new DatabaseSync(src, { readOnly: true })
try {
  db.exec(`VACUUM INTO '${String(dst).replace(/'/g, "''")}'`)
} finally { db.close() }

// 自检：快照能打开、完整性 ok、表数对得上 —— 备份当场验，别留到恢复时才发现
const chk = new DatabaseSync(dst, { readOnly: true })
try {
  const ic = chk.prepare("PRAGMA integrity_check").get()
  const v = Object.values(ic)[0]
  if (v !== "ok") { console.error(`!! 快照完整性检查失败: ${v}`); process.exit(1) }
  // 必须查一下表在不在：只拷 .db 而漏掉 -wal 时，快照会是一个"完整但空"的库 ——
  // integrity_check 照样返回 ok，恢复时才发现什么都没有。这里就要拦住。
  const tables = new Set(chk.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
  const missing = ["users", "tiers", "usage_log", "audit", "meta"].filter((t) => !tables.has(t))
  if (missing.length) {
    console.error(`!! 快照里缺表：${missing.join(", ")}`)
    console.error(`   源库 ${src} 看起来不是一个 sci-auth 库，或它的数据还在 WAL 里而你只拷了 .db —— `)
    console.error(`   请直接对【线上库本体】做快照（本脚本会连 WAL 一起读），别先手工复制 .db 文件。`)
    process.exit(1)
  }
  const users = chk.prepare("SELECT COUNT(*) AS n FROM users").get().n
  const usage = chk.prepare("SELECT COUNT(*) AS n FROM usage_log").get().n
  console.log(`快照 ok: ${dst}  用户=${users} 用量明细=${usage} 大小=${fs.statSync(dst).size}B`)
} finally { chk.close() }
