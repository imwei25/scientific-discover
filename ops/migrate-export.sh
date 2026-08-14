#!/usr/bin/env bash
# ============================================================================
# 一键导出（鉴权+网关架构）—— 把这台服务器上【全部可变状态】打成一个包。
#
# 新架构的状态只有三处，所以这个脚本比旧架构的 export-all.sh 简单得多：
#   ① $DATA_DIR/sci.db      —— 用户/档位/用量/审计/refresh（单一状态根）
#   ② $DATA_DIR/secrets.env 或 $SECRETS_FILE —— ADMIN_PASSWORD / KEY_SECRET / 上游 key
#   ③ one-api-data 卷       —— LLM 渠道配置（装了 one-api 才有）
# 其余（Caddyfile、systemd 单元、fail2ban）全部由仓库模板生成，不算状态、不进包。
#
# 【与旧脚本相比刻意做对的几件事】（都是 2026-07-28 那次迁移演练换来的）
#   · 一个包装全部：旧的 export-all.sh 只管 docker 卷，/etc/sci-manager.env 里的
#     ADMIN_PASSWORD 要靠人记得手工搬 —— 记不住就永久丢失。
#   · 库用 VACUUM INTO 热备，不 tar 活文件（WAL 下 tar 可能拼出坏库）。
#   · 包内自带 sha256 清单，导入时先校验再动数据。
#   · **导出后自动做一次影子恢复演练**：在本机把包恢复到临时目录、用临时端口真起一个
#     实例、打 /healthz —— 通过才算成功。没演练过的备份不算备份。
#
# 用法：
#   ops/migrate-export.sh [输出目录]          # 默认 /var/backups/sci-auth
#   NO_REHEARSAL=1 ops/migrate-export.sh      # 跳过影子演练（不推荐，仅用于极小机器）
#   MIGRATE_PASSPHRASE=xxx ops/migrate-export.sh   # 加密包内密钥层（强烈建议）
#
# ⚠ 不设 MIGRATE_PASSPHRASE 时，包里的 secrets 是明文：别放进 git、别用 IM 传。
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-/var/lib/sci-auth}"
DB_FILE="${DB_FILE:-$DATA_DIR/sci.db}"
SECRETS_FILE="${SECRETS_FILE:-/etc/sci-auth.env}"
ONEAPI_VOLUME="${ONEAPI_VOLUME:-one-api-data}"
OUTDIR="${1:-/var/backups/sci-auth}"

umask 077
mkdir -p "$OUTDIR"; chmod 700 "$OUTDIR" 2>/dev/null || true
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/sci-auth-backup-$STAMP"
mkdir -p "$STAGE"

echo "== 导出 sci-auth 状态 =="

# ---- ① 库（热备，不停服）----
[ -f "$DB_FILE" ] || { echo "!! 找不到库 $DB_FILE（DB_FILE= 可覆盖）" >&2; exit 1; }
command -v node >/dev/null || { echo "!! 未找到 node" >&2; exit 1; }
node "$REPO_ROOT/ops/db-snapshot.mjs" "$DB_FILE" "$STAGE/sci.db"

# ---- ② 密钥 ----
if [ -f "$SECRETS_FILE" ]; then
  if [ -n "${MIGRATE_PASSPHRASE:-}" ] && command -v openssl >/dev/null; then
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -in "$SECRETS_FILE" -out "$STAGE/secrets.env.enc" -pass env:MIGRATE_PASSPHRASE
    echo "  -> 密钥已加密进包（导入时需同一个 MIGRATE_PASSPHRASE）"
  else
    cp -a "$SECRETS_FILE" "$STAGE/secrets.env"
    echo "  -> 密钥【明文】进包 —— 设 MIGRATE_PASSPHRASE 可加密；本包务必按密件处置" >&2
  fi
else
  echo "  (没有 $SECRETS_FILE，跳过密钥；新机需自行准备 ADMIN_PASSWORD/KEY_SECRET/上游 key)" >&2
fi

# ---- ③ one-api 卷（可选）----
if command -v docker >/dev/null && docker volume inspect "$ONEAPI_VOLUME" >/dev/null 2>&1; then
  if docker ps -q --filter "volume=$ONEAPI_VOLUME" | grep -q .; then
    echo "  -> one-api 容器在跑：为拿到一致快照，建议导出前 docker stop one-api（本次照常导，SQLite 可能不一致）" >&2
  fi
  docker run --rm -v "$ONEAPI_VOLUME":/data:ro -v "$STAGE":/backup alpine \
    tar czf "/backup/$ONEAPI_VOLUME.tgz" -C /data .
  echo "  -> one-api 卷 $ONEAPI_VOLUME"
else
  echo "  (没有 $ONEAPI_VOLUME 卷，跳过；新机需重配 LLM 渠道)"
fi

# ---- 清单 + 逐成员 sha256（导入时先校验再动数据）----
{
  echo "backup_time=$STAMP"
  echo "source_host=$(hostname 2>/dev/null || echo unknown)"
  echo "repo_commit=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "schema_version=$(node "$REPO_ROOT/ops/schema-version.mjs" 2>/dev/null || echo unknown)"
  echo "node_version=$(node --version)"
  echo "encrypted_secrets=$([ -f "$STAGE/secrets.env.enc" ] && echo yes || echo no)"
  echo "members:"
  (cd "$STAGE" && for f in *; do [ -f "$f" ] && echo "  - $f"; done)
} > "$STAGE/MANIFEST.txt"
(cd "$STAGE" && sha256sum $(ls | grep -v '^SHA256SUMS$') > SHA256SUMS)

FINAL="$OUTDIR/sci-auth-backup-$STAMP.tar.gz"
tar czf "$FINAL" -C "$WORK" "sci-auth-backup-$STAMP"
chmod 600 "$FINAL"

# ---- 影子恢复演练：把刚生成的包真的恢复一次并起起来 ----
if [ -n "${NO_REHEARSAL:-}" ]; then
  echo "  (已按 NO_REHEARSAL 跳过影子恢复演练 —— 这个包没有被验证过)" >&2
else
  echo "== 影子恢复演练（同机、临时目录、临时端口）=="
  if "$REPO_ROOT/ops/rehearse-restore.sh" "$FINAL"; then
    echo "rehearsal=ok" >> "$OUTDIR/sci-auth-backup-$STAMP.verified"
    echo "  ✅ 演练通过：这个包能恢复、且恢复后服务能起来"
  else
    echo "  ❌ 影子恢复演练【失败】——这个包不可信，别拿它当备份" >&2
    mv "$FINAL" "$FINAL.UNVERIFIED"
    echo "     产物已改名为 $FINAL.UNVERIFIED" >&2
    exit 1
  fi
fi

echo
echo "== 完成 =="
echo "  产物：$FINAL  ($(du -h "$FINAL" | cut -f1))"
echo "  校验：$(sha256sum "$FINAL" | cut -d' ' -f1)"
echo "  迁移：scp 到新机，在新机仓库里跑  ops/migrate-import.sh <包>"
