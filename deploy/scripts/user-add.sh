#!/usr/bin/env bash
# 新增用户：分配端口 → 生成强密码 → 写 users/<name>.env → 重渲染 compose → 创建(不启动)容器 → 热加载 manager。
# 单域名路径路由：不再为每个用户建子域 / 改 Caddy —— 新用户 = 一个容器 + 一次 manager 重载。
# 用法：scripts/user-add.sh <用户名> [档位]   —— 档位见 deploy/tiers.env，省略则用 free（或 DEFAULT_TIER）。
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

name="${1:-}"
tier="${2:-${DEFAULT_TIER:-free}}"
if ! [[ "$name" =~ ^[a-z][a-z0-9-]{1,20}$ ]]; then
  echo "用法：user-add.sh <用户名> [档位]（用户名：小写字母开头，仅小写字母/数字/连字符，2–21 位）"; exit 1
fi
case " admin api login logout " in *" $name "*) echo "!! '$name' 是保留名（与管理台 /$name 路径冲突），换一个"; exit 1;; esac
# 校验档位存在于 tiers.env
if [ -f tiers.env ] && ! awk -v t="$tier" '!/^[[:space:]]*#/ && NF>=3 && $1==t {f=1} END{exit !f}' tiers.env; then
  echo "!! 档位 '$tier' 未在 deploy/tiers.env 定义。可用档位：" >&2
  awk '!/^[[:space:]]*#/ && NF>=3 {printf "   %-8s 每日$%s  存储%sMB\n",$1,$2,$3}' tiers.env >&2
  exit 1
fi
env="users/${name}.env"
[ -e "$env" ] && { echo "用户 $name 已存在（$env）"; exit 1; }
mkdir -p users

# ---- 分配端口：从 3001 起，跳过一切已被占用的 ----
# 只查 users/*.env 是不够的：那是「我们自己的登记簿」，看不见宿主上别的东西。
# 实例：one-api 网关占着 127.0.0.1:3010，而本循环数到第 10 个用户正好分到 3010
# → docker 端口绑定失败、该用户容器压根起不来（曾是潜伏的雷，加到第 9 人才会炸）。
# 故三重排除：① 已登记给其他用户 ② 保留端口（写死，防被占用者恰好没在跑时漏判）
# ③ 宿主上此刻真实在监听的端口（兜底，将来撞上任何新东西都能自动躲开）。
used=$(sed -n 's/^PORT=//p' users/*.env 2>/dev/null | sort -n || true)
# 保留端口：即使当前没在监听也绝不分配（容器/服务可能只是暂时停着）
reserved="3010 8090 2019"   # one-api 网关 / manager / caddy admin
# ss 的 Local Address:Port 形如 127.0.0.1:3010 / *:80 / [::]:22 —— 取最后一个冒号后的数字
listening=$(ss -tln 2>/dev/null | tail -n +2 | awk '{n=split($4,a,":"); print a[n]}' | sort -un || true)
# 注意：这里刻意用 if/fi 而非 `grep -qx "$1" && return 0`。后者在 set -e 下有歧义——
# grep 不匹配时整个 && 列表返回非零，可能把脚本直接带崩。
is_taken() {
  local p="$1"
  if printf '%s\n' "$used"      | grep -qx "$p"; then return 0; fi
  if printf '%s\n' $reserved    | grep -qx "$p"; then return 0; fi
  if printf '%s\n' "$listening" | grep -qx "$p"; then return 0; fi
  return 1
}
port=3001
while is_taken "$port"; do
  port=$((port+1))
  if [ "$port" -gt 3999 ]; then echo "!! 端口耗尽（已排到 $port），请检查端口规划" >&2; exit 1; fi
done

pass=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-20)

umask 077
cat > "$env" <<EOF
NAME=$name
PORT=$port
LAN_AUTH=1
LAN_USER=$name
LAN_PASSWORD=$pass
# 档位（见 deploy/tiers.env）：决定每日成本额度与存储上限。改档位用 scripts/user-tier.sh $name <档位>
TIER=$tier
# 个别加码/收紧（覆盖档位）：取消注释并填值，USD/天、MB，0=不限；改后 render-compose.sh + docker restart agent-$name
#DAILY_COST_LIMIT=
#STORAGE_LIMIT_MB=
EOF
echo "写入 $env（端口 $port，档位 $tier）"

scripts/render-compose.sh
docker compose up --no-start "agent-${name}"
systemctl reload sci-manager 2>/dev/null || pkill -HUP -f 'manager.mjs' 2>/dev/null || echo "!! 未热加载 manager（首次部署尚未启动服务时属正常）"

BASE_DOMAIN=""; [ -f .env ] && BASE_DOMAIN=$(sed -n 's/^BASE_DOMAIN=//p' .env | head -1)
BASE_DOMAIN=${BASE_DOMAIN:-<你的域名>}
tinfo=$(awk -v t="$tier" '!/^[[:space:]]*#/ && NF>=3 && $1==t {printf "每日$%s / 存储%sMB（0=不限）",$2,$3; exit}' tiers.env 2>/dev/null)
cat <<MSG

✅ 用户 $name 就绪
   访问：https://$BASE_DOMAIN/$name/
   账号：$name
   密码：$pass
   档位：$tier  ${tinfo:+（$tinfo）}
   （首次访问冷启动约 10–40s；空闲自动停机，下次访问再唤醒）
MSG
