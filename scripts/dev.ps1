# Dev mode: backend (auto-reload) + frontend (Vite HMR) in two windows.
$root = Split-Path $PSScriptRoot -Parent

Write-Host "Starting backend sidecar (http://127.0.0.1:8756) ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\backend'; .\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8756"
)

Write-Host "Starting frontend Vite (http://localhost:5173) ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\frontend'; npm run dev"
)

Start-Sleep -Seconds 4
Start-Process "http://localhost:5173"
Write-Host "Dev servers launched in two new windows. Frontend: 5173, Backend: 8756" -ForegroundColor Green
