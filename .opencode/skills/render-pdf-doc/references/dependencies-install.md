> Moved verbatim from SKILL.md section "Dependencies"; read when `bash scripts/check_deps.sh` reports [MISS] or when installing pandoc / xelatex / ctex / CJK fonts on a new machine.

## Dependencies

```bash
# macOS
brew install pandoc
brew install --cask mactex-no-gui          # xelatex + xeCJK + ctex (~5 GB)

# Linux — texlive-lang-chinese provides the ctex class (ctexart) used for Chinese;
# it is NOT in texlive-lang-cjk, so both are required.
sudo apt-get install pandoc texlive-xetex texlive-lang-cjk texlive-lang-chinese fonts-noto-cjk

# Windows (PowerShell) — run in Git Bash afterwards
winget install --id JohnMacFarlane.Pandoc
winget install --id MiKTeX.MiKTeX          # xelatex; auto-installs ctex/xeCJK on first render
initexmf --set-config-value "[MPM]AutoInstall=1"   # so the first render doesn't hang on a prompt
# No font download needed: 宋体 SimSun / 黑体 SimHei (ctex, Chinese) + Malgun Gothic (Korean)
# + Times New Roman (Latin) all ship with Windows.
```

The repo's one-click installers cover all of this: `install.ps1 -WithPdf` (Windows) /
`bash install.sh --with-pdf` (Linux/macOS).

Detection:
```bash
bash scripts/check_deps.sh
```

**Windows / Git Bash note.** winget-installed binaries frequently land off the Git Bash
`PATH`: MiKTeX's `xelatex` (`%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin\x64`) and pandoc
(`%LOCALAPPDATA%\Microsoft\WinGet\...`) can read as `[MISS]` even after a successful install.
Both `check_deps.sh` and `render_pdf.sh` now auto-probe those locations; if either still
isn't found, add the directory to your `PATH` (or open a fresh terminal). The Windows
Chinese fonts come from the ctex `fontset=windows` (宋体 SimSun / 黑体 SimHei, both preinstalled)
— no font download needed; Korean uses Malgun Gothic. Override the Chinese font per document
via frontmatter `CJKmainfont` or `--cjk-font`.
