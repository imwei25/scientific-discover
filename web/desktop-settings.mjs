// 桌面版的两个本机开关：开机自启动 / 关闭时完全退出。
//
// 【为什么这两件事归网关管，而不归外壳（Rust）管】设置界面在网页里，网页只能跟网关说话；
// 让它去驱动外壳还得再造一条 IPC。而这两个开关的落点（注册表、一个 json 文件）node 都够得着，
// 所以整件事就在这一侧闭环，外壳只在点 X 时读一下那个 json（见 main.rs 的 exit_on_close）。
//
// 【为什么自启动读的是注册表而不是这个 json】用户可以在任务管理器的「启动」页里把它禁掉，
// 也可以用别的工具删掉那个键——那时 json 还写着 true，界面就会显示一个与事实不符的勾。
// 所以 json 只存 exitOnClose（没有别处能改它），autostart 一律现查注册表。

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const pexecFile = promisify(execFile)

// 注册表 Run 键：HKCU 而不是 HKLM —— 后者要管理员权限，而这个应用是 per-user 安装
// （tauri.conf.json 的 installMode: currentUser），本来就没有管理员上下文。
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
const RUN_NAME = "NiumaScience"

const exePath = () => process.env.DESKTOP_EXE || ""

/** 只有跑在桌面外壳里才谈得上这两个开关（外壳会传 DESKTOP_EXE 进来）。 */
export const supported = () => !!exePath() && process.platform === "win32"

// 和外壳 main.rs 的 exit_on_close 读的必须是同一个文件：<安装目录>\bundle\app\web\desktop-settings.json
// 用 fileURLToPath 而不是手工剥 URL 的斜杠——后者在 Windows 上会得到 "/C:/..." 这种走不通的路径。
const WEB_DIR = path.dirname(fileURLToPath(import.meta.url))
const settingsPath = () => path.join(WEB_DIR, "desktop-settings.json")

const readSettings = () => {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) || {}
  } catch {
    return {}
  }
}

const writeSettings = (o) => {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(o, null, 2))
    return true
  } catch {
    return false
  }
}

/**
 * 查注册表里当前登记的自启动路径。
 * 返回 null = 没登记；返回字符串 = 登记的那个路径（可能指向旧安装位置，见 status 的处理）。
 */
async function queryAutostart() {
  try {
    const { stdout } = await pexecFile("reg", ["query", RUN_KEY, "/v", RUN_NAME], {
      windowsHide: true,
    })
    // 输出形如：    NiumaScience    REG_SZ    "C:\...\sciagent-desktop.exe"
    const m = stdout.match(/REG_SZ\s+(.+?)\s*$/m)
    return m ? m[1].trim().replace(/^"|"$/g, "") : null
  } catch {
    return null // reg query 找不到值时退出码非 0，等价于"没登记"
  }
}

export async function status() {
  if (!supported()) return { ok: true, available: false }
  const registered = await queryAutostart()
  const s = readSettings()
  return {
    ok: true,
    available: true,
    // 【必须比对路径】用户升级过、或换过安装目录时，键还在但指向的是旧 exe ——
    // 那种情况下开机拉起来的是个不存在的程序，等于没开。显示成"没开"并让用户重勾一次，
    // 比显示"已开"却其实不生效要诚实。
    autostart: !!registered && path.normalize(registered).toLowerCase() === path.normalize(exePath()).toLowerCase(),
    autostartStale: !!registered && path.normalize(registered).toLowerCase() !== path.normalize(exePath()).toLowerCase(),
    exitOnClose: s.exitOnClose === true,
  }
}

export async function setConfig(body) {
  if (!supported()) return { ok: false, err: "这两个开关只在 Windows 桌面版里有意义" }

  if (typeof body.autostart === "boolean") {
    try {
      if (body.autostart) {
        // /f 覆盖已有值：升级换了安装目录时，这一步顺带把旧路径修正过来
        await pexecFile("reg", ["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ", "/d", exePath(), "/f"], { windowsHide: true })
      } else {
        await pexecFile("reg", ["delete", RUN_KEY, "/v", RUN_NAME, "/f"], { windowsHide: true })
      }
    } catch (e) {
      // 删一个本来就不存在的值也会非 0；那种情况下目标状态已经达成，不算失败
      const already = !body.autostart && !(await queryAutostart())
      if (!already) return { ok: false, err: `写注册表失败：${e?.message || e}` }
    }
  }

  if (typeof body.exitOnClose === "boolean") {
    const s = readSettings()
    s.exitOnClose = body.exitOnClose
    if (!writeSettings(s)) return { ok: false, err: "设置文件写入失败（安装目录只读？）" }
  }

  return { ...(await status()) }
}
