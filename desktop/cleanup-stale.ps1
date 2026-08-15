<#
  升级后清理「上一版有、这一版没有」的残留文件。

  【为什么需要】NSIS 是把新文件**覆盖**到旧目录树上的：它只管自己登记过的文件，
  凡是上一版装过、这一版不再随包的东西，既不会被覆盖也不会被删除，会一直留在磁盘上。
  真机实测（2026-08-16，0.1.29 → 0.1.30）：ppt-master 的 AI 配图对照图库从包里移除后，
  安装目录里那 55 个文件 / 43.2 MB 原样留着——安装器瘦了 33.5 MB，老用户一个字节没省回来。
  卸载路径早就用「没用户数据就整棵树删」根治过了，漏的一直是升级路径。

  【为什么用清单而不是逐个点名】installer-hooks.nsh 里那串 Delete/RMDir 的教训已经写在
  它自己的注释里：清单式点名天生会漏（0.1.4 漏了 web-packs，0.1.5/0.1.6 漏了 workspace.html），
  每漏一个用户就看到一次「卸载不掉」。所以这里反过来做：打包时记下**随包有什么**，
  装完后把包拥有的目录里**不在清单上的**一律删掉。以后再增删随包内容，这里不用改。

  【只扫“包拥有的目录”】运行期产物（outputs / uploads / chat-bridge / tasks /
  skill-packs / web-packs）与用户状态（登录态、会话标题、模型路由）都不在扫描范围内，
  或在 $KeepAlways 白名单里——它们本来就不该出现在清单上，扫到了也不能删。

  【防灾闸】清单缺失、读不出、或条目数少得离谱时**什么都不做**并明确报出来。
  宁可留下残留，也绝不能因为清单没生成而把刚装好的程序扫掉。
#>
param(
  [Parameter(Mandatory = $true)][string]$BundleDir,
  # 只报会删什么、不真删。安装器不传这个；排查「它到底想删哪些」时手工加上。
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Log([string]$m) { Write-Host $m }

$manifestPath = Join-Path $BundleDir "manifest.txt"
if (-not (Test-Path $manifestPath)) {
  Log "  跳过残留清理：找不到 manifest.txt（旧版安装包不带清单，属正常）"
  exit 0
}

try {
  $entries = [System.IO.File]::ReadAllLines($manifestPath)
} catch {
  Log "  跳过残留清理：清单读取失败（$($_.Exception.Message)）"
  exit 0
}

# 防灾闸：正常包有上万个文件（光 .venv 就好几千）。远低于此说明清单没生成全，
# 此时按清单删 = 把刚装好的程序删掉。宁可不清。
$MIN_ENTRIES = 2000
if ($entries.Count -lt $MIN_ENTRIES) {
  Log "  跳过残留清理：清单只有 $($entries.Count) 条，少于安全下限 $MIN_ENTRIES —— 判定清单不完整，不动任何文件"
  exit 0
}

$keep = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($e in $entries) { if ($e.Trim()) { [void]$keep.Add($e.Trim()) } }

# 包拥有的目录：这几棵树的内容完全由安装包决定，扫描只在它们里面进行。
$sweepRoots = @("app\.opencode", "app\web", "app\.venv", "app\release-notes", "runtime")

# 即使不在清单上也绝不删：打包时**刻意排除**的用户状态文件（见 bundle.ps1 第 6 节 ExcludeFiles）。
# 它们就住在 app\web 这棵被扫的树里，漏掉这份白名单 = 用户升级后要重新登录、会话标题全丢。
$keepAlways = @(
  "app\web\model-config.json",
  "app\web\cloud-state.json",
  "app\web\sessions-meta.json",
  "app\web\headless-env.json"
)
foreach ($k in $keepAlways) { [void]$keep.Add($k) }

$deleted = 0
$bytes = 0L
$failed = 0

foreach ($root in $sweepRoots) {
  $full = Join-Path $BundleDir $root
  if (-not (Test-Path $full)) { continue }
  $files = Get-ChildItem $full -Recurse -File -Force -ErrorAction SilentlyContinue
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($BundleDir.Length).TrimStart([char]92)
    if ($keep.Contains($rel)) { continue }
    try {
      $sz = $f.Length
      if ($DryRun) { Log "    [试运行] 将删除 $rel" } else { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop }
      $deleted++; $bytes += $sz
    } catch {
      $failed++
    }
  }
}

# 收尾：删空目录（自底向上，删完文件后可能整棵子树都空了）
if ($DryRun) {
  Log ("  [试运行] 合计 {0} 个文件 / {1:N1} MB，未实际删除" -f $deleted, ($bytes / 1MB))
  exit 0
}
foreach ($root in $sweepRoots) {
  $full = Join-Path $BundleDir $root
  if (-not (Test-Path $full)) { continue }
  $dirs = Get-ChildItem $full -Recurse -Directory -Force -ErrorAction SilentlyContinue |
          Sort-Object { $_.FullName.Length } -Descending
  foreach ($d in $dirs) {
    try {
      if (-not (Get-ChildItem $d.FullName -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $d.FullName -Force -ErrorAction Stop
      }
    } catch { }
  }
}

if ($deleted -gt 0) {
  Log ("  已清理上一版残留：{0} 个文件，{1:N1} MB" -f $deleted, ($bytes / 1MB))
} else {
  Log "  无上一版残留需要清理"
}
if ($failed -gt 0) { Log "  （$failed 个文件删不掉，多半仍被占用；下次升级会再试）" }
exit 0
