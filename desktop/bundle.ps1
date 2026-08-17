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
  # ★ 排除项要在目标里【补删】一遍：staging 是累积的（不加 -Clean 就直接复用上一版），
  #   robocopy 的 /XF /XU只是"这次不拷"，上一版拷进去的那份原地不动。所以往排除名单里
  #   新加一条，或从仓库删掉一个文件，包里都还留着旧的 —— 实测 0.1.20：598f66f2 刚把
  #   dev-lan.mjs / dev-skillmods.mjs 加进排除名单，重跑一次组装它俩照样躺在包里。
  #   这类残留从外表完全看不出来（体积、自检、版本号都正常）。
  foreach ($f in $ExcludeFiles) { Get-ChildItem -Path $Dst -Filter $f -Recurse -File -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }
  foreach ($d in $ExcludeDirs)  { Get-ChildItem -Path $Dst -Filter $d -Recurse -Directory -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
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
# ---- 裁掉 PortableGit 里本应用用不到的部分 ----
# 由来：有用户报「抽取:无法写入文件 …\runtime\git\usr\bin\msys-svn_diff-1-0.dll」。
# 那批 msys-svn_*.dll 是 `git svn` 用的，本应用从不碰 SVN —— 不该随包发。
# 顺带清掉图形界面(git-gui/gitk/Tcl-Tk)、文档/man/info、翻译：省 ~27MB，
# 也少给杀软留误报面（msys 系 DLL 是常见误报对象）。
# ⚠ 只能删这些：bash / 核心工具 / git 本体必须留着 —— 技能的 .sh 与 opencode 的会话快照全靠它们。
#   改这份清单后务必用包内 bash 跑一遍 smoke.sh，末行要是 ALL GREEN。
Step "裁剪 PortableGit（去 svn/GUI/文档，省体积也少踩杀软）"
$trim = @(
  "$gitDir\usr\bin\msys-svn*", "$gitDir\mingw64\libexec\git-core\git-svn*",
  "$gitDir\mingw64\share\perl5\Git\SVN*",
  "$gitDir\mingw64\libexec\git-core\git-gui*", "$gitDir\mingw64\libexec\git-core\git-citool*",
  "$gitDir\mingw64\share\git-gui", "$gitDir\mingw64\share\gitk",
  "$gitDir\mingw64\lib\tcl*", "$gitDir\mingw64\lib\tk*",
  "$gitDir\usr\bin\wish*", "$gitDir\mingw64\bin\wish*",
  "$gitDir\mingw64\share\doc", "$gitDir\usr\share\doc",
  "$gitDir\mingw64\share\man", "$gitDir\usr\share\man",
  "$gitDir\usr\share\info", "$gitDir\mingw64\share\info",
  "$gitDir\usr\share\locale", "$gitDir\mingw64\share\locale"
)
foreach ($t in $trim) { Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue }
if (-not (Test-Path "$gitDir\bin\bash.exe")) { throw "裁剪把 bash 删没了 —— 清单写错了" }

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
"python$PyVerNoDot.zip`r`n.`r`nLib\site-packages`r`nimport site`r`n" | Out-File "$vs\python$PyVerNoDot._pth" -Encoding ascii
# python3.exe：ppt-master 等技能里大量裸 `python3` 调用（launcher 会把 Scripts 挂进 PATH）
Copy-Item "$vs\python.exe" "$vs\python3.exe" -Force
# VC 运行库 app-local：目标机可能没装 VC++ redist，numpy/scipy import 会缺 msvcp140.dll
foreach ($d in "msvcp140.dll", "msvcp140_1.dll", "vcomp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll") {
  if (Test-Path "C:\Windows\System32\$d") { Copy-Item "C:\Windows\System32\$d" $vs -Force }
}

if (-not $SkipPip) {
  Step "pip + 科研依赖（packaging\requirements.txt，钉版）"
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
  & "$vs\python.exe" -m pip install --no-cache-dir --no-warn-script-location -r "$Root\packaging\requirements.txt" -i https://pypi.tuna.tsinghua.edu.cn/simple
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "tuna 源失败，换官方 PyPI 重试"
    & "$vs\python.exe" -m pip install --no-cache-dir --no-warn-script-location -r "$Root\packaging\requirements.txt"
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
"..\Scripts\python$PyVerNoDot.zip`r`n..\Scripts`r`n..\Scripts\Lib\site-packages`r`nimport site`r`n" | Out-File "$vb\python$PyVerNoDot._pth" -Encoding ascii
& "$vb\python.exe" -c "import pandas; print('  .venv\bin 自检通过')"
if ($LASTEXITCODE -ne 0) { throw ".venv\bin 自检失败" }

# ================= 6. 应用本体 =================
Step "应用本体：web 网关 + 技能 + AGENTS.md"
# web：排除运行时状态与密钥（model-config.json 含开发机的 key，绝不能进包）
# 排除三类：运行时状态与密钥、开发用启动器、自动化测试。
# 测试目录里有 "sk-mine" 这种假 key，混进包既是无谓体积，也会让密钥扫描工具误报。
Copy-Tree "$Root\web" "$App\web" `
  -ExcludeFiles @("model-config.json", "cloud-state.json", "sessions-meta.json", "headless-env.json",
                  "dev-test.mjs", "dev-gateway.mjs", "dev-lan.mjs", "dev-skillmods.mjs", "dev-folders.mjs") `
  -ExcludeDirs  @("test", "Microsoft")
# ↑ dev-*.mjs 一个都别漏：这几个都是开发用启动器，有的会自带假 opencode / 固定口令，
#   进了客户包既是无谓体积，也多一份没人维护的入口。原来只排了前两个，后加的三个
#   （lan / skillmods / folders）一直跟着进包 —— 按上面那句注释的本意，它们本就该在这。
#   加进名单还不够：staging 是累积的，上一版拷进去的那两份得靠 Copy-Tree 里的补删清掉。
# ↑ Microsoft/：PowerShell 在 HOME/LOCALAPPDATA 被改向时会往当前目录拉一棵
#   Microsoft\Windows\PowerShell\ModuleAnalysisCache 出来。开发机上是垃圾，跟着进包更没意义。
# .opencode：技能 + opencode 插件依赖
# 排除 __pycache__：开发机跑过技能脚本就会生成，进包纯属无谓体积（本次实测 18 个目录）
Copy-Tree "$Root\.opencode" "$App\.opencode" -ExcludeDirs @("__pycache__")
Copy-Item "$Root\AGENTS.md" $App -Force

# ---- 自动化加密防护（全量扫描新旧技能 + AGENTS.md + .py/.sh 工具脚本）----
Step "安全防护：全自动加密（AGENTS.md + 所有技能 + .py/.sh 脚本）"
$nodeExe = Join-Path $Rt "node\node.exe"
if (-not (Test-Path $nodeExe)) { $nodeExe = "node" }
$appPy = Join-Path $App ".venv\Scripts\python.exe"
if (-not (Test-Path $appPy)) { $appPy = "python" }
$stagingSkills = Join-Path $App ".opencode\skills"
$stagingEnc = Join-Path $App ".opencode\skills.enc"
$stagingAgents = Join-Path $App "AGENTS.md"
& $nodeExe "$App\web\skill-security.mjs" encrypt "$stagingSkills" "$stagingEnc" "$stagingAgents" "$appPy"
if ($LASTEXITCODE -ne 0) { throw "自动化技能与脚本加密失败，退出代码: $LASTEXITCODE" }

# 更新说明：左下角那个「更新说明」按钮读的就是这些（见 server.mjs 的 /api/release-notes）。
# 随包走而不是找云端要 —— 断网也看得到，也不会出现"装的是老版本、读到的却是新版说明"。
# 只拿 desktop\发布说明-*.md，别把 desktop\ 下的需求文档、验收清单一起塞进客户包。
New-Item -ItemType Directory -Force "$App\release-notes" | Out-Null
Get-ChildItem "$PSScriptRoot\发布说明-*.md" -File | Copy-Item -Destination "$App\release-notes" -Force
Write-Host ("  更新说明 {0} 份" -f @(Get-ChildItem "$App\release-notes\*.md" -File).Count) -ForegroundColor Green

# ---- opencode 插件运行时（预置，别让用户的第一条消息去下 52MB）----
#
# 网关把 opencode 的配置目录圈在 app\.ocglobal（XDG_CONFIG_HOME，见 server.mjs 那段长注释）：
# 技能只对本应用可见、不污染用户自己的 opencode、卸载即消失。代价是那个目录是全新的，而
# opencode 会在【第一轮会话】时往配置目录里装一套插件运行时 —— 实测 52.4 MB / 3667 个文件，
# 恰好卡在"用户点了发送、等第一个回复"那一刻。所以随包发出去。
#
# 【怎么拿到这份运行时】没有 npm 可用（包里只有 node.exe），而它的触发条件是"跑一轮会话"。
# 所以这里就照它的脾气来：起一个临时 opencode，配一个【打不通的 provider】发一轮，
# 它会先把插件运行时装好、再去连那个不存在的地址失败 —— 我们要的正是前半段。
# 产物按 opencode 版本缓存，重跑不重下。
Step "opencode 插件运行时（预置，省掉用户第一条消息时的 52MB 下载）"
$seedCache = Join-Path $Cache "ocplugin-$OcVer"
if (-not (Test-Path "$seedCache\opencode\node_modules")) {
  $tmpCfgHome = Join-Path $Cache "ocplugin-tmp"
  if (Test-Path $tmpCfgHome) { Remove-Item -LiteralPath $tmpCfgHome -Recurse -Force }
  New-Item -ItemType Directory -Force "$tmpCfgHome\opencode" | Out-Null
  $deadCfg = Join-Path $tmpCfgHome "seed-opencode.json"
  @"
{
  "`$schema": "https://opencode.ai/config.json",
  "provider": {
    "custom": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "seed-only",
      "options": { "baseURL": "http://127.0.0.1:9/none", "apiKey": "seed-only" },
      "models": { "seed": { "name": "seed" } }
    }
  }
}
"@ | Write-Utf8NoBom $deadCfg
  $prevXdg = $env:XDG_CONFIG_HOME; $prevCfg = $env:OPENCODE_CONFIG
  $env:XDG_CONFIG_HOME = $tmpCfgHome; $env:OPENCODE_CONFIG = $deadCfg
  $seedPort = 4177
  $proc = Start-Process "$ocDir\opencode.exe" -ArgumentList "serve","--port","$seedPort" -PassThru -WindowStyle Hidden
  try {
    # 等它起来
    $ready = $false
    foreach ($i in 1..120) { try { Invoke-WebRequest "http://127.0.0.1:$seedPort/config" -UseBasicParsing -TimeoutSec 3 | Out-Null; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 } }
    if (-not $ready) { throw "临时 opencode 没起来" }
    $dirQ = [uri]::EscapeDataString(($tmpCfgHome -replace '\\','/'))
    $ses = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$seedPort/session?directory=$dirQ" -ContentType "application/json" -Body '{"title":"seed"}'
    $body = '{"model":{"providerID":"custom","modelID":"seed"},"parts":[{"type":"text","text":"seed"}]}'
    try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$seedPort/session/$($ses.id)/message" -ContentType "application/json" -Body $body -TimeoutSec 90 | Out-Null } catch { }  # 连不上那个地址是预期的
    # 装好没有：等 node_modules 落地
    foreach ($i in 1..60) { if (Test-Path "$tmpCfgHome\opencode\node_modules") { break }; Start-Sleep -Milliseconds 500 }
  } finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $env:XDG_CONFIG_HOME = $prevXdg; $env:OPENCODE_CONFIG = $prevCfg
  }
  if (Test-Path "$tmpCfgHome\opencode\node_modules") {
    New-Item -ItemType Directory -Force "$seedCache\opencode" | Out-Null
    Copy-Tree "$tmpCfgHome\opencode\node_modules" "$seedCache\opencode\node_modules"
    foreach ($f in @("package.json","package-lock.json")) { if (Test-Path "$tmpCfgHome\opencode\$f") { Copy-Item "$tmpCfgHome\opencode\$f" "$seedCache\opencode\" -Force } }
  }
  Remove-Item -LiteralPath $tmpCfgHome -Recurse -Force -ErrorAction SilentlyContinue
}
# ★ 拿不到就【继续打包】，只响亮告警：缺了它不影响功能，只是用户第一条消息要等一次下载。
#   为这个中断整次打包不值当（它依赖网络 + opencode 的内部行为，是最容易出意外的一步）。
if (Test-Path "$seedCache\opencode\node_modules") {
  New-Item -ItemType Directory -Force "$App\.ocglobal\opencode" | Out-Null
  Copy-Tree "$seedCache\opencode" "$App\.ocglobal\opencode"
  $n = @(Get-ChildItem "$App\.ocglobal\opencode\node_modules" -Directory).Count
  Write-Host "  已预置插件运行时：$n 个顶层包" -ForegroundColor Green
} else {
  Write-Warning "  没能预置 opencode 插件运行时 —— 包仍可用，但用户【第一条消息】会先等一次 ~52MB 下载。"
}
# opencode.json 干净基线（server.mjs 启动时会自己补 question:false 等；不带任何 key）
@"
{
  "`$schema": "https://opencode.ai/config.json",
  "tools": { "question": false },
  "permission": { "external_directory": "allow" }
}
"@ | Write-Utf8NoBom "$App\opencode.json"
New-Item -ItemType Directory -Force "$App\outputs", "$App\uploads" | Out-Null

# matplotlibrc（Windows 字体版；机制同 packaging\matplotlibrc，见彼处长注释——
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
  "gatewayUrl": "https://niuma.tellgen.com"
}
"@ | Write-Utf8NoBom "$App\cloud.json.example"

# 预置站点地址：cloud.json 【每次打包都写】，客户装完开箱即到登录页、默认走云端。
# 只写地址不写 key，所以这个文件可以随包发给任何人。
#
# 【为什么不再是"给了 SCI_CLOUD_URL 才写"】不写就等于发了一个"没接入任何平台"的包：
# 客户装完既没有登录窗、也没有模型，界面只能引导他去填自己的 API key —— 这正是要消除的
# 首启体验。默认站点写死在下面这个常量里，要打给别家就临时设 SCI_CLOUD_URL 覆盖。
$CloudUrl = if ($env:SCI_CLOUD_URL) { $env:SCI_CLOUD_URL } else { "https://niuma.tellgen.com" }
@"
{
  "gatewayUrl": "$CloudUrl"
}
"@ | Write-Utf8NoBom "$App\cloud.json"
Write-Host "  已预置 cloud.json → $CloudUrl" -ForegroundColor Green

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
           # headless-env.json 是壳每次启动写的环境快照，里面【原样带着 OC_GATEWAY_KEY】——
           # 开发机跑过一次就会生成，混进安装器等于把 key 发给客户（与 model-config.json 同类）。
           # 客户机上它由壳首次启动时自己生成，包里不需要也不能有。
           "$App\web\headless-env.json",
           "$App\headless-gateway.log",
           "$App\serve.out", "$App\serve.err", "$App\server.log")
foreach ($f in $dirty) { if (Test-Path $f) { Remove-Item $f -Force; Write-Host "  删除 $f" -ForegroundColor Yellow } }
foreach ($d in @("$App\outputs", "$App\uploads", "$App\tasks")) {
  if (Test-Path $d) { Get-ChildItem $d -Force | Remove-Item -Recurse -Force -Confirm:$false }
}
# 技能包 / 界面包的本机换版记录：打进安装器会让新装的客户端一上来就"已经装过某个在线版本"，
# 于是回退链的最后一环（factory = 出厂版）指向的其实是开发机某次更新后的状态。必须清干净。
foreach ($d in @("$App\skill-packs", "$App\web-packs")) {
  if (Test-Path $d) { Remove-Item $d -Recurse -Force -Confirm:$false; Write-Host "  删除 $d" -ForegroundColor Yellow }
}
# ★ 出厂时间戳：清干净之后，只写回一条"这个安装包是什么时候打的"。
#   出厂版没有版本号（current 空串），客户端判"服务器上的包是不是真比我新"只能靠它——
#   不写的话，刚打的安装包（技能是今天的仓库快照）遇到服务器上更早发布的包也会弹
#   "有新版技能"，点下去把技能换旧。判定逻辑见 web/pack-freshness.mjs。
$factoryAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
foreach ($d in @("$App\skill-packs", "$App\web-packs")) {
  New-Item -ItemType Directory -Force $d | Out-Null
  @"
{
  "current": "",
  "history": [],
  "factoryAt": $factoryAt
}
"@ | Write-Utf8NoBom "$d\installed.json"
}
Write-Host "  写入出厂时间戳 factoryAt=$factoryAt（$([DateTimeOffset]::FromUnixTimeMilliseconds($factoryAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm')))" -ForegroundColor Green
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
