#!/usr/bin/env bash
# 把所有用户子域的 DuckDNS 记录刷新到本机公网 IP（ip= 留空表示用请求来源 IP）。
# 注意：DuckDNS API 只能"更新"已存在的域名；新建子域必须先在 https://www.duckdns.org 面板手动创建（免费账号最多 5 个）。
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DUCKDNS_TOKEN:?请在 deploy/.env 设置 DUCKDNS_TOKEN}"

subs=()
shopt -s nullglob
for f in users/*.env; do
  d=$(sed -n 's/^DOMAIN=//p' "$f" | head -1)
  case "$d" in *.duckdns.org) subs+=("${d%.duckdns.org}");; esac
done
[ ${#subs[@]} -gt 0 ] || { echo "无 *.duckdns.org 域名，跳过"; exit 0; }

list=$(IFS=,; echo "${subs[*]}")
resp=$(curl -fsS "https://www.duckdns.org/update?domains=${list}&token=${DUCKDNS_TOKEN}&ip=")
echo "DuckDNS 更新 [$list]：$resp"
[ "$resp" = "OK" ] || { echo "!! DuckDNS 返回非 OK —— 子域可能尚未在面板创建"; exit 1; }
