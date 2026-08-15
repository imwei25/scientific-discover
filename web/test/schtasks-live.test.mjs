// 真注册一条 Windows 计划任务，等它到点自己把运行器拉起来，再看退出码。
//
// 【为什么必须有这么一条"真跑"的测试】XML 生成的单测只能证明字符串长得对；而这条链路上
// 会失败的全是环境性的东西：schtasks 认不认这份 XML（编码/字段顺序/版本）、任务计划到点
// 会不会真去启动我们给的 node、带空格的路径有没有被拆开、以什么身份跑。这些全都只在真机上现形。
//
// 【怎么做到不花一分钱】故意指向一个【不存在的任务 id】：运行器会在读定义那一步就退出（码 2），
// 根本走不到发消息。而"Last Result = 2"恰恰证明了我们要证明的全部——Windows 到点确实按我们
// 给的命令行启动了运行器，并且它跑到了自己的逻辑里。
//
// 默认跳过（要等一分多钟）。手动跑：
//   SCI_LIVE_SCHTASKS=1 node --test web/test/schtasks-live.test.mjs
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const WEB = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
process.env.SCI_TASKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "schtasks-live-"))
process.env.SCI_TASK_FOLDER = "NiumaScienceTest"   // 别和用户/开发机上真实的任务混在一起
const T = await import("../tasks.mjs")
const S = await import("../schtasks.mjs")

const skip = process.platform !== "win32" ? "非 Windows"
  : process.env.SCI_LIVE_SCHTASKS !== "1" ? "默认跳过（要等约 2 分钟）：SCI_LIVE_SCHTASKS=1 才跑"
    : false

/** 用 PowerShell 读任务状态：schtasks 在中文系统上输出 GBK，字段名会乱码，没法稳定解析。 */
function taskInfo(name) {
  const ps = `$ErrorActionPreference='Stop'; $i = Get-ScheduledTaskInfo -TaskName '${name}'; ` +
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ` +
    `@{ last = $i.LastTaskResult; runs = $i.NumberOfMissedRuns; at = "$($i.LastRunTime)" } | ConvertTo-Json -Compress`
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }).toString("utf8")
  return JSON.parse(out)
}

test("真机：计划任务到点自己拉起运行器", { skip }, async () => {
  // 90 秒后触发。给足余量：任务计划的秒级精度与本机时钟对齐都有几秒抖动。
  const at = new Date(Date.now() + 90_000)
  const p = (n) => String(n).padStart(2, "0")
  const t = T.normalizeTask({
    title: "真机验证（指向不存在的任务，必然退 2）",
    prompt: "不会被用到",
    schedule: { kind: "once", date: `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`, time: `${p(at.getHours())}:${p(at.getMinutes())}` },
  }).task
  // ★ 故意不把定义写盘：运行器读不到就在花钱之前退出（码 2）
  const name = S.taskName(t.id)

  const r = await S.register(t)
  assert.equal(r.ok, true, `注册应成功：${r.err}`)
  try {
    assert.ok((await S.listRegistered()).includes(name), "注册完应能在自己的文件夹下列出来")

    // 等它跑。267011 = 任务从未运行过（Task Scheduler 的常量）
    const deadline = Date.now() + 240_000
    let info = null
    for (;;) {
      info = taskInfo(name)
      if (info.last !== 267011 && info.last !== 267009) break   // 267009 = 正在运行
      if (Date.now() > deadline) throw new Error(`等了 4 分钟任务还没跑（LastTaskResult=${info.last}）`)
      await new Promise((x) => setTimeout(x, 5000))
    }
    assert.equal(info.last, 2, `运行器应以"找不到任务"退出（码 2），实际 ${info.last}——` +
      "非 0 非 2 说明 Windows 启动它的方式有问题（路径被空格拆开 / node 找不到 / 权限）")
  } finally {
    const u = await S.unregister(t.id)
    assert.equal(u.ok, true, `撤销应成功：${u.err}`)
    assert.ok(!(await S.listRegistered()).includes(name), "撤销后不该再列出来")
  }
})
