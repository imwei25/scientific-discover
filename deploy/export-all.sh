#!/usr/bin/env bash
# ============================================================================
# 一键导出：把本机(阿里云)上所有用户的全部数据打成一个 tar.gz，供迁移到新服务器。
#
# 打包内容（与 scripts/backup.sh 同一套“真实架构”，别再对着废弃设计导）：
#   ① 每个用户的三个 Docker 卷：<user>-uploads / <user>-outputs / <user>-ocdata
#      （ocdata 卷里含 OpenCode 会话历史 + 会话元数据 + 所选模型）——卷是【无前缀显式命名】。
#   ② LLM 网关卷 one-api-data（渠道/令牌/用量），迁移后不用重配网关。
#   ③ 配置与密钥：.env、users/*.env（账号+密码+端口）、tiers.env（分级）、docker-compose.yml。
#      —— 这些不在 git 里，是重建用户与路由的唯一来源。
#
# 用法（在 deploy/ 目录下）：
#   ./export-all.sh                 # 导出到 /var/backups/sci-export/（仓库【之外】，含明文密码故不放工作树）
#   ./export-all.sh /path/to/dir    # 导出到指定目录
#
# ⚠ 产物含 .env 与 users/*.env（全部账号 + 明文密码）。别把它放进 git 工作树，也别用邮件/IM 传。
# ⚠ 本包只覆盖 compose 内的东西（卷 + deploy/ 下的配置）。宿主侧还有几样【必须手工搬】：
#     /etc/sci-manager.env（ADMIN_PASSWORD / ONEAPI_TOKEN / WAKE_* —— manager 是宿主 systemd 服务，不在 compose 里）
#     /etc/caddy/Caddyfile（TLS 与路径路由）、/etc/sci-monitor.conf（告警 webhook）、fail2ban 配置
#   只导入本包就 `docker compose up -d` 的话：没有 manager、没有 TLS/路由、没有 /admin 密码、
#   没有监控告警 —— 站点整体不可达，且 admin 密码若未另存就永久丢失。
#
# 迁移到新服务器：把生成的 sci-agent-backup-*.tar.gz 拷过去，在新机 deploy/ 里跑 ./import-all.sh 它。
# 容器无需停机即可导出（tar 直接读卷）；但 ocdata 是 SQLite(WAL)，为拿到一致快照建议先 `docker compose stop`。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"                                   # 切到 deploy/ 目录

command -v docker >/dev/null || { echo "!! 未找到 docker"; exit 1; }
# 【默认目录必须在仓库之外】产物里包含 config/.env 与 config/users/（全部账号 + 明文密码 + 端口）
# 以及所有用户数据。原默认是 ./backups，也就是 deploy/backups —— 就在 git 工作树里，而且
# .gitignore 没有任何规则命中它：运维在服务器上跑完导出、照惯例 git add -A && git push，
# 全站明文密码和患者相关产物就进了 git 历史并推到远端，且历史里删不干净。
OUTDIR="${1:-/var/backups/sci-export}"
mkdir -p "$OUTDIR"
# 同时收紧权限：backup.sh 有 chmod 700，这里原本没有，默认 umask 下产物是 0644，同机其他用户可读。
chmod 700 "$OUTDIR" 2>/dev/null || true
umask 077
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/sci-agent-backup-$STAMP"
mkdir -p "$STAGE/volumes" "$STAGE/config"

echo "== 导出全部用户数据 =="

# ① 用户数据卷：按【卷名后缀】发现（无前缀，与 backup.sh 一致），外加网关卷 one-api-data。
#    tgz 文件名 == 卷名，导入时原名恢复，跨机器/改目录名都不用套前缀。
VOLS="$(docker volume ls -q | grep -E -- '-(uploads|outputs|ocdata)$' || true)"
docker volume inspect one-api-data >/dev/null 2>&1 && VOLS="$VOLS one-api-data"
if [ -z "${VOLS// }" ]; then
  echo "!! 没找到形如 <user>-(uploads|outputs|ocdata) 的卷。这台机上还没有用户数据？"
  exit 1
fi
COUNT=0; FAIL=0
for vol in $VOLS; do
  echo "  -> 卷 $vol"
  # 不吞 tar 报错（旧版 2>/dev/null 把“卷损坏/磁盘满”一起藏了）；单卷失败计数但继续导其余。
  if docker run --rm -v "$vol":/data:ro -v "$STAGE/volumes":/backup alpine \
       tar czf "/backup/${vol}.tgz" -C /data .; then
    COUNT=$((COUNT+1))
  else
    echo "  !! 卷 $vol 导出失败" >&2; FAIL=$((FAIL+1)); rm -f "$STAGE/volumes/${vol}.tgz"
  fi
done

# ② 配置与密钥（.env / users/ / tiers.env / docker-compose.yml）——不在 git 里，全量恢复必需
for f in .env tiers.env docker-compose.yml; do
  [ -f "./$f" ] && cp -a "./$f" "$STAGE/config/$f" || true
done
[ -d ./users ] && cp -a ./users "$STAGE/config/users" || echo "  (无 ./users 目录，跳过账号导出)"

# 清单：项目信息 + 卷列表，导入时核对
{
  echo "backup_time=$STAMP"
  echo "source_host=$(hostname 2>/dev/null || echo unknown)"
  echo "volumes:"
  for vol in $VOLS; do [ -f "$STAGE/volumes/${vol}.tgz" ] && echo "  - ${vol}"; done
} > "$STAGE/MANIFEST.txt"

# 打成单个 tar.gz
FINAL="$OUTDIR/sci-agent-backup-$STAMP.tar.gz"
tar czf "$FINAL" -C "$WORK" "sci-agent-backup-$STAMP"
SIZE="$(du -h "$FINAL" | cut -f1)"

echo
echo "== 完成 =="
echo "  用户/网关卷：$COUNT 个成功$([ "$FAIL" -gt 0 ] && echo "，$FAIL 个失败（见上）")"
echo "  产物：      $FINAL  ($SIZE)"
echo "  迁移：      scp 到新服务器的 deploy/ 目录，运行  ./import-all.sh sci-agent-backup-$STAMP.tar.gz"
# 有卷导出失败 → 以非零码退出，别让 cron/调用方以为“全量导出成功”
[ "$FAIL" -eq 0 ] || { echo "!! 有 $FAIL 个卷导出失败，备份不完整" >&2; exit 1; }
