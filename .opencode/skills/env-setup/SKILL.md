---
name: env-setup
description: 一键准备 / 自举运行环境。首次使用本套科研技能、或换机器 / 换智能体框架 / 换目录后，先跑它：检测 Python（没有就装）→ 在项目根创建 `.venv` 虚拟环境 → 装齐所有技能依赖（含 pandoc/xelatex 供出 PDF）→ 自检。当用户说"初始化环境""装依赖""第一次用""环境没配好""跑不起来 缺包""setup"，或任何技能报"缺 Python / 缺包 / 找不到 .venv"时，先用本技能。
---

# 环境自举技能

本套技能的 Python 一律跑在**项目根的 `.venv`** 里——不依赖系统 Python，也不写死任何机器绝对路径，所以能跨机器、跨框架直接搬。第一步先把它建好，之后所有技能都用它。

## 第零步：先确认它是不是真的坏了（**必做，不许跳**）

**打包版（桌面客户端）的 `.venv` 是随安装包装好的，不可能缺。** 绝大多数"找不到 .venv / 缺包"其实是**命令写错**，最常见的一条：

> 安装目录形如 `.../Niuma Science/bundle/app`，**里面有一个空格**。不加引号时 bash 会从空格处把路径切成两半，报
> `.../Local/Niuma: No such file or directory`。**这不是环境坏了，是漏了引号。**

所以进本技能后**先跑这一条自检**（路径务必带引号）：

```bash
"${SCI_PYTHON:-${REPO_ROOT:-/app}/.venv/bin/python}" -c "import sys, pandas, numpy, scipy, matplotlib; print('venv OK', sys.version, sys.executable)"
```

- **打印出 `venv OK` → 环境本来就是好的**：**立刻停止，什么都别装**。把 `sys.executable` 这个路径回报给用户/调用方，告诉他之前那条命令的正确写法是给路径加引号，然后**退出本技能**。
  - 禁止在这种情况下执行 `python -m venv`、`pip install -r requirements`、重装依赖或跑 `install.ps1`——环境已经就绪，重装只会白烧十几分钟，还可能把包版本弄坏。
- **报 `No such file or directory` 且路径在空格处断掉** → 同上，是引号问题，不是环境问题；补引号重试。
- **只有解释器确实不存在、或 `import` 真的报 ModuleNotFoundError**，才继续往下走安装流程；且此时**只补缺的那个包**，别整包重装。

## 一键（优先）
仓库里若有安装脚本，直接调它（下面所有步骤它都做了）。脚本在**仓库根目录**，要排版 PDF 加 `-WithPdf`（Windows）/ `--with-pdf`（Linux/macOS）：
- Windows：`powershell -ExecutionPolicy Bypass -File install.ps1`
- Linux / macOS：`bash install.sh`

可选开关（按需叠加）：`-WithPdf`/`--with-pdf`（排版 PDF 工具链）；**`-WithEmbed`/`--with-embed`（`zotero-library` 全文 RAG 的本地嵌入/精排：装 sentence-transformers + 从 ModelScope 下 BCE 嵌入与 reranker 模型，全程本地不触远程端点、不用生成模型；较重，含 torch + ~2.2GB 模型，默认跳过）**。

跑完就好，跳到「验证」。

## 手动分步（脚本不在 / 移植到别处时）
**在项目根目录**执行：

1. **确认 Python（需 3.10+）**。都没有就先装：
   - Windows：`winget install -e --id Python.Python.3.12`
   - Ubuntu/Debian：`sudo apt-get install -y python3 python3-venv python3-pip`
   - macOS：`brew install python@3.12`
2. **建虚拟环境**（已存在 `"${REPO_ROOT:-/app}/.venv"` 就跳过）：
   `python -m venv "${REPO_ROOT:-/app}/.venv"`（`python` 不存在就用 `python3` 或 `py -3`）
   > ⚠️ **路径必须带 `"${REPO_ROOT:-/app}/"` 前缀**：会话的当前工作目录是**该会话的产物目录**
   > （`outputs/<会话id>/`），写 `python -m venv .venv` 会把整个虚拟环境建到**用户的产物目录里**——
   > 既计入该用户的存储配额、又会出现在界面"产出"侧栏，而第 3 步要用的
   > `"${REPO_ROOT:-/app}/.venv/bin/python"` 依然不存在 → 整个引导流程死在这里。
3. **用 venv 的解释器装依赖**（从这步起就写死用 `.venv`，不再碰系统 Python）：
   `"${REPO_ROOT:-/app}/.venv/bin/python" -m pip install -U pip -r "${REPO_ROOT:-/app}/scripts/requirements-skills.txt"`
   > `-r` 后面的路径同样要带前缀：requirements 文件在**仓库**的 `scripts/` 下，
   > 相对当前工作目录（会话产物目录）找不到，会直接 FileNotFoundError。
   - 没有 requirements 文件时，至少装：
     `pandas numpy scipy matplotlib scikit-learn seaborn statsmodels openpyxl requests httpx metapub biopython habanero pyalex bibtexparser rispy python-docx reportlab lxml beautifulsoup4 tqdm lifelines adjustText pymupdf pymupdf4llm`
4. **排版工具链**（`render-pdf-doc` 出 PDF 用；不排版可跳过）：
   - Windows：`winget install --id JohnMacFarlane.Pandoc; winget install --id MiKTeX.MiKTeX`
   - Linux：`sudo apt-get install -y pandoc texlive-xetex texlive-lang-cjk fonts-noto-cjk`

## 之后所有技能怎么调 Python
统一用项目根 `.venv` 的解释器：
- **Windows**：`"${REPO_ROOT:-/app}/.venv/bin/python" 脚本.py`
- **Linux / macOS**：`"${REPO_ROOT:-/app}/.venv/bin/python" 脚本.py`

各技能的「Python 环境」段都按这个来；不要用系统 `python` / `python3` 直接装包或跑。

## 验证
`"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/scripts/validate_skills.py"`
（脚本在**仓库**的 `scripts/` 下，不带前缀会因当前工作目录是会话产物目录而找不到）

装完向用户汇报：Python 版本、`.venv` 路径、装了多少包、pandoc/xelatex 是否就绪。

## 约定
- venv 固定在**项目根 `.venv`**；已存在就复用，别重复创建。
- 全程用 `.venv` 的解释器，绝不用系统 Python 装包。
- 缺 Python 又无法自动安装（没有 winget/apt/brew 权限）时，如实告诉用户手动装 Python 3.10+ 再来，别硬撑。
- 联网差导致 pip 慢/失败时说明情况，可换国内镜像（`-i https://pypi.tuna.tsinghua.edu.cn/simple`）。
