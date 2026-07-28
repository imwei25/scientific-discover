#!/usr/bin/env node
// 打印当前代码支持的库 schema 版本。
// 单独一个文件而不是在 shell 里内联 `node -e "import(...)"`：绝对路径的动态 import
// 在不同平台上要不要 file:// 前缀不一样，内联写法很容易悄悄失败成 "unknown"。
import { SCHEMA_VERSION } from "../server/lib/db.mjs"
console.log(SCHEMA_VERSION)
