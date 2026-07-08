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

INPUT=""
OUTPUT=""
INFER_COLWIDTHS=0
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
  --infer-colwidths     Run scripts/infer_colwidths.py on a temp copy first
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
CJK_KIND="$(python3 - "$INPUT" <<'PY' 2>/dev/null || echo none
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

# Windows/Git Bash: MiKTeX's bin directory is frequently absent from the Git Bash
# PATH, so xelatex is not found even after `winget install MiKTeX.MiKTeX`. Prepend
# the known MiKTeX bin locations (best-effort) when xelatex is not already resolvable.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if ! command -v xelatex >/dev/null 2>&1; then
      _la="$(cygpath -u "${LOCALAPPDATA:-}" 2>/dev/null || printf '%s' "${LOCALAPPDATA:-}")"
      _pf="$(cygpath -u "${PROGRAMFILES:-}" 2>/dev/null || printf '%s' "${PROGRAMFILES:-}")"
      for _d in \
        "$_la/Programs/MiKTeX/miktex/bin/x64" \
        "$_la/Programs/MiKTeX/miktex/bin" \
        "$_pf/MiKTeX/miktex/bin/x64"; do
        if [[ -x "$_d/xelatex.exe" ]]; then PATH="$_d:$PATH"; break; fi
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
  python3 - "$INPUT" "$WORK" <<'PY'
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
  python3 "$SCRIPT_DIR/infer_colwidths.py" "$SRC" --out "$WORK"
fi

ARGS=(
  --pdf-engine=xelatex
  -V "geometry:margin=0.85in"
  -V "fontsize=11pt"
  -V "linestretch=1.25"
  -V "colorlinks=true"
  -o "$OUTPUT"
)
# Only inject a font -V when the user set it on the CLI OR the frontmatter does not
# already define it — otherwise -V would override (and defeat) the frontmatter value.
if [[ "$CLI_MAINFONT_SET" == "1" || "$FM_HAS_MAINFONT" == "0" ]]; then
  ARGS+=(-V "mainfont=${MAINFONT}")
fi
if [[ "$CLI_CJKFONT_SET" == "1" || "$FM_HAS_CJKFONT" == "0" ]]; then
  ARGS+=(-V "CJKmainfont=${CJKFONT}")
fi

echo "[render_pdf] in=$INPUT out=$OUTPUT cjk_kind=$CJK_KIND mainfont='$MAINFONT' CJK='$CJKFONT' fm_font=${FM_HAS_MAINFONT}/${FM_HAS_CJKFONT} infer=$INFER_COLWIDTHS" >&2
pandoc "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"} "$WORK"
echo "[render_pdf] ok → $OUTPUT" >&2
