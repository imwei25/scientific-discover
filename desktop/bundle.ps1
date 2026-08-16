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
$CcVer     = "1.4.1"    # cc-connect（聊天接入桥）：换版本必跑 web/test/chat-bridge.test.mjs + 真机冒烟（cmd 空格拆分/事件 schema 都可能变）

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

# ================= 2.5 cc-connect（聊天接入桥：企微/微信 ←→ 本机 agent）=================
# 预置二进制：npm 包首跑要现场从 GitHub 拉 exe，国内用户十有八九 ECONNRESET —— 必须随包发。
Step "cc-connect $CcVer"
$ccDir = Join-Path $Rt "cc-connect"
# ---- 【临时】自建修复版优先 --------------------------------------------------
# 官方 v1.4.1 有个竞态：上一轮 opencode 进程打完 step_finish 后还要拖几百毫秒才退出，它的
# readLoop 在 EOF 触发兜底 sendEventResult()，而去重标志 resultSent 已被下一次 Send() 重置 →
# 这个【过期的完成事件】把刚出队的新一轮提前判成"完成"，用户收到「(空响应)」、真实回复丢失。
# 只有"出队的第一条"会踩。修法是给每次 Send() 加 turnGen 代次守卫，丢弃过期 readLoop 的终结事件。
# 2026-08-15 本机实测：修复版下 bridge.log 会打印 "suppressing stale EventResult"（说明过期事件
# 真的来了、被拦住了），排队那轮拿到 response_len=114 的正常回复，不再是 11（= "(空响应)" 的字节数）。
#
# 【这是临时措施，上游合并发版后就删掉这一段、把 $CcVer 抬到官方新版】自建产物不在 git 里
# （desktop/dist/ 被忽略），所以换台机器打包会走下面的官方下载分支——那样打出来的包【不含修复】。
$ccFix = Join-Path $Root "desktop\dist\vendor\cc-connect-v1.4.1-fix.3-windows-amd64.exe"
$ccFixVer = "1.4.1-fix.3"
if (Test-Path $ccFix) {
  New-Item -ItemType Directory -Force $ccDir | Out-Null
  Copy-Item $ccFix "$ccDir\cc-connect.exe" -Force
  $CcVer = $ccFixVer
  Write-Host "  ⚠ 用的是自建修复版 $ccFixVer（空响应竞态修复 + 排队合并 + 发送配额放宽），不是官方 release" -ForegroundColor Yellow
} else {
  Write-Host "  ⚠ 没找到自建修复版（$ccFix）——将回退官方 $CcVer，打出的包【不含】排队空响应修复" -ForegroundColor Yellow
}
if (-not (Test-Path "$ccDir\cc-connect.exe")) {
  New-Item -ItemType Directory -Force $ccDir | Out-Null
  $zip = Get-Cached "cc-connect-v$CcVer-windows-amd64.zip" @(
    "https://gitee.com/cg33/cc-connect/releases/download/v$CcVer/cc-connect-v$CcVer-windows-amd64.zip",
    "https://github.com/chenhg5/cc-connect/releases/download/v$CcVer/cc-connect-v$CcVer-windows-amd64.zip")
  $tmp = Join-Path $Cache "cc-tmp"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $exe = Get-ChildItem $tmp -Recurse -Filter "cc-connect*.exe" | Select-Object -First 1
  if (-not $exe) { throw "cc-connect 压缩包里没找到 exe" }
  Copy-Item $exe.FullName "$ccDir\cc-connect.exe"
}
$ccv = & "$ccDir\cc-connect.exe" --version 2>&1
if ("$ccv" -notmatch [regex]::Escape($CcVer)) { throw "cc-connect.exe 版本不对：$ccv（要 $CcVer）" }

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
  -ExcludeFiles @("model-config.json", "cloud-state.json", "sessions-meta.json", "headless-env.json",
                  "desktop-settings.json",
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
# 排除 ai-image-comparison：ppt-master 的 AI 配图风格对照图库（~30 MB PNG），
#   唯一消费方是 scripts/confirm_ui/server.py 的 /api/ai-image-comparison 网页画廊。
#   本包刻意不装 flask（见 packaging/requirements.txt 第 52-68 行的实测结论），确认页起不来，
#   这些图在包里永远没人看。模型侧也用不到 —— SKILL.md 明令禁止直接读图片文件。
#   ⚠️ 将来若把 flask 加回 requirements 启用确认页，必须同时把这一项从排除清单里去掉，
#      否则画廊会静默空白（只有本地仓库跑得出图，安装包跑不出）。
Copy-Tree "$Root\.opencode" "$App\.opencode" -ExcludeDirs @("__pycache__", "ai-image-comparison")
Copy-Item "$Root\AGENTS.md" $App -Force

# ---- env-setup 不进包 ----
# 打包版的 .venv 是本脚本第 5 节亲手装好并自检过的，不可能缺。留着这个技能只有坏处：
# 安装目录 %LOCALAPPDATA%\Niuma Science\... 带空格，命令漏了引号就报
# 「.../Local/Niuma: No such file or directory」，agent 会把它读成"没有 .venv"→ 调 env-setup
# → 重建虚拟环境、重装 requirements，真机上白烧十几分钟还可能把包版本弄坏。
# 根因已在三处修掉（launcher 的 space_free / 技能正文加引号 / 网关前言），这里再断掉最后一条退路。
# 仓库里保留该技能：自建部署、换机器、开发机初始化仍要用它（走 install.ps1 也行）。
# AGENTS.md 与各技能正文里已经没有任何指向 env-setup 的指引（改成"报错先查引号 + install.ps1"），
# 所以这里只需删目录，不用再后处理文案。
$envSetup = "$App\.opencode\skills\env-setup"
if (Test-Path $envSetup) { Remove-Item $envSetup -Recurse -Force }
if (Select-String -Path "$App\AGENTS.md" -Pattern 'env-setup' -Quiet) {
  throw "AGENTS.md 还提到 env-setup——包里会留下一条指向不存在技能的指引，先改仓库根的 AGENTS.md"
}
Step "env-setup 已剔除（打包版环境随包装好，见上方注释）"

# ---- 技能金库：把技能封成加密的 skills.pak，删掉明文技能，安装器里不再含可读技能 ----
# 【为什么在这里】web\ 与 .opencode\ 都已拷进 staging，此刻 $App\web\skill-vault.mjs（客户端运行时
#   用的同一份加解密逻辑与密钥）与 $App\.opencode\skills\ 都在位，直接用包内 node 就地封存。
# 【只封真 IP】ppt-master 那 ~59MB vendored 第三方库是明文保留的（PLAINTEXT_SKILLS）——它不是本方
#   IP，且体量大到加密会把客户端启动拖到 40 秒以上（实测）。归档在客户机首次在线更新时才产生，
#   由 server.mjs 换版后即时封成 archive.pak，安装器里本来就没有归档。
# 【staging 是累积的】重跑打包时 Copy-Tree 会把明文技能重新铺回来，本步每次重新封 + 删，幂等。
# 客户端行为：server.mjs 启动时见到 skills.pak 就解密还原到原路径、退出时擦除（见 skill-vault.mjs 头注）。
Step "技能金库：封存 skills.pak（安装器不含明文技能）"
& "$nodeDir\node.exe" "$Root\packaging\seal-skills.mjs" "$App\web\skill-vault.mjs" "$App\.opencode\skills"
if ($LASTEXITCODE -ne 0) { throw "技能封存失败（seal-skills.mjs rc=$LASTEXITCODE）——不能发一个明文技能没删干净、或 pak 损坏的包" }
if (-not (Test-Path "$App\.opencode\skills.pak")) { throw "技能封存后没有生成 skills.pak" }
# 硬自检：封存后 skills\ 下【绝不能】再有除 PLAINTEXT_SKILLS 之外的 SKILL.md（那就是没删干净的明文技能）
$leakSkill = Get-ChildItem "$App\.opencode\skills" -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne "ppt-master" } |
  Where-Object { Test-Path (Join-Path $_.FullName "SKILL.md") }
if ($leakSkill) { throw "打包中止：封存后仍有明文技能 —— $($leakSkill.Name -join '、')" }
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
# 聊天接入的运行期状态：state.json 存企微 bot_id/bot_secret（开发机联调过一次就有），
# config.toml 是含 secret 的生成物，其余是日志。整目录都是运行期产物，包里不该有——
# 混进安装器等于把开发机的测试机器人发给客户（与 cloud-state.json 同类）。
if (Test-Path "$App\chat-bridge") { Remove-Item "$App\chat-bridge" -Recurse -Force -Confirm:$false; Write-Host "  删除 $App\chat-bridge" -ForegroundColor Yellow }
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
# chat-bridge\ 按目录查而不是按文件名查：它的文件叫 state.json / config.toml，名字太通用，
# 全树按名扫会误伤 .venv 里第三方包自带的同名文件。
if (Test-Path "$App\chat-bridge") { throw "打包中止：仍存在 chat-bridge\（含企微 bot 凭证）—— $App\chat-bridge" }

# ================= 6.9 随包清单（升级时据此清掉上一版残留）=================
#
# 【为什么要有】NSIS 把新文件**覆盖**到旧目录树上，只管自己登记过的文件 —— 上一版装过、
# 这一版不再随包的东西会永远留在磁盘上。实测 0.1.29 → 0.1.30：对照图库从包里移除后，
# 用户机器上那 43.2 MB 原样留着，安装器瘦了 33.5 MB 而老用户一个字节没省回来。
# 装完后由 cleanup-stale.ps1 按这份清单把「包拥有的目录里、不在清单上的」文件删掉。
# 用清单而不是在 installer-hooks.nsh 里逐个点名：那种清单天生会漏（那文件自己的注释里
# 记着 0.1.4 漏 web-packs、0.1.5/0.1.6 漏 workspace.html 的账），以后增删随包内容也不用改它。
#
# ★ 必须放在这里：所有内容都已就位（技能已封存、运行时状态已清、出厂时间戳已写），
#   再往后就只剩自检了。提前生成会漏掉后面才写的文件，而漏掉 = 装完被当成残留删掉。
Step "随包清单 manifest.txt"
Copy-Item "$PSScriptRoot\cleanup-stale.ps1" "$Staging\cleanup-stale.ps1" -Force
$manifestLines = Get-ChildItem $Staging -Recurse -File -Force |
  ForEach-Object { $_.FullName.Substring($Staging.Length).TrimStart([char]92) }
($manifestLines -join "`n") | Write-Utf8NoBom "$Staging\manifest.txt"
Write-Host "  清单已写入：$($manifestLines.Count) 个文件" -ForegroundColor Green
# 防呆：清单条目数远低于常态说明枚举出了问题，此时发包会让客户端把刚装好的程序当残留删掉。
if ($manifestLines.Count -lt 2000) { throw "打包中止：清单只有 $($manifestLines.Count) 条，明显不完整（cleanup-stale.ps1 的安全下限也是 2000）" }

# ================= 7. 汇总自检 =================
Step "汇总自检"
& "$nodeDir\node.exe" --version | ForEach-Object { Write-Host "  node $_" }
& "$gitDir\bin\bash.exe" --version | Select-Object -First 1 | ForEach-Object { Write-Host "  $_" }
& "$pdDir\pandoc.exe" --version | Select-Object -First 1 | ForEach-Object { Write-Host "  $_" }
Write-Host "  opencode $ocv"
$sz = "{0:N0} MB" -f ((Get-ChildItem $Staging -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "打包完成：$Staging（$sz）" -ForegroundColor Green
