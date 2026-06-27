@echo off
chcp 65001 >nul
title Research Assistant - Environment Doctor
cd /d "%~dp0"
if exist "backend\.venv\Scripts\python.exe" (
  backend\.venv\Scripts\python.exe backend\doctor.py
) else (
  echo [X] 未找到 backend\.venv，请先运行 scripts\setup.ps1 安装依赖。
)
echo.
pause
