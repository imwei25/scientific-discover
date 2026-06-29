# 一键把打好的 Windows 安装包发布到 GitHub Release。
# 前提: 已 `cargo tauri build` 出安装包, 且已执行过一次 `gh auth login`。
# 用法: powershell -ExecutionPolicy Bypass -File scripts\publish-release.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

# 解析 gh: 优先 PATH, 否则用 winget 用户级安装位置兜底。
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
    $cand = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter gh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cand) { $gh = $cand.FullName }
}
if (-not $gh) { throw "未找到 gh(GitHub CLI)。先安装: winget install --id GitHub.cli" }

# 找安装包
$exe = Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) { throw "没找到安装包(*-setup.exe)。先运行 cargo tauri build。" }

# 从 tauri.conf.json 读版本号作为 tag
$conf = Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$tag = "v$($conf.version)"

Write-Host "==> 发布 $tag : $($exe.Name) ($([math]::Round($exe.Length/1MB)) MB)" -ForegroundColor Cyan

$notes = @"
科研助手 Windows 桌面安装包。

- 下载 ``$($exe.Name)`` 后双击安装, 终端用户无需安装 Python。
- 首次打开会在 ``%APPDATA%\科研助手\.env`` 生成配置模板,
  填入你的 ``LLM_API_KEY`` 后重新打开应用即可使用 AI 功能。
"@

# release 不存在则创建, 已存在则覆盖上传同名资源
& $gh release view $tag 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    & $gh release create $tag "$($exe.FullName)" --title "科研助手 $tag" --notes $notes
} else {
    Write-Host "Release $tag 已存在, 覆盖上传安装包…" -ForegroundColor Yellow
    & $gh release upload $tag "$($exe.FullName)" --clobber
}

Write-Host "`n完成。下载页:" -ForegroundColor Green
& $gh release view $tag --json url -q .url
