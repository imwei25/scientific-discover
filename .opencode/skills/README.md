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

脚本做的事：建/复用项目根 `.venv` → 装/更新依赖（`scripts/requirements-skills.txt`）→ 跑 `scripts/validate_skills.py` 校验（无 BOM、frontmatter 合法、引用脚本齐全、shell 脚本 LF）→ 把顶层 `AGENTS.md` 镜像成**项目根 `CLAUDE.md`**（供 Claude Code 读；OpenCode 直接读 `AGENTS.md`；**只落项目根，不写机器全局 `~/.claude`**）。

> **换机器 / 换框架（OpenCode·Claude Code·OpenClaw…）同理**：把技能拷到目标项目根后，在那儿跑一次脚本即可，无需改任何 SKILL.md。

## 唯一源头
本目录 `.opencode/skills/` 是技能的**唯一源头**：本地 OpenCode / Claude Code 直接读它，
桌面安装包由 `desktop/bundle.ps1` 直接打包它。改技能只改这里一处。

技能跑在**用户自己的机器上**（桌面版），服务器只做鉴权 + LLM 网关，不跑技能、不跑容器。
所以技能改完的分发路径是：① 技能包在线发布（管理台一键，客户端提示更新）；
② 或随下一版安装包发。**没有"重建镜像"这一步**——旧的 Docker 多用户架构已整体废弃。
