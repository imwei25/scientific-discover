#Requires -Version 5.1
<#
win_ocr.ps1 —— 用 Windows 自带的 OCR 引擎（WinRT: Windows.Media.Ocr）把图片里的字识别出来。

【它是 ocr.sh 的第三条通道，不是主力】离线、免费、不限次、图片不出本机；代价是中文准确度不如
OCR.space Engine3，且完全不做表格版面（只有行）。云端两条通道都走不通时由 ocr.sh 自动接手。

【为什么必须 powershell.exe（Windows PowerShell 5.1），不能用 pwsh 7】
WinRT 的异步接口要靠 System.Runtime.WindowsRuntime 里的 AsTask 扩展投影成 .NET Task 才能等；
这套投影只在 .NET Framework 上有，PowerShell 7（.NET Core）默认加载不到，脚本会在 Add-Type 就停。

【这个文件必须带 UTF-8 BOM】Windows PowerShell 5.1 读 .ps1 时，没有 BOM 就按系统 ANSI 代码页解，
中文注释与中文报错会全变乱码（脚本还照跑，只是错误信息看不懂——最难查的那种坏法）。
编辑后请确认 BOM 还在（`(Get-Content -Encoding Byte -TotalCount 3 win_ocr.ps1)` 应为 239 187 191）。

用法：
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File win_ocr.ps1 -Probe
      → 探测可用性：能用则把已安装的识别语言（逗号分隔）打到 stdout 并退出 0；不能用退出非 0。
  powershell.exe ... -File win_ocr.ps1 -Path C:\a.png [-Path C:\b.jpg] [-Lang zh-Hans-CN]
      → 识别文本走 stdout，诊断信息走 stderr。

退出码：0 成功 / 2 参数或文件问题 / 3 本机环境不支持 WinRT OCR / 4 没装任何识别语言包 / 5 识别失败
#>
[CmdletBinding()]
param(
  [string[]]$Path,
  [string]$Lang = 'zh-Hans-CN',
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Die([int]$code, [string]$msg) { [Console]::Error.WriteLine($msg); exit $code }

if ($PSVersionTable.PSEdition -and $PSVersionTable.PSEdition -ne 'Desktop') {
  Die 3 "[win-ocr] 需要 Windows PowerShell 5.1（powershell.exe）；当前是 $($PSVersionTable.PSEdition) 版，加载不到 WinRT 投影。"
}
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop }
catch { Die 3 "[win-ocr] 加载 System.Runtime.WindowsRuntime 失败：$($_.Exception.Message)" }

# WinRT 的 IAsyncOperation<T> → Task<T>，同步等它。PS 里没有 await，只能自己反射拿这个扩展方法。
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
}) | Select-Object -First 1
if (-not $asTaskGeneric) { Die 3 "[win-ocr] 找不到 AsTask 扩展方法，本机 .NET 不支持 WinRT 异步投影。" }

function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$t.Wait(-1)
  $t.Result
}

try {
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]        | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]         | Out-Null
} catch { Die 3 "[win-ocr] 本机没有 Windows.Media.Ocr（需要 Windows 10 及以上）：$($_.Exception.Message)" }

# 已安装的识别语言。装没装是【系统设置 → 语言】那边的事：简体中文要装「中文(简体)」语言包里的
# 「光学字符识别」可选功能，没装就只有英文之类，中文图会识别成一堆乱字符而不是报错。
$avail = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
if (-not $avail -or $avail.Count -eq 0) {
  Die 4 "[win-ocr] 本机没有安装任何 OCR 识别语言包（设置 → 时间和语言 → 语言 → 某语言 → 可选功能 → 光学字符识别）。"
}

if ($Probe) {
  [Console]::Out.WriteLine((($avail | ForEach-Object { $_.LanguageTag }) -join ','))
  exit 0
}

if (-not $Path -or $Path.Count -eq 0) { Die 2 "[win-ocr] 缺 -Path（要识别的图片路径）。" }

# 选语言：先按 -Lang 精确配，再退到任意简体中文，最后退到第一个可用的。
# 【不自己 new Language】直接从 AvailableRecognizerLanguages 里挑现成对象，省掉一处会抛异常的构造。
$sel = $avail | Where-Object { $_.LanguageTag -ieq $Lang } | Select-Object -First 1
if (-not $sel) { $sel = $avail | Where-Object { $_.LanguageTag -like 'zh-Hans*' } | Select-Object -First 1 }
if (-not $sel) { $sel = $avail | Select-Object -First 1 }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($sel)
if (-not $engine) { Die 4 "[win-ocr] 无法为语言 $($sel.LanguageTag) 创建 OCR 引擎。" }
[Console]::Error.WriteLine("[win-ocr] 识别语言 $($sel.LanguageTag)（本机可用：$(($avail | ForEach-Object { $_.LanguageTag }) -join ', ')）")
if ($sel.LanguageTag -notlike 'zh*' -and $Lang -like 'zh*') {
  [Console]::Error.WriteLine("[win-ocr] ⚠ 本机没装中文识别语言包，用 $($sel.LanguageTag) 识中文只会出乱码——这时的结果不可用。")
}

$maxDim = [double][Windows.Media.Ocr.OcrEngine]::MaxImageDimension

function Test-Cjk([char]$c) {
  $n = [int]$c
  return (($n -ge 0x2E80 -and $n -le 0x303F) -or ($n -ge 0x3400 -and $n -le 0x4DBF) -or
          ($n -ge 0x4E00 -and $n -le 0x9FFF) -or ($n -ge 0xF900 -and $n -le 0xFAFF) -or
          ($n -ge 0xFF00 -and $n -le 0xFFEF))
}

# 【为什么不用 $line.Text】WinRT 把一行里的每个 word 用空格拼起来，中文按字/词切 word，
# 于是 "申请代码" 会变成 "申 请 代 码"。所以自己拼：两边只要有一侧是中日韩字符就不加空格。
function Get-LineText($line) {
  $sb = New-Object System.Text.StringBuilder
  $prev = ''
  foreach ($wd in $line.Words) {
    $t = [string]$wd.Text
    if ($t.Length -eq 0) { continue }
    if ($prev.Length -gt 0 -and -not (Test-Cjk $prev[$prev.Length - 1]) -and -not (Test-Cjk $t[0])) {
      [void]$sb.Append(' ')
    }
    [void]$sb.Append($t)
    $prev = $t
  }
  $sb.ToString()
}

$rc = 0
foreach ($p in $Path) {
  try {
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "文件不存在：$p" }
    $full = (Resolve-Path -LiteralPath $p).ProviderPath

    $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
    $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

    $w = [double]$decoder.PixelWidth
    $h = [double]$decoder.PixelHeight
    if ($w -lt 1 -or $h -lt 1) { throw "解不出图像尺寸" }
    # 缩放两头都要管：超过引擎上限会直接失败；而截图那种小图放大一倍能明显提准
    # （本地引擎对小字号比云端敏感得多）。放大同样不能越过上限。
    $scale = 1.0
    $big = [Math]::Max($w, $h)
    if ($big -gt $maxDim) { $scale = $maxDim / $big }
    elseif ($big -lt 1000) { $scale = [Math]::Min(2.0, $maxDim / $big) }

    $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
    $tf.ScaledWidth  = [uint32][Math]::Max(1, [Math]::Floor($w * $scale))
    $tf.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($h * $scale))
    $tf.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant

    $bmp = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $tf,
        [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::ColorManageToSRgb)) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    foreach ($line in $res.Lines) { [Console]::Out.WriteLine((Get-LineText $line)) }

    $bmp.Dispose()
    $stream.Dispose()
  } catch {
    [Console]::Error.WriteLine("[win-ocr] 识别失败 $p ：$($_.Exception.Message)")
    $rc = 5
  }
}
exit $rc
