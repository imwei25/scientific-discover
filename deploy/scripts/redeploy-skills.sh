#!/usr/bin/env bash
# 一键重部署：把更新后的技能脚本 + 检索源 API key 生效到所有用户容器。
#
# 做三件事：① 重建镜像（技能脚本是 COPY 进镜像的，改了必须 rebuild）；
#          ② 重渲染 docker-compose.yml（注入 deploy/.env 里的检索 key）；
#          ③ 重建容器（--no-start，保持按需唤醒模型；下次请求时以新镜像/新 env 启动）。
#
# 用法（在服务器 /root/sci-agent 下）：
#   bash deploy/scripts/redeploy-skills.sh            # 用当前代码
#   bash deploy/scripts/redeploy-skills.sh --pull     # 先 git pull 再部署
set -euo pipefail
cd "$(dirname "$0")/.."          # -> deploy/
ROOT="$(cd .. && pwd)"

if [ "${1:-}" = "--pull" ]; then
  echo "== git pull =="
  git -C "$ROOT" pull --ff-only
fi

# 0) 确保 .env 存在（首次从示例种子；不覆盖已有）
if [ ! -f .env ]; then
  cp .env.example .env
  echo "!! 已从 .env.example 生成 deploy/.env —— 请先填 SCI_CONTACT_EMAIL 等再重跑本脚本。" >&2
  exit 1
fi
if ! grep -qE '^SCI_CONTACT_EMAIL=.+' .env || grep -qE '^SCI_CONTACT_EMAIL=you@your-org.com$' .env; then
  echo "!! deploy/.env 里 SCI_CONTACT_EMAIL 还没填真实邮箱（Unpaywall/NCBI 需要）。建议先填。" >&2
fi

# 1) 重建镜像（skills COPY 层会更新；其余层有缓存，通常很快）
echo "== docker build sci-agent:latest =="
docker build -f Dockerfile -t sci-agent:latest "$ROOT"

# 2) 重渲染 compose（把 .env 里的检索 key 写进每个容器的 environment）
echo "== render-compose.sh =="
scripts/render-compose.sh

# 3) 重建容器：--no-start 保持"按需唤醒"。运行中的容器会被重建成新镜像/新 env（短暂中断），
#    停止的容器仅更新定义、下次请求由 manager 唤醒。
echo "== docker compose up --no-start（重建容器定义）=="
docker compose up --no-start

echo "✅ 完成。检索 key/技能更新已生效，容器将在下次请求时以新镜像启动。"
echo "   验证：docker compose config | grep -E 'NCBI_API_KEY|S2_API_KEY|SCI_CONTACT_EMAIL'"
