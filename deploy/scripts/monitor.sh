#!/usr/bin/env bash
# 轻量应用层监控：cron 每 5 分钟跑一遍，异常推企业微信群机器人。带去重：同一问题不重复刷屏
# （每 6 小时最多重发一次），恢复后发一条「已恢复」。纯 shell，零依赖、几乎不占内存。
#
# 配置在 /etc/sci-monitor.conf（含 webhook，chmod 600，不入库）。用法：
#   scripts/monitor.sh          # 跑一轮检查（cron 调用）
#   scripts/monitor.sh --test   # 发一条测试消息，验证 webhook 通不通
#   scripts/monitor.sh --dry    # 只打印会报什么，不真发（排错用）
#
# 主机级指标（CPU/内存/磁盘）建议同时用阿里云云监控（零占用，控制台配），本脚本管应用层。
set -uo pipefail
CONF=/etc/sci-monitor.conf
[ -f "$CONF" ] && . "$CONF"
WECOM_WEBHOOK="${WECOM_WEBHOOK:-}"
DOMAIN="${DOMAIN:-weigu.duckdns.org}"
DISK_PCT="${DISK_PCT:-85}"                 # 根分区使用率阈值 %
SWAP_PCT="${SWAP_PCT:-70}"                 # swap 使用率阈值 %
COST_USER="${COST_USER_USD:-5}"            # 单用户今日成本阈值 USD
COST_TOTAL="${COST_TOTAL_USD:-20}"         # 全站今日总成本阈值 USD
CERT_DAYS="${CERT_DAYS:-10}"               # 证书剩余天数低于此报警
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sci}"
REALERT="${REALERT_SEC:-21600}"            # 同一问题重发间隔（默认 6h）
STATE_DIR=/var/lib/sci-monitor
HOST=$(hostname)
now=$(date +%s)
mkdir -p "$STATE_DIR"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

wecom_send() {
  local msg="$1"
  if [ -z "$WECOM_WEBHOOK" ]; then echo "[monitor] 未配置 WECOM_WEBHOOK，跳过发送：$msg"; return; fi
  # JSON 转义：反斜杠 → 引号 → 换行
  local esc; esc=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')
  curl -s -m 10 -H 'Content-Type: application/json' \
    -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"$esc\"}}" "$WECOM_WEBHOOK" >/dev/null \
    || echo "[monitor] webhook 发送失败"
}

if [ "${1:-}" = "--test" ]; then
  wecom_send "🔔 [$HOST] sci-monitor 测试消息 —— 通道正常。收到即说明企业微信告警已打通。"
  echo "已尝试发送测试消息（没收到就检查 /etc/sci-monitor.conf 的 WECOM_WEBHOOK）"; exit 0
fi

declare -A bad   # key -> 人话描述

# 1) 磁盘
dp=$(df -P / 2>/dev/null | awk 'NR==2{gsub("%","",$5);print $5}')
[ "${dp:-0}" -ge "$DISK_PCT" ] 2>/dev/null && bad[disk]="磁盘使用率 ${dp}%（阈值 ${DISK_PCT}%），清理或扩容"
# 2) swap
read -r st su < <(free -m 2>/dev/null | awk '/^Swap:/{print $2, $3}')
if [ "${st:-0}" -gt 0 ] 2>/dev/null; then sp=$((su*100/st)); [ "$sp" -ge "$SWAP_PCT" ] && bad[swap]="swap 使用 ${sp}%（${su}M/${st}M）—— 内存吃紧，可能变慢"; fi
# 3) 关键服务
for s in sci-manager caddy docker; do systemctl is-active --quiet "$s" 2>/dev/null || bad[svc:$s]="服务 $s 未运行"; done
# 4) 容器被 OOM 杀（和内存上限相关）
for c in $(docker ps -a --filter name=agent- --format '{{.Names}}' 2>/dev/null); do
  [ "$(docker inspect -f '{{.State.OOMKilled}}' "$c" 2>/dev/null)" = "true" ] && bad[oom:$c]="容器 $c 被 OOM 杀死（内存不足），考虑调 mem_limit 或降 WARM_CAP"
done
# 5) 站点从外部可达（探 manager 的登录页，不唤醒容器）
curl -sf -m 15 -o /dev/null "https://$DOMAIN/" 2>/dev/null || bad[site]="站点 https://$DOMAIN/ 探活失败（外部可能打不开）"
# 6) 今日成本（读各用户 ocdata 卷 quota.json）
total=0
for v in $(docker volume ls -q 2>/dev/null | grep -- '-ocdata$'); do
  mp=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null) || continue
  q="$mp/quota.json"; [ -f "$q" ] || continue
  [ "$(sed -n 's/.*"day":"\([^"]*\)".*/\1/p' "$q")" = "$(date -u +%F)" ] || continue
  cost=$(sed -n 's/.*"cost":\([0-9.]*\).*/\1/p' "$q"); cost=${cost:-0}; name=${v%-ocdata}
  [ "$(awk -v c="$cost" -v t="$COST_USER" 'BEGIN{print (c>=t)?1:0}')" = 1 ] && bad[cost:$name]="用户 $name 今日成本 \$$cost（阈值 \$$COST_USER）"
  total=$(awk -v a="$total" -v b="$cost" 'BEGIN{printf "%.4f", a+b}')
done
[ "$(awk -v c="$total" -v t="$COST_TOTAL" 'BEGIN{print (c>=t)?1:0}')" = 1 ] && bad[cost_total]="今日全站总成本 \$$total（阈值 \$$COST_TOTAL）"
# 7) 昨夜备份是否成功（最新备份目录 26h 内）
if [ -d "$BACKUP_DIR" ]; then
  [ -z "$(find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*' -mmin -1560 2>/dev/null | head -1)" ] && bad[backup]="最近 26 小时无成功备份（$BACKUP_DIR），检查 backup cron"
else
  bad[backup]="备份目录不存在：$BACKUP_DIR"
fi
# 8) HTTPS 证书剩余天数
end=$(echo | timeout 15 openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$end" ]; then ee=$(date -d "$end" +%s 2>/dev/null || true); [ -n "${ee:-}" ] && { days=$(((ee-now)/86400)); [ "$days" -lt "$CERT_DAYS" ] && bad[cert]="HTTPS 证书 ${days} 天后到期（Caddy 一般自动续，留意）"; }; fi

# ---- 去重 + 发送 ----
STATE="$STATE_DIR/state"; touch "$STATE"
declare -A prevts
while IFS='|' read -r k ts; do [ -n "$k" ] && prevts[$k]=$ts; done < "$STATE"

fire=""
for k in "${!bad[@]}"; do
  last=${prevts[$k]:-0}
  if [ "$last" = 0 ] || [ $((now-last)) -ge "$REALERT" ]; then fire+="• ${bad[$k]}"$'\n'; prevts[$k]=$now; else prevts[$k]=$last; fi
done
recovered=""
for k in "${!prevts[@]}"; do [ -z "${bad[$k]+x}" ] && { recovered+="• ${k}"$'\n'; unset 'prevts[$k]'; }; done

if [ "$DRY" = 1 ]; then
  echo "当前问题："; [ -n "$fire" ] && printf '%s' "$fire" || echo "（无）"
  echo "已恢复："; [ -n "$recovered" ] && printf '%s' "$recovered" || echo "（无）"
else
  [ -n "$fire" ] && wecom_send "⚠️ [$HOST] 科研平台告警"$'\n'"$fire"
  [ -n "$recovered" ] && wecom_send "✅ [$HOST] 以下问题已恢复"$'\n'"$recovered"
fi

# 写回状态（只留当前仍异常的 key）
: > "$STATE"; for k in "${!bad[@]}"; do echo "$k|${prevts[$k]}" >> "$STATE"; done
