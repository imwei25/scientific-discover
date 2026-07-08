<#
  One-command install for the sci-skill suite (Windows).
  - Builds a project-root .venv and installs all Python deps (auto-falls back to a
    China PyPI mirror when pypi.org is slow/unreachable).
  - Auto-installs Python 3.12 via winget when no usable Python is found.
  - Optional: -WithPdf also installs pandoc + MiKTeX (needed only by render-pdf-doc)
    and enables MiKTeX auto package install so first render does not hang.
  - Optional: -LinkClaude copies skills\* into %USERPROFILE%\.claude\skills so
    Claude Code picks them up without manual copying.
  ASCII-only on purpose: PowerShell 5.1 reads BOM-less UTF-8 scripts as ANSI and would garble non-ASCII.

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -WithPdf
    powershell -ExecutionPolicy Bypass -File install.ps1 -WithPdf -LinkClaude
#>
param([switch] $WithPdf, [switch] $LinkClaude)
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Venv = Join-Path $Root ".venv"
$Py = Join-Path $Venv "Scripts\python.exe"
$Req = Join-Path $Root "scripts\requirements-skills.txt"
$Steps = New-Object System.Collections.ArrayList
$MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"

function Step($name, $ok, $detail) {
  [void]$Steps.Add([pscustomobject]@{ Name = $name; OK = $ok; Detail = $detail })
  $mark = "[FAIL]"; $color = "Red"
  if ($ok) { $mark = "[ OK ]"; $color = "Green" }
  Write-Host "$mark $name  $detail" -ForegroundColor $color
}

function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $u = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$m;$u"
}

function Find-BasePython {
  # Real Python only: skip the Microsoft Store execution-alias stub in WindowsApps,
  # which either pops the Store or creates a broken venv.
  foreach ($c in @("py", "python", "python3")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    if ($cmd.Source -match "WindowsApps") { continue }
    return $cmd
  }
  return $null
}

function Test-PyVersion($exe, $isLauncher) {
  # Returns $true when interpreter is CPython >= 3.10
  try {
    if ($isLauncher) { $v = & $exe -3 -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null }
    else             { $v = & $exe    -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null }
    if ($LASTEXITCODE -ne 0 -or -not $v) { return $false }
    $parts = "$v".Trim().Split(".")
    return ([int]$parts[0] -gt 3) -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10)
  } catch { return $false }
}

Write-Host "== sci-skill install (Windows) ==" -ForegroundColor Cyan

# 1) locate or install Python
$fatal = $false
if (-not (Test-Path $Py)) {
  $cmd = Find-BasePython
  $needInstall = $true
  if ($cmd) {
    $isPy = ($cmd.Source -match "py\.exe$")
    if (Test-PyVersion $cmd.Source $isPy) { $needInstall = $false }
    else { Write-Host "Found Python at $($cmd.Source) but it is older than 3.10." -ForegroundColor Yellow }
  }
  if ($needInstall) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Write-Host "Installing Python 3.12 via winget (one-time) ..." -ForegroundColor Cyan
      winget install -e --id Python.Python.3.12 --scope user --silent --accept-source-agreements --accept-package-agreements
      if ($LASTEXITCODE -ne 0) { Write-Host "winget install of Python failed (exit $LASTEXITCODE)." -ForegroundColor Yellow }
      Refresh-Path
      $cmd = Find-BasePython
    }
    if (-not $cmd) {
      Step "Python" $false "No usable Python 3.10+. Install it manually: winget install -e --id Python.Python.3.12 , then re-run install.ps1"
      $fatal = $true
    }
  }
  if (-not $fatal) {
    $isPy = ($cmd.Source -match "py\.exe$")
    if (-not (Test-PyVersion $cmd.Source $isPy)) {
      Step "Python" $false "Python at $($cmd.Source) is older than 3.10; sci-skill needs 3.10+ (3.12 recommended; avoid brand-new majors, wheels may lag)."
      $fatal = $true
    } else {
      Write-Host "Creating .venv ..." -ForegroundColor Cyan
      if ($isPy) { & $cmd.Source -3 -m venv $Venv } else { & $cmd.Source -m venv $Venv }
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Py)) { Step "venv" $false "python -m venv failed"; $fatal = $true }
    }
  }
}
if ($fatal) {
  Write-Host "`nInstall aborted: no usable Python. See message above." -ForegroundColor Red
  exit 1
}
& $Py --version
Step "Python venv" $true "$Py"

# 2) deps, with China-mirror fallback
Write-Host "Installing Python deps (first run ~3-8 min) ..." -ForegroundColor Cyan
& $Py -m pip install -U pip -q --timeout 30 --retries 2
& $Py -m pip install -r $Req --timeout 30 --retries 2
if ($LASTEXITCODE -ne 0) {
  Write-Host "pypi.org unstable; retrying via Tsinghua mirror ..." -ForegroundColor Yellow
  & $Py -m pip install -r $Req -i $MIRROR --timeout 30 --retries 2
  if ($LASTEXITCODE -eq 0) {
    # Persist the working mirror for every later pip call in this venv.
    $pipIni = Join-Path $Venv "pip.ini"
    "[global]`nindex-url = $MIRROR" | Out-File -FilePath $pipIni -Encoding ascii
    Write-Host "Mirror saved to .venv\pip.ini for future installs." -ForegroundColor DarkGray
  }
}
if ($LASTEXITCODE -ne 0) {
  Step "Python deps" $false "pip install failed on both pypi.org and the Tsinghua mirror; check network/proxy and re-run"
} else {
  Step "Python deps" $true "requirements-skills.txt installed"
}

# 3) optional PDF toolchain
if ($WithPdf) {
 try {
  Write-Host "Installing pandoc + MiKTeX (for render-pdf-doc) ..." -ForegroundColor Cyan
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    if (-not (Get-Command pandoc -ErrorAction SilentlyContinue)) {
      winget install --id JohnMacFarlane.Pandoc --scope user --silent --accept-source-agreements --accept-package-agreements
      if ($LASTEXITCODE -ne 0) { Write-Host "winget pandoc failed (exit $LASTEXITCODE)" -ForegroundColor Yellow }
    }
    if (-not (Get-Command xelatex -ErrorAction SilentlyContinue)) {
      winget install --id MiKTeX.MiKTeX --scope user --silent --accept-source-agreements --accept-package-agreements
      if ($LASTEXITCODE -ne 0) { Write-Host "winget MiKTeX failed (exit $LASTEXITCODE)" -ForegroundColor Yellow }
    }
    Refresh-Path
    # MiKTeX installs under LOCALAPPDATA and is often not on PATH yet in this session.
    $mikBin = Join-Path $env:LOCALAPPDATA "Programs\MiKTeX\miktex\bin\x64"
    if (Test-Path $mikBin) { $env:Path = "$mikBin;$env:Path" }
    $pandocOk = [bool](Get-Command pandoc -ErrorAction SilentlyContinue)
    $xelatexOk = [bool](Get-Command xelatex -ErrorAction SilentlyContinue)
    if ($xelatexOk) {
      # Without AutoInstall=1, the first non-interactive render hangs on a
      # "install missing package?" prompt inside xelatex.
      initexmf --set-config-value "[MPM]AutoInstall=1" 2>$null
      miktex packages update 2>$null
    }
    Step "pandoc"  $pandocOk  $(if ($pandocOk)  { (Get-Command pandoc).Source }  else { "not on PATH; open a NEW terminal or install manually" })
    Step "xelatex" $xelatexOk $(if ($xelatexOk) { (Get-Command xelatex).Source } else { "not on PATH; open a NEW terminal or install manually" })
  } else {
    Step "PDF toolchain" $false "winget missing; install pandoc + MiKTeX manually for PDF output"
  }
 } catch {
   Step "PDF toolchain" $false "install step errored: $($_.Exception.Message)"
 }
}

# 4) optional: expose skills to Claude Code
if ($LinkClaude) {
  try {
    $target = Join-Path $env:USERPROFILE ".claude\skills"
    New-Item -ItemType Directory -Force $target | Out-Null
    $n = 0
    Get-ChildItem (Join-Path $Root "skills") -Directory | ForEach-Object {
      $dst = Join-Path $target $_.Name
      if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
      Copy-Item -Recurse $_.FullName $dst
      $n++
    }
    Step "Claude Code skills" $true "$n skills copied to $target"
  } catch {
    Step "Claude Code skills" $false "copy failed: $($_.Exception.Message)"
  }
}

# 5) validate skills + environment
try {
  & $Py (Join-Path $Root "scripts\validate_skills.py") --env
  if ($LASTEXITCODE -ne 0) { Step "Self-check" $false "validate_skills.py reported problems (see above)" }
  else { Step "Self-check" $true "skills + environment validated" }
} catch {
  Step "Self-check" $false "validate_skills.py could not run: $($_.Exception.Message)"
}

# 6) summary - never print a green Done when something failed
$failed = @($Steps | Where-Object { -not $_.OK })
Write-Host ""
if ($failed.Count -eq 0) {
  Write-Host "Done. All steps passed." -ForegroundColor Green
} else {
  Write-Host ("FINISHED WITH {0} PROBLEM(S):" -f $failed.Count) -ForegroundColor Red
  $failed | ForEach-Object { Write-Host ("  - {0}: {1}" -f $_.Name, $_.Detail) -ForegroundColor Red }
}
Write-Host "Interpreter: $Py"
Write-Host "Skills dir : $(Join-Path $Root 'skills')"
Write-Host "Load them: point your agent framework at the skills\ folder (see README)."
if (-not $WithPdf) { Write-Host "PDF (render-pdf-doc)? re-run with -WithPdf." -ForegroundColor DarkGray }
if (-not $LinkClaude) { Write-Host "Using Claude Code? re-run with -LinkClaude to copy skills into ~/.claude/skills." -ForegroundColor DarkGray }
if ($failed.Count -gt 0) { exit 1 }
