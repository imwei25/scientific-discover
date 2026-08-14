#!/usr/bin/env bash
# check_deps.sh — verify pandoc + xelatex + CJK font availability.
set -u

ok=0
fail=0

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "[OK] $name"
    ok=$((ok + 1))
  else
    echo "[MISS] $name"
    fail=$((fail + 1))
  fi
}

# Windows/Git Bash: winget-installed binaries frequently land off the Git Bash PATH,
# so xelatex (MiKTeX) and pandoc read as [MISS] even after a successful install.
# Best-effort: prepend their known install locations when not already resolvable.
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

check "pandoc" command -v pandoc
check "xelatex" command -v xelatex

# ctex document class (ctexart) — render_pdf.sh switches to it for Chinese docs.
if command -v kpsewhich >/dev/null 2>&1 && kpsewhich ctexart.cls >/dev/null 2>&1; then
  echo "[OK] ctex class (ctexart)"
  ok=$((ok + 1))
elif [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
  echo "[INFO] ctexart.cls not present yet — MiKTeX auto-installs it on first render (needs AutoInstall=1)"
else
  echo "[MISS] ctex class (ctexart) — apt install texlive-lang-chinese (NOT in texlive-lang-cjk)"
  fail=$((fail + 1))
fi

case "$(uname -s)" in
  Darwin)
    if /usr/bin/fc-list 2>/dev/null | grep -qi "Apple SD Gothic Neo" \
       || system_profiler SPFontsDataType 2>/dev/null | grep -qi "Apple SD Gothic Neo"; then
      echo "[OK] Apple SD Gothic Neo (macOS)"
      ok=$((ok + 1))
    else
      echo "[WARN] Apple SD Gothic Neo not detected — falling back to default fontconfig"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    _win="$(cygpath -u "${WINDIR:-}" 2>/dev/null || printf '%s' "${WINDIR:-}")"
    [[ -z "$_win" ]] && _win="/c/Windows"
    # Chinese is the primary target: the ctex fontset=windows uses 宋体 SimSun (simsun.ttc)
    # for the body — that's the font that must be present. Malgun Gothic is Korean-only.
    if [[ -f "$_win/Fonts/simsun.ttc" || -f "$_win/Fonts/simsun.ttf" ]]; then
      echo "[OK] SimSun 宋体 (Windows, Chinese ctex body)"
      ok=$((ok + 1))
    else
      echo "[WARN] SimSun (simsun.ttc) not detected — it ships with Windows; see C:\\Windows\\Fonts"
    fi
    if [[ -f "$_win/Fonts/malgun.ttf" ]]; then
      echo "[OK] Malgun Gothic (Windows, Korean)"
    else
      echo "[INFO] Malgun Gothic (Korean) not detected — only needed for Korean docs"
    fi
    ;;
  *)
    if fc-list 2>/dev/null | grep -qiE "Noto.*CJK.*(SC|KR)"; then
      echo "[OK] Noto Sans/Serif CJK (SC/KR)"
      ok=$((ok + 1))
    else
      echo "[MISS] Noto CJK — apt install fonts-noto-cjk"
      fail=$((fail + 1))
    fi
    ;;
esac

echo
echo "Summary: $ok ok, $fail fail"
exit $fail
