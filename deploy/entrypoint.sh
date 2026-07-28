#!/usr/bin/env bash
set -e
cd /app
# 多用户部署不再把上游 key 注入容器（走宿主 manager 的 /llm 转发，凭据是 OC_GATEWAY_KEY）；
# 两者都缺才是真没法调模型。
[ -z "$DEEPSEEK_API_KEY" ] && [ -z "$OC_GATEWAY_URL" ] && echo "!! DEEPSEEK_API_KEY 与 OC_GATEWAY_URL 都未设置，模型无法调用" >&2
exec node /app/web/server.mjs
