#!/usr/bin/env bash
# 新增用户：分配端口 → 生成强密码 → 写 users/<name>.env → 重渲染 compose → 创建(不启动)容器 → 热加载 manager。
# 单域名路径路由：不再为每个用户建子域 / 改 Caddy —— 新用户 = 一个容器 + 一次 manager 重载。
# 用法：scripts/user-add.sh <用户名>
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

name="${1:-}"
if ! [[ "$name" =~ ^[a-z][a-z0-9-]{1,20}$ ]]; then
  echo "用法：user-add.sh <用户名>（小写字母开头，仅小写字母/数字/连字符，2–21 位）"; exit 1
fi
env="users/${name}.env"
[ -e "$env" ] && { echo "用户 $name 已存在（$env）"; exit 1; }
mkdir -p users

# 从 3001 起分配第一个未占用端口
used=$(sed -n 's/^PORT=//p' users/*.env 2>/dev/null | sort -n || true)
port=3001
while printf '%s\n' "$used" | grep -qx "$port"; do port=$((port+1)); done

pass=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-20)

umask 077
cat > "$env" <<EOF
NAME=$name
PORT=$port
LAN_AUTH=1
LAN_USER=$name
LAN_PASSWORD=$pass
EOF
echo "写入 $env（端口 $port）"

scripts/render-compose.sh
docker compose up --no-start "agent-${name}"
systemctl reload sci-manager 2>/dev/null || pkill -HUP -f 'manager.mjs' 2>/dev/null || echo "!! 未热加载 manager（首次部署尚未启动服务时属正常）"

BASE_DOMAIN=""; [ -f .env ] && BASE_DOMAIN=$(sed -n 's/^BASE_DOMAIN=//p' .env | head -1)
BASE_DOMAIN=${BASE_DOMAIN:-<你的域名>}
cat <<MSG

✅ 用户 $name 就绪
   访问：https://$BASE_DOMAIN/$name/
   账号：$name
   密码：$pass
   （首次访问冷启动约 10–40s；空闲自动停机，下次访问再唤醒）
MSG
