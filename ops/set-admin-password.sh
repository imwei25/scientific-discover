#!/usr/bin/env bash
# ============================================================================
# 改管理台口令。
#
# 为什么要有这个脚本、而不是让人手敲 sed：
#   · 一行 sed 里同时有 " 和 | ，从 Windows(PowerShell) 经 ssh 传过去时引号会被吃掉，
#     远端把 | 当管道执行 —— 真踩过，报的是莫名其妙的 "command not found / Permission denied"。
#   · systemd 的 EnvironmentFile【不剥行尾注释】，手改时在值后面跟一句说明，
#     注释会成为口令的一部分，表现是"口令怎么都不对"，而且没有任何报错。
#   · 口令同时是管理台会话 cookie 的签名密钥，改完必须重启才真的生效。
#
# 用法（在服务器上，root）：
#   ops/set-admin-password.sh                 # 交互式输入（不回显，推荐）
#   ops/set-admin-password.sh --random        # 随机生成一个 24 位的并打印
#   echo -n '口令' | ops/set-admin-password.sh --stdin
#
# 改完所有已登录的管理台会话立即失效（签名密钥变了），这是设计。
# ============================================================================
set -euo pipefail

SECRETS_FILE="${SECRETS_FILE:-/etc/sci-auth.env}"
SERVICE="${SERVICE:-sci-auth}"
NO_RESTART="${NO_RESTART:-}"

[ -f "$SECRETS_FILE" ] || { echo "!! 找不到 $SECRETS_FILE（SECRETS_FILE= 可覆盖）" >&2; exit 1; }

MODE="${1:-interactive}"
case "$MODE" in
  --random)
    PW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
    echo "生成的新口令（只显示这一次）："
    echo "    $PW"
    ;;
  --stdin)
    PW="$(cat)"
    ;;
  interactive)
    read -r -s -p "新的管理台口令：" PW; echo
    read -r -s -p "再输一遍确认：" PW2; echo
    [ "$PW" = "$PW2" ] || { echo "!! 两次输入不一致" >&2; exit 1; }
    ;;
  *)
    echo "用法: $0 [--random | --stdin]" >&2; exit 2 ;;
esac

# ---- 校验：这几样一旦混进去，症状都是"口令怎么都不对"且不报错 ----
[ -n "$PW" ] || { echo "!! 口令不能为空（空 = 管理台整个 404）" >&2; exit 1; }
case "$PW" in
  *$'\n'*|*$'\r'*) echo "!! 口令里不能有换行" >&2; exit 1 ;;
esac
[ "${#PW}" -ge 12 ] || { echo "!! 口令至少 12 位（它同时是会话签名密钥，别用弱口令）" >&2; exit 1; }
# 前后空白会被原样算进口令，几乎肯定是误粘贴
[ "$PW" = "$(printf '%s' "$PW" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" ] \
  || { echo "!! 口令首尾有空白字符，多半是粘贴带进来的；去掉再来" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
cp -a "$SECRETS_FILE" "$SECRETS_FILE.bak-$STAMP"

# 用 python 改写：口令里可能有 & / | \ 等在 sed 替换串里有特殊含义的字符，
# 交给 sed 处理迟早出事（& 会被展开成整个匹配）。
PW="$PW" SECRETS_FILE="$SECRETS_FILE" python3 - <<'PY'
import os, re
p, pw = os.environ["SECRETS_FILE"], os.environ["PW"]
s = open(p, encoding="utf-8").read()
line = "ADMIN_PASSWORD=" + pw
s, n = re.subn(r"^ADMIN_PASSWORD=.*$", lambda _m: line, s, flags=re.M)
if n == 0:                       # 原文件里没有这一行就追加
    if not s.endswith("\n"): s += "\n"
    s += line + "\n"
open(p, "w", encoding="utf-8").write(s)
print(f"  已写入 {p}（{'替换' if n else '追加'}，长度 {len(pw)}）")
PY
chmod 600 "$SECRETS_FILE"
echo "  原文件备份为 $SECRETS_FILE.bak-$STAMP"

# 回读确认：确保写进去的和我们要的一字不差（防行尾注释、防编码问题）
PW="$PW" SECRETS_FILE="$SECRETS_FILE" python3 - <<'PY'
import os, sys
p, pw = os.environ["SECRETS_FILE"], os.environ["PW"]
got = None
for l in open(p, encoding="utf-8"):
    if l.startswith("ADMIN_PASSWORD="):
        got = l.rstrip("\n").rstrip("\r")[len("ADMIN_PASSWORD="):]
if got != pw:
    print(f"!! 回读不一致：文件里是 {len(got or '')} 字符，期望 {len(pw)} 字符", file=sys.stderr)
    sys.exit(1)
print("  回读一致 ✅")
PY

if [ -n "$NO_RESTART" ]; then
  echo "  （NO_RESTART 已设，未重启；口令要重启 $SERVICE 才生效）"
else
  systemctl restart "$SERVICE"
  sleep 1.5
  systemctl is-active --quiet "$SERVICE" && echo "  $SERVICE 已重启，新口令生效" \
    || { echo "!! $SERVICE 没起来：" >&2; journalctl -u "$SERVICE" -n 20 --no-pager >&2; exit 1; }
fi
echo "  提醒：已登录的管理台会话全部失效，需用新口令重新登录。"
