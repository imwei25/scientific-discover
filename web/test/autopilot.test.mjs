// 无人值守（autopilot）续跑决策的单元测试：哨兵识别 / 剥离、轮数上限、停滞检测。
// 端到端链路（真 opencode + 脚本化 mock 模型）见 autopilot-e2e.test.mjs。
//
// server.mjs 是"导入即启动"的模块，所以按 skill-gate.test.mjs 的同款套路：
// env 全部指向临时目录、OC 指向死端口（决策函数不碰 opencode），导入后测导出的纯函数。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-"))
const over = {
  MANAGE_OC: "0", PORT: "0",
  OC_URL: "http://127.0.0.1:1",
  HOME: dir, USERPROFILE: dir,
  SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
  MODEL_CFG_PATH: path.join(dir, "model-config.json"),
  OC_CONFIG_PATH: path.join(dir, "opencode.json"),
  CLOUD_STATE_PATH: path.join(dir, "no-cloud-state.json"),
  CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
  SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
  ALLOWED_SKILLS: "", ALLOWED_MODULES: "", SUGGEST_ENABLED: "0",
  OC_AUTO_MAX_ROUNDS: "3",   // 上限测试要小值才测得动
}
const saved = {}
for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
let mod
try { mod = await import("../server.mjs?autopilot-unit") } finally {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
}
const { autoHasSentinel, autoStripSentinel, autoVerdict } = mod
test.after(() => new Promise((r) => (mod.server ? mod.server.close(r) : r())))

test("哨兵识别：只认结尾的 [FINAL]", () => {
  assert.equal(autoHasSentinel("全部完成。\n[FINAL]"), true)
  assert.equal(autoHasSentinel("[FINAL]"), true, "只有哨兵也算（正文可能全在上一段 part）")
  assert.equal(autoHasSentinel("全部完成。\n[FINAL]\n\n  "), true, "尾随空白不影响")
  assert.equal(autoHasSentinel("规则是最后输出 [FINAL]，我还没做完"), false, "正文中途提到不算")
  assert.equal(autoHasSentinel("done [FINAL] 后面还有话"), false)
  assert.equal(autoHasSentinel(""), false)
  assert.equal(autoHasSentinel(null), false)
})

test("哨兵剥离：去掉结尾标记与其前的换行，正文中途的保留", () => {
  assert.equal(autoStripSentinel("全部完成。\n[FINAL]"), "全部完成。")
  assert.equal(autoStripSentinel("全部完成。[FINAL]"), "全部完成。")
  assert.equal(autoStripSentinel("全部完成。\n  [FINAL]  \n"), "全部完成。")
  assert.equal(autoStripSentinel("提到 [FINAL] 的规则，继续干活"), "提到 [FINAL] 的规则，继续干活")
  assert.equal(autoStripSentinel("没有标记"), "没有标记")
})

test("verdict：见哨兵 → 停（final）；没哨兵 → 续跑", () => {
  const st = { rounds: 0, lastText: "" }
  assert.deepEqual(autoVerdict("干完了。\n[FINAL]", st), { go: false, why: "final" })
  assert.deepEqual(autoVerdict("方向有两个：1) A（推荐） 2) B。直接回 1 或 2。", st), { go: true, why: "continue" })
  assert.deepEqual(autoVerdict("继续写第二章……", st), { go: true, why: "continue" })
})

test("verdict：空文本不续跑（多半是上游异常，别烧钱）", () => {
  assert.deepEqual(autoVerdict("", { rounds: 0 }), { go: false, why: "empty" })
  assert.deepEqual(autoVerdict("   \n ", { rounds: 0 }), { go: false, why: "empty" })
})

test("verdict：达到轮数上限 → 停（cap）", () => {
  assert.equal(autoVerdict("还没完", { rounds: 2, lastText: "" }).go, true, "上限 3，第 2 轮后还能续")
  assert.deepEqual(autoVerdict("还没完", { rounds: 3, lastText: "" }), { go: false, why: "cap" })
})

test("verdict：连续两轮归一化后相同 → 停（stalled）；空白差异不影响判定", () => {
  const norm = "我已经把能做的都做完了。"
  const st = { rounds: 1, lastText: norm }
  assert.deepEqual(autoVerdict("我已经把能做的\n都做完了。", st), { go: true, why: "continue" }, "内容不同（换行改变了字序列之外的空白但字不同则续）——此句与 lastText 不同")
  assert.deepEqual(autoVerdict("我已经把能做的都做完了。", st), { go: false, why: "stalled" })
  assert.deepEqual(autoVerdict("  我已经把能做的都做完了。  \n", st), { go: false, why: "stalled" }, "首尾空白与换行归一化后仍算相同")
  assert.equal(autoVerdict("这次真的不一样了", st).go, true)
})
