# 从零部署到一台新服务器（多用户）

三条命令上线：**装依赖 → 填配置 → 一键部署**。之后加用户一行搞定。
架构与调参细节见 [README-multiuser.md](README-multiuser.md)。

---

## 0. 前置条件（云控制台里做）

1. **一台服务器**：Ubuntu 22.04，≥2 vCPU / 4 GiB（约 10 人常用建议 8 核 16G）。香港等**免备案**地域省事。
2. **域名指向它**：一个域名的 A 记录指到服务器公网 IP（DuckDNS 免费够用；用户访问地址是 `https://域名/<用户名>/`，**不需要每人一个子域**）。
3. **安全组/防火墙**：
   - `22` **只放行你自己的 IP**；
   - `80`、`443` 放行（Caddy 自动 HTTPS 用）；
   - **不要**对公网开 `3000`、`8090`（它们只监听回环）。
4. **一个 DeepSeek API Key**（所有用户共用，账单/额度共享；只存宿主，不进用户容器——见下"上游 LLM key 不再进容器"）。

---

## 1. 拉代码 + 装宿主依赖（一条命令）

```bash
# 以 root 登录服务器
git clone https://github.com/imwei25/scientific-discover.git ~/sci-agent
cd ~/sci-agent
git checkout feat/multiuser-deploy          # 部署代码所在分支

sudo bash deploy/bootstrap-host.sh          # 装 docker/node20/caddy/git/fail2ban/2G swap/zram（幂等）
```

> 装的是标准依赖，脚本幂等、可重复跑。国内/香港机拉 docker/nodesource/caddy 源可能稍慢，耐心等。

---

## 2. 填配置

```bash
cp deploy/.env.example deploy/.env
vi deploy/.env
```
填三项（其余默认即可）：
```ini
DEEPSEEK_API_KEY=sk-你的真实密钥
BASE_DOMAIN=你的域名            # 例：weigu.duckdns.org
SCI_CONTACT_EMAIL=你@你的机构域名  # 必填！不能留占位值，见下
```

> ⚠ `SCI_CONTACT_EMAIL` 是**必填**的（`.env.example` 里也标了）：全文检索链路要用它作礼貌联系邮箱。
> 留着默认占位值 `you@your-org.com` 的话，**Unpaywall 会直接拒（HTTP 422）**、NCBI 也少一档礼貌池，
> `fulltext-retrieval` 技能会必然失败。填你机构的真实邮箱即可，别用 example.com。

---

## 3. 一键部署（一条命令）

```bash
sudo bash deploy/setup.sh
```
它会：① 构建镜像 → ② 装并启动 manager（systemd）→ ③ 把 Caddy 配成 `域名 → manager:8090`（自动签 HTTPS）→ ④ 装 fail2ban 规则（SSH + 登录爆破）→ ⑤ 收紧 `deploy/.env` 权限到 600、并加主机防火墙规则只让私网访问记账/转发端口 8091（`scripts/harden-quota-port.sh`，持久化依赖 `bootstrap-host.sh` 装的 `iptables-persistent`）。

---

## 4. 加用户（一行一个）

```bash
sudo deploy/scripts/user-add.sh alice admin     # 管理员：不限额
sudo deploy/scripts/user-add.sh bob             # 省略档位=free（普通，$0.30/天）
```
每次会打印该用户的 **访问地址 / 账号 / 随机强密码 / 档位**。把前三样发给对应的人即可。
> 档位（分级）定义在 `deploy/tiers.env`：`free`/`plus`/`admin`，每档一个每日额度与存储上限；改档用 `user-tier.sh`。详见 `README-multiuser.md` 的"用户分级"节。
- 访问：`https://你的域名/alice/`，或直接开 `https://你的域名/` 用通用登录页填账号密码。
- 首次访问会冷启动容器（约 10–40s），空闲自动停机，下次访问再唤醒。

---

## 5. 日常运维

| 操作 | 命令 |
|---|---|
| 加用户 | `sudo deploy/scripts/user-add.sh <名> [档位]`（省略档位=free） |
| 改用户档位（分级） | `sudo deploy/scripts/user-tier.sh <名> <档位>`（即时重启生效） |
| 看全员档位/额度/今日用量 | `sudo deploy/scripts/user-list.sh`，或**网页管理台** `https://你的域名/admin`（见下） |
| 开启网页管理台 | 编辑 **`/etc/sci-manager.env`**（chmod 600）设 `ADMIN_PASSWORD=<强密码>` → `systemctl restart sci-manager` → 访问 `https://你的域名/admin`。**别再去改 sci-manager.service 里的 `Environment=`**：单元里的 `EnvironmentFile=-/etc/sci-manager.env` 在所有 `Environment=` 之后，会把它覆盖掉，改了不生效还不报错 |
| 删用户（留数据） | `sudo deploy/scripts/user-del.sh <名>` |
| 删用户（连数据，先自动备份） | `sudo deploy/scripts/user-del.sh <名> --purge` |
| 改档位额度（对整档生效） | 编辑 `deploy/tiers.env` → `sudo deploy/scripts/render-compose.sh` → `docker compose up --no-start --force-recreate`（重建容器才会读到新额度，见下注） |
| 给某用户单独设额度（覆盖档位） | 编辑 `deploy/users/<名>.env` 取消注释 `DAILY_COST_LIMIT=`（USD/天，0=不限）→ `render-compose.sh && docker rm -f agent-<名> && docker compose up --no-start agent-<名>` |

> ⚠ 额度/存储上限是容器**环境变量**，在容器「创建」时固化；manager 唤醒用的是 `docker start`，**`docker restart` 不会重读 compose**。所以改额度后必须**重建**容器（如上；数据在命名卷里，重建不丢），或直接用 `user-tier.sh`（改档位时已自动重建）。
| **加 / 换生图 key（`QWEN_API_KEY`）** | **网关形态（当前生产）**：写进 **`/etc/sci-auth.env`** → `systemctl restart sci-auth`。走服务端 `/img` 转发通道，**key 只在服务器、客户端拿不到**，并按档位限每天张数（见下一行）。<br>容器形态才改 `deploy/.env`（那条路没有转发通道，key 会进容器、全体用户共用）。 |
| **改某档位每天能出几张图** | 管理台「档位」→ 每日生图张数（`imgDaily`，0 = 不限）；或 API `POST /admin/api/tier {key, imgDaily}`。**现查库、改完下一次调用即生效**，不吊销 key、不用重登。<br>当前初值：free 2 / plus 5 / admin 10（张/天，UTC 0 点重置）。<br>⚠ **不传 `imgDaily` 时保留原值**——漏传不会把限额抹成"不限"。 |
| 加 / 换一把技能用的 API key（检索、OCR…） | 编辑 **`deploy/.env`**（模板见 `deploy/.env.example`）→ `sudo deploy/scripts/render-compose.sh` → **重建**容器 `docker compose up --no-start --force-recreate`。<br>⚠ 必须重建：这些 key 是容器**环境变量**，在容器「创建」时固化，`docker restart` 不会重读 compose（同下方⚠注）。<br>⚠ 这类 key 注入容器后**容器内 agent 一句 `env` 就读得到**，等于全体用户共用。所以只放"可随时重置、能设消费上限"的 key（检索 / OCR）；主上游 LLM key 与生图 key 都刻意不走这条路 |
| 改了代码后更新 | `sudo bash deploy/scripts/redeploy-skills.sh --pull`（拉代码 → 重建镜像 → **重建**容器）。<br>⚠ 别用 `docker restart`：它只重启既有容器、仍跑创建时那份旧镜像，**新代码看着更新了其实没生效**（同下方⚠注）。另 `docker restart agent-*` 里的 `agent-*` 不是文件名，shell 不会展开，命令本身也跑不通 |
| 每日备份（建 cron） | `sudo deploy/scripts/backup.sh`（7 天轮转，写 `/var/backups/sci/`） |
| 看谁在跑 | `docker ps --filter name=agent-` |
| 调并发/闲置 | 编辑 **`/etc/sci-manager.env`** 的 `WARM_CAP`/`IDLE_MS` → `systemctl restart sci-manager`（不必 daemon-reload）。同上：改单元里的 `Environment=` 会被这个文件覆盖，无效 |

### 宿主侧额度账本（防容器内篡改）

每日成本的**权威账本在宿主**：manager 另开一个记账端点（默认 `0.0.0.0:8091`，`/etc/sci-manager.env` 的 `QUOTA_LISTEN` 可改/置空关闭），各用户容器的网关把成本增量上报到宿主 `deploy/data/quota/<用户>.json`，容器内 `quota.json` 只是回退缓存。这样容器里的 agent（root、能跑任意命令）改不到账本，"让 AI 清零 quota.json" 绕不过每日额度；manager 在代理 `/api/chat/start` 时还会按宿主账本再拦一道。

- 上报凭据是 `users/<名>.env` 里的 `QUOTA_TOKEN`（`user-add.sh` 生成；老用户由 `render-compose.sh` 自动补发）。端点**只收正增量**，令牌即使被容器内 agent 读走，也只能给自己多记账。
- ⚠ 云安全组 / 防火墙**不要**放行 8091：它只该被本机容器（172.x 私网）访问，端点自身也校验私网来源 + 令牌。
- 升级到此机制需**重建**容器（`render-compose.sh` 后 `docker compose up --no-start --force-recreate`），让 `QUOTA_API_URL`/`QUOTA_TOKEN`/`extra_hosts` 生效；未重建的老容器仍走本地记账，admin 台读数对其自动回退。

### 上游 LLM key 不再进容器

`DEEPSEEK_API_KEY` 是全体用户共用的上游 key，原先注入每个容器 env——容器里的 agent 一句 `env` 就能读走。现在 `render-compose.sh` **不再注入它**：容器 opencode 统一以每用户 `QUOTA_TOKEN` 走 manager 记账端点的 **`/llm` 转发通道**，manager 验完令牌把 Authorization 换成真实 key 再流式转发（SSE 不攒包）。真实 key 只存在于宿主（`deploy/.env`，或 `/etc/sci-manager.env` 的 `LLM_UPSTREAM_KEY`，manager 优先读后者、自动回落前者）。

- 令牌泄露的爆炸半径：从「全局上游 key」缩小到「该用户自己的转发通道」；换发只需改 `users/<名>.env` 的 `QUOTA_TOKEN` → `render-compose.sh` → 重建该容器。停用用户即断其通道。
- 想让全部流量走 one-api 网关调度：在 `/etc/sci-manager.env` 设 `LLM_UPSTREAM_URL=http://127.0.0.1:3010/v1` + `LLM_UPSTREAM_KEY=<one-api令牌>`（容器无感）。
- 恢复旧直连行为（不推荐）：在 `deploy/.env` 显式设 `OC_GATEWAY_URL`/`OC_GATEWAY_KEY`（它们对 compose 默认值有覆盖权）。

### one-api 管理接口（网页"切换同供应商模型" + /admin 网关渠道面板）

> **迁移到新机器时若要用这两个功能，必须在 `/etc/sci-manager.env` 设** `ONEAPI_URL` + `ONEAPI_TOKEN`（两者皆非空才启用）。这和上面的 `LLM_UPSTREAM_*` 是**两回事**：`LLM_UPSTREAM_*` 是"转发用哪把上游 key"，`ONEAPI_*` 是"manager 去 one-api 的**管理 API** 读渠道/模型列表"。不设的话前端"切换同供应商模型"与 `/admin` 网关面板显示"网关未接入"，其余功能不受影响。

- `ONEAPI_URL`：one-api 地址，如 `http://127.0.0.1:3010`。
- `ONEAPI_TOKEN`：one-api 的**系统访问令牌**（管理台"设置→系统访问令牌"，请求头 `New-Api-User: 1`），**不是**普通 `sk-` 渠道 key。
- 完整注释见 `deploy/sci-manager.env.example`。历史坑：这两项一度被 inline 写死在 systemd 单元里（旧机器可能仍是），务必归位到 `/etc/sci-manager.env`——放单元 `Environment=` 会覆盖 env 文件、且 setup.sh 升级旧单元时可能漏迁（已修，见 setup.sh 的迁移清单）。
- ⚠ 若把 `QUOTA_LISTEN` 置空关掉记账端点，`/llm` 通道也随之关闭，容器将**调不到模型**——除非按上一条显式配直连。
- ⚠ **升级顺序**：新容器把模型流量与记账都指向宿主 `:8091`。务必**先** `systemctl restart sci-manager`（让新版 manager 起来监听 8091）、**再**重建容器（`render-compose.sh` → `docker compose up --no-start --force-recreate`）。顺序反了：容器起来时 `:8091` 还没人听 → 连模型都调不到（连接被拒）。反向中间态（新 manager + 尚未重建的老容器）是安全的：老容器仍带自己的 `DEEPSEEK_API_KEY` 直连、额度读卷内 `quota.json`。

### 定时备份

`backup.sh` 每次把 **每个用户的数据卷**（uploads/outputs/ocdata）+ **配置密钥**（`.env`/`users/*.env`/compose，不在 git 里、全量恢复必需）打包到 `/var/backups/sci/<日期>/`，保留最近 7 天。

装每日 cron（每天 3:30）：
```bash
echo '30 3 * * * root /root/sci-agent/deploy/scripts/backup.sh >/var/log/sci-backup.log 2>&1' | sudo tee /etc/cron.d/sci-backup
sudo /root/sci-agent/deploy/scripts/backup.sh    # 先手动跑一次验证
```

**异地容灾**（同盘备份挡不住磁盘/整机损坏，可选）：再把目录同步到别处，例如
```bash
# 追加到上面的 cron 后面，或单独一条：把当天备份同步到另一台机
rsync -az /var/backups/sci/ backup-host:/backups/sci/
```

**恢复**（新机上）：跑完 §1–§3 后，解开配置与数据卷即可：
```bash
cd /root/sci-agent/deploy
tar xzf /path/to/config.tar.gz                                  # 还原 .env / users/*.env / compose
scripts/render-compose.sh
for v in /path/to/<用户>-{uploads,outputs,ocdata}.tar.gz; do    # 逐个还原数据卷
  vol=$(basename "$v" .tar.gz)
  docker volume create "$vol" >/dev/null
  docker run --rm -v "$vol:/data" -v "$(dirname "$v"):/b" alpine tar xzf "/b/$(basename "$v")" -C /data
done
systemctl reload sci-manager
```

调参口径见 [README-multiuser.md](README-multiuser.md)：`WARM_CAP≈可用内存/1.75G`；4G 机 2、16G 机 ~6。

---

## 6. 安全收尾（上线后务必做）

- **SSH 换密钥登录**：把你的公钥加进 `~/.ssh/authorized_keys`，然后 `sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl restart ssh`。
- 安全组：确认 `22` 只对你的 IP，`3000/8090/8091` 不对公网（8090/3000 只听回环；**8091 必须听 0.0.0.0**——per-user 多网络架构所需——已由 setup.sh ⑤ 的主机 iptables 规则 + 应用层私网校验双重兜底，但云安全组**仍须人工确认不放行 8091**，这是第一道闸）。
- 主机防火墙（8091 记账/转发端口）：由 `setup.sh` ⑤ 自动装（`scripts/harden-quota-port.sh`，独立链 `SCI-QUOTA` 仅放行 `172.16/12`+回环）。规则持久化需 `iptables-persistent`（`bootstrap-host.sh` 已装）；验证 `iptables -S INPUT | grep 8091`。想单独重跑：`sudo bash deploy/scripts/harden-quota-port.sh`。
- fail2ban 已装 `sshd` 与 `caddy-login` 两个 jail：`sudo fail2ban-client status caddy-login` 可查。
- 别把真实患者数据放上来（本部署约定）。

---

## 7. 回滚 / 卸载

- **停某用户**：`docker stop agent-<名>`（下次访问自动唤醒）。
- **整体停服**：`systemctl stop sci-manager caddy`。
- **卸载 manager**：`systemctl disable --now sci-manager && rm /etc/systemd/system/sci-manager.service`。
- **删所有数据卷**（危险）：`docker volume ls -q | grep -E '\-(uploads|outputs|ocdata)$' | xargs -r docker volume rm`。

---

## 已验证 / 未验证

- **已在真实服务器验证**：`setup.sh` 的每一步（构建镜像、装 manager、Caddy 反代、fail2ban 命中）、路径路由、通用登录、每日额度拦截、按需启停、跨用户隔离。
- **未在全新机器跑过**：`bootstrap-host.sh` 里装 docker/node/caddy 的那几条（都是各家官方标准装法，但没在一台干净的新机上端到端跑过一遍）。首次用新机建议逐行留意其输出。
