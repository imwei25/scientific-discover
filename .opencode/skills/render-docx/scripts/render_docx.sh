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
#                  [--no-infer-colwidths] [--no-table-tune]   # 表格自动排版兜底，默认开
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
HEADCJKFONT=""; HEADFONTSIZE=""
PAGENUMBERS=""; INDENTCHARS=""; CAPTIONFONTSIZE=""; TABLEFONTSIZE=""; TITLEFONTSIZE=""; H1FONTSIZE=""; AUTHORFONTSIZE=""
# 表格两开关默认开：pandoc 出的 docx 表要么 autofit（Word 自动布局不可预测）要么按
# 分隔行均分列宽，长列名必然排丑；推断列宽 + 后处理三线表是兜底，不改变表内容。
INFERCW=1; TABLETUNE=1; LANDSCAPEWIDE=""
# 块级空行补齐默认开：表题贴着表格写（模型极常见）会让 pandoc 把整张表摊平成一段文本，
# docx 里一个 <w:tbl> 都没有且**不报错**——静默丢表比排丑严重得多，故默认兜住。
NORMALIZE=1
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
  --heading-cjk-font N  标题(Heading 1-6)中文字体，与正文分开（标书"标题黑体、正文宋体"）
  --heading-fontsize PT 标题字号（各级统一；如四号=14）
  --title-fontsize PT   论文标题(Title 样式，来自稿件 YAML title)字号
  --h1-fontsize PT      一级标题(Heading 1)字号，覆盖 --heading-fontsize 的统一值
  --page-numbers        页脚居中加页码（PAGE 域）
  --indent-chars N      正文每段首行缩进 N 个英文半角字符（如 4）
  --caption-fontsize PT 图题/表题/表注字号（图表题并居中、单倍行距、序号加粗）
  --table-fontsize PT   表内字号（默认正文-1.5pt）
  --author-fontsize PT  作者/机构块字号并居中（稿件 YAML author: 生成的 Author 样式段）
  --figures-at-end  把图表搬到正文末尾（NEJM/JAMA/Lancet 送审稿要求）
  --no-infer-colwidths  关掉默认的按内容推断表格列宽（infer_colwidths.py）
  --no-table-tune       关掉默认的 docx 表格调优（三线表/固定列宽/表内字号降档）
  --no-normalize        关掉默认的块级空行补齐（表格/标题/列表前缺空行会被 pandoc 摊平成正文）
  --landscape-wide-tables 纵向压不下的宽表连同表题转入横向节（跨页表默认已重复表头+禁止行内断页）
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
    --heading-cjk-font) HEADCJKFONT="$2"; shift 2 ;;
    --heading-fontsize) HEADFONTSIZE="$2"; shift 2 ;;
    --title-fontsize) TITLEFONTSIZE="$2"; shift 2 ;;
    --h1-fontsize) H1FONTSIZE="$2"; shift 2 ;;
    --page-numbers) PAGENUMBERS=1; shift ;;
    --indent-chars) INDENTCHARS="$2"; shift 2 ;;
    --caption-fontsize) CAPTIONFONTSIZE="$2"; shift 2 ;;
    --table-fontsize) TABLEFONTSIZE="$2"; shift 2 ;;
    --author-fontsize) AUTHORFONTSIZE="$2"; shift 2 ;;
    --figures-at-end) FIGSATEND=1; shift ;;
    --no-infer-colwidths) INFERCW=""; shift ;;
    --no-table-tune) TABLETUNE=""; shift ;;
    --landscape-wide-tables) LANDSCAPEWIDE=1; shift ;;
    --no-normalize) NORMALIZE=""; shift ;;
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
  PRESET_HEADING_CJKFONT=""; PRESET_HEADING_FONTSIZE=""
  PRESET_PAGENUMBERS=""; PRESET_INDENT_CHARS=""; PRESET_CAPTION_FONTSIZE=""
  PRESET_TABLE_FONTSIZE=""; PRESET_TITLE_FONTSIZE=""; PRESET_H1_FONTSIZE=""
  PRESET_AUTHOR_FONTSIZE=""
  # shellcheck disable=SC1090
  source "$PFILE"
  [[ -z "$FONT" ]] && FONT="$PRESET_FONT"
  [[ -z "$CJKFONT" ]] && CJKFONT="$PRESET_CJKFONT"
  [[ -z "$HEADCJKFONT" ]] && HEADCJKFONT="$PRESET_HEADING_CJKFONT"
  [[ -z "$HEADFONTSIZE" ]] && HEADFONTSIZE="$PRESET_HEADING_FONTSIZE"
  [[ -z "$FONTSIZE" ]] && FONTSIZE="$PRESET_FONTSIZE"
  [[ -z "$MARGIN" ]] && MARGIN="$PRESET_MARGIN"
  [[ -z "$LINESPACING" ]] && LINESPACING="$PRESET_LINESPACING"
  [[ -z "$LINENUMBERS" && "$PRESET_LINENUMBERS" == "1" ]] && LINENUMBERS=1
  [[ -z "$PAGENUMBERS" && "$PRESET_PAGENUMBERS" == "1" ]] && PAGENUMBERS=1
  [[ -z "$INDENTCHARS" ]] && INDENTCHARS="$PRESET_INDENT_CHARS"
  [[ -z "$CAPTIONFONTSIZE" ]] && CAPTIONFONTSIZE="$PRESET_CAPTION_FONTSIZE"
  [[ -z "$TABLEFONTSIZE" ]] && TABLEFONTSIZE="$PRESET_TABLE_FONTSIZE"
  [[ -z "$TITLEFONTSIZE" ]] && TITLEFONTSIZE="$PRESET_TITLE_FONTSIZE"
  [[ -z "$H1FONTSIZE" ]] && H1FONTSIZE="$PRESET_H1_FONTSIZE"
  [[ -z "$AUTHORFONTSIZE" ]] && AUTHORFONTSIZE="$PRESET_AUTHOR_FONTSIZE"
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

SRCMD="$INPUT"

# --no-normalize 可关：把表格/标题/列表前缺的空行补上，必须排在所有预处理之前——
# 后面的 figures_at_end / infer_colwidths 都靠"能认出这是张表"才生效，表没被识别就全落空。
if [[ -n "$NORMALIZE" ]]; then
  PYNM="$(resolve_py)"
  if [[ -n "$PYNM" ]]; then
    if [[ -z "${TMPD:-}" ]]; then TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT; fi
    NMOUT="$TMPD/nm_$(basename "$SRCMD")"
    if "$PYNM" "$SCRIPT_DIR/normalize_md.py" "$SRCMD" --out "$NMOUT"; then
      SRCMD="$NMOUT"
    else
      echo "[render_docx] WARN: normalize_md.py 运行失败，跳过空行补齐（表格可能被摊平成正文）" >&2
    fi
  else
    echo "[render_docx] WARN: 未找到 Python，跳过空行补齐；若稿件里表题与表格贴着写，表会丢" >&2
  fi
fi

# --figures-at-end: 先把图表搬到文末，再交 pandoc（不改原稿，写临时文件）
if [[ -n "$FIGSATEND" ]]; then
  PYBIN="$(resolve_py)"
  [[ -z "$PYBIN" ]] && { echo "ERROR: --figures-at-end 需 Python（.venv/PATH 均未找到）；先跑 env-setup" >&2; exit 5; }
  if [[ -z "${TMPD:-}" ]]; then TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT; fi
  # 【读 $SRCMD 而非 $INPUT】否则上一步补好空行的中间文件会被直接丢掉、退回原稿
  FEIN="$SRCMD"
  SRCMD="$TMPD/figend_$(basename "$INPUT")"
  FE=("$PYBIN" "$SCRIPT_DIR/figures_at_end.py" "$FEIN" --out "$SRCMD")
  # 与 citeproc 参考文献并用时，插文献锚点让参考文献表排在图表之前（正文→参考文献→图表）
  [[ -n "$CSL" ]] && FE+=(--refs-anchor)
  "${FE[@]}" || { echo "ERROR: figures_at_end.py failed" >&2; exit 5; }
fi

# --infer-colwidths（默认开）：借 render-pdf-doc 的同名脚本按内容重写 pipe 表分隔行比例，
# 让 pandoc 把内容比例列宽带进 docx，而不是 autofit/均分。失败只降级警告，不阻塞渲染。
if [[ -n "$INFERCW" ]]; then
  ICW="$SCRIPT_DIR/../../render-pdf-doc/scripts/infer_colwidths.py"
  PYCW="$(resolve_py)"
  if [[ -f "$ICW" && -n "$PYCW" ]]; then
    if [[ -z "${TMPD:-}" ]]; then TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT; fi
    CWOUT="$TMPD/cw_$(basename "$SRCMD")"
    if "$PYCW" "$ICW" "$SRCMD" --out "$CWOUT" >/dev/null 2>&1; then
      SRCMD="$CWOUT"
    else
      echo "[render_docx] WARN: infer_colwidths.py 运行失败，跳过列宽推断（表用 pandoc 原列宽）" >&2
    fi
  else
    echo "[render_docx] WARN: 未找到 infer_colwidths.py（render-pdf-doc 技能）或 Python，跳过列宽推断" >&2
  fi
fi

echo "[render_docx] in=$INPUT out=$OUTPUT journal='${JOURNAL:-none}' ref='${REF:-none}' csl='${CSL:-none}' figsatend='${FIGSATEND:-0}' infercw='${INFERCW:-0}' tabletune='${TABLETUNE:-0}'" >&2
if [[ -z "${TMPD:-}" ]]; then TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT; fi
PERR="$TMPD/pandoc.err"
pandoc "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"} "$SRCMD" 2>"$PERR" \
  || { cat "$PERR" >&2; echo "ERROR: pandoc failed" >&2; exit 4; }
[[ -s "$PERR" ]] && cat "$PERR" >&2
# ★ 图片取不到时 pandoc【只警告、照样退 0】，产出的 docx 里一张图都没有 —— 这正是
#   "润色完图没了"那条链路上最后一道、也是最沉默的一环。必须把它升级成硬错误：
#   稿子里写着图、出件里没有图，是不能交付的产物，宁可红着停下让人补图。
if grep -q "Could not fetch resource" "$PERR" 2>/dev/null; then
  echo "ERROR: 稿件引用的图片找不到，pandoc 已把它们替换成文字说明——**产出的 .docx 里没有这些图**。" >&2
  grep "Could not fetch resource" "$PERR" | sed 's/^/       /' >&2
  echo "       修法：把图片文件放到稿件同级目录（或改成正确的相对路径）后重跑；" >&2
  echo "       原稿是 Word/PDF 的，用 humanize-academic/scripts/ingest_doc.py 重新读入即可把图抽出来。" >&2
  # 缺图的 .docx 已删除：留着它比没有更糟 —— 用户会当成成品直接投出去，
  # 而流水线只看"产物文件在不在"，留着还会把这一步判成绿的。
  rm -f "$OUTPUT"
  echo "       （缺图的 $OUTPUT 已删除，避免被当成可投稿的成品）" >&2
  exit 6
fi

# ---- post-process: bake font / size / margin / spacing / line numbers / tables into the docx ----
FMTARGS="$FONT$CJKFONT$FONTSIZE$MARGIN$LINESPACING$LINENUMBERS$HEADCJKFONT$HEADFONTSIZE$PAGENUMBERS$INDENTCHARS$CAPTIONFONTSIZE$TABLEFONTSIZE$TITLEFONTSIZE$H1FONTSIZE$AUTHORFONTSIZE"
if [[ -n "$FMTARGS$TABLETUNE" ]]; then
  PYBIN="$(resolve_py)"
  if [[ -z "$PYBIN" ]]; then
    # 显式格式参数拿不到 Python 是硬错误；只剩默认表格调优则降级警告，保住 docx 产物
    if [[ -n "$FMTARGS" ]]; then
      echo "ERROR: 找不到 Python（项目根 .venv 或 PATH），格式参数无法落盘；先跑 env-setup" >&2
      exit 5
    fi
    echo "[render_docx] WARN: 找不到 Python，跳过表格调优（三线表/固定列宽未生效）；先跑 env-setup" >&2
  else
    PP=("$PYBIN" "$SCRIPT_DIR/postprocess_docx.py" "$OUTPUT")
    [[ -n "$FONT" ]] && PP+=(--font "$FONT")
    [[ -n "$CJKFONT" ]] && PP+=(--cjk-font "$CJKFONT")
    [[ -n "$FONTSIZE" ]] && PP+=(--fontsize "$FONTSIZE")
    [[ -n "$MARGIN" ]] && PP+=(--margin "$MARGIN")
    [[ -n "$LINESPACING" ]] && PP+=(--line-spacing "$LINESPACING")
    [[ -n "$LINENUMBERS" ]] && PP+=(--line-numbers)
    [[ -n "$LANDSCAPEWIDE" ]] && PP+=(--landscape-wide-tables)
    [[ -n "$HEADCJKFONT" ]] && PP+=(--heading-cjk-font "$HEADCJKFONT")
    [[ -n "$HEADFONTSIZE" ]] && PP+=(--heading-fontsize "$HEADFONTSIZE")
    [[ -n "$TITLEFONTSIZE" ]] && PP+=(--title-fontsize "$TITLEFONTSIZE")
    [[ -n "$H1FONTSIZE" ]] && PP+=(--h1-fontsize "$H1FONTSIZE")
    [[ -n "$PAGENUMBERS" ]] && PP+=(--page-numbers)
    [[ -n "$INDENTCHARS" ]] && PP+=(--indent-chars "$INDENTCHARS")
    [[ -n "$CAPTIONFONTSIZE" ]] && PP+=(--caption-fontsize "$CAPTIONFONTSIZE")
    [[ -n "$TABLEFONTSIZE" ]] && PP+=(--table-fontsize "$TABLEFONTSIZE")
    [[ -n "$AUTHORFONTSIZE" ]] && PP+=(--author-fontsize "$AUTHORFONTSIZE")
    [[ -n "$TABLETUNE" ]] && PP+=(--tables)
    "${PP[@]}" || { echo "ERROR: postprocess_docx.py failed（pandoc 产物在 $OUTPUT，但格式参数未生效）" >&2; exit 5; }
  fi
fi

[[ -n "$PRESET_NOTE" ]] && echo "[render_docx] 预设提示: $PRESET_NOTE" >&2
echo "[render_docx] ok → $OUTPUT" >&2
