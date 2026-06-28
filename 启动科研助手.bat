@echo off
chcp 65001 >nul
title Research Assistant
cd /d "%~dp0backend"

if not exist ".venv\Scripts\python.exe" (
    echo [未安装] 尚未安装运行环境。请右键 scripts\setup.ps1 - 用 PowerShell 运行 完成安装后再启动。
    echo [Not installed] Please run scripts\setup.ps1 first ^(right-click - Run with PowerShell^).
    pause
    exit /b
)

rem 启动前温馨提示: 未配置 .env 时 AI 功能需要先填 key(服务仍可启动)。
if not exist ".env" (
    echo [提示] 未发现 backend\.env, AI 功能可能不可用。
    echo        如需使用 AI, 请复制 backend\.env.example 为 backend\.env 并填入模型 key,
    echo        或双击根目录「检查环境.bat」自检。继续启动中...
    echo.
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
echo [启动失败] 服务未能就绪。正在运行环境自检以定位原因...
echo ============================================================
rem 用 doctor 给出可操作的诊断(依赖缺失/端口被占/未配 key 等), 比直接看日志更友好。
.venv\Scripts\python.exe doctor.py
echo ============================================================
echo.
echo 上面 [X ] / [! ] 行即问题所在, 按其 -^> 提示修复后重试。
echo 如仍无法解决, 请把 backend\server.log 的内容发给开发者。
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
