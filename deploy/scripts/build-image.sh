#!/usr/bin/env bash
# 构建（或重建）共享镜像 sci-agent:latest。所有用户容器复用同一镜像 —— 解释器/pandoc/texlive 在磁盘层和内核页缓存里天然共享。
# 改了 web/ 或 deploy/skills/ 后重跑本脚本，再逐个 docker restart（或让容器自然冷启动）即可生效。
set -euo pipefail
cd "$(dirname "$0")/../.."   # -> 仓库根（构建上下文）
docker build -f deploy/Dockerfile -t sci-agent:latest .
echo "✅ 已构建 sci-agent:latest"
