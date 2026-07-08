<#
  启动 / 自愈 opencode serve
  逻辑：探活目标端口 —— 通就复用；不通（含端口被占用但无响应）就杀掉占端口的进程，再起一个新的，并等它真正就绪。
  用法：
    powershell -ExecutionPolicy Bypass -File scripts\serve-opencode.ps1            # 智能启动（默认 4098）
    powershell -ExecutionPolicy Bypass -File scripts\serve-opencode.ps1 -Port 4099 # 指定端口
    powershell -ExecutionPolicy Bypass -File scripts\serve-opencode.ps1 -Force     # 无论是否在跑，都强制重建
#>
param(
    [int]$Port = 4098,
    [switch]$Force
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Base = "http://127.0.0.1:$Port"
$Out  = Join-Path $Root "serve.out"
$Err  = Join-Path $Root "serve.err"

# 探活：能拿到任何 HTTP 响应（哪怕 404）就算“通”；连接被拒 / 超时算“不通”
function Test-Opencode {
    try {
        Invoke-WebRequest -Uri "$Base/app" -TimeoutSec 4 -UseBasicParsing | Out-Null
        return $true
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { return $true }   # 服务器有 HTTP 应答 = 活着
        return $false                                 # 拒绝 / 超时 = 没活
    } catch { return $false }
}

# 杀掉占用该端口的进程（可能有多个）
function Kill-Port {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    $pids  = @($conns | Select-Object -ExpandProperty OwningProcess -Unique)
    if (-not $pids) { Write-Host "  端口 $Port 上没有监听进程" -ForegroundColor DarkGray; return }
    foreach ($procId in $pids) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        Write-Host ("  杀掉 PID {0} ({1})" -f $procId, ($(if ($p) { $p.ProcessName } else { "?" }))) -ForegroundColor Yellow
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    # 等端口释放
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 300
    }
}

Write-Host "== opencode serve 自愈启动（端口 $Port）==" -ForegroundColor Cyan

if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
    throw "PATH 里找不到 opencode，请先安装（npm i -g opencode-ai）"
}

if ((Test-Opencode) -and (-not $Force)) {
    Write-Host "已有 opencode 在 $Base 正常响应，直接复用。" -ForegroundColor Green
    Write-Host "（如需强制重建：加 -Force）" -ForegroundColor DarkGray
    exit 0
}

if ($Force) { Write-Host "指定 -Force，重建服务 ..." -ForegroundColor Yellow }
else        { Write-Host "$Base 不通，清理旧进程并重建 ..." -ForegroundColor Yellow }

Kill-Port

Write-Host "启动新的 opencode serve ..." -ForegroundColor Cyan
$proc = Start-Process -FilePath "opencode" `
    -ArgumentList @("serve", "--port", "$Port") `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $Out -RedirectStandardError $Err `
    -WindowStyle Hidden -PassThru

# 轮询直到就绪（最多 ~30 秒）
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) {
        Write-Host "opencode 进程已退出（exit=$($proc.ExitCode)），日志：" -ForegroundColor Red
        if (Test-Path $Err) { Get-Content $Err -Tail 20 | Write-Host }
        if (Test-Path $Out) { Get-Content $Out -Tail 20 | Write-Host }
        throw "opencode serve 启动失败"
    }
    if (Test-Opencode) {
        Write-Host "✔ opencode 已就绪：$Base  (PID $($proc.Id))" -ForegroundColor Green
        Write-Host "  日志：$Out / $Err"
        Write-Host "  下一步：node web\server.mjs   然后打开 http://localhost:3000" -ForegroundColor DarkGray
        exit 0
    }
}
throw "等待 opencode 就绪超时（30s），请查看日志：$Err"
