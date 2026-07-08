#!/usr/bin/env bash
# One-command install for the sci-skill suite (Linux / macOS).
#   bash install.sh                 # Python deps only
#   bash install.sh --with-pdf      # also install pandoc + xelatex (for render-pdf-doc)
#   bash install.sh --link-claude   # also copy skills/* into ~/.claude/skills (Claude Code)
# Flags can be combined. Falls back to the Tsinghua PyPI mirror when pypi.org is slow.
# Always writes the router at the PROJECT ROOT: AGENTS.md (OpenCode) is mirrored into a
# project-root CLAUDE.md (Claude Code) as a managed block -- project-scoped on purpose,
# never the machine-global ~/.claude/CLAUDE.md.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
REQ="$ROOT/scripts/requirements-skills.txt"
MIRROR="https://pypi.tuna.tsinghua.edu.cn/simple"
WITH_PDF=0; LINK_CLAUDE=0
for a in "$@"; do
  case "$a" in
    --with-pdf) WITH_PDF=1 ;;
    --link-claude) LINK_CLAUDE=1 ;;
    *) echo "unknown flag: $a"; exit 2 ;;
  esac
done

FAILED=()
step() { # step <ok:0|1> <name> <detail>
  if [ "$1" = 0 ]; then printf '[ OK ] %s  %s\n' "$2" "$3"
  else printf '[FAIL] %s  %s\n' "$2" "$3"; FAILED+=("$2: $3"); fi
}

echo "== sci-skill install (Linux/macOS) =="

# 1) venv (require CPython >= 3.10)
if [ ! -x "$PY" ]; then
  base=""
  for c in python3 python; do command -v "$c" >/dev/null 2>&1 && { base="$c"; break; }; done
  if [ -z "$base" ]; then
    step 1 "Python" "not found. Install 3.10+: sudo apt-get install -y python3 python3-venv python3-pip (or brew install python@3.12)"
    echo "Install aborted."; exit 1
  fi
  if ! "$base" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)'; then
    step 1 "Python" "$base is older than 3.10; sci-skill needs 3.10+"
    echo "Install aborted."; exit 1
  fi
  echo "Creating .venv ..."
  "$base" -m venv "$VENV" || { step 1 "venv" "python -m venv failed (Debian/Ubuntu: sudo apt-get install -y python3-venv)"; echo "Install aborted."; exit 1; }
fi
"$PY" --version
step 0 "Python venv" "$PY"

# 2) deps, with China-mirror fallback
echo "Installing Python deps (first run ~3-8 min) ..."
"$PY" -m pip install -U pip -q --timeout 30 --retries 2
if "$PY" -m pip install -r "$REQ" --timeout 30 --retries 2; then
  step 0 "Python deps" "requirements-skills.txt installed"
else
  echo "pypi.org unstable; retrying via Tsinghua mirror ..."
  if "$PY" -m pip install -r "$REQ" -i "$MIRROR" --timeout 30 --retries 2; then
    printf '[global]\nindex-url = %s\n' "$MIRROR" > "$VENV/pip.conf"
    echo "Mirror saved to .venv/pip.conf for future installs."
    step 0 "Python deps" "installed via Tsinghua mirror"
  else
    step 1 "Python deps" "pip failed on both pypi.org and the mirror; check network/proxy and re-run"
  fi
fi

# 3) optional PDF toolchain
if [ "$WITH_PDF" = 1 ]; then
  echo "Installing pandoc + xelatex + CJK fonts (for render-pdf-doc) ..."
  if command -v apt-get >/dev/null 2>&1; then
    # texlive-lang-chinese provides the ctex document class (ctexart) that render-pdf-doc
    # switches to for Chinese — it is NOT in texlive-lang-cjk, so it must be listed too,
    # else `documentclass=ctexart` fails with "ctexart.cls not found".
    if sudo apt-get update && sudo apt-get install -y pandoc texlive-xetex texlive-lang-cjk texlive-lang-chinese fonts-noto-cjk; then
      step 0 "PDF toolchain" "pandoc + texlive-xetex + ctex (lang-chinese) + Noto CJK installed"
    else
      step 1 "PDF toolchain" "apt-get install failed"
    fi
  elif command -v brew >/dev/null 2>&1; then
    if brew install pandoc && brew install --cask mactex-no-gui; then
      step 0 "PDF toolchain" "pandoc + mactex-no-gui installed"
    else
      step 1 "PDF toolchain" "brew install failed"
    fi
  else
    step 1 "PDF toolchain" "no apt/brew; install pandoc + texlive-xetex manually"
  fi
  command -v pandoc  >/dev/null 2>&1 && step 0 "pandoc"  "$(command -v pandoc)"  || step 1 "pandoc"  "not on PATH"
  command -v xelatex >/dev/null 2>&1 && step 0 "xelatex" "$(command -v xelatex)" || step 1 "xelatex" "not on PATH (mactex: open a new shell)"
fi

# 4) optional: expose skills to Claude Code
if [ "$LINK_CLAUDE" = 1 ]; then
  target="$HOME/.claude/skills"
  mkdir -p "$target"
  n=0
  for d in "$ROOT"/skills/*/; do
    name="$(basename "$d")"
    rm -rf "${target:?}/$name"
    cp -R "$d" "$target/$name"
    n=$((n+1))
  done
  step 0 "Claude Code skills" "$n skills copied to $target"
fi

# 4b) router: put AGENTS.md at the PROJECT ROOT under both framework names. OpenCode reads
#     AGENTS.md; the helper mirrors it into a project-root CLAUDE.md (managed block) for
#     Claude Code. Project-scoped on purpose -- never the machine-global ~/.claude/CLAUDE.md.
if [ -f "$ROOT/AGENTS.md" ]; then
  if "$PY" "$ROOT/scripts/install_router.py" "$ROOT/AGENTS.md" "$ROOT/CLAUDE.md"; then
    step 0 "Router" "project-root CLAUDE.md written (managed block) for Claude Code; AGENTS.md serves OpenCode"
  else
    step 1 "Router" "install_router.py failed"
  fi
else
  step 1 "Router" "AGENTS.md not found at project root ($ROOT)"
fi

# 5) validate skills + environment
if "$PY" "$ROOT/scripts/validate_skills.py" --env; then
  step 0 "Self-check" "skills + environment validated"
else
  step 1 "Self-check" "validate_skills.py reported problems (see above)"
fi

# 6) summary - never claim success when something failed
echo ""
if [ "${#FAILED[@]}" = 0 ]; then
  echo "Done. All steps passed."
else
  echo "FINISHED WITH ${#FAILED[@]} PROBLEM(S):"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
fi
echo "Interpreter: $PY"
echo "Skills dir : $ROOT/skills"
echo "Load them: point your agent framework at the skills/ folder (see README)."
echo "Router = project-root AGENTS.md (OpenCode) / CLAUDE.md (Claude Code) -- both written here, project-scoped, not machine-global."
echo "Tip: 'source .venv/bin/activate' so vendored skills' bare 'python3' resolves to this venv."
[ "$WITH_PDF" = 0 ] && echo "PDF (render-pdf-doc)? re-run: bash install.sh --with-pdf"
[ "$LINK_CLAUDE" = 0 ] && echo "Using Claude Code? re-run with --link-claude to also copy skills into ~/.claude/skills."
[ "${#FAILED[@]}" = 0 ] || exit 1
