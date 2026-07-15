#!/usr/bin/env bash
# 备份到 BACKUP_DIR/<日期>/（默认 /var/backups/sci），7 天轮转：
#   - 每个用户的数据卷 uploads/outputs/ocdata（<name>-*.tar.gz）
#   - 配置与密钥 .env + users/*.env + docker-compose.yml（config.tar.gz）—— 不在 git 里，全量恢复必需
# 用法：scripts/backup.sh [用户名]   —— 省略则备份所有用户。建议 cron 每日跑（见 DEPLOY.md）。
# 备份目录含明文密码，脚本已设 700 仅 root 可读；异地容灾请再把 BACKUP_DIR 同步到别处（rsync / 对象存储）。
# 说明：应用内另有 7 天 TTL 清理会话/产物，本脚本是卷级快照，二者互补。
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

BACKUP_DIR="${BACKUP_DIR:-/var/backups/sci}"
day=$(date +%F)
dest="$BACKUP_DIR/$day"
mkdir -p "$dest"
chmod 700 "$BACKUP_DIR" "$dest" 2>/dev/null || true   # 含明文密码，仅 root 可读

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

# 配置与密钥（.env + users/*.env + 生成的 compose）：不在 git 里，丢了要重建用户/密码，一并快照
cfg=(); [ -f .env ] && cfg+=(.env); [ -d users ] && cfg+=(users); [ -f docker-compose.yml ] && cfg+=(docker-compose.yml)
if [ ${#cfg[@]} -gt 0 ]; then tar czf "$dest/config.tar.gz" "${cfg[@]}" && echo "备份 配置(.env/users/compose) → $dest/config.tar.gz"; fi

# 轮转：删除 7 天前的备份目录
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
echo "备份完成：$dest"
