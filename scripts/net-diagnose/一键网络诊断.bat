@echo off
rem One-click network diagnosis (double-click me). Keep ASCII-only in this file:
rem cmd parses .bat with the OEM codepage, Chinese here would garble on some PCs.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose-server.ps1"
echo.
pause
