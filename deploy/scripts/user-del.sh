#!/usr/bin/env bash
# 删除用户：（--purge 时先备份）→ 停并删容器 → 删登记 → 重渲染 compose → 热加载 manager。
# 默认保留数据卷（安全）；加 --purge 才在备份成功后删除卷；备份失败要强删须再加 --force。
# 用法：scripts/user-del.sh <用户名> [--purge] [--force]
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

name="${1:-}"; purge=""; force=0
for a in "${@:2}"; do
  case "$a" in
    --purge) purge="--purge" ;;
    --force) force=1 ;;
    *) echo "未知参数：$a"; exit 1 ;;
  esac
done
[ -n "$name" ] || { echo "用法：user-del.sh <用户名> [--purge] [--force]"; exit 1; }
[ "$force" = 1 ] && [ -z "$purge" ] && { echo "!! --force 只在配合 --purge 时有意义；当前没有 --purge，不会删除任何数据卷。" >&2; exit 1; }
env="users/${name}.env"
[ -e "$env" ] || { echo "用户 $name 不存在（$env）"; exit 1; }

# ★ 备份必须在【删除 users/<name>.env 之前】跑。
#   backup.sh 打的 config.tar.gz 里就包含 users/ 目录（账号+密码+端口+档位），
#   若先 rm 掉这个文件再备份，备份里就没有它 —— 备份"成功"了却无法完整还原该用户。
#   同理，备份失败时也必须在【什么都还没删】的状态下中止，否则"数据卷原样保留"的提示是误导：
#   卷是还在，但账号登记已经没了。
if [ "$purge" = "--purge" ]; then
  # ★ 先把容器停掉再备份。backup.sh 是热态卷快照（不停容器直接 tar），而 ocdata 是 SQLite(WAL)：
  #   容器正在跑任务时 tar 出来的 db 与 -wal 可能不匹配，是个撕裂快照。平时无所谓（下次还能再备），
  #   但 --purge 紧接着就把【唯一的副本】删掉 —— 事后想恢复时才发现 ocdata 打不开、会话历史全丢。
  #   容器反正马上就要删，这里停它没有额外代价。用 stop 而非 rm -f：留给下面统一删。
  if docker ps -q -f "name=^agent-${name}$" | grep -q .; then
    echo "先停容器 agent-${name}（让 SQLite 落盘，避免备份出撕裂快照）…"
    docker stop "agent-${name}" >/dev/null 2>&1 || echo "!! 停容器失败，备份可能是撕裂快照" >&2
  fi
  echo "先备份（含 users/${name}.env 与三个数据卷）…"
  if ! scripts/backup.sh "$name"; then
    if [ "$force" = 1 ]; then
      echo "!! 备份失败，但指定了 --force → 仍继续删除" >&2
    else
      echo "!! 备份失败，已中止：用户与数据卷【均原样保留】，什么都没删。" >&2
      # 但容器确实被上面停掉了 —— 不说明的话，这句"什么都没删"会让运维以为服务照常。
      # 影响有限（下次访问时 manager 的 ensureUp 会自动拉起），但必须如实讲。
      echo "   注意：为拿到一致快照，上面已停掉容器 agent-${name}；该用户下次访问时会自动重新拉起。" >&2
      echo "   想立刻恢复服务：docker start agent-${name}" >&2
      echo "   确认无需保留数据、坚持删除请加 --force：scripts/user-del.sh $name --purge --force" >&2
      exit 1
    fi
  fi
fi

docker rm -f "agent-${name}" 2>/dev/null || true
# 无论走不走 --purge，users/<name>.env 都会被删掉，而它含 LAN_PASSWORD/PORT/TIER——
# 默认路径（不带 --purge）此前【完全没有备份】就永久删掉它：卷虽然按名字还能重挂，
# 但密码/端口/档位全丢了，而提示语"已保留数据卷"读起来却像是可回滚的安全操作。
# 故先留一份带日期的副本（--purge 路径上面已整体备份过，这里再留一份也无妨、便宜）。
keep_dir="${BACKUP_DIR:-/var/backups/sci}/deleted-users"
if mkdir -p "$keep_dir" 2>/dev/null; then
  chmod 700 "$keep_dir" 2>/dev/null || true          # 含明文密码，仅 root 可读
  cp -a "$env" "$keep_dir/${name}-$(date +%F_%H%M%S).env" 2>/dev/null \
    && echo "已留存账号登记副本：$keep_dir/${name}-*.env（含密码，仅 root 可读）"
fi
rm -f "$env"
scripts/render-compose.sh

if [ "$purge" = "--purge" ]; then
  echo "删除数据卷 …"
  # 逐个删卷并收集失败：原先 `|| true` 把失败吞掉后照打"已删除"，
  # 运维会以为患者相关产物已清干净，实际卷还在（例如容器没删干净导致 volume in-use）。
  failed=()
  for v in uploads outputs ocdata; do
    vol="${name}-${v}"
    docker volume inspect "$vol" >/dev/null 2>&1 || continue   # 本就不存在，不算失败
    if docker volume rm "$vol" >/dev/null 2>&1; then echo "  已删除卷 $vol"; else failed+=("$vol"); fi
  done
  # 注意：卷删除失败【不能在这里 exit】。此刻 users/<name>.env 已删、compose 已重渲染，
  # 唯独 manager 内存里还留着该用户条目（热加载在脚本末尾）。直接退出的话，manager 仍认为
  # 该用户存在、却已 docker rm -f 掉其容器 → 访问 /<name>/ 走进 ensureUp 抛"容器不存在"，
  # 持续回 503 而不是干净的 404，直到有人手工 reload。
  # 改为：记下失败，末尾照常热加载，最后再以非零码退出让运维知道卷没清干净。
  if [ ${#failed[@]} -gt 0 ]; then
    echo "!! 以下卷删除失败（可能仍被容器占用），数据【未】清除：${failed[*]}" >&2
    echo "   排查：docker ps -a --filter volume=${failed[0]}" >&2
    VOL_RM_FAILED=1
  fi
else
  echo "已保留数据卷 ${name}-{uploads,outputs,ocdata}（彻底删除请加 --purge）"
  echo "注意：账号登记 users/${name}.env 已删除（副本见上面的 deleted-users 目录）；要恢复该用户，"
  echo "      用 user-add.sh 重建同名用户后卷会自动挂回，但密码/端口会变——需要原值请从副本里取。"
fi

systemctl reload sci-manager 2>/dev/null || pkill -HUP -f 'manager.mjs' 2>/dev/null || true
if [ "${VOL_RM_FAILED:-0}" = 1 ]; then
  echo "⚠ 用户 $name 已从登记与路由中移除（manager 已热加载），但部分数据卷未能删除，见上面的排查提示。" >&2
  exit 1
fi
echo "✅ 用户 $name 已移除"
