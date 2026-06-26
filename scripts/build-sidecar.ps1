# Bundle the Python backend into a single-file exe (Tauri sidecar) via PyInstaller.
# Output is renamed to binaries/sidecar-<target-triple>.exe as Tauri requires.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$mirror = "https://pypi.tuna.tsinghua.edu.cn/simple"

Set-Location "$root\backend"

Write-Host "==> Installing PyInstaller" -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m pip install -i $mirror pyinstaller

Write-Host "==> Bundling backend (scipy/matplotlib need --collect-all)" -ForegroundColor Cyan
& ".\.venv\Scripts\pyinstaller.exe" `
    --onefile `
    --name sidecar `
    --collect-all scipy `
    --collect-all matplotlib `
    --collect-all pandas `
    --collect-all sklearn `
    --collect-all pingouin `
    --collect-all lifelines `
    --hidden-import app.main `
    sidecar_entry.py

# Tauri requires the sidecar filename to carry the target triple suffix
$triple = (rustc -vV | Select-String "host:").ToString().Split(" ")[1]
$binDir = "$root\src-tauri\binaries"
New-Item -ItemType Directory -Force $binDir | Out-Null
Copy-Item "dist\sidecar.exe" "$binDir\sidecar-$triple.exe" -Force

Write-Host "`nDone: $binDir\sidecar-$triple.exe" -ForegroundColor Green
