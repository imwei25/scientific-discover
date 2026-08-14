#!/usr/bin/env bash
# render_pdf.sh — pandoc + xelatex wrapper for Korean academic markdown.
#
# Usage:
#   render_pdf.sh -i input.md [-o output.pdf] [--infer-colwidths]
#                 [--font "Apple SD Gothic Neo"] [--cjk-font "Apple SD Gothic Neo"]
#                 [-- <extra pandoc args>]
#
# Defaults:
#   - macOS: mainfont/CJKmainfont = "Apple SD Gothic Neo"
#   - Linux: mainfont = "Noto Serif CJK KR", CJKmainfont = "Noto Sans CJK KR"
#   - Output path = <input>.pdf
#   - geometry = margin=0.85in, fontsize = 11pt (override via frontmatter)
#
# The frontmatter in input.md takes precedence over CLI/auto-detected defaults.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve a Python interpreter. The original script hard-coded `python3`, which does
# NOT exist on many Windows installs (only `python`/`py`), so the CJK-script detection
# below silently fell back to "none" and the Chinese ctex path never fired. Prefer the
# project-root .venv (repo convention), then fall back to python3/python/py on PATH.
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
PYBIN="$(resolve_py)"

INPUT=""
OUTPUT=""
INFER_COLWIDTHS=1   # 默认开启：CJK 科研文档几乎都含表格，不推断列宽会让标签列被压成逐字折行
MAINFONT=""
CJKFONT=""
CLI_MAINFONT_SET=0
CLI_CJKFONT_SET=0
JOURNAL=""; MARGIN=""; FONTSIZE=""; LINESTRETCH=""; LINENUMBERS=""; CSL=""; BIB=""; FIGSATEND=""
# 送审稿细排（与 render-docx 同名参数对齐；PDF 侧靠 -H 头注入 LaTeX 实现）
INDENTCHARS=""; CAPTIONFONTSIZE=""; TABLEFONTSIZE=""; TITLEFONTSIZE=""; H1FONTSIZE=""
HEADFONTSIZE=""; AUTHORFONTSIZE=""
EXTRA=()

# 期刊预设与 CSL 同 render-docx 共用一份（单一源头，别复制）
PRESET_DIR="$SCRIPT_DIR/../../render-docx/presets"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") -i <input.md> [-o <output.pdf>] [options] [-- <pandoc args>]

Options:
  -i  Input markdown
  -o  Output PDF (default: <input>.pdf)
  --infer-colwidths     Run scripts/infer_colwidths.py first (DEFAULT: on)
  --no-infer-colwidths  Disable column-width inference (raw pandoc widths)
  --font NAME           mainfont (default: OS-detected)
  --cjk-font NAME       CJKmainfont (default: OS-detected)
  --journal J           期刊预设: nejm lancet jama bmj cmj generic-submission (--journal list 列出)
  --margin SPEC         页边距 (default 1in)
  --fontsize PT         字号，LaTeX 只认 10/11/12 (default 12)
  --line-spacing V      行距: 数字倍数或 single/onehalf/double (default 1.4)
  --line-numbers        连续行号 (lineno 宏包)
  --indent-chars N      正文首行缩进 N 个英文半角字符 (按 0.5em/字符折算)
  --caption-fontsize PT 图题/表题字号 (caption 宏包；序号加粗、居中)
  --table-fontsize PT   表内字号 (longtable/tabular 环境内)
  --title-fontsize PT   论文标题字号 (titling)
  --h1-fontsize PT      一级标题 \section 字号
  --heading-fontsize PT 二级及以下标题 \subsection.. 字号
  --author-fontsize PT  作者/机构块字号 (titling)
  --figures-at-end      把图表搬到正文末尾 (NEJM/JAMA/Lancet 送审稿要求)
  --csl STYLE           CSL 文件路径或 presets/csl 里的名字 — 需稿件用 [@key] 引用 + --bib
  --bib FILE            bibliography (.bib)
  -h | --help           Help

优先级: 命令行 > --journal 预设 > frontmatter > 默认。
Pass-through: any args after '--' go directly to pandoc.
EOF
  exit 1
}

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
    --infer-colwidths) INFER_COLWIDTHS=1; shift ;;
    --no-infer-colwidths) INFER_COLWIDTHS=0; shift ;;
    --font) MAINFONT="$2"; CLI_MAINFONT_SET=1; shift 2 ;;
    --cjk-font) CJKFONT="$2"; CLI_CJKFONT_SET=1; shift 2 ;;
    --journal) JOURNAL="$2"; shift 2 ;;
    --margin) MARGIN="$2"; shift 2 ;;
    --fontsize) FONTSIZE="$2"; shift 2 ;;
    --line-spacing) LINESTRETCH="$(norm_spacing "$2")"; shift 2 ;;
    --line-numbers) LINENUMBERS=1; shift ;;
    --indent-chars) INDENTCHARS="$2"; shift 2 ;;
    --caption-fontsize) CAPTIONFONTSIZE="$2"; shift 2 ;;
    --table-fontsize) TABLEFONTSIZE="$2"; shift 2 ;;
    --title-fontsize) TITLEFONTSIZE="$2"; shift 2 ;;
    --h1-fontsize) H1FONTSIZE="$2"; shift 2 ;;
    --heading-fontsize) HEADFONTSIZE="$2"; shift 2 ;;
    --author-fontsize) AUTHORFONTSIZE="$2"; shift 2 ;;
    --figures-at-end) FIGSATEND=1; shift ;;
    --csl) CSL="$2"; shift 2 ;;
    --bib) BIB="$2"; shift 2 ;;
    -h|--help) usage ;;
    --) shift; EXTRA=("$@"); break ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

if [[ "$JOURNAL" == "list" ]]; then
  echo "可用期刊预设 (render-docx/presets/*.env，两技能共用):" >&2
  for f in "$PRESET_DIR"/*.env; do [[ -f "$f" ]] && echo "  - $(basename "$f" .env)" >&2; done
  exit 0
fi

[[ -z "$INPUT" ]] && usage
[[ -f "$INPUT" ]] || { echo "ERROR: input not found: $INPUT" >&2; exit 2; }
[[ -z "$OUTPUT" ]] && OUTPUT="${INPUT%.md}.pdf"

# ---- journal preset: fill any knob the CLI didn't set explicitly ----
PRESET_NOTE=""
if [[ -n "$JOURNAL" ]]; then
  case "$JOURNAL" in
    中华医学杂志|中华系列|zhonghua) JOURNAL="cmj" ;;
    generic|通用) JOURNAL="generic-submission" ;;
  esac
  PFILE="$PRESET_DIR/$JOURNAL.env"
  if [[ ! -f "$PFILE" ]]; then
    echo "ERROR: 未知期刊预设 '$JOURNAL'；--journal list 查看可用项" >&2
    exit 2
  fi
  PRESET_MARGIN=""; PRESET_FONT=""; PRESET_CJKFONT=""; PRESET_FONTSIZE=""
  PRESET_LINESPACING=""; PRESET_LINENUMBERS=""; PRESET_CSL=""
  PRESET_INDENT_CHARS=""; PRESET_CAPTION_FONTSIZE=""; PRESET_TABLE_FONTSIZE=""
  PRESET_TITLE_FONTSIZE=""; PRESET_H1_FONTSIZE=""; PRESET_HEADING_FONTSIZE=""
  PRESET_AUTHOR_FONTSIZE=""
  # shellcheck disable=SC1090
  source "$PFILE"
  [[ -z "$MARGIN" ]] && MARGIN="$PRESET_MARGIN"
  [[ -z "$FONTSIZE" ]] && FONTSIZE="$PRESET_FONTSIZE"
  [[ -z "$LINESTRETCH" ]] && LINESTRETCH="$PRESET_LINESPACING"
  [[ -z "$LINENUMBERS" && "$PRESET_LINENUMBERS" == "1" ]] && LINENUMBERS=1
  [[ -z "$INDENTCHARS" ]] && INDENTCHARS="$PRESET_INDENT_CHARS"
  [[ -z "$CAPTIONFONTSIZE" ]] && CAPTIONFONTSIZE="$PRESET_CAPTION_FONTSIZE"
  [[ -z "$TABLEFONTSIZE" ]] && TABLEFONTSIZE="$PRESET_TABLE_FONTSIZE"
  [[ -z "$TITLEFONTSIZE" ]] && TITLEFONTSIZE="$PRESET_TITLE_FONTSIZE"
  [[ -z "$H1FONTSIZE" ]] && H1FONTSIZE="$PRESET_H1_FONTSIZE"
  [[ -z "$HEADFONTSIZE" ]] && HEADFONTSIZE="$PRESET_HEADING_FONTSIZE"
  [[ -z "$AUTHORFONTSIZE" ]] && AUTHORFONTSIZE="$PRESET_AUTHOR_FONTSIZE"
  # 预设西文字体只在用户没自己指定字体时生效（中文稿的中文字体由 ctex fontset 管）
  if [[ "$CLI_MAINFONT_SET" == "0" && -n "$PRESET_FONT" ]]; then MAINFONT="$PRESET_FONT"; CLI_MAINFONT_SET=1; fi
  if [[ -z "$CSL" && -n "$BIB" && -n "$PRESET_CSL" ]]; then CSL="$PRESET_CSL"; fi
  if [[ -z "$BIB" && -n "$PRESET_CSL" ]]; then
    echo "[render_pdf] 注：预设含参考文献样式 ($PRESET_CSL)，但未给 --bib——仅当稿件用 pandoc [@key] 引用并提供 .bib 时才能重排参考文献" >&2
  fi
fi

# LaTeX 标准文档类只支持 10/11/12pt，别的值会被静默忽略
if [[ -n "$FONTSIZE" && ! "$FONTSIZE" =~ ^1[012]$ ]]; then
  echo "[render_pdf] WARN: PDF 字号只认 10/11/12pt，'$FONTSIZE' 改按 12pt 排（要精确字号请出 docx）" >&2
  FONTSIZE=12
fi

# --csl 允许写 presets/csl 里的名字
if [[ -n "$CSL" && ! -f "$CSL" ]]; then
  for cand in "$PRESET_DIR/csl/$CSL" "$PRESET_DIR/csl/$CSL.csl"; do
    [[ -f "$cand" ]] && { CSL="$cand"; break; }
  done
fi
if [[ -n "$CSL" && -z "$BIB" ]] || [[ -z "$CSL" && -n "$BIB" ]]; then
  echo "ERROR: --csl and --bib must be used together (citeproc needs both a style and a bibliography)" >&2
  exit 1
fi

# Does the frontmatter already set a font? If so, DON'T inject -V for it —
# pandoc's -V template variable would otherwise override the YAML metadata and
# silently defeat a user who set the correct font in frontmatter.
FM_HAS_MAINFONT=0
FM_HAS_CJKFONT=0
if head -n 60 "$INPUT" | grep -qiE '^\s*mainfont\s*:'; then FM_HAS_MAINFONT=1; fi
if head -n 60 "$INPUT" | grep -qiE '^\s*CJKmainfont\s*:'; then FM_HAS_CJKFONT=1; fi

# Detect which CJK script the document actually uses so the default font covers it.
# xelatex silently DROPS glyphs the font lacks, so a Korean default (Malgun Gothic)
# would blank out Chinese text with no error. Classify: han | hangul | none.
CJK_KIND="$("${PYBIN:-python3}" - "$INPUT" <<'PY' 2>/dev/null || echo none
import sys
try:
    t = open(sys.argv[1], encoding="utf-8", errors="ignore").read()
except Exception:
    print("none"); sys.exit()
han = any('一' <= c <= '鿿' for c in t)
hangul = any('가' <= c <= '힣' for c in t)
print("han" if han else ("hangul" if hangul else "none"))
PY
)"

# OS-based font defaults, chosen by detected script.
if [[ -z "$MAINFONT" || -z "$CJKFONT" ]]; then
  case "$(uname -s)" in
    Darwin)
      if [[ "$CJK_KIND" == "han" ]]; then
        : "${MAINFONT:=PingFang SC}"; : "${CJKFONT:=PingFang SC}"
      else
        : "${MAINFONT:=Apple SD Gothic Neo}"; : "${CJKFONT:=Apple SD Gothic Neo}"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      # Windows: Microsoft YaHei (msyh.ttc) ships with Windows and covers Simplified
      # Chinese + Latin; Malgun Gothic is Korean-only for Han and drops most hanzi.
      if [[ "$CJK_KIND" == "hangul" ]]; then
        : "${MAINFONT:=Malgun Gothic}"; : "${CJKFONT:=Malgun Gothic}"
      else
        : "${MAINFONT:=Microsoft YaHei}"; : "${CJKFONT:=Microsoft YaHei}"
      fi
      ;;
    *)
      if [[ "$CJK_KIND" == "hangul" ]]; then
        : "${MAINFONT:=Noto Serif CJK KR}"; : "${CJKFONT:=Noto Sans CJK KR}"
      else
        : "${MAINFONT:=Noto Serif CJK SC}"; : "${CJKFONT:=Noto Sans CJK SC}"
      fi
      ;;
  esac
fi

# Chinese (ctex) typesetting parameters, chosen per OS. FONTSET selects a locally
# available Chinese font family (宋体 body / 黑体 headings, the NSFC/公文 convention);
# LATINFONT is a Times-compatible serif for the Latin/numeric runs; MONOFONT must cover
# box-drawing (├ └ │ ─) used in code fences — the default Latin Modern Mono drops them
# silently. These apply only on the Chinese (Han) render path below.
case "$(uname -s)" in
  Darwin)               FONTSET="macnew";  LATINFONT="Times New Roman"; MONOFONT="Menlo" ;;
  MINGW*|MSYS*|CYGWIN*) FONTSET="windows"; LATINFONT="Times New Roman"; MONOFONT="Consolas" ;;
  *)                    FONTSET="fandol";  LATINFONT="TeX Gyre Termes"; MONOFONT="DejaVu Sans Mono" ;;
esac

# Windows/Git Bash: winget-installed binaries frequently land off the Git Bash PATH,
# so xelatex (MiKTeX) and pandoc are not found even after a successful install. Prepend
# their known install locations (best-effort) when not already resolvable.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    _la="$(cygpath -u "${LOCALAPPDATA:-}" 2>/dev/null || printf '%s' "${LOCALAPPDATA:-}")"
    _pf="$(cygpath -u "${PROGRAMFILES:-}" 2>/dev/null || printf '%s' "${PROGRAMFILES:-}")"
    if ! command -v xelatex >/dev/null 2>&1; then
      for _d in \
        "$_la/Programs/MiKTeX/miktex/bin/x64" \
        "$_la/Programs/MiKTeX/miktex/bin" \
        "$_pf/MiKTeX/miktex/bin/x64"; do
        if [[ -x "$_d/xelatex.exe" ]]; then PATH="$_d:$PATH"; break; fi
      done
    fi
    if ! command -v pandoc >/dev/null 2>&1; then
      for _p in \
        "$_la"/Microsoft/WinGet/Packages/JohnMacFarlane.Pandoc*/pandoc-*/pandoc.exe \
        "$_la"/Microsoft/WinGet/Links/pandoc.exe \
        "$_pf"/Pandoc/pandoc.exe; do
        if [[ -x "$_p" ]]; then PATH="$(dirname "$_p"):$PATH"; break; fi
      done
    fi
    ;;
esac

command -v pandoc >/dev/null || { echo "ERROR: pandoc not installed" >&2; exit 3; }
command -v xelatex >/dev/null || { echo "ERROR: xelatex not installed (install mactex / texlive-xetex / MiKTeX)" >&2; exit 3; }

TMPDIR=""
mktmp() { [[ -n "$TMPDIR" ]] || { TMPDIR="$(mktemp -d)"; trap 'rm -rf "$TMPDIR"' EXIT; }; }

WORK="$INPUT"

# --figures-at-end: 把图表搬到文末（复用 render-docx 里的共享脚本，单一源头，不复制）
if [[ -n "$FIGSATEND" ]]; then
  mktmp
  FE_SRC="$WORK"; WORK="$TMPDIR/figend_$(basename "$INPUT")"
  FE=("${PYBIN:-python3}" "$SCRIPT_DIR/../../render-docx/scripts/figures_at_end.py" "$FE_SRC" --out "$WORK")
  [[ -n "$CSL" ]] && FE+=(--refs-anchor)
  "${FE[@]}" || { echo "ERROR: figures_at_end.py failed" >&2; exit 5; }
fi

# redact_internal: true in frontmatter → strip change-history / version / PI-attribution
# lines from a circulation copy before rendering. (Documented in SKILL.md; previously a
# no-op — the flag existed but nothing acted on it.)
if head -n 60 "$INPUT" | grep -qiE '^\s*redact_internal\s*:\s*true\b'; then
  mktmp
  WORK="$TMPDIR/$(basename "$INPUT")"
  "${PYBIN:-python3}" - "$INPUT" "$WORK" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
lines = open(src, encoding="utf-8").read().splitlines(keepends=True)
# Drop ONLY metadata-style lines (label at line start, "Label: value" form) — never
# match inside narrative prose. "We used version 2.1 of Bowtie" must survive; a line
# like "Version: 3.2.1" or a "## Change History" heading must not.
LABEL = (r'version|revision|change\s*history|revision\s*history|document\s*version|'
         r'内部版本|版本号?|修订记录|修订历史|变更历史|变更记录|负责人|课题负责人|'
         r'버전|변경\s*이력|수정\s*이력|책임자|'
         r'PI|principal\s*investigator')
# metadata line: optional markdown heading/bullet, then Label, then :/：, then value
meta = re.compile(r'^\s*(?:#{1,6}\s*|[-*]\s*|\*\*)?(?:' + LABEL + r')\s*[:：]', re.I)
# a heading that STARTS a change-history section (drop the heading AND its body
# until the next heading of any level)
hist = re.compile(r'^\s*#{1,6}\s*(?:change\s*history|revision\s*history|修订历史|变更历史|修订记录|버전\s*이력|변경\s*이력)\b', re.I)
any_head = re.compile(r'^\s*#{1,6}\s')
out, in_hist = [], False
for ln in lines:
    if in_hist:
        if any_head.match(ln) and not hist.match(ln):
            in_hist = False          # next section starts — stop skipping, keep this line
        else:
            continue                 # still inside the change-history section — drop
    if hist.match(ln):
        in_hist = True
        continue
    if meta.match(ln):
        continue
    out.append(ln)
open(dst, "w", encoding="utf-8").writelines(out)
PY
  echo "[render_pdf] redact_internal: stripped internal history/version/PI lines" >&2
fi

# 手写表题（`**表1. …**` 写在表格上方）→ pandoc 表格题注（表后 `: **表1.** …`）。
# 只在要求了题注字号时做：caption 宏包只作用于真 \caption{}，不转的话表题就是一段
# 普通正文，PDF 里表题 12pt、图题 10.5pt，两者不一致。列宽推断之前做（转换会动表块）。
if [[ -n "$CAPTIONFONTSIZE" && -n "${PYBIN:-}" ]]; then
  mktmp
  TC_SRC="$WORK"; WORK="$TMPDIR/tc_$(basename "$INPUT")"
  if ! "${PYBIN:-python3}" "$SCRIPT_DIR/table_caption_to_pandoc.py" "$TC_SRC" --out "$WORK"; then
    echo "[render_pdf] WARN: table_caption_to_pandoc.py 失败，表题保持正文字号" >&2
    WORK="$TC_SRC"
  fi
fi

if [[ "$INFER_COLWIDTHS" == "1" ]]; then
  mktmp
  SRC="$WORK"
  WORK="$TMPDIR/cw_$(basename "$INPUT")"
  "${PYBIN:-python3}" "$SCRIPT_DIR/infer_colwidths.py" "$SRC" --out "$WORK"
fi

# 某变量已由用户经 '--' 透传给 pandoc 时，脚本不得再注入同名默认值——pandoc 对重复
# -V 会把两个值拼在一起（例如 \setstretch{1.42.0}），直接编译崩溃（历史 G1 bug）。
extra_has() {
  local k="$1" a
  for a in ${EXTRA[@]+"${EXTRA[@]}"}; do [[ "$a" == *"$k"* ]] && return 0; done
  return 1
}
fm_has() { head -n 60 "$INPUT" | grep -qiE "^\s*$1\s*:"; }

ARGS=(
  --pdf-engine=xelatex
  --resource-path ".:$(dirname "$INPUT")"
  -V "colorlinks=true"
  -o "$OUTPUT"
)

# 版面三件套：pandoc 对重复 -V 会把两个值拼在一起（\setstretch{1.42.0} → 编译崩溃）。
# 铁律：**只要用户已在 '--' 透传同名 -V，脚本就一律不注入**——不管我们的值来自默认、
# 命令行显式，还是 --journal 预设。透传永远最优先（用户显式手写 LaTeX 变量意图最强）。
# 优先级：'--' 透传 > 命令行/预设显式值 > frontmatter > 脚本默认。
inject_var() {  # $1=键名(extra/fm 检测用) $2=显式值(可空) $3=要注入的 -V 串 $4=默认 -V 串(可空)
  local key="$1" explicit="$2" vstr="$3" defstr="$4"
  if extra_has "$key"; then
    [[ -n "$explicit" ]] && echo "[render_pdf] 注：'--' 透传的 -V $key 覆盖了显式/预设值 '$explicit'（避免重复注入崩溃）" >&2
    return
  fi
  if [[ -n "$explicit" ]]; then ARGS+=(-V "$vstr"); return; fi
  fm_has "$key" && return
  [[ -n "$defstr" ]] && ARGS+=(-V "$defstr")
}
inject_var "geometry"    "$MARGIN"      "geometry:margin=$MARGIN"   "geometry:margin=1in"
inject_var "fontsize"    "$FONTSIZE"    "fontsize=${FONTSIZE}pt"    "fontsize=12pt"
inject_var "linestretch" "$LINESTRETCH" "linestretch=$LINESTRETCH"  "linestretch=1.4"

# 连续行号（多数期刊送审稿要求）：lineno 宏包，经 -H 头注入
if [[ -n "$LINENUMBERS" ]]; then
  mktmp
  LNHDR="$TMPDIR/lineno.tex"
  printf '%s\n' '\usepackage{lineno}' '\linenumbers' > "$LNHDR"
  ARGS+=(-H "$LNHDR")
fi

# ---- 送审稿细排：首行缩进 / 题注字号 / 表内字号 / 标题与题名块字号 ----
# docx 侧靠 python-docx 改样式，PDF 侧只能靠 LaTeX，所以这里生成一个 -H 头。
# 每项都由对应参数（或 --journal 预设字段）单独开关，没给就一行都不注入——
# 免得给不需要送审格式的文档（标书、简报）平白引入 titlesec/titling 这类会改版式的宏包。
if [[ -n "$INDENTCHARS$CAPTIONFONTSIZE$TABLEFONTSIZE$TITLEFONTSIZE$H1FONTSIZE$HEADFONTSIZE$AUTHORFONTSIZE" ]]; then
  mktmp
  SUBHDR="$TMPDIR/submission.tex"
  : > "$SUBHDR"
  # 行距按 1.2×字号给（LaTeX 惯例）；linestretch 会在其上再乘，双倍行距仍成立
  lead() { awk -v s="$1" 'BEGIN{printf "%.1f", s*1.2}'; }

  if [[ -n "$INDENTCHARS" ]]; then
    # 1 个英文半角字符 ≈ 0.5em
    IND_EM="$(awk -v n="$INDENTCHARS" 'BEGIN{printf "%.2f", n*0.5}')"
    # pandoc 默认模板在无 indent 变量时强制 \parindent=0pt + 段间距，必须先关掉它
    extra_has "indent" || ARGS+=(-V "indent=true")
    # \AtBeginDocument 兜第二遍：ctex/其它宏包也在 begin document 时设 parindent
    printf '%s\n' \
      "\\setlength{\\parindent}{${IND_EM}em}" \
      "\\AtBeginDocument{\\setlength{\\parindent}{${IND_EM}em}}" >> "$SUBHDR"
  fi

  if [[ -n "$CAPTIONFONTSIZE" ]]; then
    printf '%s\n' \
      '\usepackage{caption}' \
      "\\DeclareCaptionFont{sciCapFont}{\\fontsize{${CAPTIONFONTSIZE}}{$(lead "$CAPTIONFONTSIZE")}\\selectfont}" \
      '\captionsetup{font=sciCapFont,labelfont={sciCapFont,bf},justification=centering,singlelinecheck=false}' >> "$SUBHDR"
    # 本套件的题注自带编号（`![图1. …]`、`**表1. …**`），LaTeX 再加一层就成
    # "Figure 1: 图1. …"。题注自编号时关掉 LaTeX 的标签，别双重编号。
    NCAP="$(grep -cE '^!\[' "$WORK" || true)"
    NSELF="$(grep -cE '^!\[\s*\**\s*(图|表|Figure|Table|Fig\.?|Tab\.?)\s*S?[0-9]' "$WORK" || true)"
    if [[ "$NSELF" -gt 0 ]]; then
      printf '%s\n' '\captionsetup{labelformat=empty}' >> "$SUBHDR"
      echo "[render_pdf] 注：题注自带编号（$NSELF/$NCAP 张图），已关掉 LaTeX 自动标签避免 'Figure 1: 图1.' 双重编号" >&2
    fi
  fi

  if [[ -n "$TABLEFONTSIZE" ]]; then
    # pandoc 的 pipe 表一律落成 longtable，所以只钩 longtable：
    #   · 不能用 \AtBeginEnvironment 把 \fontsize 塞进环境内部——那会打断 longtable 的
    #     列声明解析，直接 "Misplaced \crcr" 编译失败；要用 Before/After 在环境外套 group。
    #   · 也别顺手把 tabular 一起钩上：LaTeX 的**作者块本身就是个 tabular**
    #     （\and 展开成 \end{tabular}…\begin{tabular}），钩了就把作者名一起缩成表内字号。
    TBLFONT="\\fontsize{${TABLEFONTSIZE}}{$(lead "$TABLEFONTSIZE")}\\selectfont"
    printf '%s\n' \
      '\usepackage{etoolbox}' \
      "\\BeforeBeginEnvironment{longtable}{\\begingroup${TBLFONT}}" \
      '\AfterEndEnvironment{longtable}{\endgroup}' >> "$SUBHDR"
  fi

  if [[ -n "$H1FONTSIZE$HEADFONTSIZE" ]]; then
    H1="${H1FONTSIZE:-$HEADFONTSIZE}"; HN="${HEADFONTSIZE:-$H1FONTSIZE}"
    if [[ "$CJK_KIND" == "han" ]]; then
      # ctexart 自己管章节格式，titlesec 与它冲突；用 ctex 官方接口 format+= 追加
      printf '%s\n' \
        "\\ctexset{section/format+={\\bfseries\\fontsize{${H1}}{$(lead "$H1")}\\selectfont}," \
        "  subsection/format+={\\bfseries\\fontsize{${HN}}{$(lead "$HN")}\\selectfont}," \
        "  subsubsection/format+={\\bfseries\\fontsize{${HN}}{$(lead "$HN")}\\selectfont}}" >> "$SUBHDR"
    else
      printf '%s\n' \
        '\usepackage{titlesec}' \
        "\\titleformat*{\\section}{\\bfseries\\fontsize{${H1}}{$(lead "$H1")}\\selectfont}" \
        "\\titleformat*{\\subsection}{\\bfseries\\fontsize{${HN}}{$(lead "$HN")}\\selectfont}" \
        "\\titleformat*{\\subsubsection}{\\bfseries\\fontsize{${HN}}{$(lead "$HN")}\\selectfont}" >> "$SUBHDR"
    fi
  fi

  if [[ -n "$TITLEFONTSIZE$AUTHORFONTSIZE" ]]; then
    printf '%s\n' '\usepackage{titling}' >> "$SUBHDR"
    if [[ -n "$TITLEFONTSIZE" ]]; then
      printf '%s\n' \
        "\\pretitle{\\begin{center}\\bfseries\\fontsize{${TITLEFONTSIZE}}{$(lead "$TITLEFONTSIZE")}\\selectfont}" \
        '\posttitle{\par\end{center}\vskip 0.5em}' >> "$SUBHDR"
    fi
    if [[ -n "$AUTHORFONTSIZE" ]]; then
      AF="\\fontsize{${AUTHORFONTSIZE}}{$(lead "$AUTHORFONTSIZE")}\\selectfont"
      # \preauthor 必须照 titling 默认那样**开一个 tabular**、\postauthor 关掉它：
      # pandoc 用 \and 分隔多作者，而 \and 展开成 \end{tabular}…\begin{tabular}，
      # 少了这层就是不配对的 tabular → 编译报 "Misplaced \crcr"（错在表格行，很难联想到作者块）。
      printf '%s\n' \
        "\\preauthor{\\begin{center}${AF}\\lineskip 0.5em\\begin{tabular}[t]{c}}" \
        '\postauthor{\end{tabular}\par\end{center}}' \
        "\\predate{\\begin{center}${AF}}" '\postdate{\par\end{center}}' >> "$SUBHDR"
    fi
  fi
  ARGS+=(-H "$SUBHDR")
fi

# 参考文献 CSL 重排（稿件须用 [@key] 引用）
if [[ -n "$CSL" ]]; then
  [[ -f "$CSL" ]] || { echo "ERROR: --csl not found: $CSL" >&2; exit 2; }
  [[ -f "$BIB" ]] || { echo "ERROR: --bib not found: $BIB" >&2; exit 2; }
  # CSL 只对 pandoc [@key] 引用生效。本套件 write-paper 默认产出 [n] 文本引用——那种稿
  # 传 --csl 会静默 no-op（引用原样保留、不重排、pandoc 不报错），用户以为排了期刊格式其实没排。
  if ! grep -qE '\[@[[:alnum:]_-]+' "$INPUT"; then
    echo "[render_pdf] WARN: 稿件未见 pandoc [@key] 引用，--csl/--bib 对 [n] 文本引用不生效——参考文献将原样保留、不会按 $(basename "$CSL") 重排。要重排请让写作阶段以 [@key] 引用并配 .bib。" >&2
  fi
  ARGS+=(--citeproc --csl "$CSL" --bibliography "$BIB")
fi

if [[ "$CJK_KIND" == "han" ]]; then
  # Chinese path: the ctex document class (ctexart) gives real Chinese typesetting —
  # 宋体 body / 黑体 headings, punctuation kerning, no line break before a closing mark,
  # and first-line indent — none of which the bare article class + a single sans CJK
  # font provided. The Latin serif and box-drawing-safe monofont are set alongside.
  ARGS+=(-V "documentclass=ctexart")
  ARGS+=(-V "classoption=fontset=$FONTSET")
  ARGS+=(-V "monofont=$MONOFONT")
  if [[ "$CLI_MAINFONT_SET" == "1" || "$FM_HAS_MAINFONT" == "0" ]]; then
    ARGS+=(-V "mainfont=$LATINFONT")
  fi
  # Let the ctex fontset govern CJK fonts; override the CJK main font only when the
  # user explicitly passed --cjk-font (frontmatter CJKmainfont is read automatically).
  if [[ "$CLI_CJKFONT_SET" == "1" ]]; then
    ARGS+=(-V "CJKmainfont=$CJKFONT")
  fi
  # Enclosed alphanumerics (① ② ③ …) and geometric marks (■ ● ▲ …) are common in
  # Chinese academic prose (筛选标准 ①②③④⑤, 纳入/排除标准). xeCJK classifies them as
  # Latin by default, so they route to the Times serif — which lacks them — and drop
  # silently. Reclassify those ranges as CJK so the Chinese font (which covers them)
  # renders them. (⚠ U+26A0 and similar emoji are in NO installed font — left as-is.)
  mktmp
  HDR="$TMPDIR/cjk-charclass.tex"
  cat > "$HDR" <<'TEX'
\xeCJKDeclareCharClass{CJK}{"2460 -> "24FF}
\xeCJKDeclareCharClass{CJK}{"25A0 -> "25FF}
TEX
  ARGS+=(-H "$HDR")
  RENDER_MODE="chinese/ctexart fontset=$FONTSET latin=$LATINFONT mono=$MONOFONT"
else
  # Korean / non-CJK path: original article class + OS-detected CJK font. Only inject a
  # font -V when set on the CLI OR absent from frontmatter — else -V defeats frontmatter.
  if [[ "$CLI_MAINFONT_SET" == "1" || "$FM_HAS_MAINFONT" == "0" ]]; then
    ARGS+=(-V "mainfont=${MAINFONT}")
  fi
  if [[ "$CLI_CJKFONT_SET" == "1" || "$FM_HAS_CJKFONT" == "0" ]]; then
    ARGS+=(-V "CJKmainfont=${CJKFONT}")
  fi
  RENDER_MODE="article mainfont=$MAINFONT CJK=$CJKFONT"
fi

echo "[render_pdf] in=$INPUT out=$OUTPUT cjk_kind=$CJK_KIND mode=[$RENDER_MODE] journal='${JOURNAL:-none}' margin='${MARGIN:-def}' fontsize='${FONTSIZE:-def}' linestretch='${LINESTRETCH:-def}' lineno='${LINENUMBERS:-0}' fm_font=${FM_HAS_MAINFONT}/${FM_HAS_CJKFONT} infer=$INFER_COLWIDTHS" >&2
mktmp
PERR="$TMPDIR/pandoc.err"
pandoc "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"} "$WORK" 2>"$PERR" \
  || { cat "$PERR" >&2; echo "ERROR: pandoc failed" >&2; exit 4; }
[[ -s "$PERR" ]] && cat "$PERR" >&2
# ★ 与 render_docx.sh 同一道闸：图片取不到时 pandoc 只警告、照样退 0，出来的 PDF 里没有图。
#   稿子里写着图、出件里没有图，不是可交付的产物。
if grep -q "Could not fetch resource" "$PERR" 2>/dev/null; then
  echo "ERROR: 稿件引用的图片找不到，pandoc 已把它们替换成文字说明——**产出的 PDF 里没有这些图**。" >&2
  grep "Could not fetch resource" "$PERR" | sed 's/^/       /' >&2
  echo "       修法：把图片文件放到稿件同级目录（或改成正确的相对路径）后重跑；" >&2
  echo "       原稿是 Word/PDF 的，用 humanize-academic/scripts/ingest_doc.py 重新读入即可把图抽出来。" >&2
  rm -f "$OUTPUT"
  echo "       （缺图的 $OUTPUT 已删除，避免被当成可投稿的成品）" >&2
  exit 6
fi
[[ -n "$PRESET_NOTE" ]] && echo "[render_pdf] 预设提示: $PRESET_NOTE" >&2
echo "[render_pdf] ok → $OUTPUT" >&2
