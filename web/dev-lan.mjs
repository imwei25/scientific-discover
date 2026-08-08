// 局域网联测入口：起一套【专用】网关，让同一网段的人帮着一起测。
//
// 为什么不直接 `node web/server.mjs`：这个检出经常有好几个会话各跑各的网关，而 server.mjs
// 启动时会做两件抢占性的事 —— killPort(PORT) 抢自己的网关端口、killPort(OC_PORT) 把本机
// opencode 杀掉重起。默认 OC 端口是 4098，那上面通常正跑着别人的实例，直接起就等于把别人
// 的会话掐了。所以这里把两个端口都挪开：
//   · 网关 3010（launch.json 里 autoPort，被占了会自己换）
//   · opencode 4099（专属，谁也不碰）
//
// ⚠️ opencode.json 的 provider.baseURL 由【最后启动的那个网关】改写成自己的端口，而 opencode
//    只在启动时读一次配置。所以两套并存的前提是各自"先改写、再起自己的 opencode"——本文件正是
//    这个顺序（server.mjs 内部保证）。对方那套要恢复，重启他那一个网关即可。
//
// 登录：局域网访问必须登录（本机 localhost 免登录）。不给 LAN_PASSWORD 就每次随机生成一个并
// 打印出来 —— 联测环境是临时的，把口令写死在仓库文件里没有任何理由。
import crypto from "node:crypto"

process.env.PORT = process.env.PORT || "3010"
process.env.OC_URL = process.env.OC_URL || "http://127.0.0.1:4099"
process.env.MANAGE_OC = "1"
process.env.LAN_USER = process.env.LAN_USER || "tellgen"
if (!process.env.LAN_PASSWORD) {
  process.env.LAN_PASSWORD = "sci-" + crypto.randomBytes(3).toString("hex")
  // server.mjs 那行只打掩码（它的日志会长期留在服务器上），本机联测得有人看得到明文，
  // 否则没人能登录。要固定口令就自己传 LAN_PASSWORD。
  console.log(`[lan] 本次登录口令：${process.env.LAN_USER} / ${process.env.LAN_PASSWORD}（每次启动都换）`)
}
await import("./server.mjs")
