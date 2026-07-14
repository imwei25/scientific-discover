#!/usr/bin/env bash
# 备份用户数据卷（uploads/outputs/ocdata）到 BACKUP_DIR/<日期>/，7 天轮转。
# 用法：scripts/backup.sh [用户名]   —— 省略用户名则备份所有用户。建议 cron 每日跑。
# 说明：应用内已有 7 天 TTL 清理会话/产物，本脚本是卷级快照，二者互补。
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

BACKUP_DIR="${BACKUP_DIR:-/var/backups/sci}"
day=$(date +%F)
dest="$BACKUP_DIR/$day"
mkdir -p "$dest"

names=()
if [ $# -ge 1 ]; then
  names=("$1")
else
  shopt -s nullglob
  for f in users/*.env; do n=$(sed -n 's/^NAME=//p' "$f" | head -1); [ -n "$n" ] && names+=("$n"); done
fi

for name in "${names[@]}"; do
  for v in uploads outputs ocdata; do
    vol="${name}-${v}"
    docker volume inspect "$vol" >/dev/null 2>&1 || continue
    docker run --rm -v "${vol}:/data:ro" -v "${dest}:/backup" alpine \
      tar czf "/backup/${name}-${v}.tar.gz" -C /data . \
      && echo "备份 $vol → $dest/${name}-${v}.tar.gz"
  done
done

# 轮转：删除 7 天前的备份目录
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
echo "备份完成：$dest"
