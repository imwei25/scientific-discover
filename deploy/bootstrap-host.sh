#!/usr/bin/env bash
# 一键装齐宿主依赖（全新 Ubuntu 22.04）：docker + compose 插件、Node 20、Caddy、git、fail2ban、2G swap、zram。
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

echo "== 2G 磁盘 swapfile（若无）=="
# 只看 /swapfile 本身是否已激活（旧写法 `swapon --show | grep .` 会把 zram 也算成“已有 swap”，
# 于是 zram 在但磁盘 swapfile 缺失的机器上跳过创建 → render-compose 假设的“磁盘兜底”落空）。
if ! grep -qE '^/swapfile[[:space:]]' /proc/swaps 2>/dev/null; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048; chmod 600 /swapfile; mkswap /swapfile; }
  swapon /swapfile 2>/dev/null || true
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== zram（压缩内存 swap；小内存机扛多容器的关键）=="
# 为什么要 zram：每个空闲用户容器驻留约 300MB，其中大半是冷页。zram 把冷页 lz4 压缩后
# 仍留在内存（压缩比约 2~3x），等效把 3.4G 内存扩到 ~5G；相比换到云盘 swapfile，
# 换入快 2~3 个数量级，用户唤醒容器几乎无感——WARM_CAP 才提得上去。
# 三项配置（幂等，重复跑只是覆盖同样内容）：
#   PERCENT=60  → zram 大小 = 60% 物理内存（3.4G 机约 2G 名义容量）
#   PRIORITY=100 → 高于磁盘 swapfile（bootstrap 建的 swapfile 优先级为负），先压内存、磁盘只兜底
#   swappiness=100 / page-cluster=0 → 鼓励早换冷页；zram 无寻道成本，预读关掉
apt-get install -y -qq zram-tools
# 只在【配置真变了 或 服务没在跑】时才 restart：restart 会先 swapoff，高负载下冷页挤不回内存可能失败，
# set -e 下会中止脚本、且可能把本来好好的 zram 关掉。配置没变就别动正在服务的 zram。
printf 'ALGO=lz4\nPERCENT=60\nPRIORITY=100\n' > /etc/default/zramswap.new
if ! cmp -s /etc/default/zramswap.new /etc/default/zramswap 2>/dev/null || ! systemctl is-active --quiet zramswap; then
  mv /etc/default/zramswap.new /etc/default/zramswap
  systemctl enable zramswap >/dev/null 2>&1
  systemctl restart zramswap || echo "  !! zramswap restart 失败（高负载下 swapoff 可能挤不回内存）；若 zram 仍在跑可忽略" >&2
else
  rm -f /etc/default/zramswap.new
fi
printf 'vm.swappiness=100\nvm.page-cluster=0\n' > /etc/sysctl.d/99-zram.conf
sysctl -p /etc/sysctl.d/99-zram.conf >/dev/null

echo
echo "✅ 宿主依赖就绪：docker=$(docker -v 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)  node=$(node -v)  caddy=$(caddy version 2>/dev/null | head -c 8)  zram=$(zramctl --noheadings 2>/dev/null | awk '{print $3; exit}')"
echo "下一步：cp deploy/.env.example deploy/.env 并填 DEEPSEEK_API_KEY / BASE_DOMAIN，再跑  sudo bash deploy/setup.sh"
