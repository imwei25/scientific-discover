---
name: env-setup
description: 一键准备 / 自举运行环境。首次使用本套科研技能、或换机器 / 换智能体框架 / 换目录后，先跑它：检测 Python（没有就装）→ 在项目根创建 `.venv` 虚拟环境 → 装齐所有技能依赖（含 pandoc/xelatex 供出 PDF）→ 自检。当用户说"初始化环境""装依赖""第一次用""环境没配好""跑不起来 缺包""setup"，或任何技能报"缺 Python / 缺包 / 找不到 .venv"时，先用本技能。
---

# 环境自举技能

本套技能的 Python 一律跑在**项目根的 `.venv`** 里——不依赖系统 Python，也不写死任何机器绝对路径，所以能跨机器、跨框架直接搬。第一步先把它建好，之后所有技能都用它。

## 一键（优先）
仓库里若有安装脚本，直接调它（下面所有步骤它都做了）。脚本在**仓库根目录**，要排版 PDF 加 `-WithPdf`（Windows）/ `--with-pdf`（Linux/macOS）：
- Windows：`powershell -ExecutionPolicy Bypass -File install.ps1`
- Linux / macOS：`bash install.sh`

跑完就好，跳到「验证」。

## 手动分步（脚本不在 / 移植到别处时）
**在项目根目录**执行：

1. **确认 Python（需 3.10+）**。都没有就先装：
   - Windows：`winget install -e --id Python.Python.3.12`
   - Ubuntu/Debian：`sudo apt-get install -y python3 python3-venv python3-pip`
   - macOS：`brew install python@3.12`
2. **建虚拟环境**（已存在 `.venv` 就跳过）：
   `python -m venv .venv`（`python` 不存在就用 `python3` 或 `py -3`）
3. **用 venv 的解释器装依赖**（从这步起就写死用 `.venv`，不再碰系统 Python）：
   - Windows：`.venv/Scripts/python.exe -m pip install -U pip -r scripts/requirements-skills.txt`
   - Linux/macOS：`.venv/bin/python -m pip install -U pip -r scripts/requirements-skills.txt`
   - 没有 requirements 文件时，至少装：
     `pandas numpy scipy matplotlib scikit-learn seaborn statsmodels openpyxl requests httpx metapub biopython habanero pyalex bibtexparser rispy python-docx reportlab lxml beautifulsoup4 tqdm lifelines adjustText pymupdf pymupdf4llm`
4. **排版工具链**（`render-pdf-doc` 出 PDF 用；不排版可跳过）：
   - Windows：`winget install --id JohnMacFarlane.Pandoc; winget install --id MiKTeX.MiKTeX`
   - Linux：`sudo apt-get install -y pandoc texlive-xetex texlive-lang-cjk fonts-noto-cjk`

## 之后所有技能怎么调 Python
统一用项目根 `.venv` 的解释器：
- **Windows**：`.venv/Scripts/python.exe 脚本.py`
- **Linux / macOS**：`.venv/bin/python 脚本.py`

各技能的「Python 环境」段都按这个来；不要用系统 `python` / `python3` 直接装包或跑。

## 验证
- Windows：`.venv/Scripts/python.exe scripts/validate_skills.py`
- Linux/macOS：`.venv/bin/python scripts/validate_skills.py`

装完向用户汇报：Python 版本、`.venv` 路径、装了多少包、pandoc/xelatex 是否就绪。

## 约定
- venv 固定在**项目根 `.venv`**；已存在就复用，别重复创建。
- 全程用 `.venv` 的解释器，绝不用系统 Python 装包。
- 缺 Python 又无法自动安装（没有 winget/apt/brew 权限）时，如实告诉用户手动装 Python 3.10+ 再来，别硬撑。
- 联网差导致 pip 慢/失败时说明情况，可换国内镜像（`-i https://pypi.tuna.tsinghua.edu.cn/simple`）。
