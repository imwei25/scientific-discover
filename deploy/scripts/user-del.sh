#!/usr/bin/env bash
# 删除用户：停并删容器 → 重渲染 compose → 热加载 manager。
# 默认保留数据卷（安全）；加 --purge 才在备份后删除卷。
# 用法：scripts/user-del.sh <用户名> [--purge]
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

name="${1:-}"; purge="${2:-}"
[ -n "$name" ] || { echo "用法：user-del.sh <用户名> [--purge]"; exit 1; }
env="users/${name}.env"
[ -e "$env" ] || { echo "用户 $name 不存在（$env）"; exit 1; }

docker rm -f "agent-${name}" 2>/dev/null || true
rm -f "$env"
scripts/render-compose.sh

if [ "$purge" = "--purge" ]; then
  echo "备份后删除数据卷 …"
  scripts/backup.sh "$name" || echo "!! 备份失败，继续删除（如需保数据请 Ctrl-C）"
  for v in uploads outputs ocdata; do docker volume rm "${name}-${v}" 2>/dev/null || true; done
  echo "已删除卷 ${name}-{uploads,outputs,ocdata}"
else
  echo "已保留数据卷 ${name}-{uploads,outputs,ocdata}（彻底删除请加 --purge）"
fi

systemctl reload sci-manager 2>/dev/null || pkill -HUP -f 'manager.mjs' 2>/dev/null || true
echo "✅ 用户 $name 已移除"
