# 一体化镜像：Node(网关+OpenCode) + Python(科研技能)
# 构建上下文 = 仓库根目录：  docker build -f deploy/Dockerfile -t sci-agent:latest .
FROM node:20-bookworm-slim

# 系统依赖：python3 + pip + curl(健康检查) + git(部分技能/MCP 需要)
# pandoc + texlive-xetex + CJK 字体 供 render-pdf-doc 技能出版级 PDF 排版
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip curl git ca-certificates \
      pandoc texlive-xetex texlive-fonts-recommended texlive-lang-cjk fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# OpenCode（固定版本，避免自动升级带来的意外）
RUN npm install -g opencode-ai@1.17.14

WORKDIR /app

# 科研 Python 环境（装进系统 python，容器本身就是隔离）
COPY deploy/requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /app/requirements.txt

# 网关依赖
COPY web/package.json /app/web/package.json
RUN cd /app/web && npm install --omit=dev

# 应用文件
COPY web/server.mjs web/index.html /app/web/
COPY deploy/skills/ /app/.opencode/skills/
COPY deploy/AGENTS.md /app/AGENTS.md
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh \
    && mkdir -p /app/uploads /app/outputs

ENV OC_URL=http://127.0.0.1:4098 \
    OC_MODEL=deepseek/deepseek-v4-pro \
    PORT=3000
EXPOSE 3000
CMD ["/app/entrypoint.sh"]
