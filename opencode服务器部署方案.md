# 科研 Agent 服务器部署方案（手把手版）

面向：从"先证明能跑"到"多人正式使用"，分 4 个阶段，一步步来。

> 建议顺序：先做**阶段 A**（30 分钟，证明服务器上能跑），成功后再做 B → C → D。不要一上来就搞多用户。

---

## 0. 这套东西是什么

一个自己服务器上跑的"科研 AI 助手"：用户在网页里对话，AI 能调用科学计算（pandas/numpy/scipy/matplotlib…）、读用户上传的数据、出图表结果供下载。**大脑用 DeepSeek（走 API），数据和代码都在你自己服务器上。**

```
浏览器(网页)  →  nginx(登录/路由)  →  每个用户一个容器 { 网关 + OpenCode + Python科研环境 }  →  DeepSeek API
                                              └ 上传目录 uploads/  产出目录 outputs/
```

关键组件（都已做好，在本仓库 `opencode-agent` 分支）：
- `web/server.mjs` + `web/index.html`：网页 + 网关（对话、文件上传/下载）
- `.opencode/skills/`：AI 的"技能"（data-analysis 用 Python 做分析）
- `deploy/`：部署用的 Dockerfile、compose、nginx 等（本文用到的都在这）

---

## 1. 你需要准备

1. **一台云服务器**（阿里云/腾讯云/AWS 都行）
   - 系统：**Ubuntu 22.04**（本文以此为例）
   - 规格：10 个人轻度用 → **4 核 8G**起步；会跑较重计算 → **8 核 16G**。硬盘 ≥ 50G。
2. **一个 DeepSeek API Key**（在 DeepSeek 开放平台申请，形如 `sk-xxx`），确认账号里有可用模型名（我们用的是 `deepseek-v4-pro`）。
3. 会用 **SSH 登录服务器**（`ssh root@你的服务器IP`）。

---

## 2. 服务器基础环境（一次性，5 分钟）

SSH 登录服务器后，逐行粘贴：

```bash
# 更新 + 装 git、Node 20、Python、pip
sudo apt update
sudo apt install -y git curl python3 python3-pip
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 装 Docker（阶段 B/C 用）
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable docker

# 验证
node -v && python3 --version && docker --version
```

把代码拉到服务器（把下面 URL 换成你的仓库地址；或用 scp 上传整个目录）：

```bash
cd ~
git clone <你的仓库地址> sci-agent
cd sci-agent
git checkout opencode-agent      # 切到我们做好的分支
```

---

## 阶段 A — 单实例快速验证（不用 Docker，先证明能跑）

目标：在服务器上把这套跑起来、用浏览器验证一次。**这是最该先做的一步。**

```bash
cd ~/sci-agent

# 1) 装科研 Python 包（装进系统 python3）
pip3 install --break-system-packages -r deploy/requirements.txt

# 2) 用"服务器版技能"（调用 python3，而不是 Windows 的 venv 路径）
cp -r deploy/skills/* .opencode/skills/

# 3) 配 DeepSeek key（本次会话有效）
export DEEPSEEK_API_KEY=sk-你的密钥

# 4) 装网关依赖
cd web && npm install && cd ..

# 5) 启动 OpenCode（后台）
nohup opencode serve --port 4098 --hostname 127.0.0.1 > ~/oc.log 2>&1 &

# 6) 启动网关（后台）
nohup node web/server.mjs > ~/gw.log 2>&1 &

# 7) 本机自测
sleep 3
curl -s http://127.0.0.1:3000/api/files    # 返回 [] 或文件列表即正常
```

**用浏览器验证**（在你自己电脑上开一个 SSH 隧道，把服务器 3000 映射到本地）：

```bash
# 在你自己电脑（不是服务器）执行：
ssh -L 3000:127.0.0.1:3000 root@你的服务器IP
```

然后本地浏览器打开 `http://localhost:3000`，试：
- 发一句"你好，你能做什么" → 应看到 DeepSeek 流式回复
- 上传一个 CSV → 在对话里说"分析 uploads/你的文件.csv，做线性回归并画图" → 应生成 `outputs/xxx.png`，右侧出现下载链接

✅ 到这里，说明服务器完全能跑。停止：`pkill -f "opencode serve"; pkill -f "web/server.mjs"`。

---

## 阶段 B — 容器化（打成一个镜像，一条命令跑一个用户）

目标：把上面这套装进一个 Docker 镜像，以后开箱即用、便于复制给多个用户。

```bash
cd ~/sci-agent

# 1) 填密钥
cp deploy/.env.example deploy/.env
nano deploy/.env          # 把 DEEPSEEK_API_KEY 改成真的，保存(Ctrl+O 回车, Ctrl+X)

# 2) 构建镜像（第一次约 2-5 分钟）
docker build -f deploy/Dockerfile -t sci-agent:latest .

# 3) 跑一个容器测试
docker run -d --name sci-test --env-file deploy/.env \
  -p 3000:3000 --memory 2g --cpus 1.5 sci-agent:latest

# 4) 验证
sleep 8
docker logs sci-test | tail             # 应看到 opencode ready + gateway on ...
curl -s http://127.0.0.1:3000/api/files
```

同样用 SSH 隧道在浏览器验证一遍。没问题就清理测试容器：`docker rm -f sci-test`。

---

## 阶段 C — 多用户 + 登录（正式给 10 个人用）

目标：每个用户一个独立容器（互相隔离），前面 nginx 做登录和路由。文件都在 `deploy/` 里已备好。

```bash
cd ~/sci-agent/deploy

# 1) 创建登录账号（用 docker 生成，不用装额外软件）
#    格式：docker run ... htpasswd -Bbn 用户名 密码 >> htpasswd
docker run --rm httpd:alpine htpasswd -Bbn alice 密码1  > htpasswd
docker run --rm httpd:alpine htpasswd -Bbn bob   密码2 >> htpasswd

# 2) 起全部服务（会构建镜像 + 起 alice、bob 两个容器 + nginx）
docker compose build
docker compose up -d
docker compose ps
```

浏览器访问：`http://你的服务器IP:8080/alice/`（输入 alice/密码1）、`/bob/`（bob/密码2）。各自的数据互不可见。

**加一个用户（例如 carol）**，改 3 处再 `docker compose up -d`：
1. `docker-compose.yml`：复制一个 `agent-bob:` 服务块改名 `agent-carol`，并在 `volumes:` 加 `carol-uploads/carol-outputs`；
2. `nginx.conf`：复制一个 `location /bob/` 改成 `/carol/` 指向 `agent-carol:3000/`；
3. 追加账号：`docker run --rm httpd:alpine htpasswd -Bbn carol 密码3 >> htpasswd`。

---

## 阶段 D — 上线加固（正式对外前做）

**① HTTPS（强烈建议）** — 用 Caddy 自动签证书，最省事。装 Caddy 后建 `/etc/caddy/Caddyfile`：
```
你的域名.com {
    reverse_proxy 127.0.0.1:8080
}
```
`sudo systemctl restart caddy`，之后用户走 `https://你的域名.com/alice/`。

**② 防火墙** — 只开必要端口，内部端口不暴露：
```bash
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443
sudo ufw enable     # 注意：8080/3000/4098 不对公网开，只经 Caddy/nginx 内部访问
```

**③ 开机自启** — compose 里已写 `restart: unless-stopped`，且 `systemctl enable docker` 后，服务器重启会自动拉起。

**④ 备份数据** — 用户文件在 docker volume 里：
```bash
docker run --rm -v deploy_alice-outputs:/data -v $PWD:/bak alpine tar czf /bak/alice-outputs.tgz -C /data .
```

**⑤ 更新** — 改了代码后：`docker compose build && docker compose up -d`。

**⑥ 资源上限** — `docker-compose.yml` 里每个容器 `mem_limit: 2g` / `cpus: 1.5`，按服务器规格和人数调整，防止一个人吃满机器。

---

## ⚠️ 安全须知（必读）

1. **Agent 能执行任意代码，本质不是沙箱**——所以**每个用户必须独立容器**（阶段 C 已如此）。绝不要让多个用户共用一个容器。
2. **不要给容器挂宿主敏感目录，也不要挂 `docker.sock`**——否则容器能控制整台机器。
3. **DeepSeek 密钥只放 `deploy/.env`（已被 .gitignore 忽略），绝不进镜像、不进 git、不写进网页或提示词**。
4. **只面向可信用户（内部/小范围）**。要面向公开 C 端，需要额外的滥用防护、配额、审计，超出本方案。
5. 需要限制 AI 联网时，可给容器加网络策略（`--network` / compose networks）。

---

## 🔧 故障排查（含我们真踩过的坑）

| 现象 | 原因 / 解决 |
|---|---|
| `opencode serve` 报 `Unexpected error` 起不来 | **端口被占**。换端口，或 `lsof -i:4098` 找到占用进程杀掉。（本机上曾被另一个 opencode 占了 4096） |
| AI 说"Python 没装"、退回别的方式 | **技能里的 Python 路径不对**。服务器/容器用 `python3`（`deploy/skills` 已是）；只有 Windows 本地才是 `backend/.venv/Scripts/python.exe`。 |
| 技能加载让服务崩溃 | **SKILL.md 带了 BOM**。用 Windows 记事本存会加 BOM，要存成 **UTF-8 无 BOM**。 |
| 模型报错 / 无响应 | **模型名不对或没鉴权**。`OC_MODEL` 必须是你 DeepSeek 账号可用的模型（我们用 `deepseek-v4-pro`，不是 `deepseek-chat`）；确认 `DEEPSEEK_API_KEY` 传进了容器（`docker exec -it 容器 env | grep DEEPSEEK`）。 |
| 网页对话不是"流式"、要等很久才一次出 | **nginx 没关缓冲**。`nginx.conf` 里已设 `proxy_buffering off` + `proxy_read_timeout 3600s`，确认生效。 |
| 网页里 `/api/...` 404 | 前端要用**相对路径**（已改），且 nginx 的 `location /用户/` 末尾要带斜杠以剥掉前缀。 |
| 上传大文件失败 | nginx `client_max_body_size`（已设 100m），需要更大就调大。 |
| Python 包缺失 | 确认 `deploy/requirements.txt` 装进了系统 python3（阶段 A）或镜像（阶段 B）。 |

日志在哪：
```bash
docker compose logs -f agent-alice     # 某用户容器日志
docker compose logs -f nginx           # 路由/登录日志
```

---

## 💰 成本估算

- **服务器**：4核8G ≈ ¥200-400/月，8核16G ≈ ¥400-800/月（10 人够用；重计算再加）。
- **DeepSeek**：按 token 用量计费，日常对话+分析很便宜。
- 一次性人力：照本文，半天到一天可上线。

---

## 📌 运维速查

```bash
cd ~/sci-agent/deploy
docker compose ps                      # 看所有容器状态
docker compose logs -f agent-alice     # 看某人日志
docker compose restart agent-alice     # 重启某人
docker compose up -d                   # 应用改动/加用户后
docker compose down                    # 全停
docker compose build && docker compose up -d   # 更新代码后重建
```

> 本方案已在开发者的 Windows 机器上完整验证：分支重构、科研技能（真 pandas/scipy 回归出图）、网页流式对话、文件上传/下载全部跑通。服务器端按本文照做即可复现。
