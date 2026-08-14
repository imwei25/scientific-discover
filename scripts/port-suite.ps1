<#
  Port the research skill suite into any agent framework's skills directory (default: WorkBuddy).
  The result is self-contained: skills + a dedicated .venv, with interpreter/script paths rewritten
  to ABSOLUTE paths so it works regardless of the target framework's working directory.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\port-suite.ps1 -Dest "<target skills dir>"
  Example (WorkBuddy default):
    powershell -ExecutionPolicy Bypass -File scripts\port-suite.ps1 -Dest "$env:USERPROFILE\.workbuddy\skills-marketplace\skills"
#>
param(
  [Parameter(Mandatory = $true)] [string] $Dest,
  [string] $VenvHome = "$env:USERPROFILE\.sci-agent"
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Root ".opencode\skills"
$Venv = Join-Path $VenvHome ".venv"
$VenvPy = Join-Path $Venv "Scripts\python.exe"
$Req = Join-Path $Root "scripts\requirements-skills.txt"

Write-Host "== Port research skill suite ==" -ForegroundColor Cyan
Write-Host "source skills: $Src"
Write-Host "dest dir:      $Dest"
Write-Host "venv:          $Venv"

# 1) Create dedicated venv (reuse if present)
if (-not (Test-Path $VenvPy)) {
  Write-Host "`nCreating venv ..." -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $VenvHome | Out-Null
  $base = $null
  foreach ($c in @("py", "python", "python3")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $base = $cmd.Source; break }
  }
  if (-not $base) { throw "Python not found. Install Python 3.10+ first: winget install -e --id Python.Python.3.12" }
  if ($base -match "py\.exe$") { & $base -3 -m venv $Venv } else { & $base -m venv $Venv }
  if (-not (Test-Path $VenvPy)) { throw "venv creation failed" }
}
& $VenvPy --version

# 2) Install dependencies
Write-Host "`nInstalling deps (first run ~3-8 min) ..." -ForegroundColor Cyan
& $VenvPy -m pip install -U pip -q
if (Test-Path $Req) {
  & $VenvPy -m pip install -r $Req
} else {
  & $VenvPy -m pip install pandas numpy scipy matplotlib scikit-learn seaborn statsmodels openpyxl `
    requests httpx metapub biopython habanero pyalex bibtexparser rispy python-docx reportlab `
    lxml beautifulsoup4 tqdm lifelines adjustText pymupdf pymupdf4llm
}

# 3) Copy skills + rewrite paths to absolute (working-dir independent)
Write-Host "`nCopying skills and absolutizing paths ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Recurse -Force (Join-Path $Src "*") $Dest
$destAbs = (Resolve-Path $Dest).Path
$n = 0
Get-ChildItem -Path $Dest -Recurse -Filter "SKILL.md" | ForEach-Object {
  $t = [System.IO.File]::ReadAllText($_.FullName)
  # interpreter: .venv\Scripts\python.exe -> absolute venv python
  $t = $t.Replace(".venv\Scripts\python.exe", $VenvPy)
  # script root: .opencode/skills/ -> absolute dest dir
  $t = $t.Replace(".opencode/skills/", ($destAbs + "\"))
  # write back as UTF-8 WITHOUT BOM (BOM crashes skill loaders)
  [System.IO.File]::WriteAllText($_.FullName, $t, (New-Object System.Text.UTF8Encoding($false)))
  $n++
}
Write-Host "  rewrote $n SKILL.md files" -ForegroundColor Green

Write-Host "`nDone." -ForegroundColor Green
Write-Host "skills at:   $destAbs ($n SKILL.md)"
Write-Host "interpreter: $VenvPy"
Write-Host ""
Write-Host "Next: point WorkBuddy at the skills dir above (if -Dest already is its skills root, it auto-discovers)."
Write-Host "Self-check: & `"$VenvPy`" `"$destAbs\reference-check\verify_refs.py`" `"10.1038/s41586-020-2649-2`""
