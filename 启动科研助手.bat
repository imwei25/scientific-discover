@echo off
chcp 65001 >nul
title Research Assistant
cd /d "%~dp0backend"

if not exist ".venv\Scripts\python.exe" (
    echo [Not installed] Please run scripts\setup.ps1 first ^(right-click - Run with PowerShell^).
    pause
    exit /b
)

rem Read the configured port from backend\.env (default 8756). cwd is already backend.
set "PORT=8756"
if exist ".env" for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
)
set "URL=http://127.0.0.1:%PORT%"

rem If the service is already running, just open the browser (avoid a duplicate that fails to bind the port).
curl -s -o nul --max-time 2 %URL%/api/health
if %errorlevel%==0 (
    echo Service already running on port %PORT%. Opening browser...
    start "" %URL%
    exit /b
)

echo Starting Research Assistant on port %PORT%, please wait...
start "RA-Server" /min cmd /c ".venv\Scripts\python.exe -m app.main > server.log 2>&1"

rem Wait until the service is healthy (up to ~25s) before opening the browser.
set /a tries=0
:waitloop
timeout /t 1 /nobreak >nul
curl -s -o nul --max-time 2 %URL%/api/health
if %errorlevel%==0 goto ready
set /a tries+=1
if %tries% lss 25 goto waitloop
echo.
echo [启动失败] 服务未能就绪。请打开 backend\server.log 查看错误原因，并把内容发给开发者。
echo Log file: %~dp0backend\server.log
echo.
start "" notepad "%~dp0backend\server.log"
pause
exit /b

:ready
start "" %URL%
echo.
echo Research Assistant is running (port %PORT%). The browser has opened.
echo Keep the minimized "RA-Server" window open while using the app.
echo To quit completely, run "停止科研助手.bat" (or close the RA-Server window).
echo.
pause
