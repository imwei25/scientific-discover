# 多用户部署

自托管科研 Agent 的多用户方案。核心原则：**Agent 能执行任意代码、容器不是强沙箱 → 每个用户一个独立容器，绝不共用**。

## 架构

```
Internet ─HTTPS─> Caddy (宿主：每用户一个域名，自动证书 + fail2ban)
                    │  每个用户域名 → 127.0.0.1:8090（manager），保留 Host、flush_interval -1 (SSE)
                    ▼
        manager.mjs (宿主 systemd 服务，非容器 → 不暴露 docker.sock)
          按需 docker start/stop · 流式反代 · 空闲停机 · WARM_CAP 并发上限(LRU 驱逐)
        ┌───────────┼───────────┐
   agent-alice   agent-bob   agent-…   （按需启停；每用户 3 个卷：uploads/outputs/ocdata）
   127.0.0.1:3001  :3002        端口仅发布到回环
```

- **路由/TLS**：只用 Caddy（不用 nginx）。按域名路由，每用户一个 DuckDNS 子域，都 A→同一台机。app 保持挂在根路径，零改代码。
- **登录**：复用 app 自带表单登录，每容器独立 `LAN_USER/LAN_PASSWORD`（有登录页 + 会话 + 登出）。
- **按需启停**：`manager.mjs` 在请求到来时唤醒停止的容器，空闲后停机 → 多个「大多时候空闲」的用户也能挤在小机器上。真正吃内存的是每用户各自运行的 opencode + 它写的任意 Python（隔离边界所在，无法共享）；解释器/pandoc/texlive 的**程序**本身已经在镜像层和内核页缓存里天然共享。

## 首次部署（服务器上）

```bash
# 0) 前置：已装 docker、node、caddy；仓库已放到 /opt/scientific-discover（按需改路径）
cd /opt/scientific-discover/deploy
cp .env.example .env && vi .env          # 填 DEEPSEEK_API_KEY、DUCKDNS_TOKEN

# 1) 构建共享镜像
scripts/build-image.sh

# 2) 装并启动 manager（宿主 systemd 服务）
sudo cp sci-manager.service /etc/systemd/system/   # 先按实际路径改 unit 里两处
sudo systemctl daemon-reload && sudo systemctl enable --now sci-manager

# 3) 主 Caddyfile 里 import 多用户配置（见 Caddyfile.example）
#    确保 /etc/caddy/Caddyfile 有：import /etc/caddy/multiuser.caddy

# 4) 逐个加用户（先去 DuckDNS 面板建好子域 weigu-<name>.duckdns.org）
scripts/user-add.sh alice
scripts/user-add.sh bob
# 输出会打印各自的 URL / 账号 / 密码
```

## 日常运维

| 操作 | 命令 |
|---|---|
| 加用户 | `scripts/user-add.sh <name>`（自动：分配端口 → 强密码 → 渲染 compose → 建容器 → 同步 Caddy/DuckDNS → 热加载 manager） |
| 删用户（留数据） | `scripts/user-del.sh <name>` |
| 删用户（连数据） | `scripts/user-del.sh <name> --purge`（先自动备份再删卷） |
| 改了 web/skills 代码 | `scripts/build-image.sh` 后逐个 `docker restart agent-<name>`（或等其自然冷启动） |
| 备份 | `scripts/backup.sh`（建议 cron 每日；7 天轮转，写 `/var/backups/sci/<日期>/`） |
| 看谁在跑 | `docker ps --filter name=agent-` |
| 手动叫停某用户 | `docker stop agent-<name>`（下次访问会自动唤醒） |

数据清理沿用 app 内建的 **7 天 TTL**（自动清会话/产物）；`backup.sh` 是卷级快照，二者互补。

## 调参（`sci-manager.service` 里的 Environment）

- `WARM_CAP`：同时最多几个容器在跑。**4G 机设 2；换 8核16G 后设 ~6**。达到上限再来新用户会按 LRU 停一个空闲容器。
- `IDLE_MS`：空闲多久停机（默认 25 分钟 = 1500000）。设大些避免打断用户思考间隙；有开着的连接（含跑流水线的 SSE 长流）绝不停。
- `START_TIMEOUT_MS`：冷启动就绪等待上限（默认 60s；含容器内 opencode 预热）。

## 内存与扩容

- 每容器 `mem_limit` 约 1.75G（上限非预留）。4GiB+2G swap 试用机够 **1–2 个不同时跑重活的用户**；约 10 人常用需 **8核16G**，同时把 `WARM_CAP` 调到 ~6。
- DuckDNS 免费账号最多 5 个子域；超过 5 用户改用带**通配符**的正式域名（届时可考虑改回按路径路由）。

## 安全要点

- 容器端口**只发布到 127.0.0.1**：公网无法直连，且避免触发 app 的 `isLocal` 免登录旁路（务必别用 host 网络）。
- 阿里云安全组：**22 限本人 IP**；开 80/443；**不要**对公网开 3000/8090。
- fail2ban `caddy-login` jail 盯 `POST /api/login` 的 401 —— 多用户改经 Caddy 反代后，**需重新核对该 jail 正则对新日志行仍命中**。
- 加密与备份不含真实患者数据（本部署约定）。

## 关键实现注记

- `restart: "no"`：空闲停机是主动 `docker stop`（退出码 143），`on-failure` 会误判崩溃反复重启。崩溃恢复交给 manager 的「下次请求唤醒」。
- `ocdata` 卷（`/root/.local/share/opencode`）持久化 opencode 会话历史 —— **没有它，按需停机会清空对话**。首次部署务必确认该路径正确：`docker exec agent-<name> ls /root/.local/share/opencode`。
- 冷启动后 app 的内存态登录 token 会失效，被唤醒的用户需重新登录一次（安全、可接受）。
