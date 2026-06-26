@echo off
chcp 65001 >nul
title Stop Research Assistant
echo Stopping Research Assistant service...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*app.main*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Done. Service stopped.
timeout /t 2 /nobreak >nul
