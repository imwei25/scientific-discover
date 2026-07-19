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
#   ./export-all.sh                 # 导出到 ./backups/
#   ./export-all.sh /path/to/dir    # 导出到指定目录
#
# 迁移到新服务器：把生成的 sci-agent-backup-*.tar.gz 拷过去，在新机 deploy/ 里跑 ./import-all.sh 它。
# 容器无需停机即可导出（tar 直接读卷）；但 ocdata 是 SQLite(WAL)，为拿到一致快照建议先 `docker compose stop`。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"                                   # 切到 deploy/ 目录

command -v docker >/dev/null || { echo "!! 未找到 docker"; exit 1; }
OUTDIR="${1:-./backups}"
mkdir -p "$OUTDIR"
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
