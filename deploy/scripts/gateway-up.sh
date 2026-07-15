#!/usr/bin/env bash
# 起 LLM 网关(one-api)：OpenAI 兼容的多渠道模型代理。所有用户容器的 OpenCode 都指向它，
# 由它做「分级路由不同模型 + 多家大模型 API 加权/failover 调度」。数据(渠道/token/用量)存 one-api-data 卷。
#
# 前置：用户容器已建好(deploy_default 网络已存在)。首次配置渠道/token 见 README-multiuser.md「LLM 网关」节。
# 启用网关：在 deploy/.env 设 OC_GATEWAY_URL=http://one-api:3000/v1 与 OC_GATEWAY_KEY=sk-<token>，
#           再 render-compose.sh + 重建容器。停用网关：清空这两个变量 + 重建，即回落直连各家 API。
set -euo pipefail
IMG="${ONEAPI_IMAGE:-justsong/one-api:latest}"
NET="${GATEWAY_NET:-deploy_default}"
docker network inspect "$NET" >/dev/null 2>&1 || { echo "!! docker 网络 '$NET' 不存在——先跑 user-add 建用户容器(会创建它)再起网关"; exit 1; }
docker pull "$IMG"
docker rm -f one-api >/dev/null 2>&1 || true
docker run -d --name one-api --network "$NET" --restart unless-stopped \
  -p 127.0.0.1:3010:3000 -v one-api-data:/data -e TZ=Asia/Shanghai "$IMG" >/dev/null
echo "✅ one-api 已启动。管理台在 127.0.0.1:3010（仅回环；本机 SSH 隧道访问：ssh -L 3010:127.0.0.1:3010 ...）"
echo "   首次登录 root/123456，务必立刻改密码，并在「渠道」加各家 API、在「令牌」建一个给 OpenCode 用。"
