# 一次性安装脚本: 创建 Python 虚拟环境、安装依赖、构建前端。
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$mirror = "https://pypi.tuna.tsinghua.edu.cn/simple"

Write-Host "==> 创建 Python 虚拟环境" -ForegroundColor Cyan
Set-Location "$root\backend"
if (-not (Test-Path ".venv")) { python -m venv .venv }
& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip -i $mirror
& ".\.venv\Scripts\python.exe" -m pip install -i $mirror -r requirements.txt

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "已创建 backend\.env, 请填入你的模型 API key。" -ForegroundColor Yellow
}

Write-Host "==> 安装前端依赖" -ForegroundColor Cyan
Set-Location "$root\frontend"
npm install --registry=https://registry.npmmirror.com --no-fund --no-audit

Write-Host "==> 构建前端" -ForegroundColor Cyan
npm run build

Set-Location $root
Write-Host "`n安装完成! 双击 ‘启动科研助手.bat’ 即可使用。" -ForegroundColor Green
