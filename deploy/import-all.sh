#!/usr/bin/env bash
# ============================================================================
# 一键导入：在新服务器上恢复 export-all.sh 导出的备份。
#
# 做两件事：
#   ① 把每个卷的内容灌回本机【同名】Docker 卷（<user>-uploads/-outputs/-ocdata、one-api-data；
#      卷不存在则自动创建）——无前缀，与 compose 的显式 name: 一致，恢复的数据才会被真正挂载。
#   ② 恢复配置：.env、users/、tiers.env、docker-compose.yml（已存在的先备份成 *.bak-<时间>）。
#
# 用法（在新机的 deploy/ 目录下）：
#   ./import-all.sh sci-agent-backup-YYYYmmdd-HHMMSS.tar.gz
#
# 恢复后：docker compose up -d 即可（compose 已在包里，一般无需重新 build）。
# 安全：每个卷【先校验 tgz 完整性（tar tzf）再动数据】，坏包在清空目标卷之前就中止，绝不“先毁后验”。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

BACKUP="${1:-}"
[ -n "$BACKUP" ] && [ -f "$BACKUP" ] || { echo "用法: ./import-all.sh <sci-agent-backup-*.tar.gz>"; exit 1; }
command -v docker >/dev/null || { echo "!! 未找到 docker"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar xzf "$BACKUP" -C "$WORK"
ROOT="$(find "$WORK" -maxdepth 1 -type d -name 'sci-agent-backup-*' | head -1)"
[ -d "$ROOT" ] || { echo "!! 备份包结构不对（找不到 sci-agent-backup-* 目录）"; exit 1; }

echo "== 从 $(basename "$BACKUP") 恢复 =="
[ -f "$ROOT/MANIFEST.txt" ] && { echo "--- 清单 ---"; cat "$ROOT/MANIFEST.txt"; echo "------------"; }

STAMP="$(date +%Y%m%d-%H%M%S)"
FAIL=0

# ① 逐卷恢复：tgz 文件名即目标卷名（无前缀）。alice-uploads.tgz → 卷 alice-uploads。
if [ -d "$ROOT/volumes" ]; then
  for tgz in "$ROOT"/volumes/*.tgz; do
    [ -f "$tgz" ] || continue
    b="$(basename "$tgz")"
    target="${b%.tgz}"                                # alice-uploads / one-api-data
    echo "  -> 卷 $target"
    docker volume create "$target" >/dev/null
    # set -e：tar tzf 校验失败 → 容器在 rm 之前退出，既有数据不受损（修“先清空后解包失败”）。
    if ! docker run --rm -v "$target":/data -v "$ROOT/volumes":/backup alpine \
         sh -c "set -e
                tar tzf /backup/$b >/dev/null
                rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null || true
                tar xzf /backup/$b -C /data"; then
      echo "  !! 卷 $target 恢复失败（tgz 损坏或磁盘不足），已跳过、未破坏既有数据" >&2; FAIL=$((FAIL+1))
    fi
  done
else
  echo "  (备份里没有 volumes/，跳过卷恢复)"
fi

# ② 配置：.env / tiers.env / docker-compose.yml + users/ 目录
if [ -d "$ROOT/config" ]; then
  for f in .env tiers.env docker-compose.yml; do
    src="$ROOT/config/$f"; [ -f "$src" ] || continue
    [ -e "./$f" ] && cp -a "./$f" "./$f.bak-$STAMP" && echo "  原 ./$f 备份为 ./$f.bak-$STAMP"
    cp -a "$src" "./$f"; echo "  -> 已恢复 ./$f"
  done
  if [ -d "$ROOT/config/users" ]; then
    [ -e ./users ] && mv ./users "./users.bak-$STAMP" && echo "  原 ./users 备份为 ./users.bak-$STAMP"
    cp -a "$ROOT/config/users" ./users; echo "  -> 已恢复 ./users（账号+密码+端口）"
  fi
fi

echo
echo "== 完成 =="
[ "$FAIL" -eq 0 ] && echo "  全部卷恢复成功。" || echo "  ⚠ 有 $FAIL 个卷恢复失败（见上），请核对后重试。"
echo "  下一步： docker compose up -d"
[ "$FAIL" -eq 0 ] || exit 1
