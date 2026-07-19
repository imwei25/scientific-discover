#!/usr/bin/env bash
# 备份到 BACKUP_DIR/<日期>/（默认 /var/backups/sci），7 天轮转：
#   - 每个用户的数据卷 uploads/outputs/ocdata（<name>-*.tar.gz）
#   - 配置与密钥 .env + users/*.env + docker-compose.yml（config.tar.gz）—— 不在 git 里，全量恢复必需
# 用法：scripts/backup.sh [用户名]   —— 省略则备份所有用户。建议 cron 每日跑（见 DEPLOY.md）。
# 备份目录含明文密码，脚本已设 700 仅 root 可读；异地容灾请再把 BACKUP_DIR 同步到别处（rsync / 对象存储）。
# 说明：本脚本是卷级快照。注意【应用内并没有】所谓 7 天 TTL 自动清理（此前注释这么写过，是错的，
#       代码里从未实现）——用户数据目前只能靠他自己在界面上删会话来回收。
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

# 单卷失败要“看得见”：set -e 对 `A && echo` 的左侧不生效，旧写法里 tar 失败会跳过 echo 但脚本照跑到底、
# 结尾仍打“备份完成” → 坏备份长期无人知，恢复时才炸。改为显式 if，失败即计数，结尾非零退出让 cron/monitor 抓到。
fail=0
for name in "${names[@]}"; do
  for v in uploads outputs ocdata; do
    vol="${name}-${v}"
    docker volume inspect "$vol" >/dev/null 2>&1 || continue
    if docker run --rm -v "${vol}:/data:ro" -v "${dest}:/backup" alpine \
         tar czf "/backup/${name}-${v}.tar.gz" -C /data . ; then
      echo "备份 $vol → $dest/${name}-${v}.tar.gz"
    else
      echo "!! 备份失败：$vol" >&2; fail=$((fail+1)); rm -f "$dest/${name}-${v}.tar.gz"
    fi
  done
done

# LLM 网关(one-api)的数据卷：渠道/令牌/用量，和用户无关但同样要备份（不然迁移后网关要重配）
if docker volume inspect one-api-data >/dev/null 2>&1; then
  if docker run --rm -v one-api-data:/data:ro -v "${dest}:/backup" alpine tar czf /backup/gateway-one-api.tar.gz -C /data . ; then
    echo "备份 one-api-data → $dest/gateway-one-api.tar.gz"
  else
    echo "!! 备份失败：one-api-data" >&2; fail=$((fail+1)); rm -f "$dest/gateway-one-api.tar.gz"
  fi
fi

# 配置与密钥（.env + users/*.env + tiers.env + 生成的 compose）：不在 git 里，丢了要重建用户/密码，一并快照
cfg=(); [ -f .env ] && cfg+=(.env); [ -d users ] && cfg+=(users); [ -f tiers.env ] && cfg+=(tiers.env); [ -f docker-compose.yml ] && cfg+=(docker-compose.yml)
if [ ${#cfg[@]} -gt 0 ]; then
  if tar czf "$dest/config.tar.gz" "${cfg[@]}" ; then echo "备份 配置(.env/users/compose) → $dest/config.tar.gz"
  else echo "!! 备份失败：config.tar.gz" >&2; fail=$((fail+1)); fi
fi

# 轮转：删除 7 天前的备份目录
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
# 成功标记文件：monitor 据此判断"昨夜备份成功"。
# 为什么不能让 monitor 只看目录新鲜度：本脚本一开头就无条件 mkdir 了 $dest，
# 所以【备份失败时也会留下一个 mtime 是刚刚的空目录】——按目录判就永远命中、永远不告警。
# 最典型的失败场景恰恰是磁盘满，那正是最需要被发现的时候。故：只有全部成功才落 OK。
ok_marker="$dest/OK"
rm -f "$ok_marker"
if [ "$fail" -eq 0 ]; then
  # 先写临时文件、成功后再 mv 成 OK：若中途某条（如 du）非零，pipefail+set -e 会在这里中止，
  # 那时 OK 还不存在 → monitor 正确判定为"备份未成功"。若直接重定向进 OK，
  # 会留下一个半截的 OK 文件而脚本非零退出，monitor 反倒读成成功——正好是我们要消灭的假阳性。
  # `|| true`：size 只是给人看的装饰字段。备份期间用户容器可能正在写 outputs 卷，
  # du 会因文件被并发删除而 stat 失败退非零 → 在 pipefail+set -e 下会让整个块失败、
  # 于是 tar 全都成功却不落 OK、monitor 次日误报"备份失败"。别让装饰字段变成成败判据。
  # tmp 名带 $$：cron 夜跑与 user-del --purge 触发的单用户备份可能同日重叠，固定名会互相踩。
  tmpf="$ok_marker.$$.tmp"
  { echo "time=$(date -Is)"
    echo "users=${names[*]:-}"
    du -sh "$dest" 2>/dev/null | cut -f1 | sed 's/^/size=/' || true
  } > "$tmpf"
  mv "$tmpf" "$ok_marker"
  echo "备份完成：$dest"
else
  rm -f "$ok_marker.$$.tmp"   # 只清自己的 tmp，别删掉并发实例正在写的那个
  echo "!! 备份不完整：$fail 项失败，产物在 $dest（不要当作可用备份，已不写 OK 标记）" >&2
  exit 1
fi
