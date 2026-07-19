# 【已废弃】容器内 token 分级设计 —— 存档，勿照此实现

**归档日期**：2026-07-18（第二轮 bug 审查 D1）
**结论：这套设计从未接线，运行时零生效。真实生效的是另一套，见下。**

## 这里放了什么

| 文件 | 原位置 | 说明 |
|---|---|---|
| `quota.mjs` | `web/quota.mjs` | 按 **token** 计的分级/额度/用量模块。`web/server.mjs` **从未 import 它**。 |
| `admin.html` | `web/admin.html` | 管理台页面，调 `api/admin/overview\|user\|tier`。`server.mjs` **没有任何 `/api/admin/*` 路由**，也没有返回该页面的静态路由 → 访问只会 404。 |
| `state/` | `deploy/state/` | `users.json`(档位)+`usage/`(用量) 的共享目录。`render-compose.sh` **不挂载它**，容器里根本没有。 |
| `用户分级与数据迁移.md` | `deploy/用户分级与数据迁移.md` | 描述上面这套设计的文档，写得像已实现，实际没有。 |

补充：`deploy/Dockerfile` 只 `COPY web/server.mjs web/index.html web/login.html`，
所以 `quota.mjs`/`admin.html` **连镜像都没进过**——它们纯粹是仓库里的死代码。

## 真实生效的是什么

- **额度**：`web/server.mjs` 内置，按 **USD 成本**计（`DAILY_COST_LIMIT`），**UTC 0 点**重置，
  额度值由 `deploy/tiers.env` 的档位表经 `render-compose.sh` 注入每个容器。
  （本存档那套是按 token 计、**北京时间**重置——两套的计量单位与重置时区都不一样，别混用。）
- **管理台**：在**宿主侧** `deploy/manager.mjs` 的 `/admin`，有 ADMIN_PASSWORD + 图形验证码 +
  Secure/SameSite=Strict cookie + 审计日志。不在用户容器里。
- **账号/档位数据源**：`deploy/users/*.env`（账号+密码+端口）与 `deploy/tiers.env`（档位），
  **不是** `state/users.json`。备份口径见 `deploy/scripts/backup.sh`。

## 为什么要归档而不是留在原地

它已经**真实误导过一次**：`deploy/export-all.sh` / `import-all.sh` 当初照着这套废弃设计写，
去备份并不存在的 `./state`、用并不存在的 `${PROJ}_` 前缀找卷，
导致**迁移脚本会丢光全部用户数据**（2026-07-18 已重写修复，见 `docs/bug审查-第二轮-2026-07-18.md` B1–B3）。

还有一个未来隐患：若有人把 `quota.mjs` 的 `setUserTier/setTier/listAll` 接进 `server.mjs`
而忘了加 `IS_ADMIN` 门禁，**每个注册用户都能改所有人的档位**。

## 若将来真要做容器内 token 分级

别直接复用这些文件，至少先解决：
1. 加 `IS_ADMIN` 门禁，且只在管理员容器暴露 `/api/admin/*`；
2. 与现有 USD 额度**二选一或明确合并**（单位、重置时区都要统一）；
3. `render-compose.sh` 要真的挂载共享 state 卷，并处理多容器并发写 `usage/` 的竞态。
