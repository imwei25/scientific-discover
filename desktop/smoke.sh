#!/usr/bin/env bash
# 技能命令契约冒烟：与 SKILL.md 里写死的调用形态一字不差
set -e
echo "REPO_ROOT expands to: ${REPO_ROOT:-/app}"
${REPO_ROOT:-/app}/.venv/bin/python -c "import sys,pandas,scipy,matplotlib,lifelines; print(sys.executable); print('pandas',pandas.__version__,'scipy',scipy.__version__,'matplotlib',matplotlib.__version__)"
python3 -c "print('bare python3 ok')"
pandoc --version | head -1
echo "--- heredoc test（ocr/render 技能的调用形态）---"
${REPO_ROOT:-/app}/.venv/bin/python - <<'PY'
print("heredoc stdin python ok")
PY
echo ALL GREEN
