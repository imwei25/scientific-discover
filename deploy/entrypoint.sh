#!/usr/bin/env bash
set -e
cd /app
[ -z "$DEEPSEEK_API_KEY" ] && echo "!! 未设置 DEEPSEEK_API_KEY，模型无法调用" >&2
exec node /app/web/server.mjs
