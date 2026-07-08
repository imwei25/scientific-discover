<#
  一键安装：科研医学 Skill 套件（Windows 本地）
  - Python 统一走项目根虚拟环境 .venv（跨机器/跨框架可搬）
  - 装齐所有技能所需的包，冒烟测试，再校验所有 SKILL.md
  用法（在仓库根目录）：  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $Root ".venv"
$Py = Join-Path $Venv "Scripts\python.exe"
$Req = Join-Path $Root "scripts\requirements-skills.txt"

Write-Host "== 科研 Skill 套件 一键安装（Windows）==" -ForegroundColor Cyan
Write-Host "仓库根目录: $Root"

# 1) 确保虚拟环境存在
if (-not (Test-Path $Py)) {
    Write-Host "未发现 .venv，正在创建 ..." -ForegroundColor Yellow
    $sysPy = (Get-Command py -ErrorAction SilentlyContinue)
    if ($sysPy) { & py -3 -m venv $Venv } else { & python -m venv $Venv }
    if (-not (Test-Path $Py)) { throw "创建虚拟环境失败：请先装 Python 3.10+ 并加入 PATH" }
} else {
    Write-Host "复用已存在的虚拟环境: $Venv" -ForegroundColor Green
}
& $Py --version

# 2) 升级 pip 并安装依赖
Write-Host "`n升级 pip ..." -ForegroundColor Cyan
& $Py -m pip install --upgrade pip -q
Write-Host "安装依赖（首次约 3-8 分钟）..." -ForegroundColor Cyan
& $Py -m pip install -r $Req
if (-not $?) { throw "pip 安装失败" }

# 2b) 文档排版工具链：pandoc + xelatex（render-pdf-doc 技能需要）
Write-Host "`n检查/安装 pandoc + LaTeX(xelatex) ..." -ForegroundColor Cyan
$haveWinget = Get-Command winget -ErrorAction SilentlyContinue
if (-not (Get-Command pandoc -ErrorAction SilentlyContinue)) {
    if ($haveWinget) { winget install --id JohnMacFarlane.Pandoc --scope user --silent --accept-source-agreements --accept-package-agreements }
    else { Write-Host "  ! 无 winget，请手动装 pandoc: https://pandoc.org/installing.html" -ForegroundColor Yellow }
} else { Write-Host "  pandoc 已就绪" -ForegroundColor Green }
if (-not (Get-Command xelatex -ErrorAction SilentlyContinue)) {
    if ($haveWinget) { winget install --id MiKTeX.MiKTeX --scope user --silent --accept-source-agreements --accept-package-agreements }
    else { Write-Host "  ! 无 winget，请手动装 MiKTeX 或 TeX Live 以获得 xelatex" -ForegroundColor Yellow }
} else { Write-Host "  xelatex 已就绪" -ForegroundColor Green }
Write-Host "  (pandoc/xelatex 首次安装后可能需重开终端让 PATH 生效)" -ForegroundColor DarkGray

# 3) 冒烟测试：逐包 import
Write-Host "`n冒烟测试 ..." -ForegroundColor Cyan
$smoke = @'
import importlib
mods=["pandas","numpy","scipy","matplotlib","sklearn","seaborn","statsmodels","openpyxl",
      "requests","httpx","metapub","pymed","Bio","habanero","pyalex","bibtexparser","rispy",
      "docx","reportlab","lxml","bs4","tqdm","lifelines","adjustText","pymupdf","pymupdf4llm"]
bad=[]
for m in mods:
    try: importlib.import_module(m)
    except Exception as e: bad.append(f"{m}: {e}")
if bad:
    print("FAIL:", " | ".join(bad)); raise SystemExit(1)
print(f"OK: {len(mods)} 个包全部可导入")
'@
$smoke | & $Py -
if (-not $?) { throw "冒烟测试失败，见上方 FAIL" }

# 4) 校验所有 SKILL.md
Write-Host "`n校验技能 ..." -ForegroundColor Cyan
& $Py (Join-Path $Root "scripts\validate_skills.py")
if (-not $?) { throw "技能校验未通过" }

Write-Host "`n全部完成 ✔  解释器: $Py" -ForegroundColor Green
Write-Host "可选自检: & `"$Py`" .opencode\skills\reference-check\verify_refs.py `"10.1038/s41586-020-2649-2`""
