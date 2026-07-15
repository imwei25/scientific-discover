# 多用户部署

自托管科研 Agent 的多用户方案。核心原则：**Agent 能执行任意代码、容器不是强沙箱 → 每个用户一个独立容器，绝不共用**。

## 架构（单域名 + 路径路由）

```
Internet ─HTTPS─> Caddy (宿主：单域名，自动证书 + fail2ban)
                    │  weigu.duckdns.org → 127.0.0.1:8090（manager），flush_interval -1 (SSE)
                    ▼
        manager.mjs (宿主 systemd 服务，非容器 → 不暴露 docker.sock)
          按路径首段 /用户名/ 分发并剥前缀 · 按需 docker start/stop · 流式反代 · 空闲停机 · WARM_CAP 上限(LRU 驱逐)
        ┌───────────┼───────────┐
   agent-alice   agent-bob   agent-…   （按需启停；每用户 3 个卷：uploads/outputs/ocdata）
   127.0.0.1:3001  :3002        端口仅发布到回环
```

访问地址：`https://weigu.duckdns.org/alice/`、`…/bob/` …

- **路由/TLS**：只用 Caddy（不用 nginx），**一个域名**。manager 按 URL 首段（`/alice/`）分发到对应容器，并把该前缀剥掉，所以容器内部仍按根路径处理。app 通过 `BASE_PATH` 环境变量只在"发给浏览器"的东西上补回前缀（跳转 `Location` 与 Cookie `Path`）。
- **隔离**：每用户容器的登录 Cookie 作用域是 `Path=/<用户名>/` —— 浏览器**不会**把 alice 的登录态发往 `/bob/`，跨用户互不可见。要用 `/bob/` 必须有 bob 的密码。
- **登录**：复用 app 自带表单登录，每容器独立 `LAN_USER/LAN_PASSWORD`（有登录页 + 会话 + 登出）。
- **按需启停**：`manager.mjs` 请求到来时唤醒停止的容器、空闲后停机 → 多个「大多时候空闲」的用户也能挤在小机器上。真正吃内存的是每用户各自运行的 opencode + 它写的任意 Python（隔离边界所在，无法共享）；解释器/pandoc/texlive 的**程序**本身已在镜像层和内核页缓存里天然共享。

## 首次部署（服务器上）

```bash
# 0) 前置：已装 docker、node、caddy；仓库放到 /root/sci-agent（按需改路径）
cd /root/sci-agent/deploy
cp .env.example .env && vi .env          # 填 DEEPSEEK_API_KEY、BASE_DOMAIN

# 1) 构建共享镜像
scripts/build-image.sh

# 2) 装并启动 manager（宿主 systemd 服务；先按实际路径改 unit 里两处）
sudo cp sci-manager.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sci-manager

# 3) Caddy：把主 Caddyfile 换成单块反代到 manager（见 Caddyfile.example），然后 reload
sudo systemctl reload caddy

# 4) 逐个加用户（不需要建子域、不需要改 Caddy）
scripts/user-add.sh alice
scripts/user-add.sh bob
# 输出会打印各自的 URL / 账号 / 密码
```

## 日常运维

| 操作 | 命令 |
|---|---|
| 加用户 | `scripts/user-add.sh <name> [档位]`（自动：分配端口 → 强密码 → 渲染 compose → 建容器 → 热加载 manager；档位省略=free） |
| 改用户档位 | `scripts/user-tier.sh <name> <档位>`（改 TIER → 渲染 → 重启容器即时生效） |
| 看谁在什么档/用了多少 | `scripts/user-list.sh`（各用户档位 / 每日额度 / 今日已用 / 存储；`--fast` 跳过存储统计） |
| 删用户（留数据） | `scripts/user-del.sh <name>` |
| 删用户（连数据） | `scripts/user-del.sh <name> --purge`（先自动备份再删卷） |
| 改了 web/skills 代码 | `scripts/build-image.sh` 后逐个 `docker restart agent-<name>`（或等其自然冷启动） |
| 备份 | `scripts/backup.sh`（建议 cron 每日；7 天轮转，写 `/var/backups/sci/<日期>/`） |
| 看谁在跑 | `docker ps --filter name=agent-` |
| 手动叫停某用户 | `docker stop agent-<name>`（下次访问会自动唤醒） |

加/减用户**不需要动 Caddy 或 DNS** —— 路径路由下这些都是静态的。数据清理沿用 app 内建的 **7 天 TTL**（自动清会话/产物）；`backup.sh` 是卷级快照，二者互补。

## 调参（`sci-manager.service` 里的 Environment）

- `WARM_CAP`：同时最多几个容器在跑。**4G 机设 2；换 8核16G 后设 ~6**。
- `IDLE_MS`：空闲多久停机（默认 10 分钟 = 600000，与前端闲置登出对齐）。有开着的连接（含跑流水线的 SSE 长流）绝不停。
- `START_TIMEOUT_MS`：冷启动就绪等待上限（默认 60s；含容器内 opencode 预热）。
- `CAP_WAIT_MS`：满载排队等待上限（默认 2 分钟）。超时给用户回"繁忙请重试"。

## 满载行为（内存是硬顶，绝不超配）

新用户容器要唤醒、而 `WARM_CAP` 已满时：
1. **有空闲容器**（`conns==0`）→ 按 LRU 停最久空闲的那个腾位。被停用户下次访问要重登 + 冷启动，历史不丢（在 `ocdata` 卷）。
2. **全忙、无可停** → **排队等待**（不超配），直到有空闲槽位；等超 `CAP_WAIT_MS` 回繁忙。这样内存永远 ≤ `WARM_CAP × mem_limit`。

## 用户分级（档位）与每日额度（USD）

**分级**：档位集中定义在 `deploy/tiers.env`，每档一行 `<档位名> <每日USD> <存储MB>`（0=不限）。缺省三档：

| 档位 | 每日额度 | 存储上限 | 用途 |
|---|---|---|---|
| `free` 普通 | $0.30/天 | 1 GB | 轻度使用 |
| `plus` 高级 | $1.50/天 | 4 GB | 重度写作 |
| `admin` 管理员 | 不限 | 不限 | 内部/管理 |

- 给用户指派档位：`users/<name>.env` 里写 `TIER=<档位>`（新增用户时 `user-add.sh <name> <档位>`，改档 `user-tier.sh <name> <档位>`）。
- **档位 → 额度的解析在 `render-compose.sh` 完成**，注入容器的仍是原有的 `DAILY_COST_LIMIT`/`STORAGE_LIMIT_MB` 环境变量——网关 `server.mjs` 无改动。改 `tiers.env` 后重跑 `render-compose.sh` 并重启相关容器即生效。
- **个别覆盖**：某用户 `.env` 里若填了非空的 `DAILY_COST_LIMIT=`/`STORAGE_LIMIT_MB=`，则以其为准（优先于档位），用于单独加码/收紧。
- 额度按 **USD/天**：用 opencode 的 `session.cost`（含 DeepSeek 缓存折扣）累计每轮增量，**跨日 UTC 0 点自动清零**，持久化在 `ocdata` 卷（重启不丢）。达上限**拦截新对话**（本轮已开始的照常跑完），前端提示"今日额度已用尽"。查用量：`GET /<user>/api/quota`，或 `scripts/user-list.sh` 一览全员。

## 存储上限（MB）

- 每用户 `users/<name>.env` 里 `STORAGE_LIMIT_MB=`（`0` 或空 = 不限），统计 `uploads + outputs` 之和。改后 `docker restart agent-<name>`。
- 前端侧栏常驻显示"存储 已用/上限"，**到 90% 变红提示**；超上限**拦截新上传**（对话产物照常）。查用量：`GET /<user>/api/storage`。
- **删除会话即释放其占用**（`uploads/<sid>/` 与 `outputs/<sid>/` 一并删掉）；另有应用内 7 天 TTL 兜底。

## 闲置退出（前端）

- 无操作满 7 分钟弹 3 分钟倒计时，满 10 分钟自动登出跳登录页。移动鼠标/按键即保持登录。
- SSE 生成期间算活跃 → 长流水线跑一半不会被登出。容器侧 `IDLE_MS=600000` 与之对齐。

## 内存与扩容（sizing 公式）

- **内存是硬约束**：`WARM_CAP ≈ 可用内存 / mem_limit`（留余量）。16G 机 → `16/1.75 ≈ 9`，留头设 `WARM_CAP=6`。
- **CPU 是可压缩的**（超订只是变慢、不会崩）：让 `WARM_CAP × cpus ≈ 核数` 即可。2 核现状 `cpus:1.5` 略超订但无妨；8 核设 `cpus:2 × WARM_CAP:6` 之类。真遇到渲染高峰拖慢，再把 xelatex/pandoc 抽成共享渲染工作池。
- 单域名路径路由**没有子域数量限制**，加多少用户都不用动 DNS/Caddy。
- 旧单用户 `sci` 容器已停机（省内存）；回滚多用户 = `docker start sci` + 把 Caddy 指回 `:3000`。

## 安全要点

- 容器端口**只发布到 127.0.0.1**：公网无法直连，且避免触发 app 的 `isLocal` 免登录旁路（务必别用 host 网络）。
- 跨用户隔离靠 **Cookie `Path=/<用户名>/` 作用域** + 每容器独立账号：浏览器不会把一个用户的登录态发给另一个用户的路径。
- 阿里云安全组：**22 限本人 IP**；开 80/443；**不要**对公网开 3000/8090。
- fail2ban `caddy-login` jail 盯登录失败的 401 —— 路径路由后失败请求路径变成 `/<用户名>/api/login`，**需把 jail 正则从 `/api/login` 放宽到匹配 `/[^/]+/api/login`（或直接匹配 `/api/login$` 结尾）并重新验证命中**。
- 加密与备份不含真实患者数据（本部署约定）。

## 关键实现注记

- **路径路由**：manager 按 URL 首段选容器并剥前缀；容器内 `BASE_PATH=/<用户名>` 让 app 的跳转/Cookie 补回前缀。裸 `/alice`（无尾斜杠）会 301 到 `/alice/`，保证页面相对 URL 正确。
- `restart: "no"`：空闲停机是主动 `docker stop`（退出码 143），`on-failure` 会误判崩溃反复重启。崩溃恢复交给 manager 的「下次请求唤醒」。
- `ocdata` 卷（`/root/.local/share/opencode`）持久化 opencode 会话历史 —— **没有它，按需停机会清空对话**。首次部署务必确认该路径正确：`docker exec agent-<name> ls /root/.local/share/opencode`。
- 冷启动后 app 的内存态登录 token 会失效，被唤醒的用户需重新登录一次（安全、可接受）。
