#!/usr/bin/env bash
# 改某用户可用的技能白名单：改写 users/<name>.env 的 SKILLS= → 重渲染 compose → 重建该用户容器即时生效。
# 生效语义（enforcement 在容器网关 web/server.mjs）：
#   - 空/未设 = 全部技能；非空 = 自由对话里只许调用这些技能（env-setup 恒许可，网关自动加）
#   - 受限模块（标书/查引用/去AI味）的绑定技能被收权时，该模块整体不可用
# 用法：scripts/user-skills.sh <用户名> <技能列表逗号分隔|all>   （all = 清除限制=全部技能）
#      scripts/user-skills.sh <用户名>                            （只查看当前白名单）
#      scripts/user-skills.sh --list                              （列出全部可用技能 id）
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

# 技能清单以仓库技能目录为唯一事实来源（含 SKILL.md 的子目录才算技能）
SKILLS_DIR="../.opencode/skills"
all_skills() { for d in "$SKILLS_DIR"/*/; do [ -f "$d/SKILL.md" ] && basename "$d"; done; }

if [ "${1:-}" = "--list" ]; then all_skills; exit 0; fi

name="${1:-}"; skills="${2:-}"
env="users/${name}.env"
[ -n "$name" ] && [ -f "$env" ] || { echo "用法：user-skills.sh <用户名> <技能列表|all>；用户须已存在（users/<名>.env）。技能清单：user-skills.sh --list"; exit 1; }

cur=$(sed -n 's/^SKILLS=//p' "$env" | head -1)
if [ -z "$skills" ]; then echo "$name 当前技能白名单：${cur:-（未设，=全部技能）}"; exit 0; fi

if [ "$skills" = "all" ]; then
  clean=""   # 清除限制：SKILLS 置空 = 全部技能
else
  # 逐个对照技能目录校验：写错一个就中止（容器侧对未知 id 只是忽略，悄悄少一个技能很难排查）
  IFS=',' read -ra parts <<< "$skills"
  clean=""
  for s in "${parts[@]}"; do
    s=$(echo "$s" | tr -d '[:space:]'); [ -n "$s" ] || continue
    if [ -f "$SKILLS_DIR/$s/SKILL.md" ]; then clean="${clean:+$clean,}$s"
    else echo "!! 未知技能 '$s'。可用技能：$(all_skills | paste -sd, -)（或 all）" >&2; exit 1; fi
  done
  [ -n "$clean" ] || { echo "!! 技能列表为空。至少给一个技能，或用 all 清除限制" >&2; exit 1; }
fi

if grep -q '^SKILLS=' "$env"; then
  sed -i "s/^SKILLS=.*/SKILLS=$clean/" "$env"
else
  printf 'SKILLS=%s\n' "$clean" >> "$env"
fi
echo "$name：${cur:-（全部）} → ${clean:-（全部）}"

scripts/render-compose.sh
# 容器 env 在「创建」那一刻固化（manager 唤醒只 docker start），必须重建容器授权才生效。数据在命名卷里，不丢。
was_running=0; docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "agent-${name}" && was_running=1
docker rm -f "agent-${name}" >/dev/null 2>&1 || true
docker compose up --no-start "agent-${name}"
if [ "$was_running" = 1 ]; then
  docker start "agent-${name}" >/dev/null && echo "已重建并启动 agent-${name}，新技能白名单即时生效"
else
  echo "已重建 agent-${name}（停止态），下次访问冷启动即用新白名单"
fi
