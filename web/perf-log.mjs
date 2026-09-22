// 分阶段耗时日志（默认关闭，SCI_PERF=1 打开）。
//
// 为什么要有它：用户端只看得见"一轮很久"，看不见这一轮里【哪一段】久 —— 是 PDF 抽取慢、
// 是上游首字节慢、还是模型把 3 万字正文反复读进上下文。三者的优化方向完全不同，靠猜必错。
// 于是在两个能看见真相的地方各记一笔：
//   · cloudForward（本机 → 云端网关的每一次 LLM 调用）：请求体多大、发出到响应头多久、
//     首字节多久、整条流多久、回了多少字节、上游报的 usage 是多少。
//   · startJob（界面上的"一轮"）：发出 prompt → 首个模型事件 → 每个工具调用各花多久 → 收尾。
// 两份日志用同一个 sid 串起来，一轮里几次 LLM 往返、每次夹着哪个工具，一眼可见。
//
// 落盘：<应用>/perf.jsonl（一行一条 JSON，便于事后聚合）；同时打一行人话到控制台。
// 关掉时 perfLog 是个空函数，除了一次 if 判断之外没有任何开销 —— 可以长期留在代码里。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const PERF_ON = process.env.SCI_PERF === "1"
const FILE = process.env.SCI_PERF_FILE || path.join(__dirname, "..", "perf.jsonl")

const t0 = Date.now()
/** 进程内相对毫秒：几条日志之间比先后用它，比绝对时间好读 */
export const perfNow = () => Date.now() - t0

export function perfLog(kind, data = {}) {
  if (!PERF_ON) return
  const rec = { t: new Date().toISOString(), rel: perfNow(), kind, ...data }
  try { fs.appendFileSync(FILE, JSON.stringify(rec) + "\n") } catch { /* 日志写不进去绝不能影响主流程 */ }
  console.log(`[perf] ${kind} ${JSON.stringify(data)}`)
}

/** 计时器：const done = perfTimer(); ... done() → 毫秒 */
export const perfTimer = () => { const s = Date.now(); return () => Date.now() - s }
