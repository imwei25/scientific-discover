#!/usr/bin/env bash
# render_docx.sh — Markdown → Word (.docx) via pandoc, for journal submission.
#
# Word is what most medical journals actually accept for submission, and it is much
# less prone than the xelatex PDF path to silently dropping CJK glyphs (Word stores
# UTF-8 text and auto-substitutes a system font), so Chinese generally "just works".
#
# Usage:
#   render_docx.sh -i input.md [-o output.docx]
#                  [--journal nejm|lancet|jama|bmj|cmj|generic-submission|list]
#                  [--font NAME] [--cjk-font NAME] [--fontsize PT]
#                  [--margin 1in|2.5cm] [--line-spacing 1.0|1.5|2.0|single|double]
#                  [--line-numbers]
#                  [--ref reference.docx]        # template for styles/fonts
#                  [--csl style.csl] [--bib refs.bib]   # citation rendering (pandoc @keys)
#                  [-- <extra pandoc args>]
#
# 优先级: 命令行显式参数 > --journal 预设 > pandoc 默认。
# 预设/CSL 在 ../presets/（与 render-pdf-doc 共用）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESET_DIR="$SCRIPT_DIR/../presets"

# Resolve a Python interpreter for the post-processor (project-root .venv first —
# repo convention; python3 does not exist on many Windows installs).
resolve_py() {
  local d="$SCRIPT_DIR"
  for _ in 1 2 3 4 5 6; do
    for p in "$d/.venv/Scripts/python.exe" "$d/.venv/bin/python"; do
      [[ -x "$p" ]] && { echo "$p"; return; }
    done
    d="$(dirname "$d")"
  done
  for c in python3 python py; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; return; }; done
}

INPUT=""; OUTPUT=""; REF=""; CSL=""; BIB=""; EXTRA=()
JOURNAL=""; FONT=""; CJKFONT=""; FONTSIZE=""; MARGIN=""; LINESPACING=""; LINENUMBERS=""; FIGSATEND=""
usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") -i <input.md> [-o <output.docx>] [options] [-- <pandoc args>]
  -i             input markdown (required)
  -o             output .docx (default: <input>.docx)
  --journal J    期刊预设: nejm lancet jama bmj cmj generic-submission (--journal list 列出)
  --font NAME    西文正文字体 (e.g. "Times New Roman")
  --cjk-font N   中文正文字体 (e.g. 宋体)
  --fontsize PT  字号 (e.g. 12)
  --margin SPEC  页边距 (1in / 2.5cm)
  --line-spacing 行距: 数字倍数或 single/onehalf/double
  --line-numbers 连续行号
  --figures-at-end  把图表搬到正文末尾（NEJM/JAMA/Lancet 送审稿要求）
  --ref          reference .docx (styles/fonts template；与格式参数可叠加，模板先套、参数后覆盖)
  --csl          CSL style: 文件路径或 presets/csl 里的名字 (vancouver / the-lancet …) — needs @keys + --bib
  --bib          bibliography (.bib) for --csl
  -h|--help
EOF
  exit 1
}
list_presets() {
  echo "可用期刊预设 (presets/*.env):" >&2
  for f in "$PRESET_DIR"/*.env; do
    [[ -f "$f" ]] || continue
    echo "  - $(basename "$f" .env)" >&2
  done
  exit 0
}
# 行距关键词 → 倍数
norm_spacing() {
  case "$1" in
    single) echo "1.0" ;;
    onehalf|1.5x) echo "1.5" ;;
    double) echo "2.0" ;;
    *) echo "$1" ;;
  esac
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i) INPUT="$2"; shift 2 ;;
    -o) OUTPUT="$2"; shift 2 ;;
    --journal) JOURNAL="$2"; shift 2 ;;
    --font) FONT="$2"; shift 2 ;;
    --cjk-font) CJKFONT="$2"; shift 2 ;;
    --fontsize) FONTSIZE="$2"; shift 2 ;;
    --margin) MARGIN="$2"; shift 2 ;;
    --line-spacing) LINESPACING="$(norm_spacing "$2")"; shift 2 ;;
    --line-numbers) LINENUMBERS=1; shift ;;
    --figures-at-end) FIGSATEND=1; shift ;;
    --ref) REF="$2"; shift 2 ;;
    --csl) CSL="$2"; shift 2 ;;
    --bib) BIB="$2"; shift 2 ;;
    -h|--help) usage ;;
    --) shift; EXTRA=("$@"); break ;;
    -*) echo "ERROR: unknown option '$1' (put pandoc pass-through args after '--')" >&2; usage ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

[[ "$JOURNAL" == "list" ]] && list_presets
[[ -z "$INPUT" ]] && usage
[[ -f "$INPUT" ]] || { echo "ERROR: input not found: $INPUT" >&2; exit 2; }
# strip the last extension (handles .md/.markdown/.MD), not just a literal .md
[[ -z "$OUTPUT" ]] && OUTPUT="${INPUT%.*}.docx"

# ---- journal preset: fill any formatting knob the CLI didn't set explicitly ----
PRESET_NOTE=""
if [[ -n "$JOURNAL" ]]; then
  case "$JOURNAL" in
    中华医学杂志|中华系列|zhonghua) JOURNAL="cmj" ;;
    generic|通用) JOURNAL="generic-submission" ;;
  esac
  PFILE="$PRESET_DIR/$JOURNAL.env"
  if [[ ! -f "$PFILE" ]]; then
    echo "ERROR: 未知期刊预设 '$JOURNAL'；--journal list 查看可用项，或改用 --font/--margin/... 手动指定" >&2
    exit 2
  fi
  PRESET_MARGIN=""; PRESET_FONT=""; PRESET_CJKFONT=""; PRESET_FONTSIZE=""
  PRESET_LINESPACING=""; PRESET_LINENUMBERS=""; PRESET_CSL=""
  # shellcheck disable=SC1090
  source "$PFILE"
  [[ -z "$FONT" ]] && FONT="$PRESET_FONT"
  [[ -z "$CJKFONT" ]] && CJKFONT="$PRESET_CJKFONT"
  [[ -z "$FONTSIZE" ]] && FONTSIZE="$PRESET_FONTSIZE"
  [[ -z "$MARGIN" ]] && MARGIN="$PRESET_MARGIN"
  [[ -z "$LINESPACING" ]] && LINESPACING="$PRESET_LINESPACING"
  [[ -z "$LINENUMBERS" && "$PRESET_LINENUMBERS" == "1" ]] && LINENUMBERS=1
  # 预设的 CSL 只在用户给了 .bib（稿件是 @key 引用）时才用得上
  if [[ -z "$CSL" && -n "$BIB" && -n "$PRESET_CSL" ]]; then CSL="$PRESET_CSL"; fi
  if [[ -z "$BIB" && -n "$PRESET_CSL" ]]; then
    echo "[render_docx] 注：预设含参考文献样式 ($PRESET_CSL)，但未给 --bib——仅当稿件用 pandoc [@key] 引用并提供 .bib 时才能重排参考文献；[n] 文本引用的稿件此项不生效" >&2
  fi
fi

# --csl 允许写 presets/csl 里的名字（vancouver / the-lancet / …），免用户找文件
if [[ -n "$CSL" && ! -f "$CSL" ]]; then
  for cand in "$PRESET_DIR/csl/$CSL" "$PRESET_DIR/csl/$CSL.csl"; do
    [[ -f "$cand" ]] && { CSL="$cand"; break; }
  done
fi
# --csl and --bib must come as a pair (citeproc needs a bibliography)
if [[ -n "$CSL" && -z "$BIB" ]] || [[ -z "$CSL" && -n "$BIB" ]]; then
  echo "ERROR: --csl and --bib must be used together (citeproc needs both a style and a bibliography)" >&2
  exit 1
fi

# Windows/Git Bash: winget-installed pandoc frequently lands off the Git Bash PATH,
# so it reads as "not installed" even after a successful install. Best-effort: prepend
# its known install locations when not already resolvable. Mirrors
# render-pdf-doc/scripts/check_deps.sh so the two renderers agree on pandoc presence.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if ! command -v pandoc >/dev/null 2>&1; then
      _la="$(cygpath -u "${LOCALAPPDATA:-}" 2>/dev/null || printf '%s' "${LOCALAPPDATA:-}")"
      _pf="$(cygpath -u "${PROGRAMFILES:-}" 2>/dev/null || printf '%s' "${PROGRAMFILES:-}")"
      for _p in \
        "$_la"/Microsoft/WinGet/Packages/JohnMacFarlane.Pandoc*/pandoc-*/pandoc.exe \
        "$_la"/Microsoft/WinGet/Links/pandoc.exe \
        "$_pf"/Pandoc/pandoc.exe; do
        if [[ -x "$_p" ]]; then PATH="$(dirname "$_p"):$PATH"; break; fi
      done
    fi
    ;;
esac

if ! command -v pandoc >/dev/null 2>&1; then
  echo "ERROR: pandoc not installed. Install it: install.ps1 -WithPdf / install.sh --with-pdf" >&2
  echo "       (or winget install JohnMacFarlane.Pandoc / apt-get install pandoc / brew install pandoc)" >&2
  exit 3
fi

ARGS=(-o "$OUTPUT" --resource-path ".:$(dirname "$INPUT")")
[[ -n "$REF" ]] && { [[ -f "$REF" ]] || { echo "ERROR: --ref not found: $REF" >&2; exit 2; }; ARGS+=(--reference-doc "$REF"); }
if [[ -n "$CSL" || -n "$BIB" ]]; then
  ARGS+=(--citeproc)
  [[ -n "$CSL" ]] && { [[ -f "$CSL" ]] || { echo "ERROR: --csl not found: $CSL" >&2; exit 2; }; ARGS+=(--csl "$CSL"); }
  [[ -n "$BIB" ]] && { [[ -f "$BIB" ]] || { echo "ERROR: --bib not found: $BIB" >&2; exit 2; }; ARGS+=(--bibliography "$BIB"); }
  # CSL 只对 pandoc [@key] 引用生效；[n] 文本引用稿（本套件 write-paper 默认）传 --csl 会静默
  # no-op，用户以为排了期刊参考文献格式其实没排。检测不到 [@key] 就明确警告。
  if ! grep -qE '\[@[[:alnum:]_-]+' "$INPUT"; then
    echo "[render_docx] WARN: 稿件未见 pandoc [@key] 引用，--csl/--bib 对 [n] 文本引用不生效——参考文献将原样保留、不会按 $(basename "${CSL:-CSL}") 重排。要重排请让写作阶段以 [@key] 引用并配 .bib。" >&2
  fi
fi

# --figures-at-end: 先把图表搬到文末，再交 pandoc（不改原稿，写临时文件）
SRCMD="$INPUT"
if [[ -n "$FIGSATEND" ]]; then
  PYBIN="$(resolve_py)"
  [[ -z "$PYBIN" ]] && { echo "ERROR: --figures-at-end 需 Python（.venv/PATH 均未找到）；先跑 env-setup" >&2; exit 5; }
  TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
  SRCMD="$TMPD/figend_$(basename "$INPUT")"
  FE=("$PYBIN" "$SCRIPT_DIR/figures_at_end.py" "$INPUT" --out "$SRCMD")
  # 与 citeproc 参考文献并用时，插文献锚点让参考文献表排在图表之前（正文→参考文献→图表）
  [[ -n "$CSL" ]] && FE+=(--refs-anchor)
  "${FE[@]}" || { echo "ERROR: figures_at_end.py failed" >&2; exit 5; }
fi

echo "[render_docx] in=$INPUT out=$OUTPUT journal='${JOURNAL:-none}' ref='${REF:-none}' csl='${CSL:-none}' figsatend='${FIGSATEND:-0}'" >&2
pandoc "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"} "$SRCMD" || { echo "ERROR: pandoc failed" >&2; exit 4; }

# ---- post-process: bake font / size / margin / spacing / line numbers into the docx ----
if [[ -n "$FONT$CJKFONT$FONTSIZE$MARGIN$LINESPACING$LINENUMBERS" ]]; then
  PYBIN="$(resolve_py)"
  if [[ -z "$PYBIN" ]]; then
    echo "ERROR: 找不到 Python（项目根 .venv 或 PATH），格式参数无法落盘；先跑 env-setup" >&2
    exit 5
  fi
  PP=("$PYBIN" "$SCRIPT_DIR/postprocess_docx.py" "$OUTPUT")
  [[ -n "$FONT" ]] && PP+=(--font "$FONT")
  [[ -n "$CJKFONT" ]] && PP+=(--cjk-font "$CJKFONT")
  [[ -n "$FONTSIZE" ]] && PP+=(--fontsize "$FONTSIZE")
  [[ -n "$MARGIN" ]] && PP+=(--margin "$MARGIN")
  [[ -n "$LINESPACING" ]] && PP+=(--line-spacing "$LINESPACING")
  [[ -n "$LINENUMBERS" ]] && PP+=(--line-numbers)
  "${PP[@]}" || { echo "ERROR: postprocess_docx.py failed（pandoc 产物在 $OUTPUT，但格式参数未生效）" >&2; exit 5; }
fi

[[ -n "$PRESET_NOTE" ]] && echo "[render_docx] 预设提示: $PRESET_NOTE" >&2
echo "[render_docx] ok → $OUTPUT" >&2
