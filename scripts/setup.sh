#!/usr/bin/env bash
# 一键安装：科研医学 Skill 套件（Linux 服务器 / 非 Docker）
# - Python 统一走项目根虚拟环境 .venv（跨机器/跨框架可搬）
# - 装齐依赖，冒烟测试，校验所有 SKILL.md
# 用法（仓库根目录）：  bash scripts/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
REQ="$ROOT/scripts/requirements-skills.txt"

echo "== 科研 Skill 套件 一键安装（Linux）=="
echo "仓库根目录: $ROOT"

# 1) 确保虚拟环境存在
if [ ! -x "$PY" ]; then
  echo "未发现 .venv，正在创建 ..."
  python3 -m venv "$VENV"
fi
"$PY" --version

# 2) 升级 pip 并安装依赖
echo "升级 pip ..."
"$PY" -m pip install --upgrade pip -q
echo "安装依赖（首次约 3-8 分钟）..."
"$PY" -m pip install -r "$REQ"

# 2b) 文档排版工具链：pandoc + xelatex（render-pdf-doc 技能需要）
if ! command -v pandoc >/dev/null 2>&1 || ! command -v xelatex >/dev/null 2>&1; then
  echo "安装 pandoc + LaTeX(xelatex) + CJK 字体 ..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y \
      pandoc texlive-xetex texlive-fonts-recommended texlive-lang-cjk fonts-noto-cjk
  else
    echo "  ! 非 apt 系统，请手动安装 pandoc 与 texlive-xetex（提供 xelatex）"
  fi
else
  echo "pandoc + xelatex 已就绪"
fi

# 3) 冒烟测试
echo "冒烟测试 ..."
"$PY" - <<'PY'
import importlib
mods=["pandas","numpy","scipy","matplotlib","sklearn","seaborn","statsmodels","openpyxl",
      "requests","httpx","metapub","pymed","Bio","habanero","pyalex","bibtexparser","rispy",
      "docx","reportlab","lxml","bs4","tqdm","lifelines","adjustText","pymupdf","pymupdf4llm"]
bad=[]
for m in mods:
    try: importlib.import_module(m)
    except Exception as e: bad.append(f"{m}: {e}")
if bad:
    print("FAIL:", " | ".join(bad)); raise SystemExit(1)
print(f"OK: {len(mods)} 个包全部可导入")
PY

# 4) 校验技能
echo "校验技能 ..."
"$PY" "$ROOT/scripts/validate_skills.py"

# 5) 项目根路由：把 AGENTS.md 镜像成同目录 CLAUDE.md（Claude Code 读项目 ./CLAUDE.md；OpenCode 读 AGENTS.md）。
#    只落项目根、绝不写全局 ~/.claude，避免在无关项目触发本套件的路由铁律。
if [ -f "$ROOT/AGENTS.md" ]; then
  echo "写入项目根路由 CLAUDE.md（供 Claude Code）..."
  "$PY" "$ROOT/scripts/install_router.py" "$ROOT/AGENTS.md" "$ROOT/CLAUDE.md"
else
  echo "  ! 未在项目根找到 AGENTS.md，跳过 CLAUDE.md 路由"
fi

echo ""
echo "全部完成 ✔  解释器: $PY"
echo "技能统一用项目根 .venv：Linux/mac 是 .venv/bin/python，Windows 是 .venv\\Scripts\\python.exe。"
echo "vendored 技能(search-lit 等)内部用裸 python3——启动 OpenCode/网关前先激活让 python3 指向 venv："
echo "    source $VENV/bin/activate"
echo "（Docker 部署则用 deploy/requirements.txt，无需激活。）"
