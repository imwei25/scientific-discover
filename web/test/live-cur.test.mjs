// 「正在做哪一步」的实时推断 —— 用例全部来自 2026-08-21 综述模块打包版的两轮真实跑批。
//
// 这个推断错过两次，两次的表现都是【条子说的和实际在做的不是一回事】，比不显示更糟：
//   ① 首轮：cur 恒 null（st.cur 只在提交步骤表单时才写，综述模块只有首屏一张表单）
//      → 开跑头 6 分钟一个格子都不亮，用户无从判断是在检索还是卡死。
//   ② 复测：改成按技能名推断之后，头 20 分钟一直指着「综述成文」，实际在检索 ——
//      检索跑的是 literature-review/search.py，而 literature-review 这个名字在模块里
//      绑的是后面那格。同一轮里核查阶段又全 null：模型直接跑 verify_refs.py，
//      从头到尾没加载过 reference-check 技能。
import test from "node:test"
import assert from "node:assert/strict"
import { skillFromTool, stepForSkill, skillInModule } from "../wf-state.mjs"

test("技能名：加载技能时照常认", () => {
  assert.equal(skillFromTool("skill", { name: "literature-review" }), "literature-review")
})

test("技能名：bash 直呼技能脚本也要认（复测里核查全程走的就是这条）", () => {
  const cmd = `"/app/.venv/bin/python" "/app/.opencode/skills/reference-check/verify_refs.py" --input refs.txt --manuscript review.md`
  assert.equal(skillFromTool("bash", { command: cmd }), "reference-check")
})

test("技能名：Windows 反斜杠路径同样认", () => {
  const cmd = String.raw`python "C:\Users\tj\AppData\Local\Niuma Science\bundle\app\.opencode\skills\render-docx\scripts\render_docx.sh"`
  assert.equal(skillFromTool("bash", { command: cmd }), "render-docx")
})

test("技能名：与技能无关的 bash 不认（别把随手一条命令算成某一步）", () => {
  assert.equal(skillFromTool("bash", { command: "ls -la outputs" }), null)
  assert.equal(skillFromTool("read", { filePath: "review.md" }), null)
})

test("同一技能对应多格时取【最早未完成】的那一格", () => {
  // 综述模块：search 步 skill=search-lit，write 步 skill=literature-review。
  // 检索用 literature-review/search.py 跑 → 检索还没做完时，它就是「文献检索」这一步。
  assert.equal(stepForSkill("review", "literature-review", []), "search")
  // search 一绿，同一个技能名自动前移到「综述成文」
  assert.equal(stepForSkill("review", "literature-review", ["search"]), "write")
  // 两格都完成 → 不再指任何一格（已完成的不该挂"当前步"光环）
  assert.equal(stepForSkill("review", "literature-review", ["search", "write"]), null)
})

test("引用核查：直呼脚本推出来的技能名能落到 refcheck 那一格", () => {
  assert.equal(stepForSkill("review", "reference-check", ["search", "write"]), "refcheck")
})

test("排版出件的别名（render-docx）也要认得出", () => {
  const done = ["search", "write", "refcheck", "humanize"]
  assert.equal(stepForSkill("review", "render-docx", done), "render")
  assert.equal(stepForSkill("review", "render-pdf-doc", done), "render")
})

test("不属于本模块的技能不进推断，也推不出步骤", () => {
  assert.equal(skillInModule("review", "clinical-stats"), false)
  assert.equal(stepForSkill("review", "clinical-stats", []), null)
  assert.equal(skillInModule("review", "literature-review"), true)
})

test("自由对话 / 空值一律不推断", () => {
  assert.equal(skillInModule("chat", "literature-review"), false)
  assert.equal(stepForSkill("chat", "literature-review", []), null)
  assert.equal(stepForSkill("review", "", []), null)
  assert.equal(stepForSkill(undefined, "literature-review", []), null)
})
