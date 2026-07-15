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
4. **一个 DeepSeek API Key**（所有用户共用，账单/额度共享）。

---

## 1. 拉代码 + 装宿主依赖（一条命令）

```bash
# 以 root 登录服务器
git clone https://github.com/imwei25/scientific-discover.git ~/sci-agent
cd ~/sci-agent
git checkout feat/multiuser-deploy          # 部署代码所在分支

sudo bash deploy/bootstrap-host.sh          # 装 docker/node20/caddy/git/fail2ban/2G swap（幂等）
```

> 装的是标准依赖，脚本幂等、可重复跑。国内/香港机拉 docker/nodesource/caddy 源可能稍慢，耐心等。

---

## 2. 填配置

```bash
cp deploy/.env.example deploy/.env
vi deploy/.env
```
填两项（其余默认即可）：
```ini
DEEPSEEK_API_KEY=sk-你的真实密钥
BASE_DOMAIN=你的域名            # 例：weigu.duckdns.org
```

---

## 3. 一键部署（一条命令）

```bash
sudo bash deploy/setup.sh
```
它会：① 构建镜像 → ② 装并启动 manager（systemd）→ ③ 把 Caddy 配成 `域名 → manager:8090`（自动签 HTTPS）→ ④ 装 fail2ban 规则（SSH + 登录爆破）。

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
| 看全员档位/额度/今日用量 | `sudo deploy/scripts/user-list.sh` |
| 删用户（留数据） | `sudo deploy/scripts/user-del.sh <名>` |
| 删用户（连数据，先自动备份） | `sudo deploy/scripts/user-del.sh <名> --purge` |
| 改档位额度（对整档生效） | 编辑 `deploy/tiers.env` → `sudo deploy/scripts/render-compose.sh` → `docker compose up --no-start --force-recreate`（重建容器才会读到新额度，见下注） |
| 给某用户单独设额度（覆盖档位） | 编辑 `deploy/users/<名>.env` 取消注释 `DAILY_COST_LIMIT=`（USD/天，0=不限）→ `render-compose.sh && docker rm -f agent-<名> && docker compose up --no-start agent-<名>` |

> ⚠ 额度/存储上限是容器**环境变量**，在容器「创建」时固化；manager 唤醒用的是 `docker start`，**`docker restart` 不会重读 compose**。所以改额度后必须**重建**容器（如上；数据在命名卷里，重建不丢），或直接用 `user-tier.sh`（改档位时已自动重建）。
| 改了代码后更新 | `git pull && sudo deploy/scripts/build-image.sh` 再逐个 `docker restart agent-*`（或等其自然冷启动） |
| 每日备份（建 cron） | `sudo deploy/scripts/backup.sh`（7 天轮转，写 `/var/backups/sci/`） |
| 看谁在跑 | `docker ps --filter name=agent-` |
| 调并发/闲置 | 改 `/etc/systemd/system/sci-manager.service` 的 `WARM_CAP`/`IDLE_MS` → `systemctl daemon-reload && systemctl restart sci-manager` |

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
- 安全组：确认 `22` 只对你的 IP、`3000/8090` 不对公网。
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
