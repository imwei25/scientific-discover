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
DOMAIN="${1:-$(sed -n 's/^BASE_DOMAIN=//p' .env | head -1)}"
[ -n "$DOMAIN" ] || { echo "缺域名：传参 或 在 .env 设 BASE_DOMAIN"; exit 1; }
grep -q '^DEEPSEEK_API_KEY=sk' .env || echo "⚠ 提示：deploy/.env 里 DEEPSEEK_API_KEY 看起来还没填真实值"

echo "== 1/4 构建共享镜像 sci-agent:latest =="
scripts/build-image.sh

echo "== 2/4 安装并启动 manager（WorkingDir=$REPO/deploy）=="
NODE="$(command -v node)"
sed -e "s#/opt/scientific-discover#$REPO#g" -e "s#/usr/bin/node#$NODE#g" sci-manager.service > /etc/systemd/system/sci-manager.service
systemctl daemon-reload
systemctl enable --now sci-manager

echo "== 3/4 配置 Caddy（$DOMAIN → 127.0.0.1:8090）=="
mkdir -p /var/log/caddy
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	log {
		output file /var/log/caddy/access.log
		format json
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

echo "== 4/4 安装 fail2ban 规则（SSH 爆破 + 登录 401 爆破）=="
cp fail2ban/caddy-login.filter /etc/fail2ban/filter.d/caddy-login.conf
cp fail2ban/caddy-login.jail   /etc/fail2ban/jail.d/caddy-login.conf
[ -f /etc/fail2ban/jail.local ] && cp /etc/fail2ban/jail.local "/etc/fail2ban/jail.local.bak.$(date +%s)"
cp fail2ban/jail.local /etc/fail2ban/jail.local
systemctl restart fail2ban || echo "⚠ fail2ban 重启失败，请手动检查"

echo
echo "✅ 部署完成。"
echo "   加用户： sudo deploy/scripts/user-add.sh <用户名>"
echo "   访问：   https://$DOMAIN/<用户名>/"
