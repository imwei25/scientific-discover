#!/usr/bin/env bash
# 收紧宿主记账/转发端点（默认 8091）：只允许 docker 私网(172.16/12)与本机回环访问，公网一律 DROP。
#
# 背景：manager 的 /report 记账与 /llm 上游转发监听 0.0.0.0:8091（QUOTA_LISTEN）。它必须听 0.0.0.0——
#   每个用户容器在各自 per-user bridge 网络里，经 host.docker.internal→host-gateway 打宿主，各网关 IP
#   不同(172.19.0.1/172.20.0.1/…)，宿主进程一个 listen 绑不了多地址、且用户/网络动态增减，故只能 0.0.0.0。
#   应用层已有 isPrivateIp 校验对端真实地址挡公网（唯一有效防线），本脚本是【主机侧防御纵深】：
#   万一云安全组被误放行 8091，靠这条 iptables 规则兜住，别让花钱的 /llm 与账本端点裸奔公网。
#
# 幂等：用独立自定义链 SCI-QUOTA，可反复跑；不动 INPUT 既有规则（如 f2b-sshd）。
# 用法（服务器 root）：bash deploy/scripts/harden-quota-port.sh      # 端口可 QUOTA_PORT=8091 覆盖
set -euo pipefail
PORT="${QUOTA_PORT:-8091}"
CHAIN="SCI-QUOTA"

# 1) 建/清空自定义链，写入白名单 + 兜底 DROP
iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
iptables -A "$CHAIN" -s 127.0.0.0/8   -j ACCEPT   # 本机回环（含 manager 自身/本地进程）
iptables -A "$CHAIN" -s 172.16.0.0/12 -j ACCEPT   # 所有 docker bridge（默认 172.17 + per-user 172.19/20/21…）
iptables -A "$CHAIN" -j DROP                       # 其余来源（公网）一律拒

# 2) 从 INPUT 跳转到本链：先删旧跳转再插到最前，幂等且不重复
iptables -D INPUT -p tcp --dport "$PORT" -j "$CHAIN" 2>/dev/null || true
iptables -I INPUT -p tcp --dport "$PORT" -j "$CHAIN"

echo "== 已装 :$PORT 私网限制规则 =="
iptables -S "$CHAIN"

# 3) 持久化（否则重启后规则丢，形成"以为收紧了其实没有"的假象）
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save && echo "== 已持久化（netfilter-persistent）=="
elif [ -d /etc/iptables ]; then
  iptables-save > /etc/iptables/rules.v4 && echo "== 已持久化（/etc/iptables/rules.v4）=="
else
  echo "!! 未检测到 iptables 持久化机制，重启后规则会丢。建议：apt-get install -y iptables-persistent 后重跑本脚本。" >&2
fi
echo "✅ 完成。验证：iptables -S INPUT | grep $PORT；从公网 curl 该端口应超时/拒绝。"
