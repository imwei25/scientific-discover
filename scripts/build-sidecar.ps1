# 用 PyInstaller 把 Python 后端打包成单文件 exe, 作为 Tauri sidecar。
# 产物会按 Tauri 要求重命名为 binaries/sidecar-<目标三元组>.exe
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$mirror = "https://pypi.tuna.tsinghua.edu.cn/simple"

Set-Location "$root\backend"

Write-Host "==> 安装 PyInstaller" -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m pip install -i $mirror pyinstaller

Write-Host "==> 打包后端 (含 scipy/matplotlib 需要 --collect-all)" -ForegroundColor Cyan
& ".\.venv\Scripts\pyinstaller.exe" `
    --onefile `
    --name sidecar `
    --collect-all scipy `
    --collect-all matplotlib `
    --collect-all pandas `
    --collect-all sklearn `
    --hidden-import app.main `
    sidecar_entry.py

# Tauri 要求 sidecar 文件名带目标三元组后缀
$triple = (rustc -vV | Select-String "host:").ToString().Split(" ")[1]
$binDir = "$root\src-tauri\binaries"
New-Item -ItemType Directory -Force $binDir | Out-Null
Copy-Item "dist\sidecar.exe" "$binDir\sidecar-$triple.exe" -Force

Write-Host "`n完成: $binDir\sidecar-$triple.exe" -ForegroundColor Green
