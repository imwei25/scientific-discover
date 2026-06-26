@echo off
chcp 65001 >nul
title Allow LAN Access (port 8756)

rem ---- self-elevate to administrator ----
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator permission...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

rem ---- read configured port from backend\.env (default 8756) ----
set "PORT=8756"
pushd "%~dp0..\backend"
if exist ".env" for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
)
popd

rem ---- elevated: add inbound firewall rule for the configured TCP port (idempotent) ----
echo Adding firewall rule to allow inbound TCP %PORT% ...
powershell -NoProfile -Command "$port=%PORT%; Remove-NetFirewallRule -DisplayName ('KeyanAssistant '+$port) -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName ('KeyanAssistant '+$port) -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null; Write-Host ('[OK] Inbound TCP '+$port+' allowed for all network profiles.'); (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or ($_.IPAddress -like '172.*') }) | ForEach-Object { Write-Host (' Other devices open:  http://' + $_.IPAddress + ':' + $port) }"

echo.
echo Next steps:
echo   1) Make sure backend\.env has HOST=0.0.0.0 , then restart the app.
echo   2) On another device (same Wi-Fi/LAN), open the http URL shown above.
echo.
pause
