#!/usr/bin/env bash
# 改某用户的档位：改写 users/<name>.env 的 TIER= → 重渲染 compose → 重启该用户容器使新额度即时生效。
# 用法：scripts/user-tier.sh <用户名> <档位>          （档位见 deploy/tiers.env）
#      scripts/user-tier.sh <用户名>                  （只查看该用户当前档位）
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

name="${1:-}"; tier="${2:-}"
env="users/${name}.env"
[ -n "$name" ] && [ -f "$env" ] || { echo "用法：user-tier.sh <用户名> <档位>；用户须已存在（users/<名>.env）"; exit 1; }

cur=$(sed -n 's/^TIER=//p' "$env" | head -1)
if [ -z "$tier" ]; then echo "$name 当前档位：${cur:-（未设，按不限处理）}"; exit 0; fi

# 校验档位存在
if [ -f tiers.env ] && ! awk -v t="$tier" '!/^[[:space:]]*#/ && NF>=3 && $1==t {f=1} END{exit !f}' tiers.env; then
  echo "!! 档位 '$tier' 未在 deploy/tiers.env 定义。可用档位：" >&2
  awk '!/^[[:space:]]*#/ && NF>=3 {printf "   %-8s 每日$%s  存储%sMB\n",$1,$2,$3}' tiers.env >&2
  exit 1
fi

# 就地改写/追加 TIER=（保留文件其余内容与权限）
if grep -q '^TIER=' "$env"; then
  sed -i "s/^TIER=.*/TIER=$tier/" "$env"
else
  printf 'TIER=%s\n' "$tier" >> "$env"
fi
echo "$name：$cur → $tier"

scripts/render-compose.sh
# 让新额度生效：容器的环境变量在「创建」那一刻固化，manager 唤醒用的是 docker start —— 不会重读 compose。
# 所以必须【重建】容器（不是 restart）。数据都在命名卷里(uploads/outputs/ocdata)，重建不丢。
# 重建后置为停止态，交回 manager 按需冷启动（维持闲置退出模型）；原本在跑的则重新拉起。
was_running=0; docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "agent-${name}" && was_running=1
docker rm -f "agent-${name}" >/dev/null 2>&1 || true
docker compose up --no-start "agent-${name}"
if [ "$was_running" = 1 ]; then
  docker start "agent-${name}" >/dev/null && echo "已重建并启动 agent-${name}，新额度即时生效"
else
  echo "已重建 agent-${name}（停止态），下次访问冷启动即用新额度"
fi
