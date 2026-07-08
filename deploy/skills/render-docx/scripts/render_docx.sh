#!/usr/bin/env bash
# render_docx.sh — Markdown → Word (.docx) via pandoc, for journal submission.
#
# Word is what most medical journals actually accept for submission, and it is much
# less prone than the xelatex PDF path to silently dropping CJK glyphs (Word stores
# UTF-8 text and auto-substitutes a system font), so Chinese generally "just works".
#
# Usage:
#   render_docx.sh -i input.md [-o output.docx]
#                  [--ref reference.docx]        # template for styles/fonts
#                  [--csl style.csl] [--bib refs.bib]   # citation rendering (pandoc @keys)
#                  [-- <extra pandoc args>]
set -uo pipefail

INPUT=""; OUTPUT=""; REF=""; CSL=""; BIB=""; EXTRA=()
usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") -i <input.md> [-o <output.docx>] [options] [-- <pandoc args>]
  -i         input markdown (required)
  -o         output .docx (default: <input>.docx)
  --ref      reference .docx (styles/fonts template)
  --csl      CSL style file (e.g. GB/T 7714) — needs pandoc @citation keys + --bib
  --bib      bibliography (.bib) for --csl
  -h|--help
EOF
  exit 1
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i) INPUT="$2"; shift 2 ;;
    -o) OUTPUT="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --csl) CSL="$2"; shift 2 ;;
    --bib) BIB="$2"; shift 2 ;;
    -h|--help) usage ;;
    --) shift; EXTRA=("$@"); break ;;
    -*) echo "ERROR: unknown option '$1' (put pandoc pass-through args after '--')" >&2; usage ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

[[ -z "$INPUT" ]] && usage
[[ -f "$INPUT" ]] || { echo "ERROR: input not found: $INPUT" >&2; exit 2; }
# strip the last extension (handles .md/.markdown/.MD), not just a literal .md
[[ -z "$OUTPUT" ]] && OUTPUT="${INPUT%.*}.docx"
# --csl and --bib must come as a pair (citeproc needs a bibliography)
if [[ -n "$CSL" && -z "$BIB" ]] || [[ -z "$CSL" && -n "$BIB" ]]; then
  echo "ERROR: --csl and --bib must be used together (citeproc needs both a style and a bibliography)" >&2
  exit 1
fi

if ! command -v pandoc >/dev/null 2>&1; then
  echo "ERROR: pandoc not installed. Install it: install.ps1 -WithPdf / install.sh --with-pdf" >&2
  echo "       (or winget install JohnMacFarlane.Pandoc / apt-get install pandoc / brew install pandoc)" >&2
  exit 3
fi

ARGS=(-o "$OUTPUT")
[[ -n "$REF" ]] && { [[ -f "$REF" ]] || { echo "ERROR: --ref not found: $REF" >&2; exit 2; }; ARGS+=(--reference-doc "$REF"); }
if [[ -n "$CSL" || -n "$BIB" ]]; then
  ARGS+=(--citeproc)
  [[ -n "$CSL" ]] && { [[ -f "$CSL" ]] || { echo "ERROR: --csl not found: $CSL" >&2; exit 2; }; ARGS+=(--csl "$CSL"); }
  [[ -n "$BIB" ]] && { [[ -f "$BIB" ]] || { echo "ERROR: --bib not found: $BIB" >&2; exit 2; }; ARGS+=(--bibliography "$BIB"); }
fi

echo "[render_docx] in=$INPUT out=$OUTPUT ref='${REF:-none}' csl='${CSL:-none}'" >&2
pandoc "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"} "$INPUT" || { echo "ERROR: pandoc failed" >&2; exit 4; }
echo "[render_docx] ok → $OUTPUT" >&2
