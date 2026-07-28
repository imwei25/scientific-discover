#!/usr/bin/env bash
# ============================================================================
# 影子恢复演练：把一个备份包在【临时目录 + 临时端口】上真的恢复一遍并起起来。
#
# 为什么值得单独做这件事：
#   2026-07-28 迁移那次，"包完好"是我手工验的（还原到影子卷、diff、integrity_check）。
#   手工验的东西不会每天发生 —— 而备份是每天发生的。把演练做进导出流程，
#   每一个日常备份都自带"它真的能恢复"的证明，备份才不再是一个没验过的希望。
#
# 全程只读生产：不碰 $DATA_DIR、不碰生产端口、不碰 docker 卷。
#
# 用法：ops/rehearse-restore.sh <sci-auth-backup-*.tar.gz>
# 退出码 0 = 演练通过。
# ============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PKG="${1:-}"
[ -n "$PKG" ] && [ -f "$PKG" ] || { echo "用法: ops/rehearse-restore.sh <包>"; exit 1; }

umask 077
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar xzf "$PKG" -C "$TMP"
ROOT="$(find "$TMP" -maxdepth 1 -type d -name 'sci-auth-backup-*' | head -1)"
[ -d "$ROOT" ] || { echo "!! 包结构不对" >&2; exit 1; }

# ① 校验
if [ -f "$ROOT/SHA256SUMS" ]; then
  ( cd "$ROOT" && sha256sum -c SHA256SUMS --quiet ) || { echo "!! 包内 sha256 校验失败" >&2; exit 1; }
  echo "  · sha256 全部匹配"
fi
[ -f "$ROOT/sci.db" ] || { echo "!! 包里没有 sci.db" >&2; exit 1; }

# ② 恢复到影子目录（绝不碰生产 DATA_DIR）
SHADOW="$TMP/shadow"; mkdir -p "$SHADOW"
cp -a "$ROOT/sci.db" "$SHADOW/sci.db"

# ③ 记下期望的用户数，交给自检核对（防"库能开但内容是空的"这种假通过）
EXPECT="$(node -e "
  const {DatabaseSync}=require('node:sqlite');
  const d=new DatabaseSync(process.argv[1],{readOnly:true});
  console.log(d.prepare('SELECT COUNT(*) AS n FROM users').get().n)
" "$SHADOW/sci.db" 2>/dev/null || echo "")"

# ④ 解出密钥（只为拿 ADMIN_PASSWORD 做后台冒烟；解不出就降级为不测管理台）
SEC=""
if [ -f "$ROOT/secrets.env" ]; then
  SEC="$ROOT/secrets.env"
elif [ -f "$ROOT/secrets.env.enc" ] && [ -n "${MIGRATE_PASSPHRASE:-}" ]; then
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "$ROOT/secrets.env.enc" -out "$TMP/secrets.env" -pass env:MIGRATE_PASSPHRASE 2>/dev/null \
    && SEC="$TMP/secrets.env" || echo "  · （密钥解不开，跳过管理台冒烟）" >&2
fi

# ⑤ 真起一个实例并探活
DB_FILE="$SHADOW/sci.db" DATA_DIR="$SHADOW" SECRETS_FILE="$SEC" EXPECT_USERS="$EXPECT" \
  "$REPO_ROOT/ops/selftest.sh"
