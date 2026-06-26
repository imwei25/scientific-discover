@echo off
chcp 65001 >nul
title LAN Diagnostics

rem ---- read configured port from backend\.env (default 8756) ----
set "PORT=8756"
pushd "%~dp0..\backend"
if exist ".env" for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
)
popd

echo ============================================================
echo  Configured port (from backend\.env): %PORT%
echo ============================================================
echo  [1] What is listening on %PORT%?
echo      0.0.0.0  = LAN enabled (good)
echo      127.0.0.1 = local only (other PCs cannot connect)
echo ------------------------------------------------------------
powershell -NoProfile -Command "$p=%PORT%; $c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if($c){$c|Select-Object LocalAddress,LocalPort|Format-Table -AutoSize|Out-String|Write-Host}else{Write-Host ('  Nothing is listening on '+$p+' - is the app running?')}"

echo ============================================================
echo  [2] HOST setting in backend\.env  (need HOST=0.0.0.0 for LAN)
echo ------------------------------------------------------------
powershell -NoProfile -Command "$p=Join-Path '%~dp0..' 'backend\.env'; if(Test-Path $p){$l=Select-String -Path $p -Pattern '^HOST='; if($l){Write-Host ('  '+$l.Line)}else{Write-Host '  (no HOST= line; defaults to 127.0.0.1 = local only)'}}else{Write-Host '  backend\.env not found'}"

echo ============================================================
echo  [3] Firewall rule allowing inbound %PORT%?
echo ------------------------------------------------------------
powershell -NoProfile -Command "$p=%PORT%; if(Get-NetFirewallRule -DisplayName ('KeyanAssistant '+$p) -ErrorAction SilentlyContinue){Write-Host ('  Rule exists (Windows Firewall allows '+$p+')')}else{Write-Host ('  NO rule for '+$p+' - run the allow-LAN script (scripts) as administrator')}"

echo ============================================================
echo  [4] This PC LAN address (others open http://ADDR:%PORT%)
echo ------------------------------------------------------------
powershell -NoProfile -Command "$p=%PORT%; (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or $_.IPAddress -like '172.*' }) | ForEach-Object { Write-Host ('  http://'+$_.IPAddress+':'+$p+'  ('+$_.InterfaceAlias+')') }"

echo ============================================================
echo  [5] Third-party security software (has its own firewall)
echo ------------------------------------------------------------
powershell -NoProfile -Command "$s=Get-Process | Where-Object { $_.ProcessName -match '360|HipsTray|usysdiag|huorong|QQPCRTP|KSafe|Kingsoft|Avast|AVG' } | Select-Object -ExpandProperty ProcessName -Unique; if($s){$s|ForEach-Object{Write-Host ('  Found: '+$_+'  <- check ITS firewall / allow the port there')}}else{Write-Host '  None detected'}"

echo ============================================================
echo  Tip: from ANOTHER PC run:  Test-NetConnection THIS_IP -Port %PORT%
echo       TcpTestSucceeded False = port blocked (firewall/binding)
echo ============================================================
echo.
pause
