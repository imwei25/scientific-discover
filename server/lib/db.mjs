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

export const SCHEMA_VERSION = 2

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
  -- NULL = 随档位；'' = 不限（全部技能）。
  -- 【别把 '' 读成"一个都不给"】网关的判据是"白名单非空且不含该技能才拦"，空数组直接
  -- 放行。这里的注释一度写反，后台"把 chips 全点灭"于是变成全部放行 —— 与管理员的意图
  -- 恰好相反。语义以本行与后台 UI 的三态按钮为准。
  skills_override  TEXT,
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
  model      TEXT NOT NULL DEFAULT '',  -- 默认模型（客户端没选 / 选了不许的，都用它）
  models     TEXT NOT NULL DEFAULT '',  -- 允许清单，逗号分隔；'' = 只允许上面那个默认模型
  skills     TEXT NOT NULL DEFAULT '',  -- 逗号分隔；'' = 全部技能
  note       TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  max_conc   INTEGER NOT NULL DEFAULT 0 -- 该档单用户并发上限；0 = 跟随全局（见 queue.mjs）
);

-- ==== 模型供应商与模型目录 ====================================================
-- 【为什么这两张表要存在服务端库里】管理员要能在后台加一家供应商、加几个模型，加完
-- 桌面客户端不重装就能用上（清单随 /api/me 下发）。所以「有哪些模型、每个模型走哪家、
-- 每个模型什么价」必须是服务端的可变状态，不能再散在 env 里。
--
-- api_key 存在这张表里（库文件 0600、只在服务器上）：网关转发时才贴，绝不下发客户端。
CREATE TABLE IF NOT EXISTS providers (
  key        TEXT PRIMARY KEY,               -- 供应商键，如 deepseek / siliconflow / oneapi
  name       TEXT NOT NULL DEFAULT '',       -- 显示名
  base_url   TEXT NOT NULL,                  -- OpenAI 兼容端点根（带不带 /v1 都行，网关会消重）
  api_key    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active', -- active | disabled
  note       TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 一行 = 「某个对外模型名，由某家供应商提供」。同一个对外模型名可以有多行（多家）：
-- sort 小的先用，前面那家连不上/5xx 就自动落到下一家 —— 这就是本架构的故障切换。
CREATE TABLE IF NOT EXISTS models (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  model        TEXT NOT NULL,                  -- 对外模型名（客户端看到的、请求里写的）
  provider     TEXT NOT NULL,                  -- providers.key
  upstream     TEXT NOT NULL DEFAULT '',       -- 这家自己的真实模型名；'' = 与对外名相同
  label        TEXT NOT NULL DEFAULT '',       -- 中文显示名（客户端下拉里显示）
  price_in     REAL NOT NULL DEFAULT 0,        -- USD / 百万 token
  price_out    REAL NOT NULL DEFAULT 0,
  price_cached REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active', -- active | disabled
  sort         INTEGER NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT '',
  UNIQUE(model, provider)
);
CREATE INDEX IF NOT EXISTS ix_models_model ON models(model);

-- 明细：一次 LLM 调用一行（后台「单用户用量明细」用）
CREATE TABLE IF NOT EXISTS usage_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  day      TEXT    NOT NULL,           -- UTC 日切，与旧账本口径一致
  month    TEXT    NOT NULL,
  model    TEXT    NOT NULL DEFAULT '',   -- 【对外】模型名（用户点的那个），不是上游改名后的
  provider TEXT    NOT NULL DEFAULT '',   -- 实际服务这一单的供应商键；'' = env 兜底上游
  skill    TEXT    NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_usage_user_day ON usage_log(user_id, day);
CREATE INDEX IF NOT EXISTS ix_usage_ts ON usage_log(ts);
-- ix_usage_provider_ts 不在这里建，而在 ensureColumns 之后 —— provider 是补出来的列，
-- SCHEMA 跑在补列之前，老库（v1）在这儿建索引会直接 "no such column: provider" 崩在启动路径上。

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

-- ==== 供应侧：每家供应商的预算与健康 ==========================================
-- 【为什么要有这两张表】tiers.daily_usd 管的是「这个**用户**能花多少」，跟得很准；而
-- 「**供应商账户**里还剩多少钱」系统一直一个字节都没存。2026-08 火山账户耗尽那次，
-- 发现途径是用户报「没输出」——网关侧只能靠撞 402 才知道，而且每来一单撞一次。
-- 这两张表就是补这个洞：预算是**我们自己记的账**（不依赖各家余额 API，一份代码通吃），
-- 健康是**上游打脸后记下的状态**（撞过一次就别再往这家送，直到冷却到期）。
--
-- 【为什么不去调各家的余额接口】火山/DeepSeek/opencode 各有各的接口与字段，每接一家写一份
-- 适配，还都可能改。而 usage_log 里本来就逐单记着 provider 与 cost_usd，按窗口一聚合就是
-- 消费额；管理员只需要填一个「这个账号有多少额度」。误差来自单价表与真实账单的偏差，
-- 用于「还该不该往这家打」完全够 —— 它是闸，不是账本。
CREATE TABLE IF NOT EXISTS provider_budgets (
  provider  TEXT    NOT NULL,             -- providers.key
  win       TEXT    NOT NULL,             -- h5 | day | week | month | total（见 supply.mjs WINDOWS）
  limit_usd REAL    NOT NULL DEFAULT 0,   -- 0 = 不限（等于没设这条线）
  anchor    INTEGER NOT NULL DEFAULT 0,   -- 仅 total 窗口用：从这个时刻起算（= 充值时刻）
  PRIMARY KEY (provider, win)
);

-- 上游打脸后的状态。**内存里那份才是热路径的权威**（见 supply.mjs），这张表管两件事：
-- 进程重启后能恢复（否则一重启就把所有干涸标记忘光，又开始挨家撞 402），以及后台能看见。
CREATE TABLE IF NOT EXISTS provider_health (
  provider    TEXT    PRIMARY KEY,
  state       TEXT    NOT NULL DEFAULT 'ok',  -- ok | dry | invalid_key | rate_limited
  until       INTEGER NOT NULL DEFAULT 0,     -- 冷却到期（ms）；到点后半开放行一单探路
  reason      TEXT    NOT NULL DEFAULT '',
  http_status INTEGER NOT NULL DEFAULT 0,
  noted_at    INTEGER NOT NULL DEFAULT 0,
  trips       INTEGER NOT NULL DEFAULT 0      -- 累计跳闸次数：后台据此看出「这家老出事」
);

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

-- ==== 技能包 ==================================================================
-- 管理员发布的整套技能版本包（zip 落在 DATA_DIR/skill-packs/<version>.zip，这里只存元数据）。
-- 一行一个版本，行不可改（重发同版本号会拒绝——客户端按版本号判断"要不要提示更新"，
-- 同号不同内容会让 sha256 校验与缓存全部失去意义）。回退 = 把新版本置 disabled。
CREATE TABLE IF NOT EXISTS skill_packs (
  version        TEXT PRIMARY KEY,               -- 点分数字（与客户端版本同一比较规则）
  sha256         TEXT NOT NULL,
  size           INTEGER NOT NULL,
  changelog      TEXT NOT NULL DEFAULT '',
  changed_skills TEXT NOT NULL DEFAULT '',       -- 逗号分隔；'' = 未标注（对所有人都提示）
  skills         TEXT NOT NULL DEFAULT '',       -- 包内技能清单（展示用）
  commit_sha     TEXT NOT NULL DEFAULT '',       -- "从仓库发布"时的源 commit（算下次 diff 用）
  status         TEXT NOT NULL DEFAULT 'active', -- active | disabled（禁用即对客户端不可见）
  created_at     INTEGER NOT NULL
);

-- 用户反馈：用户把某一次会话（完整对话 + 可选的产出文件）连同赞/踩与一段评论交给管理员。
-- 【为什么把整段对话存进来】反馈"这次答得不好"如果不带上下文，管理员根本无从复现；而用户
-- 自己描述又会丢掉最关键的细节（提示词、模型答了什么、走了哪几个技能）。
-- transcript 存 JSON 文本（服务端不解析，导出与展示时才用）；附件落在 DATA_DIR/feedback/<id>/。
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  username   TEXT    NOT NULL DEFAULT '',      -- 冗余一份：用户被删了反馈也还看得出是谁提的
  session_id TEXT    NOT NULL DEFAULT '',
  title      TEXT    NOT NULL DEFAULT '',      -- 会话标题（列表里一眼看出是哪次）
  vote       INTEGER NOT NULL DEFAULT 0,       -- 1 = 赞，-1 = 踩，0 = 只留言
  comment    TEXT    NOT NULL DEFAULT '',
  transcript TEXT    NOT NULL DEFAULT '',      -- JSON：[{role, text, ts, ...}]
  msgs       INTEGER NOT NULL DEFAULT 0,       -- 消息条数（列表里显示，不必解析 transcript）
  files      TEXT    NOT NULL DEFAULT '',      -- JSON：[{name,size}]，本体在磁盘
  meta       TEXT    NOT NULL DEFAULT '',      -- JSON：客户端版本/模型/技能等
  status     TEXT    NOT NULL DEFAULT 'new',   -- new | done（管理员标记已处理）
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_feedback_created ON feedback(created_at);

-- 界面包：客户端前端静态资源（web/*.html 等）的版本包。与 skill_packs 同形状、分开一张表：
-- 两者生效方式不同（这个只要刷新页面，技能包要重启 opencode），版本号也各走各的。
CREATE TABLE IF NOT EXISTS web_packs (
  version    TEXT PRIMARY KEY,               -- 点分数字
  sha256     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  changelog  TEXT NOT NULL DEFAULT '',
  files      TEXT NOT NULL DEFAULT '',       -- 包内文件清单，逗号分隔（展示用）
  commit_sha TEXT NOT NULL DEFAULT '',       -- "从仓库发布"时的源 commit
  status     TEXT NOT NULL DEFAULT 'active', -- active | disabled（撤下即对客户端不可见）
  created_at INTEGER NOT NULL
);

-- 公告：一条一行。老设计是 meta 里一行 JSON（全站只留当前这一条），用户点掉就再也找不回来，
-- 管理员也查不到发过什么。现在留半年（purgeNotices 每天扫），客户端界面上常驻可查。
-- status: active | withdrawn（撤下只是标记，不删行 —— 管理员仍要看得到自己发过什么）
CREATE TABLE IF NOT EXISTS notices (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  text               TEXT    NOT NULL DEFAULT '',
  level              TEXT    NOT NULL DEFAULT 'info',   -- info | warn | urgent
  min_client_version TEXT    NOT NULL DEFAULT '',       -- 比它旧的客户端会被额外催升级
  download_url       TEXT    NOT NULL DEFAULT '',
  status             TEXT    NOT NULL DEFAULT 'active',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notices_created ON notices(created_at);

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

/**
 * 就地升级老库。
 *
 * v1 → v2：tiers 多了 models 列（每档的允许模型清单）。新表由 SCHEMA 的 CREATE TABLE
 * IF NOT EXISTS 建好，但【已存在的表不会被它改】——老库里 tiers 仍是 v1 的形状，
 * 于是任何 SELECT models 都会炸在 "no such column"。所以必须显式 ALTER。
 *
 * 老库升上来后 models 列全是 ''，语义正是"只允许该档的默认模型"，与升级前行为一致：
 * 管理员不去后台勾选，谁都不会突然多出模型可选。
 */
/**
 * 补齐后加的列。**无条件跑**，不看 schema_version。
 *
 * 为什么不放在 migrate() 里按版本号跑：版本号本身可能不可信。老库若 meta 表在、却没有
 * schema_version 那一行（迁移脚本只搬了部分行、或人手动改过 meta），openDb 会走"新库"
 * 分支直接写下 v2 并跳过 migrate —— tiers 永远缺 models 列，此后每次 SELECT 都炸在
 * "no such column"，而报错离病因十万八千里。每步都先 PRAGMA 查列，跑一百遍也没有副作用，
 * 那就没有理由拿版本号当前置条件。
 */
function ensureColumns(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)
  if (!has("tiers", "models")) db.exec("ALTER TABLE tiers ADD COLUMN models TEXT NOT NULL DEFAULT ''")
  if (!has("usage_log", "provider")) db.exec("ALTER TABLE usage_log ADD COLUMN provider TEXT NOT NULL DEFAULT ''")
  // 0 = 跟随全局并发限额；老库升上来全是 0，与加这一列之前的行为逐字节一致
  if (!has("tiers", "max_conc")) db.exec("ALTER TABLE tiers ADD COLUMN max_conc INTEGER NOT NULL DEFAULT 0")
  // 客户端汇报的本机技能包版本（与 client_version 同机制：请求头顺手记下，供后台看升级面）
  if (!has("users", "skills_version")) db.exec("ALTER TABLE users ADD COLUMN skills_version TEXT NOT NULL DEFAULT ''")
  // 同上，本机界面包（前端静态资源）版本
  if (!has("users", "web_version")) db.exec("ALTER TABLE users ADD COLUMN web_version TEXT NOT NULL DEFAULT ''")
  // "从仓库发布"的包记下出包时的 commit：下次发布 diff 这两个 sha 就能精确算出变更技能
  if (!has("skill_packs", "commit_sha")) db.exec("ALTER TABLE skill_packs ADD COLUMN commit_sha TEXT NOT NULL DEFAULT ''")

  // ---- 生图张数限额（mechanism-figure 技能走 /img 代理）----
  // 【为什么不并进 daily_usd 的美元额度】生图按【张】计价且单价比一次对话高一两个量级，
  // 混进美元额度里，用户一天画几张图就把当天的对话额度烧光了，而他完全看不出是被图吃掉的。
  // 分开一条独立的"每天几张"，出问题时话也好说：「今天的 2 张画完了」。
  // 【默认值取 2 而不是 0】本仓库的额度约定是 0=不限（daily_usd / max_conc 都是），生图沿用
  // 这个口径以免运营记两套规则；但**列默认值**必须保守 —— 以后新建一个档位忘了填，
  // 默认成"不限"就是一个直接烧钱的洞。所以默认 2 张：够试，烧不穿。
  if (!has("tiers", "img_daily")) {
    db.exec("ALTER TABLE tiers ADD COLUMN img_daily INTEGER NOT NULL DEFAULT 2")
    // 老库升上来铺一次运营定的初值（2026-08-07）：free 2 / plus 5 / admin 10。
    // 只在【首次加列】时跑，之后管理员在后台怎么改就是什么，不会被这段覆盖回去。
    for (const [k, n] of [["plus", 5], ["admin", 10]]) {
      try { db.prepare("UPDATE tiers SET img_daily=? WHERE key=?").run(n, k) } catch {}
    }
  }
  // 当天已生成张数：挂在既有的日汇总上，不另开表 —— UTC 日切、删用户清理都跟着 usage_daily 走，
  // 不会出现"用户删了图配额还留着"这类孤儿数据。
  if (!has("usage_daily", "images")) db.exec("ALTER TABLE usage_daily ADD COLUMN images INTEGER NOT NULL DEFAULT 0")

  // ---- OCR 次数限额（ocr 技能走 /ocr 代理）----
  // 【为什么又是一条独立的次数而不是并进美元额度】与生图同一个理由：OCR 走的是 OCR.space 的
  // 免费档，计价单位是"次"、且额度是【全平台共享】的（Engine3 每月 2500 次、每天 500 次/IP，
  // 而所有用户的请求现在都从本服务器这一个 IP 出去）。一个用户扫一本三百页的书，就能把全平台
  // 当月的额度吃干净 —— 所以必须有每人每天的闸。
  // 【默认 20 而非 0】理由同 img_daily：本仓库 0=不限，但列默认值必须保守，新建档位忘了填
  // 不能默认成"不限"。20 次/天够查十几张官方图片表，又不至于一个人吃穿全平台。
  if (!has("tiers", "ocr_daily")) {
    db.exec("ALTER TABLE tiers ADD COLUMN ocr_daily INTEGER NOT NULL DEFAULT 20")
    for (const [k, n] of [["plus", 50], ["admin", 100]]) {
      try { db.prepare("UPDATE tiers SET ocr_daily=? WHERE key=?").run(n, k) } catch {}
    }
  }
  // 当天已识别次数：同 images，挂在日汇总上，日切与删用户清理都跟着 usage_daily 走。
  if (!has("usage_daily", "ocr")) db.exec("ALTER TABLE usage_daily ADD COLUMN ocr INTEGER NOT NULL DEFAULT 0")

  // 【必须在补完 provider 列之后】供应侧的预算闸按 (provider, ts) 聚合（见 providerSpend），
  // 没索引就要全表扫 usage_log —— 那是只增不减的明细表，上线几个月后每一单请求都会被它拖慢。
  // 放在 SCHEMA 里会崩：SCHEMA 跑在本函数之前，那时老库还没有 provider 这一列。
  db.exec("CREATE INDEX IF NOT EXISTS ix_usage_provider_ts ON usage_log(provider, ts)")
}

function migrate(db, from) {
  if (from < 2) ensureColumns(db)
  db.prepare("UPDATE meta SET v=? WHERE k='schema_version'").run(String(SCHEMA_VERSION))
}

export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(SCHEMA)
  ensureColumns(db)
  const cur = db.prepare("SELECT v FROM meta WHERE k='schema_version'").get()
  if (!cur) {
    db.prepare("INSERT INTO meta(k,v) VALUES('schema_version',?)").run(String(SCHEMA_VERSION))
    const ins = db.prepare("INSERT OR IGNORE INTO tiers(key,daily_usd,monthly_usd,model,skills,note,sort) VALUES(?,?,?,?,?,?,?)")
    for (const t of SEED_TIERS) ins.run(t.key, t.daily_usd, t.monthly_usd, t.model, t.skills, t.note, t.sort)
  } else if (Number(cur.v) > SCHEMA_VERSION) {
    throw new Error(`库的 schema 版本 ${cur.v} 高于本程序支持的 ${SCHEMA_VERSION}——别用旧版程序开新库，会写坏数据`)
  } else if (Number(cur.v) < SCHEMA_VERSION) {
    migrate(db, Number(cur.v))
  }
  // 【无条件跑，与 ensureColumns 同理】它自己带幂等标记；挂在版本号上就会漏掉那些
  // "meta 表在、schema_version 却缺一行"的库 —— 那种库会走上面的新库分支，公告就搬不过来。
  migrateLegacyNotice(db)
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
  "pass_hash", "pass_salt", "must_change_pw", "client_version", "skills_version", "web_version", "last_login_at", "last_seen_at",
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
/** 检索用的 LIKE 参数（searchUsers 与 countSearchUsers 必须用同一份，否则"命中 N"会对不上）。 */
function searchArgs(kw) {
  const esc = kw.replace(/[\\%_]/g, (c) => "\\" + c)
  return { like: `%${esc}%`, pre: `${esc}%` }
}
const SEARCH_WHERE = `display_name LIKE ? ESCAPE '\\'
       OR surname      LIKE ? ESCAPE '\\'
       OR username     LIKE ? ESCAPE '\\'
       OR phone        LIKE ? ESCAPE '\\'
       OR hospital     LIKE ? ESCAPE '\\'`

/**
 * 命中总数（不受分页 limit 影响）。
 * 【为什么不能拿 rows.length 当命中数】它被 limit 截断过，后台"命中 200 / 640"是假的，
 * 而管理员正是靠这个数字判断"要不要再缩关键词"。
 */
export function countSearchUsers(db, q) {
  const kw = String(q || "").trim()
  if (!kw) return countUsers(db)
  const { like } = searchArgs(kw)
  return db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${SEARCH_WHERE}`)
    .get(like, like, like, like, like).n
}

/** 每个档位下的用户数（服务端算，不能拿"当前这页搜索结果"去数，见 countSearchUsers 的理由）。 */
export function tierCounts(db) {
  const out = {}
  for (const r of db.prepare("SELECT tier, COUNT(*) AS n FROM users GROUP BY tier").all()) out[r.tier] = r.n
  return out
}

export function searchUsers(db, q, { limit = 200, offset = 0 } = {}) {
  const kw = String(q || "").trim()
  if (!kw) {
    // 不带关键词时按【最近活跃】倒序：中文姓名按 UTF-8 码点排序等于随机顺序，对运维毫无意义；
    // 而"谁最近在用"是管理员打开列表最常想先看到的。没活跃过的按创建时间兜底。
    return db.prepare(`SELECT * FROM users
      ORDER BY COALESCE(last_seen_at, last_login_at, 0) DESC, created_at DESC, id DESC
      LIMIT ? OFFSET ?`).all(limit, offset)
  }
  const { like, pre } = searchArgs(kw)
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
    WHERE ${SEARCH_WHERE}
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
  // img_daily 缺省时【保留原值】而不是落成 0：后台改档位的表单若没带这个字段（老版本管理台、
  // 或脚本只想改额度），落 0 就等于把该档静默改成"生图不限"——一个纯靠疏忽产生的烧钱洞。
  const prev = getTier(db, t.key)
  const img = t.img_daily === undefined || t.img_daily === null || t.img_daily === ""
    ? (prev ? Number(prev.img_daily) || 0 : 2)
    : Math.max(0, Math.floor(Number(t.img_daily) || 0))
  // ocr_daily 同理保留原值（管理台的档位表单同样没有这一栏，只有 API/脚本会带）
  const ocr = t.ocr_daily === undefined || t.ocr_daily === null || t.ocr_daily === ""
    ? (prev ? Number(prev.ocr_daily) || 0 : 20)
    : Math.max(0, Math.floor(Number(t.ocr_daily) || 0))
  db.prepare(`INSERT INTO tiers(key,daily_usd,monthly_usd,model,models,skills,note,sort,max_conc,img_daily,ocr_daily)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET
                daily_usd=excluded.daily_usd, monthly_usd=excluded.monthly_usd,
                model=excluded.model, models=excluded.models, skills=excluded.skills,
                note=excluded.note, sort=excluded.sort, max_conc=excluded.max_conc,
                img_daily=excluded.img_daily, ocr_daily=excluded.ocr_daily`).run(
    String(t.key), Number(t.daily_usd) || 0, Number(t.monthly_usd) || 0,
    String(t.model || ""), String(t.models || ""), String(t.skills || ""),
    String(t.note || ""), Number(t.sort) || 0, Math.max(0, Math.floor(Number(t.max_conc) || 0)), img, ocr)
  return getTier(db, t.key)
}
export function deleteTier(db, key) {
  const inUse = db.prepare("SELECT COUNT(*) AS n FROM users WHERE tier=?").get(String(key)).n
  if (inUse) return { ok: false, err: `还有 ${inUse} 个用户在这个档位上，先改档再删` }
  db.prepare("DELETE FROM tiers WHERE key=?").run(String(key))
  return { ok: true }
}

// ==== 模型供应商与模型目录 ====================================================

const csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean)

export const listProviders = (db) => db.prepare("SELECT * FROM providers ORDER BY sort, key").all()
export const getProvider = (db, key) => db.prepare("SELECT * FROM providers WHERE key=?").get(String(key)) || null

export function upsertProvider(db, p) {
  const cur = getProvider(db, p.key)
  // 【key 留空 = 不改】编辑供应商时后台不回显真实 key（只回掩码），若把掩码当新值存回去，
  // 一次"改个名字"就能把这家的凭证悄悄写坏，直到下一次调用才报 401。
  const key = p.api_key === undefined || p.api_key === null || p.api_key === ""
    ? (cur ? cur.api_key : "") : String(p.api_key)
  db.prepare(`INSERT INTO providers(key,name,base_url,api_key,status,note,sort,created_at)
              VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET
                name=excluded.name, base_url=excluded.base_url, api_key=excluded.api_key,
                status=excluded.status, note=excluded.note, sort=excluded.sort`).run(
    String(p.key), String(p.name || ""), String(p.base_url || ""), key,
    p.status === "disabled" ? "disabled" : "active", String(p.note || ""),
    Number(p.sort) || 0, cur ? cur.created_at : Date.now())
  return getProvider(db, p.key)
}

/**
 * 把各档位允许清单里【目录中已经不存在的模型名】摘掉，返回被摘掉的 {档位: [模型名]}。
 *
 * 不摘会怎样：档位页照旧显示"可选：mm"（后台从库里直出这个字符串），而运行时
 * resolveEntitlement 会把它过滤掉 —— 管理员看得见、用户选不到，无从分辨。更实际的坑是
 * 之后任何人以任何供应商重新接入一个【同名】模型，这些档位会**自动重新获得授权**，
 * 授权凭空复活。
 *
 * 只摘允许清单，不动 tiers.model（默认模型可能就是 env 兜底上游那个，本来就不在目录里）。
 */
export function pruneTierModels(db) {
  const alive = new Set(db.prepare("SELECT DISTINCT model FROM models").all().map((r) => r.model))
  const dropped = {}
  const upd = db.prepare("UPDATE tiers SET models=? WHERE key=?")
  for (const t of db.prepare("SELECT key, models FROM tiers").all()) {
    const cur = csv(t.models)
    const kept = cur.filter((m) => alive.has(m))
    if (kept.length === cur.length) continue
    upd.run(kept.join(","), t.key)
    dropped[t.key] = cur.filter((m) => !alive.has(m))
  }
  return dropped
}

/** 删供应商连同它名下的模型条目（模型没了供应商就是死条目，留着只会让路由静默落空）。 */
export function deleteProvider(db, key) {
  const k = String(key)
  const models = db.prepare("SELECT COUNT(*) AS n FROM models WHERE provider=?").get(k).n
  db.prepare("DELETE FROM models WHERE provider=?").run(k)
  db.prepare("DELETE FROM providers WHERE key=?").run(k)
  // 预算与健康跟着走：留下孤儿行的话，日后重建同名供应商会**继承上一次的干涸标记**，
  // 表现是「刚加完的新账号一上来就被摘掉」，且后台看不出为什么。
  db.prepare("DELETE FROM provider_budgets WHERE provider=?").run(k)
  db.prepare("DELETE FROM provider_health WHERE provider=?").run(k)
  return { ok: true, removedModels: models, droppedFromTiers: pruneTierModels(db) }
}

/** 模型目录（带供应商显示名，便于后台/客户端展示） */
export const listModels = (db) => db.prepare(`
  SELECT m.*, p.name AS provider_name, p.status AS provider_status, p.base_url AS provider_base_url
  FROM models m LEFT JOIN providers p ON p.key = m.provider
  ORDER BY m.model, m.sort, m.id`).all()
export const getModelRow = (db, id) => db.prepare("SELECT * FROM models WHERE id=?").get(Number(id)) || null

/**
 * 落一行模型。
 *
 * opts.insertOnly：撞上已有的 (model, provider) 就【原样不动】，返回既有行。
 * 「从供应商拉列表 → 勾选批量接入」那条路必须用它：批量项只带模型名，价格/中文名/上游
 * 真实名一律缺省，若走 DO UPDATE，就会把管理员之前手工填好的真实单价洗成 env 全局价 ——
 * 计费静默偏，正是本架构要治的病根。
 */
export function upsertModel(db, m, { insertOnly = false } = {}) {
  const row = {
    model: String(m.model || "").trim(),
    provider: String(m.provider || "").trim(),
    upstream: String(m.upstream || "").trim(),
    label: String(m.label || "").trim(),
    price_in: Number(m.price_in) || 0,
    price_out: Number(m.price_out) || 0,
    price_cached: Number(m.price_cached) || 0,
    status: m.status === "disabled" ? "disabled" : "active",
    sort: Number(m.sort) || 0,
    note: String(m.note || ""),
  }
  if (m.id) {
    // 改名/换供应商可能撞上 UNIQUE(model,provider)。裸 UPDATE 撞了会抛未捕获异常 → 500，
    // 前端只看到"保存失败"，管理员完全不知道原因是重名。先查一次，给得出人话。
    const clash = db.prepare("SELECT id FROM models WHERE model=? AND provider=? AND id<>?")
      .get(row.model, row.provider, Number(m.id))
    if (clash) return { err: `目录里已经有「${row.model} @ ${row.provider}」了，同一供应商下模型名不能重复` }
    db.prepare(`UPDATE models SET model=?,provider=?,upstream=?,label=?,price_in=?,price_out=?,
                price_cached=?,status=?,sort=?,note=? WHERE id=?`).run(
      row.model, row.provider, row.upstream, row.label, row.price_in, row.price_out,
      row.price_cached, row.status, row.sort, row.note, Number(m.id))
    return getModelRow(db, m.id)
  }
  if (insertOnly) {
    const cur = db.prepare("SELECT * FROM models WHERE model=? AND provider=?").get(row.model, row.provider)
    if (cur) return { ...cur, skipped: true }
  }
  db.prepare(`INSERT INTO models(model,provider,upstream,label,price_in,price_out,price_cached,status,sort,note)
              VALUES(?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(model,provider) DO UPDATE SET
                upstream=excluded.upstream, label=excluded.label, price_in=excluded.price_in,
                price_out=excluded.price_out, price_cached=excluded.price_cached,
                status=excluded.status, sort=excluded.sort, note=excluded.note`).run(
    row.model, row.provider, row.upstream, row.label, row.price_in, row.price_out,
    row.price_cached, row.status, row.sort, row.note)
  return db.prepare("SELECT * FROM models WHERE model=? AND provider=?").get(row.model, row.provider) || null
}
export function deleteModel(db, id) {
  db.prepare("DELETE FROM models WHERE id=?").run(Number(id))
  return { ok: true, droppedFromTiers: pruneTierModels(db) }
}

/**
 * 某个对外模型名的候选路由，按 sort、id 排序。
 * 多行 = 多家供应商都能提供这个模型名 → 前面那家连不上/5xx 时网关自动落到下一家。
 * 只取【模型条目与供应商都启用】的行：停用任一层都应立刻不再出流量。
 */
export const modelRoutes = (db, model) => db.prepare(`
  SELECT m.model, m.upstream, m.price_in, m.price_out, m.price_cached, m.sort,
         p.key AS provider, p.name AS provider_name, p.base_url, p.api_key
  FROM models m JOIN providers p ON p.key = m.provider
  WHERE m.model=? AND m.status='active' AND p.status='active'
  ORDER BY m.sort, m.id`).all(String(model))

/** 目录里【当前可用】的对外模型名集合（供应商也启用）。空集合 = 还没建目录，走 env 上游。 */
export function catalogModels(db) {
  const rows = db.prepare(`SELECT DISTINCT m.model FROM models m JOIN providers p ON p.key=m.provider
                           WHERE m.status='active' AND p.status='active'`).all()
  return new Set(rows.map((r) => r.model))
}

/** 客户端要显示的模型清单（含中文名与供应商），按目录顺序，同名只留优先级最高的那家。 */
export function modelInfo(db, names) {
  const want = new Set(names)
  const out = new Map()
  for (const r of listModels(db)) {
    if (!want.has(r.model) || r.status !== "active" || r.provider_status !== "active") continue
    if (out.has(r.model)) continue          // 同名多家：只报最优先那家，客户端不需要知道兜底细节
    out.set(r.model, {
      model: r.model, label: r.label || r.model,
      provider: r.provider, providerName: r.provider_name || r.provider,
      price: { input: r.price_in, output: r.price_out, cached: r.price_cached },
    })
  }
  // 目录里没有的（如仅由 env 上游提供的默认模型）也要给出来，否则客户端下拉里会缺当前在用的那个
  return names.map((n) => out.get(n) || { model: n, label: n, provider: "", providerName: "", price: null })
}

/**
 * 某用户的生效额度/模型/技能：显式覆盖 > 档位 > 兜底。
 * 与旧 resolveLimits 同口径：0 = 不限（故意的，不是"没配"）。
 *
 * model  = 默认模型（客户端没选、或选了不许的，一律用它）
 * models = 允许清单（默认模型永远在内）。'' 的档位就只有默认模型这一个 —— 老库升上来
 *          正是这个形状，即"没人主动去后台开放，谁都不会突然多出模型可选"。
 */
export function resolveEntitlement(db, user) {
  const t = getTier(db, user.tier) || null
  const num = (ov, tv) => (ov === null || ov === undefined ? (t ? Number(tv) || 0 : 0) : Number(ov) || 0)
  const skillsRaw = user.skills_override === null || user.skills_override === undefined
    ? (t ? t.skills : "") : user.skills_override
  const model = (t && t.model) || ""
  const cat = catalogModels(db)
  const allowed = []
  for (const m of [model, ...csv(t && t.models)]) {
    if (!m || allowed.includes(m)) continue
    // 清单里的每一项都必须有【当前启用】的目录条目撑着：模型停用、供应商停用、供应商被删，
    // 都要立刻从用户能选的清单里消失（选了也调不通，只会落到 env 上游换回一个 404）。
    // 【不能写成"目录为空就不过滤"】停用最后一个模型恰好会让目录变空，那种写法下它反而
    // 又冒出来了。默认模型是唯一例外：它可能就是 env 兜底上游那个，本来就不在目录里。
    if (m !== model && !cat.has(m)) continue
    allowed.push(m)
  }
  return {
    tier: user.tier,
    daily: num(user.daily_override, t?.daily_usd),
    monthly: num(user.monthly_override, t?.monthly_usd),
    model,
    models: allowed,
    // '' = 不限（全部技能）；否则是白名单数组
    skills: csv(skillsRaw),
    // 单用户并发上限：0 = 跟随全局（网关的并发闸现查现用，不进 access key，改完立刻生效）
    maxConc: Math.max(0, Math.floor(Number(t?.max_conc) || 0)),
    // 每天可生成几张图（0 = 不限，与 daily 同口径）。没有档位时给 0 而不是默认值：
    // 走到这儿说明 tier 已经被删了，此时"不限"是既有 num() 对所有额度的一致行为，别在这条上搞特例。
    imgDaily: t ? Math.max(0, Math.floor(Number(t.img_daily) || 0)) : 0,
    // 每天可识别几次图片（0 = 不限）。档位被删时给 0 的理由同 imgDaily。
    ocrDaily: t ? Math.max(0, Math.floor(Number(t.ocr_daily) || 0)) : 0,
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
        (user_id, ts, day, month, model, provider, skill, prompt_tokens, completion_tokens, cached_tokens, cost_usd)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      Number(userId), ts, day, month, String(rec.model || ""), String(rec.provider || ""), String(rec.skill || ""),
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
/** 今天已生成几张图（UTC 日切，与 todayCost 同一个 day 键，两处口径永远一致）。 */
export function todayImages(db, userId, ts = Date.now()) {
  const r = db.prepare("SELECT images FROM usage_daily WHERE user_id=? AND day=?").get(Number(userId), dayOf(ts))
  return r ? Number(r.images) || 0 : 0
}

/**
 * 记一张已生成的图，返回记完之后的当天张数。
 *
 * 【必须是 upsert 而不是 UPDATE】当天第一张图很可能发生在这个用户当天第一次对话【之前】
 * （比如他上来就画图），那时 usage_daily 还没有今天这一行，UPDATE 会静默影响 0 行 —— 张数
 * 永远停在 0，限额形同虚设。cost_usd 留 0：生图的钱不进美元额度（见 ensureColumns 的说明）。
 */
export function recordImage(db, userId, ts = Date.now()) {
  const uid = Number(userId), day = dayOf(ts), month = monthOf(ts)
  db.prepare(`INSERT INTO usage_daily(user_id,day,month,cost_usd,calls,images)
              VALUES(?,?,?,0,0,1)
              ON CONFLICT(user_id,day) DO UPDATE SET images=images+1`).run(uid, day, month)
  return todayImages(db, uid, ts)
}

/** 今天这个用户已识别几次（UTC 日切，与 todayCost / todayImages 同一个 day 键）。 */
export function todayOcr(db, userId, ts = Date.now()) {
  const r = db.prepare("SELECT ocr FROM usage_daily WHERE user_id=? AND day=?").get(Number(userId), dayOf(ts))
  return r ? Number(r.ocr) || 0 : 0
}

/** 记一次成功的识别，返回记完之后当天的次数。upsert 的理由同 recordImage。 */
export function recordOcr(db, userId, ts = Date.now()) {
  const uid = Number(userId), day = dayOf(ts), month = monthOf(ts)
  db.prepare(`INSERT INTO usage_daily(user_id,day,month,cost_usd,calls,ocr)
              VALUES(?,?,?,0,0,1)
              ON CONFLICT(user_id,day) DO UPDATE SET ocr=ocr+1`).run(uid, day, month)
  return todayOcr(db, uid, ts)
}

/**
 * 全平台今天 / 本月的识别总次数。
 *
 * 【为什么要有"全平台"这一档】OCR.space 的额度不是按用户算的，是按【我们这一把 key、
 * 这一个服务器 IP】算的（免费档 Engine3 每月 2500 次、每天 500 次/IP）。只有每人每天的闸
 * 挡不住"人多把公共额度耗光"，而耗光后上游只回一句限速，谁也不知道发生了什么。
 */
export function ocrTotals(db, ts = Date.now()) {
  const d = db.prepare("SELECT SUM(ocr) AS n FROM usage_daily WHERE day=?").get(dayOf(ts))
  const m = db.prepare("SELECT SUM(ocr) AS n FROM usage_daily WHERE month=?").get(monthOf(ts))
  return { day: Number(d?.n) || 0, month: Number(m?.n) || 0 }
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

// ---- 对账聚合 ----------------------------------------------------------------
// usage_log 早就记了 model 与 provider 两列，但一直没有任何一处按它们聚合 ——
// 要回答"这个月硅基流动该收我多少""哪个模型最烧钱"只能 SSH 进去手写 SQL。
// 单价配错会让计费系统性地偏、而且偏得很安静，对账是唯一能发现它的手段。
// 全部按 day 字符串过滤（UTC 日切，与额度口径一致），闭区间 [from, to]。

const RANGE = "WHERE day >= ? AND day <= ?"

export const usageByModel = (db, from, to) => db.prepare(`
  SELECT model, COUNT(*) AS calls, SUM(cost_usd) AS cost,
         SUM(prompt_tokens) AS tin, SUM(completion_tokens) AS tout, SUM(cached_tokens) AS tcached
  FROM usage_log ${RANGE} GROUP BY model ORDER BY cost DESC`).all(String(from), String(to))

export const usageByProvider = (db, from, to) => db.prepare(`
  SELECT provider, COUNT(*) AS calls, SUM(cost_usd) AS cost,
         SUM(prompt_tokens) AS tin, SUM(completion_tokens) AS tout, SUM(cached_tokens) AS tcached
  FROM usage_log ${RANGE} GROUP BY provider ORDER BY cost DESC`).all(String(from), String(to))

export const usageByUser = (db, from, to) => db.prepare(`
  SELECT u.username, u.display_name, u.tier, COUNT(*) AS calls, SUM(l.cost_usd) AS cost,
         SUM(l.prompt_tokens) AS tin, SUM(l.completion_tokens) AS tout, SUM(l.cached_tokens) AS tcached
  FROM usage_log l LEFT JOIN users u ON u.id = l.user_id
  WHERE l.day >= ? AND l.day <= ?
  GROUP BY l.user_id ORDER BY cost DESC`).all(String(from), String(to))

export const usageBySkill = (db, from, to) => db.prepare(`
  SELECT skill, COUNT(*) AS calls, SUM(cost_usd) AS cost
  FROM usage_log ${RANGE} GROUP BY skill ORDER BY cost DESC`).all(String(from), String(to))

/** 明细行（CSV 导出用）。上限兜底，别让一次导出把内存吃穿。 */
export const usageRange = (db, from, to, limit = 50000) => db.prepare(`
  SELECT l.ts, l.day, u.username, u.display_name, l.model, l.provider, l.skill,
         l.prompt_tokens, l.completion_tokens, l.cached_tokens, l.cost_usd
  FROM usage_log l LEFT JOIN users u ON u.id = l.user_id
  WHERE l.day >= ? AND l.day <= ?
  ORDER BY l.ts DESC, l.id DESC LIMIT ?`).all(String(from), String(to), Number(limit) || 50000)

// ==== 供应侧：预算与健康 ======================================================
// 表定义与「为什么要有」见上面 SCHEMA 里 provider_budgets / provider_health 那段。
// 这里只放存取；窗口语义、失败分类、候选过滤在 lib/supply.mjs（那边全是纯函数，好单测）。

/** 某家在 [from, ∞) 内的消费（USD）。走 ix_usage_provider_ts，不扫全表。 */
export function providerSpend(db, provider, from) {
  const r = db.prepare("SELECT SUM(cost_usd) AS c FROM usage_log WHERE provider=? AND ts>=?")
    .get(String(provider), Number(from) || 0)
  return r && r.c ? Number(r.c) : 0
}

/** 一家的全部预算行（没设过就是空数组 = 不限）。 */
export const listBudgets = (db, provider) =>
  db.prepare("SELECT provider, win, limit_usd, anchor FROM provider_budgets WHERE provider=? ORDER BY win")
    .all(String(provider))

/** 全部预算行，按供应商分组好，供 supply.mjs 一次性建缓存。 */
export function allBudgets(db) {
  const out = new Map()
  for (const r of db.prepare("SELECT provider, win, limit_usd, anchor FROM provider_budgets").all()) {
    if (!out.has(r.provider)) out.set(r.provider, [])
    out.get(r.provider).push(r)
  }
  return out
}

/**
 * 落一条预算线。limit_usd ≤ 0 视为「取消这条线」，直接删行 ——
 * 留一行 0 会和「不限」同义却多占一行，后台列表里看着像设过，其实没有。
 */
export function setBudget(db, provider, win, limitUsd, anchor = 0) {
  const p = String(provider), w = String(win)
  const lim = Number(limitUsd) || 0
  if (lim <= 0) {
    db.prepare("DELETE FROM provider_budgets WHERE provider=? AND win=?").run(p, w)
    return null
  }
  db.prepare(`INSERT INTO provider_budgets(provider,win,limit_usd,anchor) VALUES(?,?,?,?)
              ON CONFLICT(provider,win) DO UPDATE SET limit_usd=excluded.limit_usd, anchor=excluded.anchor`)
    .run(p, w, lim, Number(anchor) || 0)
  return db.prepare("SELECT provider, win, limit_usd, anchor FROM provider_budgets WHERE provider=? AND win=?").get(p, w)
}

export const deleteBudgets = (db, provider) =>
  db.prepare("DELETE FROM provider_budgets WHERE provider=?").run(String(provider))

/** 健康状态：全量读（进程启动时载进内存），与单家写入。 */
export const listHealth = (db) => db.prepare("SELECT * FROM provider_health").all()

export function saveHealth(db, provider, h) {
  db.prepare(`INSERT INTO provider_health(provider,state,until,reason,http_status,noted_at,trips)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(provider) DO UPDATE SET
                state=excluded.state, until=excluded.until, reason=excluded.reason,
                http_status=excluded.http_status, noted_at=excluded.noted_at, trips=excluded.trips`).run(
    String(provider), String(h.state || "ok"), Number(h.until) || 0, String(h.reason || ""),
    Number(h.httpStatus) || 0, Number(h.notedAt) || 0, Number(h.trips) || 0)
}

export const deleteHealth = (db, provider) =>
  db.prepare("DELETE FROM provider_health WHERE provider=?").run(String(provider))

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

// ==== 公告 ====================================================================
//
// 站长要通知全员（今晚维护、某模型下线、新版客户端已发）此前只能一个个发微信。
//
// 【2026-07-31 从"一行 meta"改成一张表】老设计全站只留【当前这一条】：客户端点掉就再也
// 找不回来（用户第二天想确认"维护是几点来着"只能问管理员），管理员自己也查不到发过什么。
// 现在一条公告一行，客户端拿到的是【近半年的列表】，界面上常驻可查；撤下只是标记，不删行。
//
// 保留期：`purgeNotices` 每天扫一次，删掉超过 NOTICE_KEEP_DAYS（默认 180 天）的行 ——
// 与审计同款策略。客户端那边也按同一个天数过滤，两边都不显示更老的。
export const NOTICE_LEVELS = ["info", "warn", "urgent"]
/** 保留期：与审计同款策略，只不过公告的默认值是半年（用户要能回看"上个月那条维护通知"）。 */
export const NOTICE_KEEP_DAYS = 180

const NOTICE_COLS ="id, text, level, min_client_version AS minClientVersion, download_url AS downloadUrl, status, created_at AS createdAt, updated_at AS updatedAt"

/** 发一条新公告。校验（级别/版本号/链接协议）在路由层做，这里只管截断与落库。 */
export function publishNotice(db, n) {
  const now = Date.now()
  const r = db.prepare(`INSERT INTO notices(text, level, min_client_version, download_url, status, created_at, updated_at)
                        VALUES(?,?,?,?,'active',?,?)`).run(
    String(n.text || "").slice(0, 2000),
    NOTICE_LEVELS.includes(n.level) ? n.level : "info",
    String(n.minClientVersion || "").trim().slice(0, 32),
    String(n.downloadUrl || "").trim().slice(0, 500),
    now, now)
  return getNoticeById(db, r.lastInsertRowid)
}

/**
 * 改一条已发的（改错别字、补链接）。
 *
 * 【不换 id】id 就是客户端的"已读到哪儿"游标：换 id = 所有人重新未读一遍。改错别字不该
 * 惊动全员，所以老设计里那套"内容变了才 ++id"的逻辑在这里不需要了 —— 新消息就发新的一条。
 */
export function updateNotice(db, id, patch) {
  const cur = getNoticeById(db, id)
  if (!cur) return null
  const val = (k, cut) => (patch[k] === undefined || patch[k] === null ? cur[k] : String(patch[k]).trim().slice(0, cut))
  db.prepare(`UPDATE notices SET text=?, level=?, min_client_version=?, download_url=?, updated_at=? WHERE id=?`).run(
    patch.text === undefined || patch.text === null ? cur.text : String(patch.text).slice(0, 2000),
    NOTICE_LEVELS.includes(patch.level) ? patch.level : cur.level,
    val("minClientVersion", 32), val("downloadUrl", 500), Date.now(), Number(id))
  return getNoticeById(db, id)
}

export const getNoticeById = (db, id) =>
  db.prepare(`SELECT ${NOTICE_COLS} FROM notices WHERE id=?`).get(Number(id)) || null

/** 撤下 / 恢复。撤下只是标记：管理员仍要能看到自己发过什么（这正是改成表的目的之一）。 */
export function setNoticeStatus(db, id, status) {
  const st = status === "withdrawn" ? "withdrawn" : "active"
  return db.prepare("UPDATE notices SET status=?, updated_at=? WHERE id=?").run(st, Date.now(), Number(id)).changes > 0
}
export const deleteNotice = (db, id) =>
  db.prepare("DELETE FROM notices WHERE id=?").run(Number(id)).changes > 0

/**
 * 列公告。
 *   客户端：`{ days: 180 }` —— 只给还在保留期内的、没撤下的。
 *   后台：  `{ all: true }` —— 连撤下的也要，好回看发过什么。
 * 【上限 200 条】半年内发到 200 条本身就不正常，但接口不能因此把整张表甩给客户端。
 */
export function listNotices(db, { days = 0, all = false, limit = 200 } = {}) {
  const where = [], args = []
  if (!all) where.push("status='active'")
  if (days > 0) { where.push("created_at >= ?"); args.push(Date.now() - Number(days) * 86400_000) }
  const w = where.length ? "WHERE " + where.join(" AND ") : ""
  return db.prepare(`SELECT ${NOTICE_COLS} FROM notices ${w} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args, Math.min(500, Math.max(1, Number(limit) || 200)))
}

/** 最新一条在架公告（老客户端只认这一条：它们还在用 /api/notice 与 profile.notice）。 */
export const latestNotice = (db) =>
  db.prepare(`SELECT ${NOTICE_COLS} FROM notices WHERE status='active' ORDER BY created_at DESC, id DESC LIMIT 1`).get() || null

const publicShape = (n) => n && ({
  id: n.id, text: n.text, level: n.level,
  minClientVersion: n.minClientVersion, downloadUrl: n.downloadUrl,
  createdAt: n.createdAt, updatedAt: n.updatedAt,
})

/**
 * 客户端要看到的那一条（没有在架公告就什么都不下发）。
 * 【不下发内部字段】客户端只需要"显示什么、要不要催升级、记哪个 id"。
 */
export const publicNotice = (db) => publicShape(latestNotice(db))

/** 客户端要看到的那一批（近 days 天、在架的）。 */
export const publicNotices = (db, days = NOTICE_KEEP_DAYS) =>
  listNotices(db, { days }).map(publicShape)

export const purgeNotices = (db, keepDays = NOTICE_KEEP_DAYS) =>
  db.prepare("DELETE FROM notices WHERE created_at < ?").run(Date.now() - Number(keepDays) * 86400_000).changes

/**
 * 把新公告的 id 起点抬到 `atLeast` 之上。
 *
 * 【为什么必须有这一步】老客户端（0.1.3 及更早）判"这条要不要弹"用的是
 * `localStorage 里记的已读 id >= notice.id`，而老设计的 id 是 meta 里一个自增计数（可能已经
 * 涨到 7、12…）。改成表之后 id 变成 rowid、从 1 起 —— 于是新发的公告 id=2 会被"已读到 7"的
 * 老客户端**静默吞掉**：管理员以为发出去了，老用户永远看不到。把序列抬过去就没这回事。
 * 新客户端按 id 记已读，同样受益（不会把老 id 当成"更新的"）。
 */
function bumpNoticeSeq(db, atLeast) {
  const n = Math.floor(Number(atLeast) || 0)
  if (n <= 0) return
  // AUTOINCREMENT 表的下一个 id = sqlite_sequence.seq + 1。表还没插过行时这一行不存在。
  const cur = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='notices'").get()
  if (!cur) db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES('notices', ?)").run(n)
  else if (Number(cur.seq) < n) db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='notices'").run(n)
}

/**
 * 把老库里 meta 那一条搬进表，只搬一次（搬完打个标记）。
 *
 * 不搬会怎样：升级当天，正挂着的那条公告（"今晚 10 点维护"）会**当场消失** —— 客户端拉到
 * 空列表，用户与管理员都以为公告功能坏了。只搬"发布中且有内容"的那条：停发的本就不该出现。
 *
 * 【不管搬不搬，都要把 id 序列抬到老 id 之上】见 bumpNoticeSeq —— 老客户端的"已读"游标记的
 * 是老 id，新公告的 id 低于它就会被老客户端静默吞掉。停发状态那条也算数：用户照样点过它。
 */
export function migrateLegacyNotice(db) {
  if (db.prepare("SELECT 1 FROM meta WHERE k='notice_migrated'").get()) return null
  db.prepare("INSERT INTO meta(k,v) VALUES('notice_migrated','1') ON CONFLICT(k) DO UPDATE SET v='1'").run()
  const row = db.prepare("SELECT v FROM meta WHERE k='notice'").get()
  if (!row) return null
  let old = null
  try { old = JSON.parse(row.v) } catch { return null }
  if (!old) return null
  bumpNoticeSeq(db, old.id)
  if (!old.enabled || (!old.text && !old.minClientVersion)) return null
  const now = Date.now()
  const r = db.prepare(`INSERT INTO notices(text, level, min_client_version, download_url, status, created_at, updated_at)
                        VALUES(?,?,?,?,'active',?,?)`).run(
    String(old.text || "").slice(0, 2000),
    NOTICE_LEVELS.includes(old.level) ? old.level : "info",
    String(old.minClientVersion || "").slice(0, 32),
    String(old.downloadUrl || "").slice(0, 500),
    // 【时间用老记录里的 updatedAt】否则升级当天所有老公告都变成"刚刚发布"，一进来全是未读
    Number(old.updatedAt) || now, Number(old.updatedAt) || now)
  return getNoticeById(db, r.lastInsertRowid)
}

// ==== 技能包 ==================================================================
// 元数据 CRUD。zip 文件本体由 sci-auth 落在 DATA_DIR/skill-packs/ 下，这里不碰文件系统。

export function addSkillPack(db, p) {
  if (db.prepare("SELECT 1 FROM skill_packs WHERE version=?").get(String(p.version)))
    return { ok: false, err: `版本 ${p.version} 已发布过 —— 同一版本号不许重发（客户端按版本号判断更新），请升版本号重新出包` }
  db.prepare(`INSERT INTO skill_packs(version,sha256,size,changelog,changed_skills,skills,commit_sha,status,created_at)
              VALUES(?,?,?,?,?,?,?,'active',?)`).run(
    String(p.version), String(p.sha256), Number(p.size),
    String(p.changelog || ""), String(p.changed_skills || ""), String(p.skills || ""),
    String(p.commit_sha || ""), Date.now())
  return { ok: true, pack: getSkillPack(db, p.version) }
}

// meta 便签（一行 JSON 值；公告/并发限额已各自手写同款，这俩给后来的键共用）
export function getMeta(db, key, fallback = null) {
  const row = db.prepare("SELECT v FROM meta WHERE k=?").get(String(key))
  if (!row) return fallback
  try { return JSON.parse(row.v) } catch { return fallback }
}
export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .run(String(key), JSON.stringify(value))
}

export const getSkillPack = (db, version) =>
  db.prepare("SELECT * FROM skill_packs WHERE version=?").get(String(version)) || null

export const listSkillPacks = (db) =>
  db.prepare("SELECT * FROM skill_packs ORDER BY created_at DESC").all()

export function setSkillPackStatus(db, version, status) {
  const st = status === "disabled" ? "disabled" : "active"
  const r = db.prepare("UPDATE skill_packs SET status=? WHERE version=?").run(st, String(version))
  return r.changes > 0
}

export const deleteSkillPack = (db, version) =>
  db.prepare("DELETE FROM skill_packs WHERE version=?").run(String(version)).changes > 0

// ==== 界面包 ==================================================================
// 与技能包同形状（元数据在库、zip 在 DATA_DIR/web-packs/ 下），但完全独立的一条线：
// 换的是前端静态资源，客户端刷新页面即生效，不重启任何进程。

export function addWebPack(db, p) {
  if (db.prepare("SELECT 1 FROM web_packs WHERE version=?").get(String(p.version)))
    return { ok: false, err: `版本 ${p.version} 已发布过 —— 同一版本号不许重发（客户端按版本号判断更新），请换个版本号` }
  db.prepare(`INSERT INTO web_packs(version,sha256,size,changelog,files,commit_sha,status,created_at)
              VALUES(?,?,?,?,?,?,'active',?)`).run(
    String(p.version), String(p.sha256), Number(p.size),
    String(p.changelog || ""), String(p.files || ""), String(p.commit_sha || ""), Date.now())
  return { ok: true, pack: getWebPack(db, p.version) }
}

export const getWebPack = (db, version) =>
  db.prepare("SELECT * FROM web_packs WHERE version=?").get(String(version)) || null

export const listWebPacks = (db) =>
  db.prepare("SELECT * FROM web_packs ORDER BY created_at DESC").all()

export function setWebPackStatus(db, version, status) {
  const st = status === "disabled" ? "disabled" : "active"
  return db.prepare("UPDATE web_packs SET status=? WHERE version=?").run(st, String(version)).changes > 0
}

export const deleteWebPack = (db, version) =>
  db.prepare("DELETE FROM web_packs WHERE version=?").run(String(version)).changes > 0

// ==== 用户反馈 ================================================================
// 附件本体在 DATA_DIR/feedback/<id>/ 下，这里只管元数据与对话文本。

export function addFeedback(db, f) {
  const r = db.prepare(`INSERT INTO feedback(user_id,username,session_id,title,vote,comment,transcript,msgs,files,meta,status,created_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,'new',?)`).run(
    Number(f.user_id) || 0, String(f.username || ""), String(f.session_id || "").slice(0, 128),
    String(f.title || "").slice(0, 200), Math.sign(Number(f.vote) || 0),
    String(f.comment || "").slice(0, 4000), String(f.transcript || ""),
    Number(f.msgs) || 0, String(f.files || "[]"), String(f.meta || "{}"), Date.now())
  return getFeedback(db, r.lastInsertRowid)
}

export const getFeedback = (db, id) =>
  db.prepare("SELECT * FROM feedback WHERE id=?").get(Number(id)) || null

/**
 * 列表。**不带 transcript**：那是每条几十上百 KB 的对话正文，列表页一次拉 50 条就是几 MB，
 * 而列表上只用得到标题与摘要。详情页才按 id 取整条。
 */
export function listFeedback(db, { limit = 50, offset = 0, status = "", vote = "", q = "" } = {}) {
  const where = [], args = []
  if (status === "new" || status === "done") { where.push("status=?"); args.push(status) }
  if (vote === "up") where.push("vote>0")
  else if (vote === "down") where.push("vote<0")
  if (q) {
    const like = "%" + String(q).replace(/[\\%_]/g, (c) => "\\" + c) + "%"
    where.push("(username LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR comment LIKE ? ESCAPE '\\')")
    args.push(like, like, like)
  }
  const w = where.length ? "WHERE " + where.join(" AND ") : ""
  const total = db.prepare(`SELECT COUNT(*) AS n FROM feedback ${w}`).get(...args).n
  const rows = db.prepare(`SELECT id,user_id,username,session_id,title,vote,comment,msgs,files,meta,status,created_at
                           FROM feedback ${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0))
  const counts = db.prepare(`SELECT
      COUNT(*) AS all_n,
      SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) AS new_n,
      SUM(CASE WHEN vote>0 THEN 1 ELSE 0 END) AS up_n,
      SUM(CASE WHEN vote<0 THEN 1 ELSE 0 END) AS down_n FROM feedback`).get()
  return { rows, total, counts }
}

export function setFeedbackStatus(db, id, status) {
  const st = status === "done" ? "done" : "new"
  return db.prepare("UPDATE feedback SET status=? WHERE id=?").run(st, Number(id)).changes > 0
}
export const deleteFeedback = (db, id) =>
  db.prepare("DELETE FROM feedback WHERE id=?").run(Number(id)).changes > 0

// ==== 并发限额 ================================================================
//
// 【为什么存库而不是只读 env】管理员要能在后台把"同时最多打几个上游请求"调大调小并**立刻
// 生效**（上游换套餐、白天人多晚上人少都会要改）。写在 env 里就得改文件 + 重启进程，而重启
// 会把所有在飞的长任务连根拔掉。所以：库是权威，env 只作为**首次启动的初值**。
//
// 与公告同理，一行 meta 就够，不值得为它建表。
export function getLimits(db, defaults = {}) {
  const row = db.prepare("SELECT v FROM meta WHERE k='llm_limits'").get()
  let saved = null
  if (row) { try { saved = JSON.parse(row.v) } catch { saved = null } }
  return { ...defaults, ...(saved || {}) }
}
export function setLimits(db, limits) {
  db.prepare("INSERT INTO meta(k,v) VALUES('llm_limits',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .run(JSON.stringify(limits))
  return limits
}

// ==== 审计 ====================================================================

/**
 * 写一条审计。**每个字段都截断**。
 *
 * 为什么：`login.fail` 的 actor 是【匿名请求体里的登录名】，长度不设限就等于给了未鉴权的
 * 人一个往库里写任意长文本的口子 —— 灌几百条 5000 字的行，管理员一打开审计页就卡死，
 * 库也白白涨。截断不影响可读性（真实登录名 ≤32 位），却把这个口子彻底焊上。
 */
const cut = (s, n) => { const t = String(s == null ? "" : s); return t.length > n ? t.slice(0, n) + "…" : t }
export function addAudit(db, { actor = "", event, target = "", detail = "", ip = "" }) {
  db.prepare("INSERT INTO audit(ts,actor,event,target,detail,ip) VALUES(?,?,?,?,?,?)")
    .run(Date.now(), cut(actor, 64), cut(event, 64), cut(target, 128), cut(detail, 512), cut(ip, 64))
}

/**
 * 审计查询。`login.ok` / `llm.quota_block` 这类高频事件会把"上周我把谁改成了 plus 档"
 * 冲出窗口，所以必须能按事件前缀 / 操作人 / 时间范围筛，并翻页。
 * 兼容老写法 listAudit(db, 300)。
 */
export function listAudit(db, opts = 200) {
  const o = typeof opts === "number" ? { limit: opts } : (opts || {})
  const limit = Math.min(2000, Math.max(1, Number(o.limit) || 200))
  const offset = Math.max(0, Number(o.offset) || 0)
  const where = [], args = []
  if (o.event) { where.push("event LIKE ? ESCAPE '\\'"); args.push(String(o.event).replace(/[\\%_]/g, (c) => "\\" + c) + "%") }
  if (o.actor) { where.push("actor LIKE ? ESCAPE '\\'"); args.push("%" + String(o.actor).replace(/[\\%_]/g, (c) => "\\" + c) + "%") }
  if (o.since) { where.push("ts >= ?"); args.push(Number(o.since)) }
  if (o.until) { where.push("ts <= ?"); args.push(Number(o.until)) }
  const w = where.length ? "WHERE " + where.join(" AND ") : ""
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit ${w}`).get(...args).n
  const rows = db.prepare(`SELECT * FROM audit ${w} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset)
  return typeof opts === "number" ? rows : { rows, total }
}

/** 审计保留策略：只写不删的表迟早会把库撑大，且老行对运维毫无价值。 */
export const purgeAudit = (db, keepDays = 180) =>
  db.prepare("DELETE FROM audit WHERE ts < ?").run(Date.now() - Number(keepDays) * 86400_000).changes

/** 事件类型清单（后台筛选下拉用） */
export const auditEvents = (db) =>
  db.prepare("SELECT event, COUNT(*) AS n FROM audit GROUP BY event ORDER BY event").all()
