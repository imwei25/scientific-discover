#!/usr/bin/env bash
# 一键装齐宿主依赖（全新 Ubuntu 22.04）：docker + compose 插件、Node 20、Caddy、git、fail2ban、2G swap。
# 幂等，可重复跑。用法：  sudo bash deploy/bootstrap-host.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 root 或 sudo 运行"; exit 1; }

echo "== apt 基础包 =="
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw fail2ban openssl

echo "== Docker + compose 插件 =="
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker

echo "== Node 20 =="
need_node=1
if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/v//;s/\..*//')" -ge 20 ]; then need_node=0; fi
if [ "$need_node" = 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "== Caddy（官方 apt 源）=="
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi
systemctl enable --now caddy

echo "== 2G swap（若无）=="
if ! swapon --show 2>/dev/null | grep -q .; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile; mkswap /swapfile; swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo
echo "✅ 宿主依赖就绪：docker=$(docker -v 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)  node=$(node -v)  caddy=$(caddy version 2>/dev/null | head -c 8)"
echo "下一步：cp deploy/.env.example deploy/.env 并填 DEEPSEEK_API_KEY / BASE_DOMAIN，再跑  sudo bash deploy/setup.sh"
