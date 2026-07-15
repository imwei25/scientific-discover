#!/usr/bin/env bash
# 列出所有用户的档位、每日额度、今日已用成本、存储上限与已用、容器状态。
# 今日成本读各用户 ocdata 卷里的 quota.json（server.mjs 按 UTC 日切累计 session.cost）。
# 用法：scripts/user-list.sh          （含存储用量，稍慢）
#      scripts/user-list.sh --fast   （跳过存储 du，只看额度与今日成本）
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

fast=0; [ "${1:-}" = "--fast" ] && fast=1
field() { sed -n "s/^$1=//p" "$2" | head -1; }
tier_field() { [ -f tiers.env ] || return 0; awk -v t="$1" -v c="$2" '!/^[[:space:]]*#/ && NF>=3 && $1==t {print $c; exit}' tiers.env; }
disp() { if [ -z "$1" ] || [ "$1" = "0" ]; then echo "不限"; else echo "$1"; fi; }
today=$(date -u +%F)   # 与 server.mjs 的 UTC 日切一致

printf "%-12s %-7s %-12s %-12s %-11s %-9s %s\n" 用户 档位 每日额度USD 今日已用USD 存储上限MB 已用MB 容器
printf -- "----------------------------------------------------------------------------------------\n"
shopt -s nullglob
running=$(docker ps --format '{{.Names}}' 2>/dev/null || true)
for f in users/*.env; do
  name=$(field NAME "$f"); [ -n "$name" ] || continue
  tier=$(field TIER "$f")
  dlimit=$(field DAILY_COST_LIMIT "$f"); dlimit=${dlimit:-$(tier_field "$tier" 2)}; dlimit=${dlimit:-0}
  slimit=$(field STORAGE_LIMIT_MB "$f"); slimit=${slimit:-$(tier_field "$tier" 3)}; slimit=${slimit:-0}

  # 今日已用成本（读 ocdata 卷的 quota.json；跨日/无文件按 0）
  used="0"
  q=$(docker run --rm -v "${name}-ocdata:/d:ro" alpine cat /d/quota.json 2>/dev/null || true)
  if [ -n "$q" ]; then
    qday=$(printf '%s' "$q" | sed -n 's/.*"day":"\([^"]*\)".*/\1/p')
    [ "$qday" = "$today" ] && used=$(printf '%s' "$q" | sed -n 's/.*"cost":\([0-9.]*\).*/\1/p')
    used=${used:-0}
  fi

  usedmb="-"
  if [ "$fast" = 0 ]; then
    usedmb=$(docker run --rm -v "${name}-uploads:/u:ro" -v "${name}-outputs:/o:ro" alpine \
      sh -c 'du -sm /u /o 2>/dev/null | awk "{s+=\$1} END{printf \"%d\", s}"' 2>/dev/null || echo "-")
  fi

  state="停止"; printf '%s\n' "$running" | grep -qx "agent-${name}" && state="运行中"
  printf "%-12s %-7s %-12s %-12s %-11s %-9s %s\n" \
    "$name" "${tier:-—}" "$(disp "$dlimit")" "$used" "$(disp "$slimit")" "$usedmb" "$state"
done
