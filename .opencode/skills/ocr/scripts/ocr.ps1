<#
ocr.ps1 —— OCR 技能的 PowerShell 入口：**只负责找到 .venv 的 python，逻辑全在 ocr.py**。
与 `bash ocr.sh …` 完全等价，给 Windows 上没有 bash 的会话用（桌面打包版、纯 PowerShell 环境）。

  powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 <图片/PDF 的 URL 或路径> [更多...]

【注意别调错文件】同目录的 win_ocr.ps1 **不是入口**，它是三条通道里最差的那条（本机离线兜底：
不做表格版面、不认 PDF、错字率高于云端 Engine3）。直接调它 = 主动放弃云端通道。走 ocr.ps1，
它会按 ①平台代理 → ②本机 key → ③Windows 内置 的顺序自己挑，走不通才逐级降级并在 stderr 说明。

用法与通道说明见 ocr.py 抬头。
#>
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args_)

$ErrorActionPreference = 'Stop'
if (-not $Args_ -or $Args_.Count -eq 0) {
  [Console]::Error.WriteLine("用法: ocr.ps1 <图片/PDF 的 URL 或路径> [更多...]"); exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 逐级向上找项目根的 .venv；找不到就退到 PATH 上的 python
$py = ''
$d = $scriptDir
for ($i = 0; $i -lt 7 -and $d; $i++) {
  foreach ($c in @("$d\.venv\Scripts\python.exe", "$d\.venv\bin\python")) {
    if (Test-Path -LiteralPath $c -PathType Leaf) { $py = $c; break }
  }
  if ($py) { break }
  $d = Split-Path -Parent $d
}
if (-not $py) {
  foreach ($c in @('python', 'python3', 'py')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source; break }
  }
}
if (-not $py) {
  [Console]::Error.WriteLine("ERROR: 未找到 python（缺 .venv 先跑 env-setup 技能）"); exit 3
}

$env:OCR_SKILL_SCRIPTS = $scriptDir
$env:PYTHONIOENCODING = 'utf-8'
& $py (Join-Path $scriptDir 'ocr.py') @Args_
exit $LASTEXITCODE
