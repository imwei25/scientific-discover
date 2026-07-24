#!/usr/bin/env bash
# 一键部署 App（宿主依赖已装、deploy/.env 已填后运行）。幂等，可重复跑。
# 步骤：构建镜像 → 装并启动 manager → 配置 Caddy（单域名反代到 manager）→ 装 fail2ban 规则。
# 用法：  sudo bash deploy/setup.sh [域名]      （域名省略则取 deploy/.env 的 BASE_DOMAIN）
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 root 或 sudo 运行"; exit 1; }
cd "$(dirname "$0")/.."            # -> 仓库根
REPO="$(pwd)"
cd deploy

[ -f .env ] || { echo "缺 deploy/.env：先 cp .env.example .env 并填 DEEPSEEK_API_KEY / BASE_DOMAIN"; exit 1; }
# deploy/.env 含上游 DeepSeek key / LAN_PASSWORD 等：默认 umask 常留 644 全局可读。收紧到 600（目录 700），
# 免得手动 cp 出来的 .env 被非 root 进程读走。幂等，每次部署都兜一遍。
chmod 600 .env; chmod 700 . 2>/dev/null || true
DOMAIN="${1:-$(sed -n 's/^BASE_DOMAIN=//p' .env | head -1)}"
[ -n "$DOMAIN" ] || { echo "缺域名：传参 或 在 .env 设 BASE_DOMAIN"; exit 1; }
grep -q '^DEEPSEEK_API_KEY=sk' .env || echo "⚠ 提示：deploy/.env 里 DEEPSEEK_API_KEY 看起来还没填真实值"

echo "== 1/5 构建共享镜像 sci-agent:latest =="
scripts/build-image.sh

echo "== 2/5 安装并启动 manager（WorkingDir=$REPO/deploy）=="
NODE="$(command -v node)"
UNIT=/etc/systemd/system/sci-manager.service
ENVF=/etc/sci-manager.env

rendered="$(sed -e "s#/opt/scientific-discover#$REPO#g" -e "s#/usr/bin/node#$NODE#g" sci-manager.service)"

# 安全写入一个 KEY=VALUE 到 ENVF（值可能含 / | & 等，故不用 sed 替换，避免转义地狱）
put_env() {
  local k="$1" v="$2"
  { grep -v "^${k}=" "$ENVF" 2>/dev/null || true; printf '%s=%s\n' "$k" "$v"; } > "$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"; chmod 600 "$ENVF"
}

# ⓪ 档位定义 tiers.env：不入 git（管理台会在运行时重写它），首次部署从模板生成。
#    缺了它 render-compose.sh 会静默把所有用户当"不限额"处理——那是个很贵的静默降级，必须补上。
if [ ! -f tiers.env ]; then
  if [ -f tiers.env.example ]; then cp tiers.env.example tiers.env; echo "   已从模板创建 deploy/tiers.env"
  else echo "   ⚠ 缺 deploy/tiers.env 且无模板：所有用户将按【不限额】处理，请尽快补上" >&2; fi
else
  echo "   deploy/tiers.env 已存在 → 保留不动"
fi

# ① 可变配置（管理密码 / WARM_CAP / IDLE_MS…）放独立的 EnvironmentFile：只在【不存在时】创建，之后永不覆盖。
envCreated=0
if [ ! -f "$ENVF" ]; then
  cp sci-manager.env.example "$ENVF"; chmod 600 "$ENVF"; envCreated=1
  echo "   已创建 $ENVF（管理台默认【关闭】）"
else
  echo "   $ENVF 已存在 → 保留不动（可变配置以它为准）"
fi

# ② 判断已装单元是不是【旧版】：可变配置还写死在单元里（没有 EnvironmentFile=），或还带着占位密码。
#    旧版必须升级——否则新加的 EnvironmentFile 永远不会被 systemd 读到，
#    /etc/sci-manager.env 建了也是摆设，WARM_CAP/管理密码 全都还听旧单元的（改了个寂寞）。
unitStale=0
if [ ! -f "$UNIT" ]; then unitStale=1
elif ! grep -q '^EnvironmentFile=' "$UNIT"; then unitStale=1
elif grep -q 'change-me-a-strong-admin-password' "$UNIT"; then unitStale=1
fi

# ③ 升级旧单元前，先把运维在旧单元里 inline 写死的 Environment= 值【迁移】进 ENVF。
#    不迁移就等于把线上调过的 WARM_CAP / 管理密码 / 网关凭据悄悄清零——正是本次要根治的毛病。
#    【不再依赖 envCreated】：env 文件早已存在（比如先前只往里加过 TEST_LOGIN_TOKEN）也要迁，
#    否则升级会跳过整块、把旧单元里的 inline 密钥全丢。逐 key 判断：ENVF 里【尚无】该项才迁，
#    绝不覆盖运维已在 env 里设好的值。ONEAPI_URL/ONEAPI_TOKEN 必须在列——旧生产单元把它俩写成
#    inline，漏搬会让升级后「同供应商切换 / /admin 网关管理」静默失效（实测踩过）。
if [ "$unitStale" = 1 ] && [ -f "$UNIT" ]; then
  for k in ADMIN_PASSWORD WARM_CAP IDLE_MS START_TIMEOUT_MS CAP_WAIT_MS ONEAPI_URL ONEAPI_TOKEN; do
    grep -q "^$k=" "$ENVF" 2>/dev/null && continue            # ENVF 已有该项 → 保留，不迁不覆盖
    v="$(sed -n "s/^Environment=$k=//p" "$UNIT" | head -1)"
    [ -n "$v" ] || continue
    [ "$v" = "change-me-a-strong-admin-password" ] && continue   # 占位值不迁移：迁过去等于继续裸奔
    put_env "$k" "$v"; echo "   从旧单元迁移 $k → $ENVF"
  done
fi

# ④ 占位密码只查 ENVF（运维被告知要改的就是它）。
#    绝不查 $UNIT——旧单元里必然有这个占位串，那样每台老服务器都会在这里 exit 1，
#    而提示又让人去改 ENVF，改完还是卡在同一处 → 死循环，谁都升不上去。
if grep -qs 'change-me-a-strong-admin-password' "$ENVF"; then
  echo "!! $ENVF 里的 ADMIN_PASSWORD 还是占位值 change-me-a-strong-admin-password" >&2
  echo "   这会让任何知道本仓库的人过个验证码就进 /admin（可加删用户、改档位、塞网关渠道）。" >&2
  echo "   请改成强密码（openssl rand -base64 24），或留空以关闭管理台，然后重跑。" >&2
  exit 1
fi

# ⑤ 装单元：旧版 → 备份后升级；新版且被手改过 → 只提示差异不覆盖（保住运维的调整）。
if [ "$unitStale" = 1 ]; then
  if [ -f "$UNIT" ]; then cp -a "$UNIT" "$UNIT.bak.$(date +%s)"; echo "   旧单元已备份为 $UNIT.bak.*"; fi
  printf '%s\n' "$rendered" > "$UNIT"
  echo "   已安装/升级 systemd 单元（可变配置改由 $ENVF 提供）"
elif ! printf '%s\n' "$rendered" | diff -q - "$UNIT" >/dev/null 2>&1; then
  echo "   ⚠ $UNIT 与仓库模板不一致 → 保留现有文件、不覆盖。差异（左=现有，右=仓库）："
  diff -u "$UNIT" <(printf '%s\n' "$rendered") | sed 's/^/     /' || true
  echo "   如确认要改用仓库版本：先 sudo rm $UNIT 再重跑本脚本。"
else
  printf '%s\n' "$rendered" > "$UNIT"
fi
# ⑥ 提醒 drop-in 优先级：systemd 的 .d/*.conf 在主单元【之后】解析，其中的 Environment=
#    会盖住主单元里的 EnvironmentFile=/etc/sci-manager.env。这台机器历史上若用 drop-in 存过
#    ADMIN_PASSWORD 等，运维改 env 文件将毫无效果且没有任何报错——必须说清楚以谁为准。
dropin_dir=/etc/systemd/system/sci-manager.service.d
if [ -d "$dropin_dir" ] && grep -rqs '^Environment=' "$dropin_dir" 2>/dev/null; then
  echo "   ⚠ 检测到 systemd drop-in：$dropin_dir/*.conf 里有 Environment= 设置"
  grep -rhs '^Environment=' "$dropin_dir" 2>/dev/null | sed 's/\(ADMIN_PASSWORD=\).*/\1***/' | sed 's/^/       /'
  echo "     drop-in 在主单元之后解析 → 这些值会【覆盖】 $ENVF 里的同名项。"
  echo "     想统一到 $ENVF 管理，请删掉 drop-in 里对应的行；否则请继续在 drop-in 里改。"
  echo "     查看最终生效值： systemctl show sci-manager -p Environment"
fi

systemctl daemon-reload
systemctl enable --now sci-manager

echo "== 3/5 配置 Caddy（$DOMAIN → 127.0.0.1:8090）=="
mkdir -p /var/log/caddy
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	log {
		output file /var/log/caddy/access.log
		format json
	}
	# 安全响应头 —— 与 deploy/Caddyfile.example 保持一致。
	# 此前这里【没有】这段，而 Caddyfile.example 有、服务器架构.md 也写着"打安全头"，
	# 于是走一键部署的真实线上服务器其实一个安全头都没有，文档却宣称有。
	# X-Frame-Options 用 SAMEORIGIN 而非 DENY：产物预览要用同源 iframe。
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		X-Frame-Options "SAMEORIGIN"
		-Server
	}
	reverse_proxy 127.0.0.1:8090 {
		flush_interval -1
	}
	request_body {
		max_size 100MB
	}
	encode zstd gzip
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy

echo "== 4/5 安装 fail2ban 规则（SSH 爆破 + 登录 401 爆破）=="
cp fail2ban/caddy-login.filter /etc/fail2ban/filter.d/caddy-login.conf
cp fail2ban/caddy-login.jail   /etc/fail2ban/jail.d/caddy-login.conf
[ -f /etc/fail2ban/jail.local ] && cp /etc/fail2ban/jail.local "/etc/fail2ban/jail.local.bak.$(date +%s)"
cp fail2ban/jail.local /etc/fail2ban/jail.local
systemctl restart fail2ban || echo "⚠ fail2ban 重启失败，请手动检查"

echo "== 5/5 收紧宿主记账/转发端点 8091（仅私网可达）=="
# manager 的 8091 必须听 0.0.0.0（per-user 多网络架构所需）。应用层 isPrivateIp 已挡公网，
# 这里加主机侧防御纵深：iptables 只放行 172.16/12 + 回环。持久化依赖 bootstrap 装的 iptables-persistent。
# 失败不阻断整体部署（可能环境无 iptables 权限），但响亮告警——安全组仍需人工确认不放行 8091。
scripts/harden-quota-port.sh || echo "⚠ 8091 防火墙收紧失败，请手动检查 iptables / 云安全组勿放行 8091"

echo
echo "✅ 部署完成。"
echo "   加用户： sudo deploy/scripts/user-add.sh <用户名>"
echo "   访问：   https://$DOMAIN/<用户名>/"
