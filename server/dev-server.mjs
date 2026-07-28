#!/usr/bin/env node
// 本地开发/演示用启动器：临时库 + 预置演示数据，起在 :8099。
//   node server/dev-server.mjs
// 生产不用这个（生产由 systemd 直接跑 sci-auth.mjs，配置来自 /etc/sci-auth.env）。
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const DEV_DIR = process.env.DEV_DIR || path.join(os.tmpdir(), "sci-auth-dev")
fs.mkdirSync(DEV_DIR, { recursive: true })

Object.assign(process.env, {
  LISTEN: process.env.LISTEN || "127.0.0.1:8099",
  DB_FILE: process.env.DB_FILE || path.join(DEV_DIR, "sci.db"),
  DATA_DIR: DEV_DIR,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "dev-admin-pw",
  KEY_SECRET: process.env.KEY_SECRET || "dev-key-secret",
  LLM_UPSTREAM_KEY: process.env.LLM_UPSTREAM_KEY || "dev-upstream-key",
})

const app = await import("./sci-auth.mjs")
const DB = await import("./lib/db.mjs")
const A = await import("./lib/auth.mjs")

// 预置演示数据（只在空库时播种），姓名刻意覆盖「单字/双字/复姓/同字不同位」几种检索场景
if (DB.countUsers(app.db) === 0) {
  const demo = [
    ["zhangsan", "张三", "协和医院", "主任医师", "plus"],
    ["zhangwei", "张伟", "华西医院", "副主任医师", "free"],
    ["xiaolongnv", "小龙女", "古墓派医院", "主任", "free"],
    ["lixiaolong", "李小龙", "同济医院", "主治医师", "plus"],
    ["wangxiaoming", "王小明", "湘雅医院", "住院医师", "free"],
    ["ouyangfeng", "欧阳锋", "白驼山医院", "主任医师", "admin"],
    ["zhugeliang", "诸葛亮", "卧龙医院", "科室主任", "plus"],
    ["chenouyang", "陈欧阳", "瑞金医院", "主治医师", "free"],
    ["zhaosi", "赵四", "北大医院", "住院医师", "free"],
    ["sunming", "孙明", "中山医院", "主治医师", "free"],
  ]
  for (const [username, display_name, hospital, position, tier] of demo) {
    const { hash, salt } = A.hashPassword("Demo123!pass")
    const u = DB.createUser(app.db, {
      username, display_name, hospital, position, tier,
      pass_hash: hash, pass_salt: salt, must_change_pw: false,
    })
    // 造一点用量，让看板/用量页不是空的
    const days = 1 + (u.id % 5)
    for (let d = 0; d < days; d++) {
      const ts = Date.now() - d * 86400000
      DB.recordUsage(app.db, u.id, {
        ts, model: "deepseek-v4-pro", skill: ["write-paper", "search-lit", ""][u.id % 3],
        prompt_tokens: 1000 * (u.id + d), completion_tokens: 300 * (u.id + 1),
        cached_tokens: 200 * d, cost_usd: 0.01 * (u.id + d),
      })
    }
    DB.updateUser(app.db, u.id, { last_seen_at: Date.now() - u.id * 3600_000, client_version: "1.0." + u.id })
  }
  DB.addAudit(app.db, { actor: "seed", event: "demo.seed", detail: "预置 10 个演示账号" })
  console.log("[dev] 已播种演示数据（10 个账号，口令 Demo123!pass）")
}

await app.start()
console.log(`[dev] 管理台 http://${process.env.LISTEN}/admin　口令 ${process.env.ADMIN_PASSWORD}`)
console.log(`[dev] 库文件 ${process.env.DB_FILE}（删掉它即可重新播种）`)
