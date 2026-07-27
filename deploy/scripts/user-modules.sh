#!/usr/bin/env bash
# 改某用户可用的功能模块：改写 users/<name>.env 的 MODULES= → 重渲染 compose → 重建该用户容器即时生效。
# 模块 id（与 web/server.mjs 的 MODULE_DEFS 对应）：
#   chat=自由对话  grant=标书撰写(grant-proposal)  refcheck=文献真实性检查(reference-check)  humanize=去AI味写作(humanize-academic)
# 用法：scripts/user-modules.sh <用户名> <模块列表逗号分隔|all>   （all = 全部模块）
#      scripts/user-modules.sh <用户名>                            （只查看当前授权）
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

ALL_MODULES="chat,grant,refcheck,humanize"

name="${1:-}"; mods="${2:-}"
env="users/${name}.env"
[ -n "$name" ] && [ -f "$env" ] || { echo "用法：user-modules.sh <用户名> <模块列表|all>；用户须已存在（users/<名>.env）。可用模块：$ALL_MODULES"; exit 1; }

cur=$(sed -n 's/^MODULES=//p' "$env" | head -1)
if [ -z "$mods" ]; then echo "$name 当前模块：${cur:-（未设，=全部模块）}"; exit 0; fi

[ "$mods" = "all" ] && mods="$ALL_MODULES"
# 逐个校验模块 id：写错一个就中止，别把乱码写进 env（容器侧对全非法值会 fail-closed 到仅 chat，很难排查）
IFS=',' read -ra parts <<< "$mods"
clean=""
for m in "${parts[@]}"; do
  m=$(echo "$m" | tr -d '[:space:]'); [ -n "$m" ] || continue
  case ",$ALL_MODULES," in
    *",$m,"*) clean="${clean:+$clean,}$m" ;;
    *) echo "!! 未知模块 '$m'。可用模块：$ALL_MODULES（或 all）" >&2; exit 1 ;;
  esac
done
[ -n "$clean" ] || { echo "!! 模块列表为空。至少给一个模块，或用 all" >&2; exit 1; }

if grep -q '^MODULES=' "$env"; then
  sed -i "s/^MODULES=.*/MODULES=$clean/" "$env"
else
  printf 'MODULES=%s\n' "$clean" >> "$env"
fi
echo "$name：${cur:-（全部）} → $clean"

scripts/render-compose.sh
# 容器 env 在「创建」那一刻固化（manager 唤醒只 docker start），必须重建容器授权才生效。数据在命名卷里，不丢。
was_running=0; docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "agent-${name}" && was_running=1
docker rm -f "agent-${name}" >/dev/null 2>&1 || true
docker compose up --no-start "agent-${name}"
if [ "$was_running" = 1 ]; then
  docker start "agent-${name}" >/dev/null && echo "已重建并启动 agent-${name}，新模块授权即时生效"
else
  echo "已重建 agent-${name}（停止态），下次访问冷启动即用新授权"
fi
