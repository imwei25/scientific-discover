#!/usr/bin/env bash
# 从 deploy/users/*.env 生成 deploy/docker-compose.yml：每用户一个隔离容器 + 三个数据卷 + 仅回环发布端口。
# 生成物 docker-compose.yml 含明文密码，已 gitignore；改用户后由 user-add/user-del 自动调用。
#
# 关键：用户 env 里的 PORT 是"宿主发布端口"，绝不能整体注入容器（会覆盖网关内部 PORT=3000）。
#       所以这里只把 LAN_* 显式写进 environment，PORT 只用于 ports 映射。
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

OUT=docker-compose.yml
MEM_LIMIT="${MEM_LIMIT:-1750m}"
CPUS="${CPUS:-1.5}"
tmp="$(mktemp)"

field() { sed -n "s/^$1=//p" "$2" | head -1; }

{
  echo "# ⚠ 自动生成，勿手改。改 users/*.env 后运行 scripts/render-compose.sh。"
  echo "# 每个用户：独立容器 agent-<name> + uploads/outputs/ocdata 三卷 + 仅回环(127.0.0.1)发布端口。"
  echo "services:"
  shopt -s nullglob
  had=0
  for f in users/*.env; do
    name=$(field NAME "$f"); port=$(field PORT "$f")
    luser=$(field LAN_USER "$f"); lpass=$(field LAN_PASSWORD "$f")
    lauth=$(field LAN_AUTH "$f"); lauth=${lauth:-1}
    dlimit=$(field DAILY_COST_LIMIT "$f")
    slimit=$(field STORAGE_LIMIT_MB "$f")
    if [ -z "$name" ] || [ -z "$port" ]; then echo "!! $f 缺 NAME/PORT，跳过" >&2; continue; fi
    had=1
    cat <<YAML
  agent-${name}:
    image: sci-agent:latest
    container_name: agent-${name}
    environment:
      DEEPSEEK_API_KEY: \${DEEPSEEK_API_KEY:?请在 deploy/.env 设置 DEEPSEEK_API_KEY}
      OC_MODEL: \${OC_MODEL:-deepseek/deepseek-v4-pro}
      LAN_AUTH: "${lauth}"
      LAN_USER: "${luser}"
      LAN_PASSWORD: "${lpass}"
      BASE_PATH: "/${name}"
      DAILY_COST_LIMIT: "${dlimit:-0}"
      STORAGE_LIMIT_MB: "${slimit:-0}"
    volumes:
      - ${name}-uploads:/app/uploads
      - ${name}-outputs:/app/outputs
      - ${name}-ocdata:/root/.local/share/opencode
    ports:
      - "127.0.0.1:${port}:3000"
    restart: "no"
    mem_limit: ${MEM_LIMIT}
    cpus: ${CPUS}
YAML
  done
  if [ "$had" = 1 ]; then
    echo "volumes:"
    for f in users/*.env; do
      name=$(field NAME "$f"); [ -n "$name" ] || continue
      for v in uploads outputs ocdata; do
        printf '  %s-%s:\n    name: %s-%s\n' "$name" "$v" "$name" "$v"
      done
    done
  fi
} > "$tmp"
mv "$tmp" "$OUT"
echo "已生成 $OUT（$(grep -c 'container_name:' "$OUT" || echo 0) 个用户）"
