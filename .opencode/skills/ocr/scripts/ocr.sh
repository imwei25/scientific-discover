#!/usr/bin/env bash
# ocr.sh —— OCR 技能的 bash 入口：**只负责找到 .venv 的 python，逻辑全在 ocr.py**。
#
# 【为什么拆开】以前 280 行 Python 塞在这个文件的 heredoc 里，于是"跑 OCR"变成了"必须有 bash"。
# Windows 上（桌面打包版、纯 PowerShell 会话）常常没有 bash，agent 一看是 .sh 就自己另找出路，
# 典型的错法是直接去调 win_ocr.ps1 —— 那是三条通道里最差的一条（离线兜底、不做表格、不认 PDF），
# 等于主动放弃云端 Engine3。现在三个入口等价：
#     bash        ocr.sh a.jpg
#     powershell  ocr.ps1 a.jpg
#     <.venv 的 python> ocr.py a.jpg
#
# 用法与通道说明见 ocr.py 抬头。
set -euo pipefail

[[ $# -lt 1 ]] && { echo "用法: bash ocr.sh <图片/PDF 的 URL 或路径> [更多...]" >&2; exit 1; }

# 解析项目根 .venv 的 python（优先 .venv，逐级向上找；回退 PATH 上的 python3/python/py）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
resolve_py() {
  local d="$SCRIPT_DIR"
  for _ in 1 2 3 4 5 6 7; do
    for p in "$d/.venv/Scripts/python.exe" "$d/.venv/bin/python"; do
      [[ -x "$p" ]] && { echo "$p"; return; }
    done
    d="$(dirname "$d")"
  done
  for c in python3 python py; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; return; }; done
}
PY="$(resolve_py)"
[[ -z "$PY" ]] && { echo "ERROR: 未找到 python（缺 .venv 先跑 env-setup 技能）" >&2; exit 3; }

export OCR_SKILL_SCRIPTS="$SCRIPT_DIR"
exec "$PY" "$SCRIPT_DIR/ocr.py" "$@"
