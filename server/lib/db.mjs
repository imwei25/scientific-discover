// SQLite 存储层 —— 服务器上【唯一的可变状态】都在这一个文件描述的库里。
//
// 为什么把存储收在一层：改造方案 §3.4 定的「单一状态根」。旧架构的状态散在 4 处
// （docker 卷 + users/*.env + data/quota/ + /etc/*），导致备份脚本必然漏掉其中一处
// （export-all.sh 就漏了装着 ADMIN_PASSWORD 的 /etc/sci-manager.env）。这里所有东西
// 都在 sci.db 一个文件里，迁移脚本只需要搬它。
//
// 为什么用 node:sqlite 而不是 better-sqlite3：manager.mjs 时代的零外部依赖是它好维护的
// 主要原因（systemd 直接 `node xxx.mjs`，没有 node_modules、没有原生编译）。代价是要求
// Node ≥ 22（服务器现在是 20，部署脚本会钉住 24 LTS）。若将来必须换驱动，只改本文件。

import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import path from "node:path"

export const SCHEMA_VERSION = 1

// ---- 复姓表：用于从姓名里切出「姓」，供管理台「优先姓」检索排序 ----
// 只收常见复姓；切不准不影响功能，只影响排序优先级，且管理员可在后台显式改「姓」字段。
const COMPOUND_SURNAMES = [
  "欧阳", "太史", "端木", "上官", "司马", "东方", "独孤", "南宫", "万俟", "闻人",
  "夏侯", "诸葛", "尉迟", "公羊", "赫连", "澹台", "皇甫", "宗政", "濮阳", "公冶",
  "太叔", "申屠", "公孙", "慕容", "仲孙", "钟离", "长孙", "宇文", "司徒", "鲜于",
  "司空", "闾丘", "子车", "亓官", "司寇", "巫马", "公西", "颛孙", "乐正", "宰父",
  "谷梁", "拓跋", "夹谷", "轩辕", "令狐", "段干", "百里", "呼延", "东郭", "西门",
  "南门", "第五", "梁丘", "左丘", "东宫", "仲长", "即墨", "达奚", "褚师",
]

/** 从姓名切「姓」：先试复姓，否则取首字。非中文（英文名等）取空格前的第一段。 */
export function guessSurname(displayName) {
  const s = String(displayName || "").trim()
  if (!s) return ""
  if (/^[一-龥]/.test(s)) {
    for (const c of COMPOUND_SURNAMES) if (s.startsWith(c)) return c
    return s[0]
  }
  return s.split(/\s+/)[0]
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,          -- 登录名（管理员分发，ASCII）
  display_name   TEXT    NOT NULL DEFAULT '',      -- 姓名（中文），后台按它检索
  surname        TEXT    NOT NULL DEFAULT '',      -- 姓，检索时「优先姓」用
  hospital       TEXT    NOT NULL DEFAULT '',
  position       TEXT    NOT NULL DEFAULT '',
  phone          TEXT    NOT NULL DEFAULT '',
  pass_hash      TEXT    NOT NULL,
  pass_salt      TEXT    NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,       -- 首次登录强制改密
  tier           TEXT    NOT NULL DEFAULT 'free',
  status         TEXT    NOT NULL DEFAULT 'active',-- active | suspended
  key_epoch      INTEGER NOT NULL DEFAULT 1,       -- ++ 即吊销该用户全部已签发 key
  daily_override   REAL,                           -- NULL = 随档位
  monthly_override REAL,
  skills_override  TEXT,                           -- NULL = 随档位；'' = 一个技能都不给
  client_version TEXT    NOT NULL DEFAULT '',
  note           TEXT    NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER,
  last_seen_at   INTEGER
);
CREATE INDEX IF NOT EXISTS ix_users_display ON users(display_name);
CREATE INDEX IF NOT EXISTS ix_users_surname ON users(surname);

CREATE TABLE IF NOT EXISTS tiers (
  key        TEXT PRIMARY KEY,
  daily_usd  REAL NOT NULL DEFAULT 0,   -- 0 = 不限
  monthly_usd REAL NOT NULL DEFAULT 0,  -- 0 = 不限
  model      TEXT NOT NULL DEFAULT '',
  skills     TEXT NOT NULL DEFAULT '',  -- 逗号分隔；'' = 全部技能
  note       TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0
);

-- 明细：一次 LLM 调用一行（后台「单用户用量明细」用）
CREATE TABLE IF NOT EXISTS usage_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  day      TEXT    NOT NULL,           -- UTC 日切，与旧账本口径一致
  month    TEXT    NOT NULL,
  model    TEXT    NOT NULL DEFAULT '',
  skill    TEXT    NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_usage_user_day ON usage_log(user_id, day);
CREATE INDEX IF NOT EXISTS ix_usage_ts ON usage_log(ts);

-- 汇总：查额度走这张，不扫明细
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id INTEGER NOT NULL,
  day     TEXT    NOT NULL,
  month   TEXT    NOT NULL,
  cost_usd REAL   NOT NULL DEFAULT 0,
  calls   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS ix_usage_daily_month ON usage_daily(user_id, month);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  token_hash TEXT    NOT NULL UNIQUE,
  epoch      INTEGER NOT NULL,
  exp        INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rt_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  actor  TEXT NOT NULL DEFAULT '',
  event  TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ip     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit(ts);
`

// 默认档位：首次建库播种。与旧 tiers.env 的三档对齐，外加「可用技能」这一新列。
const SEED_TIERS = [
  { key: "free", daily_usd: 0.3, monthly_usd: 5, model: "deepseek-v4-pro", skills: "", note: "基础版", sort: 1 },
  { key: "plus", daily_usd: 1.5, monthly_usd: 30, model: "deepseek-v4-pro", skills: "", note: "专业版", sort: 2 },
  { key: "admin", daily_usd: 0, monthly_usd: 0, model: "deepseek-v4-pro", skills: "", note: "内部/不限", sort: 9 },
]

export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(SCHEMA)
  const cur = db.prepare("SELECT v FROM meta WHERE k='schema_version'").get()
  if (!cur) {
    db.prepare("INSERT INTO meta(k,v) VALUES('schema_version',?)").run(String(SCHEMA_VERSION))
    const ins = db.prepare("INSERT OR IGNORE INTO tiers(key,daily_usd,monthly_usd,model,skills,note,sort) VALUES(?,?,?,?,?,?,?)")
    for (const t of SEED_TIERS) ins.run(t.key, t.daily_usd, t.monthly_usd, t.model, t.skills, t.note, t.sort)
  } else if (Number(cur.v) > SCHEMA_VERSION) {
    throw new Error(`库的 schema 版本 ${cur.v} 高于本程序支持的 ${SCHEMA_VERSION}——别用旧版程序开新库，会写坏数据`)
  }
  return db
}

// ---- 时间口径：UTC 日切/月切，与旧架构账本一致（跨日自动清零就是靠它）----
export const dayOf = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10)
export const monthOf = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 7)

// ==== 用户 ====================================================================

export function getUserByName(db, username) {
  return db.prepare("SELECT * FROM users WHERE username=?").get(String(username)) || null
}
export function getUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id=?").get(Number(id)) || null
}

export function createUser(db, u) {
  const now = Date.now()
  const surname = u.surname !== undefined && u.surname !== null && u.surname !== ""
    ? String(u.surname) : guessSurname(u.display_name)
  db.prepare(`INSERT INTO users
      (username, display_name, surname, hospital, position, phone, pass_hash, pass_salt,
       must_change_pw, tier, status, key_epoch, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active',1,?,?)`).run(
    String(u.username), String(u.display_name || ""), surname,
    String(u.hospital || ""), String(u.position || ""), String(u.phone || ""),
    String(u.pass_hash), String(u.pass_salt), u.must_change_pw === false ? 0 : 1,
    String(u.tier || "free"), String(u.note || ""), now)
  return getUserByName(db, u.username)
}

/** key_epoch++ —— 已签发的 access key 立刻失效，同时把该用户的 refresh 全部作废。 */
export function bumpEpoch(db, userId) {
  db.prepare("UPDATE users SET key_epoch = key_epoch + 1 WHERE id=?").run(Number(userId))
  db.prepare("UPDATE refresh_tokens SET revoked=1 WHERE user_id=?").run(Number(userId))
  return getUserById(db, userId).key_epoch
}

const USER_PATCH_FIELDS = new Set([
  "display_name", "surname", "hospital", "position", "phone", "tier", "status",
  "daily_override", "monthly_override", "skills_override", "note",
  "pass_hash", "pass_salt", "must_change_pw", "client_version", "last_login_at", "last_seen_at",
])
export function updateUser(db, id, patch) {
  const cols = [], vals = []
  for (const [k, v] of Object.entries(patch)) {
    if (!USER_PATCH_FIELDS.has(k)) continue
    cols.push(`${k}=?`); vals.push(v === undefined ? null : v)
  }
  if (!cols.length) return getUserById(db, id)
  vals.push(Number(id))
  db.prepare(`UPDATE users SET ${cols.join(",")} WHERE id=?`).run(...vals)
  return getUserById(db, id)
}

export function deleteUser(db, id) {
  db.prepare("DELETE FROM refresh_tokens WHERE user_id=?").run(Number(id))
  db.prepare("DELETE FROM usage_log WHERE user_id=?").run(Number(id))
  db.prepare("DELETE FROM usage_daily WHERE user_id=?").run(Number(id))
  db.prepare("DELETE FROM users WHERE id=?").run(Number(id))
}

/**
 * 按姓名检索（后台）。需求：支持用姓名中的【任何一个字或两个字】过滤，**优先姓**。
 *
 * 排序权重（小的在前）：
 *   0  姓完全等于关键词         —— 「张」→ 所有姓张的排最前
 *   1  姓包含关键词             —— 复姓「欧阳」用「欧」也能优先命中
 *   2  姓名以关键词开头         —— 姓字段没切准时的兜底
 *   3  姓名中间/末尾包含关键词  —— 「明」→ 王小明
 *   4  登录名/手机号/医院命中   —— 管理员按账号找人的便利，排最后
 * 同权重内按姓名排序，保证结果稳定。
 *
 * 空关键词 = 列全部。LIKE 的 % _ 会被转义，避免管理员输入 "%" 一次捞出全表。
 */
export function searchUsers(db, q, { limit = 200, offset = 0 } = {}) {
  const kw = String(q || "").trim()
  if (!kw) {
    // 不带关键词时按【最近活跃】倒序：中文姓名按 UTF-8 码点排序等于随机顺序，对运维毫无意义；
    // 而"谁最近在用"是管理员打开列表最常想先看到的。没活跃过的按创建时间兜底。
    return db.prepare(`SELECT * FROM users
      ORDER BY COALESCE(last_seen_at, last_login_at, 0) DESC, created_at DESC, id DESC
      LIMIT ? OFFSET ?`).all(limit, offset)
  }
  const esc = kw.replace(/[\\%_]/g, (c) => "\\" + c)
  const like = `%${esc}%`, pre = `${esc}%`
  return db.prepare(`
    SELECT *, (
      CASE
        WHEN surname = ?                                THEN 0
        WHEN surname LIKE ? ESCAPE '\\'                 THEN 1
        WHEN display_name LIKE ? ESCAPE '\\'            THEN 2
        WHEN display_name LIKE ? ESCAPE '\\'            THEN 3
        ELSE 4
      END) AS rank
    FROM users
    WHERE display_name LIKE ? ESCAPE '\\'
       OR surname      LIKE ? ESCAPE '\\'
       OR username     LIKE ? ESCAPE '\\'
       OR phone        LIKE ? ESCAPE '\\'
       OR hospital     LIKE ? ESCAPE '\\'
    ORDER BY rank, surname, display_name, username
    LIMIT ? OFFSET ?`)
    .all(kw, like, pre, like, like, like, like, like, like, limit, offset)
}

export function countUsers(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n
}

// ==== 档位 ====================================================================

export const listTiers = (db) => db.prepare("SELECT * FROM tiers ORDER BY sort, key").all()
export const getTier = (db, key) => db.prepare("SELECT * FROM tiers WHERE key=?").get(String(key)) || null

export function upsertTier(db, t) {
  db.prepare(`INSERT INTO tiers(key,daily_usd,monthly_usd,model,skills,note,sort)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET
                daily_usd=excluded.daily_usd, monthly_usd=excluded.monthly_usd,
                model=excluded.model, skills=excluded.skills,
                note=excluded.note, sort=excluded.sort`).run(
    String(t.key), Number(t.daily_usd) || 0, Number(t.monthly_usd) || 0,
    String(t.model || ""), String(t.skills || ""), String(t.note || ""), Number(t.sort) || 0)
  return getTier(db, t.key)
}
export function deleteTier(db, key) {
  const inUse = db.prepare("SELECT COUNT(*) AS n FROM users WHERE tier=?").get(String(key)).n
  if (inUse) return { ok: false, err: `还有 ${inUse} 个用户在这个档位上，先改档再删` }
  db.prepare("DELETE FROM tiers WHERE key=?").run(String(key))
  return { ok: true }
}

/**
 * 某用户的生效额度/模型/技能：显式覆盖 > 档位 > 兜底。
 * 与旧 resolveLimits 同口径：0 = 不限（故意的，不是"没配"）。
 */
export function resolveEntitlement(db, user) {
  const t = getTier(db, user.tier) || null
  const num = (ov, tv) => (ov === null || ov === undefined ? (t ? Number(tv) || 0 : 0) : Number(ov) || 0)
  const skillsRaw = user.skills_override === null || user.skills_override === undefined
    ? (t ? t.skills : "") : user.skills_override
  return {
    tier: user.tier,
    daily: num(user.daily_override, t?.daily_usd),
    monthly: num(user.monthly_override, t?.monthly_usd),
    model: (t && t.model) || "",
    // '' = 不限（全部技能）；否则是白名单数组
    skills: String(skillsRaw || "").split(",").map((s) => s.trim()).filter(Boolean),
  }
}

// ==== 用量 ====================================================================

/** 记一笔用量（明细 + 汇总在同一事务里，避免只写进一半）。 */
export function recordUsage(db, userId, rec) {
  const ts = rec.ts || Date.now()
  const day = dayOf(ts), month = monthOf(ts)
  const cost = Number(rec.cost_usd) || 0
  db.exec("BEGIN IMMEDIATE")
  try {
    db.prepare(`INSERT INTO usage_log
        (user_id, ts, day, month, model, skill, prompt_tokens, completion_tokens, cached_tokens, cost_usd)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      Number(userId), ts, day, month, String(rec.model || ""), String(rec.skill || ""),
      Number(rec.prompt_tokens) || 0, Number(rec.completion_tokens) || 0,
      Number(rec.cached_tokens) || 0, cost)
    db.prepare(`INSERT INTO usage_daily(user_id,day,month,cost_usd,calls) VALUES(?,?,?,?,1)
                ON CONFLICT(user_id,day) DO UPDATE SET
                  cost_usd = cost_usd + excluded.cost_usd, calls = calls + 1`)
      .run(Number(userId), day, month, cost)
    db.exec("COMMIT")
  } catch (e) {
    try { db.exec("ROLLBACK") } catch {}
    throw e
  }
}

export function todayCost(db, userId, ts = Date.now()) {
  const r = db.prepare("SELECT cost_usd FROM usage_daily WHERE user_id=? AND day=?").get(Number(userId), dayOf(ts))
  return r ? Number(r.cost_usd) || 0 : 0
}
export function monthCost(db, userId, ts = Date.now()) {
  const r = db.prepare("SELECT SUM(cost_usd) AS c FROM usage_daily WHERE user_id=? AND month=?").get(Number(userId), monthOf(ts))
  return r && r.c ? Number(r.c) : 0
}
// 【ts 必须带次级排序键】同一毫秒内的两条记录只按 ts 排是【未定序】的，SQLite 返回顺序不保证 ——
// 表现为后台"最近调用"列表里同秒的几条顺序随机，测试里也会随机挂。id 单调递增，拿它兜底。
export const usageDetail = (db, userId, limit = 100) =>
  db.prepare("SELECT * FROM usage_log WHERE user_id=? ORDER BY ts DESC, id DESC LIMIT ?").all(Number(userId), limit)
export const usageDailySeries = (db, userId, days = 30) =>
  db.prepare("SELECT day, cost_usd, calls FROM usage_daily WHERE user_id=? ORDER BY day DESC LIMIT ?").all(Number(userId), days)
/** 全站近 N 天用量（后台看板） */
export const usageTotalSeries = (db, days = 30) =>
  db.prepare(`SELECT day, SUM(cost_usd) AS cost, SUM(calls) AS calls
              FROM usage_daily GROUP BY day ORDER BY day DESC LIMIT ?`).all(days)

// ==== refresh token ===========================================================

export function saveRefresh(db, userId, tokenHash, epoch, exp) {
  db.prepare("INSERT INTO refresh_tokens(user_id,token_hash,epoch,exp,created_at) VALUES(?,?,?,?,?)")
    .run(Number(userId), String(tokenHash), Number(epoch), Number(exp), Date.now())
}
export const findRefresh = (db, tokenHash) =>
  db.prepare("SELECT * FROM refresh_tokens WHERE token_hash=?").get(String(tokenHash)) || null
export const revokeRefresh = (db, tokenHash) =>
  db.prepare("UPDATE refresh_tokens SET revoked=1 WHERE token_hash=?").run(String(tokenHash))
export const purgeExpiredRefresh = (db, now = Date.now()) =>
  db.prepare("DELETE FROM refresh_tokens WHERE exp < ? OR revoked=1").run(now)

// ==== 审计 ====================================================================

export function addAudit(db, { actor = "", event, target = "", detail = "", ip = "" }) {
  db.prepare("INSERT INTO audit(ts,actor,event,target,detail,ip) VALUES(?,?,?,?,?,?)")
    .run(Date.now(), String(actor), String(event), String(target), String(detail), String(ip))
}
export const listAudit = (db, limit = 200) =>
  db.prepare("SELECT * FROM audit ORDER BY ts DESC LIMIT ?").all(limit)
