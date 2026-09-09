> 本文件从 SKILL.md「Python 环境」搬出，由 SKILL.md 在需要调用 `.venv` 解释器（跑 hollowness_check.py / 排版）时引用。下面是该节的完整原文（SKILL.md 正文只保留要点与指针）。

## Python 环境（可选，用于成品排版）
> **报「找不到 `.venv` / 缺 Python」先查命令里的引号**：安装目录含空格（`.../Niuma Science/bundle/app`），路径不加引号会被 bash 从空格处切断、报 `No such file or directory`——**那不是缺环境**。Python 环境随安装包/镜像装好，**不要重建 `.venv`、也不要重装依赖**（白烧十几分钟还可能弄坏包版本）；确认解释器真的不存在时，才在仓库根跑 `install.ps1`（Windows）/ `install.sh`。
```
"${REPO_ROOT:-/app}/.venv/bin/python"
```
