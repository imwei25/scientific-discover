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
DOMAIN="${DOMAIN:-niuma.tellgen.com}"
DISK_PCT="${DISK_PCT:-85}"                 # 根分区使用率阈值 %
SWAP_PCT="${SWAP_PCT:-70}"                 # swap 使用率阈值 %
COST_USER="${COST_USER_USD:-5}"            # 单用户今日成本阈值 USD
COST_TOTAL="${COST_TOTAL_USD:-20}"         # 全站今日总成本阈值 USD
CERT_DAYS="${CERT_DAYS:-10}"               # 证书剩余天数低于此报警
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sci}"
REALERT="${REALERT_SEC:-21600}"            # 同一问题重发间隔（默认 6h）
# ---- LLM 网关(one-api)健康检查 ----
ONEAPI_URL="${ONEAPI_URL:-}"               # 如 http://127.0.0.1:3010；设了才查网关。①容器在跑 ②HTTP活着 每30分钟；③真实出模型 每小时
GATEWAY_TOKEN="${GATEWAY_TOKEN:-}"         # 网关令牌(sk-...)，用于第③层真实探活；不设则只做①②
GW_MODEL="${GW_MODEL:-deepseek-v4-pro}"    # 第③层探活用的模型名
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

# 独立告警状态机（供按自定义频率跑的检查用，与下方主 5 分钟去重解耦）：$1=key $2=异常(1/0) $3=告警文案
# 异常且(首次或距上次告警≥REALERT)→告警并记时；正常且此前告过警→发「已恢复」并清状态；未评估的周期不动其状态。
alert_check() {
  local key="$1" isbad="$2" msg="$3"
  local f="$STATE_DIR/chk-$key"
  if [ "$isbad" = 1 ]; then
    local last=0; [ -f "$f" ] && last=$(cat "$f" 2>/dev/null || echo 0)
    if [ "$last" = 0 ] || [ $((now-last)) -ge "$REALERT" ]; then
      if [ "$DRY" = 1 ]; then echo "[would-alert] $msg"; else wecom_send "⚠️ [$HOST] $msg"; fi
      echo "$now" > "$f"
    fi
  else
    if [ -f "$f" ]; then
      if [ "$DRY" = 1 ]; then echo "[would-recover] $key"; else wecom_send "✅ [$HOST] 已恢复：$key"; fi
      rm -f "$f"
    fi
  fi
}

declare -A bad   # key -> 人话描述
declare -A oomc  # 容器名 -> 窗口内 OOM 次数（见下方 4)）

# 1) 磁盘
dp=$(df -P / 2>/dev/null | awk 'NR==2{gsub("%","",$5);print $5}')
[ "${dp:-0}" -ge "$DISK_PCT" ] 2>/dev/null && bad[disk]="磁盘使用率 ${dp}%（阈值 ${DISK_PCT}%），清理或扩容"
# 2) swap
read -r st su < <(free -m 2>/dev/null | awk '/^Swap:/{print $2, $3}')
if [ "${st:-0}" -gt 0 ] 2>/dev/null; then sp=$((su*100/st)); [ "$sp" -ge "$SWAP_PCT" ] && bad[swap]="swap 使用 ${sp}%（${su}M/${st}M）—— 内存吃紧，可能变慢"; fi
# 3) 关键服务
for s in sci-manager caddy docker; do systemctl is-active --quiet "$s" 2>/dev/null || bad[svc:$s]="服务 $s 未运行"; done
# 4) 容器被 OOM 杀（和内存上限相关）
#
# 【为什么不用 docker inspect .State.OOMKilled】它只反映容器【最近一次退出】的状态，而 manager
# 是按需拉起 / 到点回收 / 腾位重建容器的——容器一旦重启，这个标志就被新状态覆盖。5 分钟一轮的
# cron 撞上"OOM 之后、下次启动之前"那个窗口的概率极低，等于这条检查基本永远报不出来。
# 改成从 docker 事件流取证：OOM 事件一旦发生就写进持久日志，容器怎么重建都抹不掉。
OOM_WINDOW="${OOM_WINDOW_SEC:-21600}"        # 报警回看窗口（默认 6h，与 REALERT 对齐）
oom_log="$STATE_DIR/oom.log"                 # 持久化：<epoch> <容器名>
oom_last="$STATE_DIR/oom.last"               # 上次扫到哪一刻，避免重复计同一事件
since=$(cat "$oom_last" 2>/dev/null); since=${since:-$((now - 300))}
# --until 给定后 docker events 会立即返回（不是长驻跟随），可安全放在 cron 里
# 【只有真的读成功才推进 oom.last】否则：docker 守护进程在这 5 分钟窗口内重启（或 socket 不可用）
# → 事件读不到，但游标照样推到 now → 这段时间发生的 OOM 此后【再也扫不到】。
# 而守护进程重启前后恰恰是内存压力最大、最可能 OOM 的时刻，等于专挑最该抓的时候漏掉。
# 注：脚本是 set -uo pipefail 无 -e，失败不会中止，必须显式判退出码。
if oom_out=$(docker events --since "$since" --until "$now" \
      --filter type=container --filter event=oom \
      --format '{{.Time}} {{.Actor.Attributes.name}}' 2>/dev/null); then
  # 记【事件真实时间 {{.Time}}】而非扫描时刻 $now（原来最多差 5 分钟）。另外 --since/--until
  # 在 docker 里都是闭区间，而下一轮的 since 恰是本轮的 now → 恰落在整秒边界上的事件会被
  # 相邻两轮各读一次，靠「事件秒级时间戳+容器名」整行查重挡掉。已知取舍：docker 的 oom 事件
  # 是 cgroup 级通知、内核杀的是组内最大进程而非必然 pid1，同一容器同一秒理论上可收到第二次
  # 通知并被本去重吞掉——后果只是告警文案里的计数偏低 1，告警本身照发，比边界重复计数便宜。
  while read -r ts c; do
    [ -n "$c" ] || continue
    grep -qxF "$ts $c" "$oom_log" 2>/dev/null || echo "$ts $c" >> "$oom_log"
  done <<< "$oom_out"
  echo "$now" > "$oom_last"          # 只在成功读到之后推进游标
else
  echo "!! docker events 读取失败，本轮不推进 OOM 游标（下轮会重扫这段区间）" >&2
fi
# 只报窗口内发生过的：事件是瞬时的，若只报"本轮新扫到的"，告警去重会在下一轮把它当作
# 已恢复而补发一条"已恢复"，把一次真实 OOM 说成虚惊。按窗口回看则键会稳定保持 6h。
if [ -f "$oom_log" ]; then
  cut=$((now - OOM_WINDOW))
  while read -r ts c; do
    [ "${ts:-0}" -ge "$cut" ] 2>/dev/null && oomc[$c]=$(( ${oomc[$c]:-0} + 1 ))
  done < "$oom_log"
  for c in "${!oomc[@]}"; do
    bad[oom:$c]="容器 $c 在过去 $((OOM_WINDOW/3600))h 内被 OOM 杀死 ${oomc[$c]} 次（内存不足），考虑调 mem_limit 或降 WARM_CAP"
  done
  # 日志只留最近 500 条，防止长期累积
  [ "$(wc -l < "$oom_log")" -gt 500 ] 2>/dev/null && { tail -n 500 "$oom_log" > "$oom_log.tmp" && mv "$oom_log.tmp" "$oom_log"; }
fi
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
  # 判据是 backup.sh 全部成功后才写的 OK 标记文件，【不是】目录新鲜度：
  # backup.sh 一开头就无条件 mkdir 当天目录，失败时也会留下一个刚刚创建的空目录，
  # 按目录判会把"备份失败"读成"备份成功"（磁盘满时最容易发生，也最需要告警）。
  [ -z "$(find "$BACKUP_DIR" -maxdepth 2 -type f -name OK -mmin -1560 2>/dev/null | head -1)" ] && bad[backup]="最近 26 小时无成功备份（$BACKUP_DIR 下无新鲜 OK 标记）：检查 backup cron 与磁盘空间。注：刚升级过 backup.sh 的话，首次告警属正常——OK 标记要等下一次备份成功才会有，跑一次 scripts/backup.sh 即可消除"
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

# ---- LLM 网关健康：①容器 ②HTTP 每30分钟(整/半点)，③真实出模型 每小时(整点)；--dry 时全跑 ----
if [ -n "$ONEAPI_URL" ]; then
  min=$((10#$(date +%M)))
  run12=0; run3=0
  if [ "$DRY" = 1 ]; then run12=1; run3=1
  else [ $((min % 30)) -eq 0 ] && run12=1; [ $((min % 60)) -eq 0 ] && run3=1; fi
  gw_up="$(docker inspect -f '{{.State.Running}}' one-api 2>/dev/null)"
  if [ "$run12" = 1 ]; then
    if [ "$gw_up" = "true" ]; then
      alert_check gw_container 0 ""
      if curl -sf -m 10 -o /dev/null "$ONEAPI_URL/api/status" 2>/dev/null; then alert_check gw_http 0 ""
      else alert_check gw_http 1 "网关(one-api) HTTP 不响应（$ONEAPI_URL/api/status）—— 容器在跑但可能卡死"; fi
    else
      alert_check gw_container 1 "网关(one-api) 容器未运行 —— 所有用户对话都会失败"
      alert_check gw_http 0 ""
    fi
  fi
  # ③真实探活：只在网关容器活着时做（容器都没跑，①已告警，别重复），max_tokens:1 花费可忽略
  if [ "$run3" = 1 ] && [ -n "$GATEWAY_TOKEN" ] && [ "$gw_up" = "true" ]; then
    code=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$ONEAPI_URL/v1/chat/completions" \
      -H "Authorization: Bearer $GATEWAY_TOKEN" -H "Content-Type: application/json" \
      -d "{\"model\":\"$GW_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1}" 2>/dev/null)
    if [ "$code" = "200" ]; then alert_check gw_upstream 0 ""
    else alert_check gw_upstream 1 "网关→模型不通（真实请求 HTTP ${code:-超时}）—— 查 DeepSeek key/欠费/上游可用性"; fi
  fi
fi
