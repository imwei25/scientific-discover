// 死循环护栏（WF.loopGuardStep）的回归测试。
//
// 【为什么必须有】这个闸出过两次事，第二次是把用户正常的 `pip install` 掐死：
// opencode 的 bash 工具每吐一段输出就发一个 message.part.updated（status 恒为 running、
// command 一字不差、callID 也不变），旧写法按【事件】累加，于是一次没有任何重试的调用被判成
// "重复 8 次"。真机 opencode.db 里那次调用的事件序列（seq 54→63）就是本文件第一个用例。
import test from "node:test"
import assert from "node:assert/strict"
import { loopGuardStep, LOOP_REPEAT_LIMIT } from "../workflows.mjs"

const PIP = "C:\\Users\\tj\\AppData\\Local\\SciAgent\\bundle\\app\\.venv\\Scripts\\python.exe -m pip install icecream"

/** 造一个 bash tool part 事件 */
const part = (callID, status, { cmd = PIP, output = null } = {}) => ({
  type: "tool", tool: "bash", callID,
  state: { status, input: { command: cmd }, ...(output === null ? {} : { metadata: { output } }) },
})

test("同一次调用流式吐 8 段输出，不算卡死（真机 pip install 的事件序列）", () => {
  const st = {}
  // seq 54：pending（还没有 input）
  assert.equal(loopGuardStep(st, { type: "tool", tool: "bash", callID: "call_1", state: { status: "pending" } }), false)
  // seq 55-62：8 个 running，输出逐步增长 —— 这是【一次】调用，闸绝不能开火
  for (const len of [0, 0, 21, 87, 240, 284, 351, 396]) {
    assert.equal(loopGuardStep(st, part("call_1", "running", { output: "x".repeat(len) })), false)
  }
  assert.equal(st.repeat, 1, "8 个 running 事件只能算 1 次调用")
  // seq 63：结束
  assert.equal(loopGuardStep(st, part("call_1", "error", { output: "x".repeat(396) })), false)
})

test("同一条命令被真的重新调用 8 次 → 判定卡死", () => {
  const st = {}
  for (let i = 1; i < LOOP_REPEAT_LIMIT; i++) {
    assert.equal(loopGuardStep(st, part(`call_${i}`, "running")), false, `第 ${i} 次不该开火`)
  }
  assert.equal(loopGuardStep(st, part(`call_${LOOP_REPEAT_LIMIT}`, "running")), true)
  assert.equal(st.hit, PIP.slice(0, 120))
})

test("命令换了就重新计数（正常重试：改参数、换写法）", () => {
  const st = {}
  for (let i = 1; i <= 20; i++) {
    // 每次都改一点（加 -i 镜像、换包名…），永远不该被判卡死
    assert.equal(loopGuardStep(st, part(`call_${i}`, "running", { cmd: `${PIP} -i mirror-${i}` })), false)
  }
  assert.equal(st.repeat, 1)
})

test("闸触发时留下被中止那次调用的真实输出（模型拿不到，得靠网关转交）", () => {
  const st = {}
  for (let i = 1; i < LOOP_REPEAT_LIMIT; i++) loopGuardStep(st, part(`call_${i}`, "running"))
  loopGuardStep(st, part(`call_${LOOP_REPEAT_LIMIT}`, "running"))
  // 中止时 opencode 把已收到的输出塞进 metadata.output（state.output 是 null）
  loopGuardStep(st, part(`call_${LOOP_REPEAT_LIMIT}`, "error", { output: "Collecting icecream\nERROR: 真实报错" }))
  assert.match(st.out, /真实报错/)
})

test("新调用开始时清掉上一次的输出，不串台", () => {
  const st = {}
  loopGuardStep(st, part("call_a", "running"))
  loopGuardStep(st, part("call_a", "running", { output: "上一次的输出" }))
  assert.equal(st.out, "上一次的输出")
  loopGuardStep(st, part("call_b", "running"))
  assert.equal(st.out, "")
})

test("非 bash 工具一律不参与计数", () => {
  const st = {}
  for (let i = 0; i < 50; i++) {
    assert.equal(loopGuardStep(st, { type: "tool", tool: "skill", callID: `c${i}`, state: { status: "running", input: { name: "write-paper" } } }), false)
  }
  assert.equal(st.repeat, undefined)
})

test("命中后不再重复开火（abort 只发一次）", () => {
  const st = {}
  for (let i = 1; i <= LOOP_REPEAT_LIMIT; i++) loopGuardStep(st, part(`call_${i}`, "running"))
  assert.ok(st.hit)
  assert.equal(loopGuardStep(st, part("call_99", "running")), false)
})
