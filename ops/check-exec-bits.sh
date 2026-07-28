#!/usr/bin/env bash
# ============================================================================
# CI 闸：所有运维脚本在 git 里必须是 100755。
#
# 由来：2026-07-28 那次迁移，deploy/export-all.sh 与 import-all.sh 在 git 里是 100644，
# 新机完整 checkout 后照文档敲 ./import-all.sh 直接 Permission denied —— 而那恰恰是
# 整条恢复链的入口。可执行位是功能的一部分，值得有一道闸。
#
# 范围：运维/部署脚本（会被人直接 ./ 跑）。**不**管两类：
#   · .opencode/skills/** —— 技能脚本一律由 SKILL.md 里的 `bash xxx.sh` 调用，不需要可执行位；
#   · desktop/** —— 打包进来的第三方运行时，不归我们管。
#
# 用法：ops/check-exec-bits.sh        （退出码非 0 = 有脚本缺可执行位）
# ============================================================================
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

BAD="$(git ls-files -s -- '*.sh' ':(exclude).opencode/**' ':(exclude)desktop/**' \
       | awk '$1 != "100755" { print $1 "  " $4 }')"
if [ -n "$BAD" ]; then
  echo "!! 以下 .sh 在 git 里不是 100755（新机 checkout 后 ./xxx.sh 会 Permission denied）：" >&2
  echo "$BAD" >&2
  echo >&2
  echo "修：git update-index --chmod=+x <文件>" >&2
  exit 1
fi
N="$(git ls-files -- '*.sh' ':(exclude).opencode/**' ':(exclude)desktop/**' | wc -l)"
echo "✅ 运维/部署脚本的可执行位齐了（$N 个）"
