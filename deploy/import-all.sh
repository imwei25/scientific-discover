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
    # 【拒绝对正在被挂载的卷动手】"先 docker compose up -d 再 import-all.sh" 是很自然的操作顺序，
    # 而下面是 rm -rf /data/* —— 在运行中的 SQLite 底下清目录会直接把库搞坏。
    if docker ps -q --filter "volume=$target" | grep -q .; then
      echo "  !! 卷 $target 正被运行中的容器挂载，已跳过。请先 docker compose stop 再导入。" >&2
      FAIL=$((FAIL+1)); continue
    fi
    docker volume create "$target" >/dev/null
    # tar tzf 前置校验只挡得住【包损坏】。清空之后的 tar xzf 若因【磁盘不足】中断，
    # 目标卷已经空了且只灌进一部分 —— 原提示"已跳过、未破坏既有数据"与事实相反，
    # 运维照此判断就不会去做补救。故：先把既有数据挪到 .rollback 而不是直接删，
    # 解包成功才清掉它；失败则原样还回去，并如实报告。
    if ! docker run --rm -v "$target":/data -v "$ROOT/volumes":/backup alpine \
         sh -c "set -e
                tar tzf /backup/$b >/dev/null
                # 【绝不无条件 rm -rf .rollback】上一次导入若在"移开之后、解包完成之前"被打断
                # （Ctrl-C / 宿主重启 / OOM / 守护进程重启），卷里数据的唯一副本就躺在 .rollback 里。
                # 若这里照旧 rm -rf，重跑一次导入就把它彻底删掉了 —— 本意是防丢数据，结果是毁数据。
                if [ -d /data/.rollback ]; then
                  echo '!! 检测到上次导入留下的 .rollback（上次可能被中断）。' >&2
                  echo '   卷里数据的唯一副本可能就在其中，本脚本不会动它。' >&2
                  echo '   请人工检查 /data/.rollback 并自行决定恢复或删除后再重跑。' >&2
                  exit 2
                fi
                mkdir -p /data/.rollback
                for f in /data/* /data/..?* /data/.[!.]*; do
                  [ -e \"\$f\" ] || continue
                  case \"\$f\" in */.rollback) continue;; esac
                  mv \"\$f\" /data/.rollback/ 2>/dev/null || true
                done
                if tar xzf /backup/$b -C /data; then
                  rm -rf /data/.rollback
                else
                  echo '解包失败，正在回滚既有数据…' >&2
                  # 清理半截解包的产物：三种通配都要带上。只写 /data/* 会漏掉隐藏文件，
                  # 让部分解包出来的点文件混进回滚后的树里。
                  for f in /data/* /data/..?* /data/.[!.]*; do
                    [ -e \"\$f\" ] || continue
                    case \"\$f\" in */.rollback) continue;; esac
                    rm -rf \"\$f\" 2>/dev/null || true
                  done
                  # 【隐藏文件也要搬回来】POSIX sh 的 * 不匹配点文件，只写 .rollback/* 的话，
                  # 移进去的隐藏条目会被原样留下、然后被下一行 rm -rf 永久删除 ——
                  # 而脚本却打印"已回滚"。ocdata 卷根目录恰恰可能有点文件。
                  for f in /data/.rollback/* /data/.rollback/..?* /data/.rollback/.[!.]*; do
                    [ -e \"\$f\" ] || continue
                    mv \"\$f\" /data/ 2>/dev/null || true
                  done
                  rm -rf /data/.rollback
                  exit 1
                fi"; then
      echo "  !! 卷 $target 恢复失败（tgz 损坏或磁盘不足）；既有数据已回滚，请先清理磁盘再重试" >&2; FAIL=$((FAIL+1))
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
