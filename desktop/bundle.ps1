<#
  桌面版打包脚本（路线2：原生 Windows 移植）
  产出：desktop\dist\bundle\  —— 自包含目录，结构：
    app\                 应用本体（web 网关 + 技能 + AGENTS.md + .venv 嵌入式 Python）
    runtime\node\        便携 node.exe（跑 web/server.mjs）
    runtime\opencode\    opencode.exe（bun 编译的独立二进制）
    runtime\git\         PortableGit（提供 bash/heredoc/管道/git 快照，技能 .sh 脚本全靠它）
    runtime\pandoc\      pandoc.exe（render-docx 硬依赖）
  之后由 desktop\launcher（Tauri）把整个 bundle 作为 resources 打进 NSIS 安装器。

  用法： powershell -ExecutionPolicy Bypass -File desktop\bundle.ps1
  说明：
    - 下载源国内镜像优先（npmmirror / tuna），官方源兜底；已下载的缓存在 desktop\dist\cache，重跑不重下。
    - 刻意【不】打包 texlive/xelatex（几个 GB）：render-pdf-doc 在目标机上会明确报缺依赖并提示装 MiKTeX，
      属已知降级项；render-docx（pandoc 路线）完整可用。
    - 刻意【不】打包 LibreOffice：只影响网关里 pptx/doc 的在线预览（降级为不可预览、可下载），
      ppt-master 生成 pptx 本身是纯 Python，不受影响。
#>
param(
  [string]$Staging = "$PSScriptRoot\dist\bundle",
  [string]$Cache   = "$PSScriptRoot\dist\cache",
  [switch]$Clean,          # 清掉已有 staging 重来（缓存保留）
  [switch]$SkipPip         # 跳过 pip install（site-packages 已装好时提速）
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

# ---- 版本钉死（与生产容器对齐；opencode 版本必须与服务器一致，避免行为漂移）----
$NodeVer   = "22.14.0"
$PyVer     = "3.12.7"
$PyVerNoDot= "312"
$OcVer     = "1.17.14"
$GitVer    = "2.47.1"
$PandocVer = "3.6.3"

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Get-Cached {
  param([string]$Name, [string[]]$Urls)
  $dst = Join-Path $Cache $Name
  if (Test-Path $dst) { Write-Host "    缓存命中 $Name" -ForegroundColor DarkGray; return $dst }
  foreach ($u in $Urls) {
    try {
      Write-Host "    下载 $u"
      # BITS/IE 引擎不稳，直接 .NET 下载；大文件用 curl.exe（Win10+ 自带）更稳
      $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
      if ($curl) { & $curl.Source -sSLf --retry 3 -o "$dst.part" $u; if ($LASTEXITCODE -ne 0) { throw "curl rc=$LASTEXITCODE" } }
      else { Invoke-WebRequest -Uri $u -OutFile "$dst.part" -UseBasicParsing }
      Move-Item "$dst.part" $dst -Force
      return $dst
    } catch { Write-Warning "    失败：$($_.Exception.Message)，换下一个源"; Remove-Item "$dst.part" -Force -ErrorAction SilentlyContinue }
  }
  throw "所有下载源都失败：$Name"
}
# 写 UTF-8【不带 BOM】的文本文件。
# Windows PowerShell 5.1 的 `Out-File -Encoding utf8` 写的是【带 BOM】的 UTF-8，
# 而 JSON.parse 与 serde_json 见了 BOM 都直接报错 —— 症状是"配置文件明明在、内容也对，
# 程序却当成没配"（cloud.json 就栽过：打包版把预置的站点地址整个读丢，首启弹错窗）。
function Write-Utf8NoBom {
  param([Parameter(ValueFromPipeline = $true)][string]$Text, [Parameter(Position = 0)][string]$Path)
  end {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
  }
}

function Copy-Tree {
  param([string]$Src, [string]$Dst, [string[]]$ExcludeFiles = @(), [string[]]$ExcludeDirs = @())
  $args = @($Src, $Dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
  if ($ExcludeFiles.Count) { $args += "/XF"; $args += $ExcludeFiles }
  if ($ExcludeDirs.Count)  { $args += "/XD"; $args += $ExcludeDirs }
  robocopy @args | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $Src -> $Dst 失败 rc=$LASTEXITCODE" }
}

if ($Clean -and (Test-Path $Staging)) { Step "清理旧 staging"; Remove-Item -Recurse -Force $Staging }
New-Item -ItemType Directory -Force $Staging, $Cache | Out-Null
$App = Join-Path $Staging "app"
$Rt  = Join-Path $Staging "runtime"
New-Item -ItemType Directory -Force $App, $Rt | Out-Null

# ================= 1. 便携 Node =================
Step "Node $NodeVer（只取 node.exe，server.mjs 依赖随 web\node_modules 一起拷）"
$nodeDir = Join-Path $Rt "node"
if (-not (Test-Path "$nodeDir\node.exe")) {
  $zip = Get-Cached "node-v$NodeVer-win-x64.zip" @(
    "https://npmmirror.com/mirrors/node/v$NodeVer/node-v$NodeVer-win-x64.zip",
    "https://nodejs.org/dist/v$NodeVer/node-v$NodeVer-win-x64.zip")
  $tmp = Join-Path $Cache "node-tmp"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive $zip $tmp
  New-Item -ItemType Directory -Force $nodeDir | Out-Null
  Copy-Item "$tmp\node-v$NodeVer-win-x64\node.exe" $nodeDir
  Remove-Item -Recurse -Force $tmp
}

# ================= 2. opencode 独立二进制 =================
Step "opencode $OcVer"
$ocDir = Join-Path $Rt "opencode"
if (-not (Test-Path "$ocDir\opencode.exe")) {
  New-Item -ItemType Directory -Force $ocDir | Out-Null
  # 优先从本机 npm 全局装的同版本直接拷（平台包里才是真二进制；opencode-ai\bin 下也可能是全量二进制）
  $cands = @(
    "C:\nvm4w\nodejs\node_modules\opencode-ai\node_modules\opencode-windows-x64\bin\opencode.exe",
    "C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode.exe"
  )
  $src = $cands | Where-Object { (Test-Path $_) -and ((Get-Item $_).Length -gt 10MB) } | Select-Object -First 1
  if (-not $src) {
    # 本机没有 → 从 npm registry 拉平台包 tgz
    $tgz = Get-Cached "opencode-windows-x64-$OcVer.tgz" @(
      "https://registry.npmmirror.com/opencode-windows-x64/-/opencode-windows-x64-$OcVer.tgz",
      "https://registry.npmjs.org/opencode-windows-x64/-/opencode-windows-x64-$OcVer.tgz")
    $tmp = Join-Path $Cache "oc-tmp"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory -Force $tmp | Out-Null
    tar -xzf $tgz -C $tmp
    $src = "$tmp\package\bin\opencode.exe"
  }
  Copy-Item $src "$ocDir\opencode.exe"
}
$ocv = & "$ocDir\opencode.exe" --version 2>&1
if ("$ocv" -notmatch [regex]::Escape($OcVer)) { throw "opencode.exe 版本不对：$ocv（要 $OcVer）" }

# ================= 3. PortableGit（bash + git）=================
Step "PortableGit $GitVer（bash/heredoc/管道 + opencode 会话快照都靠它）"
$gitDir = Join-Path $Rt "git"
if (-not (Test-Path "$gitDir\bin\bash.exe")) {
  $sfx = Get-Cached "PortableGit-$GitVer-64-bit.7z.exe" @(
    "https://registry.npmmirror.com/-/binary/git-for-windows/v$GitVer.windows.1/PortableGit-$GitVer-64-bit.7z.exe",
    "https://github.com/git-for-windows/git/releases/download/v$GitVer.windows.1/PortableGit-$GitVer-64-bit.7z.exe")
  Start-Process -FilePath $sfx -ArgumentList "-y", "-o`"$gitDir`"" -Wait -NoNewWindow
  if (-not (Test-Path "$gitDir\bin\bash.exe")) { throw "PortableGit 解压失败" }
}

# ================= 4. pandoc =================
Step "pandoc $PandocVer（render-docx 硬依赖）"
$pdDir = Join-Path $Rt "pandoc"
if (-not (Test-Path "$pdDir\pandoc.exe")) {
  $zip = Get-Cached "pandoc-$PandocVer-windows-x86_64.zip" @(
    "https://github.com/jgm/pandoc/releases/download/$PandocVer/pandoc-$PandocVer-windows-x86_64.zip",
    "https://mirror.ghproxy.com/https://github.com/jgm/pandoc/releases/download/$PandocVer/pandoc-$PandocVer-windows-x86_64.zip")
  $tmp = Join-Path $Cache "pandoc-tmp"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive $zip $tmp
  New-Item -ItemType Directory -Force $pdDir | Out-Null
  Copy-Item (Get-ChildItem $tmp -Recurse -Filter pandoc.exe | Select-Object -First 1).FullName $pdDir
  Remove-Item -Recurse -Force $tmp
}

# ================= 5. 嵌入式 Python -> app\.venv =================
# 布局约定（两头都要伺候）：
#   .venv\Scripts\python.exe  —— server.mjs 的 PYEXE() 与 install.ps1 认这个（真身，全量嵌入式发行版在此）
#   .venv\bin\python(.exe)    —— 23 个技能文件写死的路径。bin 是【真实目录】不是 junction
#                                （NSIS 装不了 junction），放 exe + dll + 改向 _pth 引用 ..\Scripts。
$venv = Join-Path $App ".venv"
$vs = Join-Path $venv "Scripts"
Step "嵌入式 Python $PyVer -> app\.venv\Scripts"
if (-not (Test-Path "$vs\python.exe")) {
  $zip = Get-Cached "python-$PyVer-embed-amd64.zip" @(
    "https://registry.npmmirror.com/-/binary/python/$PyVer/python-$PyVer-embed-amd64.zip",
    "https://www.python.org/ftp/python/$PyVer/python-$PyVer-embed-amd64.zip")
  New-Item -ItemType Directory -Force $vs | Out-Null
  Expand-Archive $zip $vs -Force
}
# _pth：打开 site + 挂上 site-packages（嵌入式默认锁死 sys.path，不改这行 pip 装了也 import 不到）
@"
python$PyVerNoDot.zip
.
Lib\site-packages
import site
"@ | Out-File "$vs\python$PyVerNoDot._pth" -Encoding ascii
# python3.exe：ppt-master 等技能里大量裸 `python3` 调用（launcher 会把 Scripts 挂进 PATH）
Copy-Item "$vs\python.exe" "$vs\python3.exe" -Force
# VC 运行库 app-local：目标机可能没装 VC++ redist，numpy/scipy import 会缺 msvcp140.dll
foreach ($d in "msvcp140.dll", "msvcp140_1.dll", "vcomp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll") {
  if (Test-Path "C:\Windows\System32\$d") { Copy-Item "C:\Windows\System32\$d" $vs -Force }
}

if (-not $SkipPip) {
  Step "pip + 科研依赖（deploy\requirements.txt，钉版与容器一致）"
  if (-not (Test-Path "$vs\Lib\site-packages\pip")) {
    $gp = Get-Cached "get-pip.py" @("https://bootstrap.pypa.io/get-pip.py")
    & "$vs\python.exe" $gp --no-warn-script-location -i https://pypi.tuna.tsinghua.edu.cn/simple
    if ($LASTEXITCODE -ne 0) { & "$vs\python.exe" $gp --no-warn-script-location }
    if ($LASTEXITCODE -ne 0) { throw "get-pip 失败" }
  }
  # 新版 get-pip 不再捎带 setuptools/wheel，而 requirements 里有 sdist 包（无 3.12 wheel 的老包）
  # 构建时要 setuptools.build_meta —— 缺了 pip 直接 BackendUnavailable
  & "$vs\python.exe" -m pip install --no-warn-script-location setuptools wheel -i https://pypi.tuna.tsinghua.edu.cn/simple
  if ($LASTEXITCODE -ne 0) { & "$vs\python.exe" -m pip install --no-warn-script-location setuptools wheel }
  if ($LASTEXITCODE -ne 0) { throw "setuptools/wheel 安装失败" }
  & "$vs\python.exe" -m pip install --no-cache-dir --no-warn-script-location -r "$Root\deploy\requirements.txt" -i https://pypi.tuna.tsinghua.edu.cn/simple
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "tuna 源失败，换官方 PyPI 重试"
    & "$vs\python.exe" -m pip install --no-cache-dir --no-warn-script-location -r "$Root\deploy\requirements.txt"
    if ($LASTEXITCODE -ne 0) { throw "pip install 失败" }
  }
}
# 自检与容器构建期同款：装歪了现在炸，别留到客户机上才发现
& "$vs\python.exe" -c "import pandas, numpy, scipy, matplotlib, mammoth; print('  .venv 自检通过: pandas', pandas.__version__, '| matplotlib', matplotlib.__version__)"
if ($LASTEXITCODE -ne 0) { throw ".venv 自检失败" }

# ---- .venv\bin：技能写死路径的落点 ----
Step ".venv\bin（技能的 .venv/bin/python 落点）"
$vb = Join-Path $venv "bin"
New-Item -ItemType Directory -Force $vb | Out-Null
foreach ($f in "python.exe", "python3.exe", "python$PyVerNoDot.dll", "python3.dll",
               "vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll") {
  if (Test-Path "$vs\$f") { Copy-Item "$vs\$f" $vb -Force }
}
# bin 侧 _pth 全部改向 ..\Scripts（_pth 里的相对路径以 _pth 文件所在目录为基准）
@"
..\Scripts\python$PyVerNoDot.zip
..\Scripts
..\Scripts\Lib\site-packages
import site
"@ | Out-File "$vb\python$PyVerNoDot._pth" -Encoding ascii
& "$vb\python.exe" -c "import pandas; print('  .venv\bin 自检通过')"
if ($LASTEXITCODE -ne 0) { throw ".venv\bin 自检失败" }

# ================= 6. 应用本体 =================
Step "应用本体：web 网关 + 技能 + AGENTS.md"
# web：排除运行时状态与密钥（model-config.json 含开发机的 key，绝不能进包）
# 排除三类：运行时状态与密钥、开发用启动器、自动化测试。
# 测试目录里有 "sk-mine" 这种假 key，混进包既是无谓体积，也会让密钥扫描工具误报。
Copy-Tree "$Root\web" "$App\web" `
  -ExcludeFiles @("model-config.json", "cloud-state.json", "sessions-meta.json", "dev-test.mjs", "dev-gateway.mjs") `
  -ExcludeDirs  @("test")
# .opencode：技能 + opencode 插件依赖
Copy-Tree "$Root\.opencode" "$App\.opencode"
Copy-Item "$Root\AGENTS.md" $App -Force
# opencode.json 干净基线（server.mjs 启动时会自己补 question:false 等；不带任何 key）
@"
{
  "`$schema": "https://opencode.ai/config.json",
  "tools": { "question": false },
  "permission": { "external_directory": "allow" }
}
"@ | Out-File "$App\opencode.json" -Encoding utf8
New-Item -ItemType Directory -Force "$App\outputs", "$App\uploads" | Out-Null

# matplotlibrc（Windows 字体版；机制同 deploy\matplotlibrc，见彼处长注释——
# font.family 多族列表才有逐字形回退；Windows 自带 Arial/微软雅黑，无需装字体）
@"
font.family: Arial, Microsoft YaHei, SimSun, DejaVu Sans
font.sans-serif: Microsoft YaHei, SimHei, SimSun, DejaVu Sans
axes.unicode_minus: False
figure.dpi: 150
savefig.dpi: 300
savefig.bbox: tight
"@ | Out-File "$App\matplotlibrc" -Encoding ascii

# 云端接入模板：只需填【站点地址】，不再往包里塞任何 key。
# 用户在应用里输入 account 用管理员发的账号登录，key 由网关代持并自动续期。
@"
{
  "//": "复制本文件为 cloud.json 并把 gatewayUrl 改成你们的站点地址；应用启动后在对话框输入 account 登录",
  "//key": "这里【不要】再填 apiKey —— 登录后由本机网关代持 access key 并自动续期，静态 key 会在一天后失效",
  "gatewayUrl": "https://你的站点域名"
}
"@ | Write-Utf8NoBom "$App\cloud.json.example"

# 预置站点地址：打包时给 SCI_CLOUD_URL 就直接写好 cloud.json，客户装完开箱即到登录页。
# 只写地址不写 key，所以这个文件可以随包发给任何人。
if ($env:SCI_CLOUD_URL) {
  @"
{
  "gatewayUrl": "$($env:SCI_CLOUD_URL)"
}
"@ | Write-Utf8NoBom "$App\cloud.json"
  Write-Host "  已预置 cloud.json → $($env:SCI_CLOUD_URL)" -ForegroundColor Green
}

# 诊断脚本随包走：客户机上出问题时，用包内 bash 跑它即可定位（bash bundle\smoke.sh）
Copy-Item "$PSScriptRoot\smoke.sh" $Staging -Force

# ★ 运行时状态清理闸：staging 目录一旦被直接跑过（开发机冒烟测试），网关会把
#   model-config.json(含 key!)、会话产物、日志写回来；Copy-Tree 的排除只是"不覆盖"，
#   不会删掉这些脏文件——不清理它们就会原样进安装器发给客户（实测踩过：15:45 那版
#   安装器带上了开发机的 DeepSeek key）。故每次打包收尾都强制清一遍。
Step "清理运行时状态（防冒烟残留进包）"
$dirty = @("$App\web\model-config.json", "$App\web\sessions-meta.json",
           # cloud-state.json 是开发机登录云端账号后留下的 refresh token（等价于口令），
           # 混进安装器 = 把你的账号发给客户。
           "$App\web\cloud-state.json",
           "$App\serve.out", "$App\serve.err", "$App\server.log")
foreach ($f in $dirty) { if (Test-Path $f) { Remove-Item $f -Force; Write-Host "  删除 $f" -ForegroundColor Yellow } }
foreach ($d in @("$App\outputs", "$App\uploads")) {
  if (Test-Path $d) { Get-ChildItem $d -Force | Remove-Item -Recurse -Force -Confirm:$false }
}
# 收尾自检：整个 staging 里绝不能再有任何 apiKey 字样的 json（opencode.json 由上面写的干净基线覆盖）
$leak = Get-ChildItem $App -Recurse -Include "model-config.json","cloud-state.json" -ErrorAction SilentlyContinue
if ($leak) { throw "打包中止：仍存在 model-config.json —— $($leak.FullName -join '; ')" }

# ================= 7. 汇总自检 =================
Step "汇总自检"
& "$nodeDir\node.exe" --version | ForEach-Object { Write-Host "  node $_" }
& "$gitDir\bin\bash.exe" --version | Select-Object -First 1 | ForEach-Object { Write-Host "  $_" }
& "$pdDir\pandoc.exe" --version | Select-Object -First 1 | ForEach-Object { Write-Host "  $_" }
Write-Host "  opencode $ocv"
$sz = "{0:N0} MB" -f ((Get-ChildItem $Staging -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "打包完成：$Staging（$sz）" -ForegroundColor Green
