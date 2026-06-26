# One-time setup: create Python venv, install deps, build frontend.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$mirror = "https://pypi.tuna.tsinghua.edu.cn/simple"

Write-Host "==> Creating Python virtual environment" -ForegroundColor Cyan
Set-Location "$root\backend"
if (-not (Test-Path ".venv")) { python -m venv .venv }
& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip -i $mirror
& ".\.venv\Scripts\python.exe" -m pip install -i $mirror -r requirements.txt

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created backend\.env - please fill in your model API key." -ForegroundColor Yellow
}

Write-Host "==> Installing frontend dependencies" -ForegroundColor Cyan
Set-Location "$root\frontend"
npm install --registry=https://registry.npmmirror.com --no-fund --no-audit

Write-Host "==> Building frontend" -ForegroundColor Cyan
npm run build

Set-Location $root
Write-Host "`nSetup complete! Double-click '启动科研助手.bat' to start." -ForegroundColor Green
