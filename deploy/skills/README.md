# 科研医学技能套件（skills/）

本目录是科研医学 Agent 的**技能集合**（20 个技能）。顶层调度不在这里——由仓库根的 **`AGENTS.md`**（常驻主控指令）判意图、按流水线依次调用这些技能；本目录只放各单项技能，每个 `<名>/SKILL.md` 有 description（触发条件）与职责。

## 更新技能仓库：跑一键脚本，别手动拷

拉取最新代码后（`git pull`），**在仓库根运行一键安装/更新脚本**——不要手动逐个复制技能目录。脚本会把依赖、路由、校验一次对齐：

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1      # 或 install.ps1
```
```bash
# Linux / macOS
bash scripts/setup.sh                                            # 或 install.sh
```

脚本做的事：建/复用项目根 `.venv` → 装/更新依赖（`scripts/requirements-skills.txt`）→ 跑 `scripts/validate_skills.py` 校验（无 BOM、frontmatter 合法、两套镜像技能集合一致、正文无漂移）→ 把顶层 `AGENTS.md` 镜像成**项目根 `CLAUDE.md`**（供 Claude Code 读；OpenCode 直接读 `AGENTS.md`；**只落项目根，不写机器全局 `~/.claude`**）。

> **换机器 / 换框架（OpenCode·Claude Code·OpenClaw…）同理**：把技能拷到目标项目根后，在那儿跑一次脚本即可，无需改任何 SKILL.md。

## 双镜像
- `.opencode/skills/`：本地（OpenCode，解释器走 `.venv\Scripts\python.exe`）
- `deploy/skills/`：服务器 / 容器（`python3`）；**线上更新要重建 Docker 镜像**才生效。

改技能须两套镜像同步改——`validate_skills.py` 会抓出「正文漂移」和「镜像不一致」。
