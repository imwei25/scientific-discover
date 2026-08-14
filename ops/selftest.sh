#!/usr/bin/env bash
# ============================================================================
# 自检：拿一份库真起一个 sci-auth（临时端口、不碰生产端口），打 /healthz 看它活不活。
#
# 这一步的意义：库文件"看起来在"和"服务能凭它跑起来"是两回事。schema 不匹配、
# 库被截断、Node 版本不对，都只有在真起进程时才暴露。迁移导入与备份导出都调它。
#
# 环境变量：
#   DB_FILE      要检的库（必需）
#   DATA_DIR     临时数据目录（默认库文件所在目录）
#   SECRETS_FILE 有就 source 进来（为了拿到 ADMIN_PASSWORD 做后台冒烟；没有也能跑）
#   EXPECT_USERS 期望的用户数（对不上就失败）；不设则只要求 ≥0
# ============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

DB_FILE="${DB_FILE:?需要 DB_FILE}"
[ -f "$DB_FILE" ] || { echo "!! 库不存在: $DB_FILE" >&2; exit 1; }
DATA_DIR="${DATA_DIR:-$(dirname "$DB_FILE")}"

command -v node >/dev/null || { echo "!! 未找到 node" >&2; exit 1; }
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "!! Node 需 ≥22（node:sqlite），当前 $(node --version)" >&2; exit 1; }

TMP="$(mktemp -d)"
PORT_FILE="$TMP/port"; LOG="$TMP/log"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ADMIN_PW=""
if [ -n "${SECRETS_FILE:-}" ] && [ -f "$SECRETS_FILE" ]; then
  ADMIN_PW="$(sed -n 's/^ADMIN_PASSWORD=//p' "$SECRETS_FILE" | tail -1 | sed 's/^["'\'']//;s/["'\'']$//')"
fi

echo "  · 起临时实例（端口 0，不与生产抢口）…"
env -i PATH="$PATH" HOME="$HOME" \
  LISTEN="127.0.0.1:0" PORT_FILE="$PORT_FILE" \
  DB_FILE="$DB_FILE" DATA_DIR="$DATA_DIR" \
  ADMIN_PASSWORD="$ADMIN_PW" KEY_SECRET="selftest-throwaway" \
  node --no-warnings "$REPO_ROOT/server/sci-auth.mjs" >"$LOG" 2>&1 &
PID=$!

for i in $(seq 1 60); do
  [ -s "$PORT_FILE" ] && break
  kill -0 "$PID" 2>/dev/null || { echo "!! 实例启动即退出，日志：" >&2; cat "$LOG" >&2; exit 1; }
  sleep 0.25
done
[ -s "$PORT_FILE" ] || { echo "!! 15 秒内没起来，日志：" >&2; cat "$LOG" >&2; exit 1; }
PORT="$(cat "$PORT_FILE")"

fail() { echo "!! $1" >&2; echo "--- 实例日志 ---" >&2; cat "$LOG" >&2; exit 1; }

# ---- /healthz ----
HZ="$(curl -fsS --max-time 10 "http://127.0.0.1:$PORT/healthz")" || fail "/healthz 打不通"
echo "$HZ" | grep -q '"ok":true' || fail "/healthz 返回异常: $HZ"
USERS="$(printf '%s' "$HZ" | sed -n 's/.*"users":\([0-9]*\).*/\1/p')"
echo "  · /healthz ok，库里 $USERS 个用户"
if [ -n "${EXPECT_USERS:-}" ] && [ "$USERS" != "$EXPECT_USERS" ]; then
  fail "用户数对不上：期望 $EXPECT_USERS，实际 $USERS"
fi

# ---- 未鉴权访问必须被挡（确认鉴权层真的在生效，而不是"能连上就算好"）----
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/api/me")"
[ "$CODE" = "401" ] || fail "/api/me 未鉴权时应 401，实际 $CODE"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "http://127.0.0.1:$PORT/llm/v1/chat/completions")"
[ "$CODE" = "401" ] || fail "/llm 未鉴权时应 401，实际 $CODE"
echo "  · 鉴权闸生效（/api/me 与 /llm 未带票据均 401）"

# ---- 管理台（有口令才测）----
if [ -n "$ADMIN_PW" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/admin")"
  [ "$CODE" = "200" ] || fail "/admin 应 200，实际 $CODE"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/admin/api/overview")"
  [ "$CODE" = "401" ] || fail "/admin/api/overview 未登录应 401，实际 $CODE"
  echo "  · 管理台可达且未登录时被拒"
else
  echo "  · （没拿到 ADMIN_PASSWORD，跳过管理台冒烟）"
fi

echo "  ✅ 自检通过"
