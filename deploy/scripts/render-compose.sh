#!/usr/bin/env bash
# 从 deploy/users/*.env 生成 deploy/docker-compose.yml：每用户一个隔离容器 + 三个数据卷 + 仅回环发布端口。
# 生成物 docker-compose.yml 含明文密码，已 gitignore；改用户后由 user-add/user-del 自动调用。
#
# 关键：用户 env 里的 PORT 是"宿主发布端口"，绝不能整体注入容器（会覆盖网关内部 PORT=3000）。
#       所以这里只把 LAN_* 显式写进 environment，PORT 只用于 ports 映射。
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

OUT=docker-compose.yml
# 每容器内存上限。整机 3.4G + 2G swap、WARM_CAP=2：2×1400=2.8G 稳在 RAM 内，重任务冲高会溢出到 swap(变慢不崩)。
# 想更宽/更紧：MEM_LIMIT=1600m scripts/render-compose.sh（或改此默认），随后重建容器生效。
MEM_LIMIT="${MEM_LIMIT:-1400m}"
CPUS="${CPUS:-1.5}"
tmp="$(mktemp)"

field() { sed -n "s/^$1=//p" "$2" | head -1; }
# 从 tiers.env 取某档位的第 col 列（2=每日USD，3=存储MB）；无 tiers.env 或档位未定义则空
tier_field() { [ -f tiers.env ] || return 0; awk -v t="$1" -v c="$2" '!/^[[:space:]]*#/ && NF>=3 && $1==t {print $c; exit}' tiers.env; }

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
    # 额度按档位解析：用户 .env 里若有非空 DAILY_COST_LIMIT/STORAGE_LIMIT_MB 则以其为准（个别覆盖），
    # 否则按 TIER 从 tiers.env 取；都没有则回落到 0（不限）。
    tier=$(field TIER "$f")
    if [ -n "$tier" ] && [ -z "$(tier_field "$tier" 2)$(tier_field "$tier" 3)" ]; then
      echo "!! $f 的 TIER=$tier 在 tiers.env 未定义，回落到不限额" >&2
    fi
    dlimit=$(field DAILY_COST_LIMIT "$f"); dlimit=${dlimit:-$(tier_field "$tier" 2)}
    slimit=$(field STORAGE_LIMIT_MB "$f"); slimit=${slimit:-$(tier_field "$tier" 3)}
    # 分级模型：用户 .env 显式 OC_MODEL 覆盖 > 档位 tiers.env 第4列 > 缺省 deepseek-v4-pro（走网关时即请求这个模型名）
    tmodel=$(field OC_MODEL "$f"); tmodel=${tmodel:-$(tier_field "$tier" 4)}; tmodel=${tmodel:-deepseek-v4-pro}
    if [ -z "$name" ] || [ -z "$port" ]; then echo "!! $f 缺 NAME/PORT，跳过" >&2; continue; fi
    had=1
    cat <<YAML
  agent-${name}:
    image: sci-agent:latest
    container_name: agent-${name}
    environment:
      DEEPSEEK_API_KEY: \${DEEPSEEK_API_KEY:?请在 deploy/.env 设置 DEEPSEEK_API_KEY}
      OC_MODEL: "deepseek/${tmodel}"
      OC_GATEWAY_URL: \${OC_GATEWAY_URL:-}
      OC_GATEWAY_KEY: \${OC_GATEWAY_KEY:-}
      OC_COST_INPUT: \${OC_COST_INPUT:-0.27}
      OC_COST_OUTPUT: \${OC_COST_OUTPUT:-1.10}
      OC_COST_CACHE_READ: \${OC_COST_CACHE_READ:-0.07}
      LAN_AUTH: "${lauth}"
      LAN_USER: "${luser}"
      LAN_PASSWORD: "${lpass}"
      BASE_PATH: "/${name}"
      USER_TIER: "${tier:-}"
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
