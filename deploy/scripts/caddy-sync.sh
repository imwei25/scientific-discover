#!/usr/bin/env bash
# 根据 users/*.env 生成 Caddy 多用户站点配置并热重载。
# 所有用户域名共用一个 reverse_proxy → manager(:8090)，由 manager 按 Host 分发到各容器（Caddy 无法自己启动容器）。
# 主 Caddyfile 需 import 本文件：见 deploy/Caddyfile.example。
set -euo pipefail
cd "$(dirname "$0")/.."   # -> deploy/

VHOST="${CADDY_VHOST_FILE:-/etc/caddy/multiuser.caddy}"
MANAGER="${MANAGER_ADDR:-127.0.0.1:8090}"

domains=()
shopt -s nullglob
for f in users/*.env; do
  d=$(sed -n 's/^DOMAIN=//p' "$f" | head -1)
  [ -n "$d" ] && domains+=("$d")
done

tmp="$(mktemp)"
if [ ${#domains[@]} -gt 0 ]; then
  # 一个站点块列出所有域名（Caddy 会为每个域名各自签证书），统一反代到 manager。
  { printf '%s' "${domains[0]}"; for d in "${domains[@]:1}"; do printf ', %s' "$d"; done; } >> "$tmp"
  cat >> "$tmp" <<CADDY
 {
	reverse_proxy ${MANAGER} {
		flush_interval -1
	}
	request_body {
		max_size 100MB
	}
	encode zstd gzip
}
CADDY
fi
# 需要写 /etc/caddy —— 若无权限自动降级 sudo
if ! cat "$tmp" > "$VHOST" 2>/dev/null; then sudo tee "$VHOST" < "$tmp" >/dev/null; fi
rm -f "$tmp"
echo "已写 $VHOST（${#domains[@]} 个域名 → $MANAGER）"

# 重载 Caddy
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet caddy; then
  { systemctl reload caddy || sudo systemctl reload caddy; } && echo "Caddy 已重载"
elif command -v caddy >/dev/null 2>&1; then
  caddy reload --config /etc/caddy/Caddyfile 2>/dev/null && echo "Caddy 已重载" || echo "!! 请手动 reload Caddy"
else
  echo "!! 未找到 caddy/systemctl，请手动 reload Caddy"
fi
