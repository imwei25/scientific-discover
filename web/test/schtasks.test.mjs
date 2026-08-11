// 计划任务 XML 生成的单测（不碰 schtasks.exe；真注册那一步在 schtasks-live.test.mjs）。
//
// 这份 XML 一旦有一处不合规，schtasks 只会回一句"任务 XML 包含的值格式设置不正确"，
// 指不到具体哪里 —— 所以关键字段逐个钉死在测试里。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.SCI_TASKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "schtasks-unit-"))
// 用独立的任务文件夹名：万一某条断言把真的 schtasks 调起来，也碰不到用户真实的定时任务
process.env.SCI_TASK_FOLDER = "NiumaScienceTest"
const T = await import("../tasks.mjs")
const S = await import("../schtasks.mjs")

const spec = { nodeExe: "C:\\app\\runtime\\node\\node.exe", script: "C:\\app\\web\\headless-run.mjs", workDir: "C:\\app" }
const mk = (over) => T.normalizeTask({ title: "每周扫描", prompt: "x", ...over }).task
const now = new Date(2026, 7, 11, 9, 0)   // 2026-08-11 周二 09:00 本地

test("每天：ScheduleByDay + 起算点落在下一次触发的那一刻", () => {
  const xml = S.buildXml(mk({ schedule: { kind: "daily", time: "07:00" } }), { now, spec })
  assert.match(xml, /<ScheduleByDay>\s*<DaysInterval>1<\/DaysInterval>/)
  // 09:00 已过 07:00 → 起算点是明天 8/12 07:00，且【不带 Z】（带 Z 会被当成 UTC，差 8 小时）
  assert.match(xml, /<StartBoundary>2026-08-12T07:00:00<\/StartBoundary>/)
  assert.ok(!/StartBoundary>[^<]*Z</.test(xml), "时间不能带时区后缀")
})

test("每周：选中的星期几逐个列出来", () => {
  const xml = S.buildXml(mk({ schedule: { kind: "weekly", time: "08:30", days: [1, 4] } }), { now, spec })
  assert.match(xml, /<ScheduleByWeek>/)
  assert.match(xml, /<Monday \/>/)
  assert.match(xml, /<Thursday \/>/)
  assert.ok(!/<Sunday \/>/.test(xml))
})

test("一次性：TimeTrigger，且跑完自动过期删除", () => {
  const xml = S.buildXml(mk({ schedule: { kind: "once", time: "09:00", date: "2026-08-20" } }), { now, spec })
  assert.match(xml, /<TimeTrigger>/)
  assert.match(xml, /<StartBoundary>2026-08-20T09:00:00<\/StartBoundary>/)
  assert.match(xml, /DeleteExpiredTaskAfter/)
  // 真机踩坑：写了 DeleteExpiredTaskAfter 就必须给 EndBoundary，否则 schtasks 直接拒收
  //（报「缺少个所需元素或属性。(46,4):EndBoundary:」）。留 7 天补跑窗口。
  assert.match(xml, /<EndBoundary>2026-08-27T09:00:00<\/EndBoundary>/)
})

test("两个关键开关必须在：关机过夜后补跑 + 允许唤醒", () => {
  const xml = S.buildXml(mk({ schedule: { kind: "daily", time: "07:00" } }), { now, spec })
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/, "没有它，关机过夜=这天的任务直接消失")
  assert.match(xml, /<WakeToRun>true<\/WakeToRun>/)
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/, "上一次还在跑就别再起一个")
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/, "笔记本用电池时也要跑")
})

test("动作指向快照里的 node 与运行器，参数带任务 id", () => {
  const t = mk({ schedule: { kind: "daily", time: "07:00" } })
  const xml = S.buildXml(t, { now, spec })
  assert.match(xml, /<Command>C:\\app\\runtime\\node\\node\.exe<\/Command>/)
  assert.match(xml, new RegExp(`--task ${t.id}<`))
  // 脚本路径必须带引号：安装目录叫「Niuma Science」，带空格，不加引号会被拆成两个参数。
  // （XML 文本节点里的双引号本就合法，不用转义成 &quot;）
  assert.match(xml, /<Arguments>"C:\\app\\web\\headless-run\.mjs" --task/)
})

test("停用的任务照样注册，但 XML 里 Enabled=false（软件里和任务计划里看到的是同一份清单）", () => {
  const xml = S.buildXml(mk({ schedule: { kind: "daily", time: "07:00" }, enabled: false }), { now, spec })
  assert.match(xml, /<Enabled>false<\/Enabled>/)
})

test("标题里的尖括号引号要转义，别把 XML 撑坏", () => {
  const xml = S.buildXml(mk({ title: 'a<b>&"c"', schedule: { kind: "daily", time: "07:00" } }), { now, spec })
  assert.match(xml, /a&lt;b&gt;&amp;&quot;c&quot;/)
})

test("任务名统一挂在自己的文件夹下（卸载时能整个删掉）", () => {
  assert.equal(S.taskName("t123"), "\\NiumaScienceTest\\t123")
})

// 【这条是真机 bug 的回归】撤销一个系统里【本来就没有】的任务必须算成功。
// 第一版的幂等判据是匹配 schtasks 的报错文案（/找不到|does not exist/），而中文 Windows 上
// 那段输出是 GBK 字节，正则永远匹配不上 → 删除接口返回失败 → 按设计"撤销失败就不删定义" →
// 用户面对一条既不会跑、也删不掉的僵尸任务。现在改成比对任务名清单，与编码和系统语言无关。
test("撤销一个不存在的任务算成功（否则计划任务被手删过的任务就永远删不掉）",
  { skip: process.platform !== "win32" ? "非 Windows" : false }, () => {
    const r = S.unregister("nosuchtask_" + Math.floor(Math.random() * 1e6))
    assert.equal(r.ok, true, `应幂等成功，实际：${r.err}`)
  })
