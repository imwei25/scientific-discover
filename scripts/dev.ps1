# 开发模式: 后端(自动重载) + 前端(Vite 热更新) 各开一个窗口。
$root = Split-Path $PSScriptRoot -Parent

Write-Host "启动后端 sidecar (http://127.0.0.1:8756) ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\backend'; .\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8756"
)

Write-Host "启动前端 Vite (http://localhost:5173) ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\frontend'; npm run dev"
)

Start-Sleep -Seconds 4
Start-Process "http://localhost:5173"
Write-Host "开发服务已在两个新窗口启动。前端: 5173, 后端: 8756" -ForegroundColor Green
