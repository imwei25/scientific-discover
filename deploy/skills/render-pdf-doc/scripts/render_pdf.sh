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
EXTRA=()

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
  -h | --help           Help

Pass-through: any args after '--' go directly to pandoc.
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i) INPUT="$2"; shift 2 ;;
    -o) OUTPUT="$2"; shift 2 ;;
    --infer-colwidths) INFER_COLWIDTHS=1; shift ;;
    --no-infer-colwidths) INFER_COLWIDTHS=0; shift ;;
    --font) MAINFONT="$2"; CLI_MAINFONT_SET=1; shift 2 ;;
    --cjk-font) CJKFONT="$2"; CLI_CJKFONT_SET=1; shift 2 ;;
    -h|--help) usage ;;
    --) shift; EXTRA=("$@"); break ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

[[ -z "$INPUT" ]] && usage
[[ -f "$INPUT" ]] || { echo "ERROR: input not found: $INPUT" >&2; exit 2; }
[[ -z "$OUTPUT" ]] && OUTPUT="${INPUT%.md}.pdf"

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

if [[ "$INFER_COLWIDTHS" == "1" ]]; then
  mktmp
  SRC="$WORK"
  WORK="$TMPDIR/cw_$(basename "$INPUT")"
  "${PYBIN:-python3}" "$SCRIPT_DIR/infer_colwidths.py" "$SRC" --out "$WORK"
fi

ARGS=(
  --pdf-engine=xelatex
  --resource-path ".:$(dirname "$INPUT")"
  -V "geometry:margin=1in"
  -V "fontsize=12pt"
  -V "linestretch=1.4"
  -V "colorlinks=true"
  -o "$OUTPUT"
)

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

echo "[render_pdf] in=$INPUT out=$OUTPUT cjk_kind=$CJK_KIND mode=[$RENDER_MODE] fm_font=${FM_HAS_MAINFONT}/${FM_HAS_CJKFONT} infer=$INFER_COLWIDTHS" >&2
pandoc "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"} "$WORK"
echo "[render_pdf] ok → $OUTPUT" >&2
