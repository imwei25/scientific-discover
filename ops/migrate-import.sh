#!/usr/bin/env bash
# ============================================================================
# 一键导入（鉴权+网关架构）—— 在新机上恢复 migrate-export.sh 的包。
#
# 安全次序（每一条都是 2026-07-28 迁移演练里验证过的行为，别删）：
#   ① 先校验包内 sha256，**校验不过就在动任何数据之前中止**；
#   ② 现有数据先【移到 .rollback】而不是直接删，解包成功才清掉；失败原样还回去；
#   ③ **绝不无条件删 .rollback**：上一次导入若在"移开之后、解包完成之前"被打断，
#      数据的唯一副本就在里面 —— 照旧 rm 就是把本要保护的数据毁掉；
#   ④ 导入完自检（起服务打 /healthz），不自检的导入只是"看起来成功了"。
#
# 用法：
#   ops/migrate-import.sh <sci-auth-backup-*.tar.gz>
#   MIGRATE_PASSPHRASE=xxx ops/migrate-import.sh <包>     # 包里密钥是加密的时候
#   NO_SELFTEST=1 ops/migrate-import.sh <包>              # 跳过导入后自检（不推荐）
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-/var/lib/sci-auth}"
DB_FILE="${DB_FILE:-$DATA_DIR/sci.db}"
SECRETS_FILE="${SECRETS_FILE:-/etc/sci-auth.env}"
ONEAPI_VOLUME="${ONEAPI_VOLUME:-one-api-data}"

PKG="${1:-}"
[ -n "$PKG" ] && [ -f "$PKG" ] || { echo "用法: ops/migrate-import.sh <sci-auth-backup-*.tar.gz>"; exit 1; }
umask 077
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

echo "== 从 $(basename "$PKG") 恢复 =="
tar xzf "$PKG" -C "$WORK"
ROOT="$(find "$WORK" -maxdepth 1 -type d -name 'sci-auth-backup-*' | head -1)"
[ -d "$ROOT" ] || { echo "!! 包结构不对（找不到 sci-auth-backup-* 目录）" >&2; exit 1; }
[ -f "$ROOT/MANIFEST.txt" ] && { echo "--- 清单 ---"; cat "$ROOT/MANIFEST.txt"; echo "------------"; }

# ---- ① 先校验，再动数据 ----
if [ -f "$ROOT/SHA256SUMS" ]; then
  ( cd "$ROOT" && sha256sum -c SHA256SUMS --quiet ) \
    || { echo "!! 包内校验失败（文件损坏或被改动）—— 已中止，本机数据【未被触碰】" >&2; exit 1; }
  echo "  ✅ 包内 sha256 全部匹配"
else
  echo "  ⚠ 包里没有 SHA256SUMS（旧包？）——无法校验完整性" >&2
fi
[ -f "$ROOT/sci.db" ] || { echo "!! 包里没有 sci.db" >&2; exit 1; }

# schema 版本闸：别用旧程序去开新库
WANT="$(node "$REPO_ROOT/ops/schema-version.mjs" 2>/dev/null || echo "")"
GOT="$(sed -n 's/^schema_version=//p' "$ROOT/MANIFEST.txt" 2>/dev/null || echo "")"
if [ -n "$WANT" ] && [ -n "$GOT" ] && [ "$GOT" != "unknown" ] && [ "$GOT" -gt "$WANT" ] 2>/dev/null; then
  echo "!! 包的 schema 版本($GOT) 高于本仓库程序($WANT)：先把代码更新到对应版本再导" >&2
  exit 1
fi

# ---- ①b 密钥可用性也属于【动数据之前】的校验 ----
# 否则会出现"库已经换掉了、才发现密钥解不开"的半截导入：服务起不来，且现场已经被改过。
DECRYPTED=""
if [ -f "$ROOT/secrets.env.enc" ]; then
  [ -n "${MIGRATE_PASSPHRASE:-}" ] || { echo "!! 包内密钥是加密的，请设 MIGRATE_PASSPHRASE 后重跑（本机数据【未被触碰】）" >&2; exit 1; }
  command -v openssl >/dev/null || { echo "!! 包内密钥是加密的，但本机没有 openssl（本机数据【未被触碰】）" >&2; exit 1; }
  DECRYPTED="$WORK/secrets.env"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "$ROOT/secrets.env.enc" -out "$DECRYPTED" -pass env:MIGRATE_PASSPHRASE 2>/dev/null \
    || { echo "!! 密钥解密失败（口令不对？）—— 已中止，本机数据【未被触碰】" >&2; exit 1; }
  echo "  ✅ 包内密钥可解密"
fi

# ---- ② 库：先备份现有的，再落新的 ----
mkdir -p "$DATA_DIR"
if [ -f "$DB_FILE" ]; then
  cp -a "$DB_FILE" "$DB_FILE.bak-$STAMP"
  echo "  原库备份为 $DB_FILE.bak-$STAMP"
fi
# WAL/SHM 是旧库的残留，留着会和新库打架
rm -f "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm"
cp -a "$ROOT/sci.db" "$DB_FILE"
chmod 600 "$DB_FILE"
echo "  -> 已恢复 $DB_FILE"

# ---- ③ 密钥 ----
if [ -n "$DECRYPTED" ]; then
  [ -f "$SECRETS_FILE" ] && cp -a "$SECRETS_FILE" "$SECRETS_FILE.bak-$STAMP"
  cp -a "$DECRYPTED" "$SECRETS_FILE"          # 已在预检阶段解密并验证过
  chmod 600 "$SECRETS_FILE"; echo "  -> 已解密恢复 $SECRETS_FILE"
elif [ -f "$ROOT/secrets.env" ]; then
  [ -f "$SECRETS_FILE" ] && cp -a "$SECRETS_FILE" "$SECRETS_FILE.bak-$STAMP"
  cp -a "$ROOT/secrets.env" "$SECRETS_FILE"; chmod 600 "$SECRETS_FILE"
  echo "  -> 已恢复 $SECRETS_FILE"
else
  echo "  ⚠ 包里没有密钥：新机需自行准备 $SECRETS_FILE（ADMIN_PASSWORD/KEY_SECRET/LLM_UPSTREAM_KEY）" >&2
  echo "     注意 KEY_SECRET 若与原机不同，全体客户端已签发的 key 会立刻失效、需重新登录。" >&2
fi

# ---- ④ one-api 卷（沿用旧脚本验证过的 .rollback 保护）----
if [ -f "$ROOT/$ONEAPI_VOLUME.tgz" ]; then
  if ! command -v docker >/dev/null; then
    echo "  ⚠ 包里有 one-api 卷但本机没有 docker，跳过" >&2
  elif docker ps -q --filter "volume=$ONEAPI_VOLUME" | grep -q .; then
    echo "  !! 卷 $ONEAPI_VOLUME 正被运行中的容器挂载，已跳过。先 docker stop one-api 再重跑。" >&2
  else
    docker volume create "$ONEAPI_VOLUME" >/dev/null
    docker run --rm -v "$ONEAPI_VOLUME":/data -v "$ROOT":/backup:ro alpine sh -c "set -e
      if [ -d /data/.rollback ]; then
        echo '!! 检测到上次导入留下的 .rollback（上次可能被中断）。' >&2
        echo '   卷里数据的唯一副本可能就在其中，本脚本不会动它。' >&2
        echo '   请人工检查 /data/.rollback 后再重跑。' >&2
        exit 2
      fi
      mkdir -p /data/.rollback
      for f in /data/* /data/..?* /data/.[!.]*; do
        [ -e \"\$f\" ] || continue
        case \"\$f\" in */.rollback) continue;; esac
        mv \"\$f\" /data/.rollback/ 2>/dev/null || true
      done
      if tar xzf /backup/$ONEAPI_VOLUME.tgz -C /data; then
        rm -rf /data/.rollback
      else
        echo '解包失败，正在回滚既有数据…' >&2
        for f in /data/* /data/..?* /data/.[!.]*; do
          [ -e \"\$f\" ] || continue
          case \"\$f\" in */.rollback) continue;; esac
          rm -rf \"\$f\" 2>/dev/null || true
        done
        for f in /data/.rollback/* /data/.rollback/..?* /data/.rollback/.[!.]*; do
          [ -e \"\$f\" ] || continue
          mv \"\$f\" /data/ 2>/dev/null || true
        done
        rm -rf /data/.rollback
        exit 1
      fi" && echo "  -> 已恢复卷 $ONEAPI_VOLUME" \
       || echo "  !! 卷 $ONEAPI_VOLUME 恢复失败；既有数据已回滚" >&2
  fi
fi

# ---- ⑤ 导入后自检 ----
if [ -n "${NO_SELFTEST:-}" ]; then
  echo "  (已按 NO_SELFTEST 跳过自检 —— 这次导入没有被验证过)" >&2
else
  echo "== 导入后自检 =="
  DB_FILE="$DB_FILE" DATA_DIR="$DATA_DIR" SECRETS_FILE="$SECRETS_FILE" \
    "$REPO_ROOT/ops/selftest.sh" || { echo "  ❌ 自检未通过，先别启服务，照上面的报错查" >&2; exit 1; }
fi

echo
echo "== 完成 =="
echo "  下一步："
echo "    systemctl restart sci-auth && systemctl status sci-auth"
echo "    systemctl reload caddy"
echo "  提醒：若 KEY_SECRET 与原机不同，全体客户端需重新登录。"
