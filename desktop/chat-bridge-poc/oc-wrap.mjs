#!/usr/bin/env node
// opencode 包装器：给 cc-connect 用，过滤 `opencode run --format json` 的事件流，
// 掐掉 reasoning（思考过程）与 tool（工具调用进度）事件——cc-connect 会把这两类
// 无条件推送到聊天平台（微信/企微），既泄露思考过程又刷爆平台限速。
// 其余子命令（session list / models / session delete…）原样透传。
//
// cc-connect 的 cmd 按空格拆分，所以 config.toml 里写：
//   cmd = 'C:\nvm4w\nodejs\node.exe C:\Users\tj\.cc-connect\oc-wrap.mjs'
// 本文件路径与 node.exe 路径都不能含空格。

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const REAL_OC = "C:\\Users\\tj\\.cc-connect\\oc-bin\\opencode.exe"; // 无空格 junction → 打包版内置 opencode
const args = process.argv.slice(2);

// 非 run 子命令：完全透传（cc-connect 还会调 session list/delete、models 等）
if (args[0] !== "run") {
  const child = spawn(REAL_OC, args, { stdio: "inherit" });
  child.on("exit", (code, sig) => process.exit(sig ? 1 : (code ?? 1)));
  child.on("error", (e) => { console.error(e.message); process.exit(1); });
} else {
  const child = spawn(REAL_OC, args, { stdio: ["inherit", "pipe", "inherit"] });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const DROP = new Set(["reasoning", "tool", "tool_use", "tool_result"]);
  rl.on("line", (line) => {
    const t = line.trim();
    if (t.startsWith("{")) {
      try {
        const evt = JSON.parse(t);
        const type = evt?.type ?? evt?.part?.type;
        if (DROP.has(type)) return; // 思考过程与工具进度：不给 cc-connect 看见
      } catch { /* 非 JSON 行原样放行 */ }
    }
    process.stdout.write(line + "\n");
  });
  child.on("exit", (code, sig) => process.exit(sig ? 1 : (code ?? 1)));
  child.on("error", (e) => { console.error(e.message); process.exit(1); });
}
