#!/usr/bin/env bash
set -e
cd /app

if [ -z "$DEEPSEEK_API_KEY" ]; then
  echo "!! 未设置 DEEPSEEK_API_KEY，模型将无法调用。请在 docker/compose 里传入。" >&2
fi

# 1) 后台启动 OpenCode 服务
opencode serve --port 4098 --hostname 127.0.0.1 &

# 2) 等它就绪（最多 30 秒）
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:4098/doc >/dev/null 2>&1; then
    echo "opencode ready"; break
  fi
  sleep 1
done

# 3) 前台启动网关（保持容器存活）
exec node /app/web/server.mjs
