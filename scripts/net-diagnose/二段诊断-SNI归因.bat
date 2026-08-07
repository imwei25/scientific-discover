@echo off
rem Stage-2 probe: is the block keyed on the DOMAIN (SNI) or on the SERVER IP?
rem Run this on the network where the site fails. Keep ASCII-only in this file.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0probe-sni.ps1"
echo.
pause
