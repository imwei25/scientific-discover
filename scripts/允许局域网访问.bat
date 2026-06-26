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

rem ---- elevated: add inbound firewall rule for TCP 8756 (idempotent) ----
echo Adding firewall rule to allow inbound TCP 8756 ...
powershell -NoProfile -Command "Remove-NetFirewallRule -DisplayName 'KeyanAssistant 8756' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName 'KeyanAssistant 8756' -Direction Inbound -Protocol TCP -LocalPort 8756 -Action Allow -Profile Any | Out-Null; Write-Host '[OK] Inbound TCP 8756 allowed for all network profiles.'; (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or ($_.IPAddress -like '172.*') }) | ForEach-Object { Write-Host (' Other devices open:  http://' + $_.IPAddress + ':8756') }"

echo.
echo Next steps:
echo   1) Make sure backend\.env has HOST=0.0.0.0 , then restart the app.
echo   2) On another device (same Wi-Fi/LAN), open the http URL shown above.
echo.
pause
