# Bundle the Python backend into a single-file exe (Tauri sidecar) via PyInstaller.
# Output is renamed to binaries/sidecar-<target-triple>.exe as Tauri requires.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$mirror = "https://pypi.tuna.tsinghua.edu.cn/simple"

Set-Location "$root\backend"

if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
    throw "backend\.venv not found. Run scripts\setup.ps1 (or create the venv + pip install -r requirements.txt) first."
}

# Pinned: unpinned 'pip install pyinstaller' made every release build against whatever
# was newest, so bundle contents (e.g. lazily-imported deps picked up by hooks) could
# silently change between releases. Bump deliberately, then smoke-test (smoke-sidecar.ps1).
Write-Host "==> Installing PyInstaller (pinned)" -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m pip install -i $mirror "pyinstaller==6.21.0"
if ($LASTEXITCODE -ne 0) { throw "pip install pyinstaller failed (exit $LASTEXITCODE)." }

Write-Host "==> Bundling backend (scipy/matplotlib need --collect-all)" -ForegroundColor Cyan
# --collect-submodules app: bundle ALL app.* backend modules. Many endpoints use lazy
#   (in-function) imports that PyInstaller's static analysis can miss (projects/config_io/
#   refio/ethics/deidentify), which would ship a release missing those features.
# bibtexparser/rispy: third-party deps of refio (reference import/export); hidden-import to be safe.
# --add-data app\data: --collect-submodules only grabs .py modules, NOT data files;
#   without it the exe silently loses scimago quartile annotation (scimago.py degrades to {}).
# --collect-all citeproc/citeproc_styles: both read CSL locale/style files from package
#   data at runtime; missing them breaks reference checking/formatting in the exe.
# --collect-all reportlab: PDF 导出用 reportlab, 其内置 CID 中文字体(STSong-Light)的
#   CMap 资源与 .pfb 字体是包内数据文件, 不 collect-all 会导致 exe 里中文 PDF 生成失败。
# CRITICAL (conda/Anaconda builds): conda ships the C-extension runtime DLLs under
# <base>\Library\bin with conda names (ffi.dll, libexpat.dll, libssl-3-x64.dll, ...), a location
# and naming PyInstaller's dependency scan misses. Any stdlib .pyd whose backing DLL is absent
# fails to import at runtime:
#   ffi.dll        -> _ctypes   (matplotlib rthook imports ctypes -> backend crashes at startup)
#   libexpat.dll   -> pyexpat   ("No module named expat" parsing XML: charts / data files / CSL)
#   libssl/crypto  -> _ssl/_hashlib (HTTPS: LLM calls, downloads)
#   sqlite3.dll    -> _sqlite3 ; liblzma/libbz2 -> _lzma/_bz2 (compression)
# Enumerated via: dumpbin /dependents over anaconda3\DLLs\*.pyd, filtered to deps present in
# Library\bin. Bundle every match. On python.org Python these don't exist (deps live in DLLs\ and
# auto-bundle), so the loop adds nothing and the build is unchanged.
$basePrefix = (& ".\.venv\Scripts\python.exe" -c "import sys; print(sys.base_prefix)").Trim()
$libBin = Join-Path $basePrefix "Library\bin"
$condaDllPatterns = @(
    "ffi.dll", "ffi-*.dll",
    "libexpat.dll", "expat.dll",
    "libbz2.dll", "liblzma.dll",
    "libcrypto-*.dll", "libssl-*.dll",
    "sqlite3.dll"
)
$dllArgs = @()
$seen = @{}
foreach ($pat in $condaDllPatterns) {
    Get-ChildItem (Join-Path $libBin $pat) -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not $seen.ContainsKey($_.Name)) { $seen[$_.Name] = $true; $dllArgs += @("--add-binary", "$($_.FullName);.") }
    }
}
if ($dllArgs.Count) { Write-Host "==> Bundling $($seen.Count) conda runtime DLLs from ${libBin}: $($seen.Keys -join ', ')" -ForegroundColor Cyan }
else { Write-Host "==> No conda runtime DLLs found (python.org build?); relying on auto-bundled deps" -ForegroundColor DarkGray }

# Clean previous PyInstaller output BEFORE building: if PyInstaller fails midway, a stale
# exe from the previous build would otherwise pass the existence check below and a stale
# backend would silently ship inside the release.
foreach ($stale in @("dist\kyzs-sidecar", "dist\sidecar", "build")) {
    if (Test-Path $stale) { Remove-Item $stale -Recurse -Force }
}

# --onedir (NOT --onefile): onefile re-extracts the whole ~170MB bundle to %TEMP% on EVERY launch,
# which antivirus (e.g. 360) then rescans -> first/cold launch can take a minute. onedir extracts
# once at install time into the app dir; every launch after is a few seconds.
# Name "kyzs-sidecar" (NOT the generic "sidecar"): the NSIS upgrade hook taskkills by image
# name, and a generic name risks killing other apps' processes with the same name.
$pyiArgs = @(
    "--onedir"
    "--noconfirm"
    "--name", "kyzs-sidecar"
    "--collect-all", "scipy"
    "--collect-all", "matplotlib"
    "--collect-all", "pandas"
    "--collect-all", "sklearn"
    "--collect-all", "pingouin"
    "--collect-all", "lifelines"
    "--collect-all", "citeproc"
    "--collect-all", "citeproc_styles"
    "--collect-all", "reportlab"
    "--collect-submodules", "app"
    "--add-data", "app\data;app\data"
    "--hidden-import", "app.main"
    "--hidden-import", "bibtexparser"
    "--hidden-import", "rispy"
    # pandas loads its Excel engines lazily (importlib), invisible to static analysis.
    # openpyxl (xlsx) has so far been picked up by hook side-effects only -- declare it
    # explicitly so a PyInstaller/hooks upgrade can't silently drop it. xlrd (legacy .xls)
    # is never detected at all and MUST be listed.
    "--hidden-import", "openpyxl"
    "--hidden-import", "xlrd"
)
$pyiArgs += $dllArgs
$pyiArgs += "sidecar_entry.py"

& ".\.venv\Scripts\pyinstaller.exe" @pyiArgs
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed (exit $LASTEXITCODE)." }

# --onedir output is a folder (dist\kyzs-sidecar\ = kyzs-sidecar.exe + _internal\). Ship the whole
# folder as a Tauri *resource* (bundle.resources in tauri.conf.json), spawned by src-tauri/src/main.rs
# from the resolved resource dir. (externalBin is single-file only, so it can't carry an onedir layout.)
$srcDir = "$root\backend\dist\kyzs-sidecar"
$dstDir = "$root\src-tauri\resources\sidecar"
if (-not (Test-Path "$srcDir\kyzs-sidecar.exe")) { throw "PyInstaller onedir output missing: $srcDir\kyzs-sidecar.exe" }
if (Test-Path $dstDir) { Remove-Item $dstDir -Recurse -Force }
New-Item -ItemType Directory -Force $dstDir | Out-Null
Copy-Item "$srcDir\*" $dstDir -Recurse -Force
# Drop any stale single-file externalBin artifact from the old --onefile flow. Best-effort:
# the file may be locked (AV/handle) and it's harmless now (tauri.conf no longer references it),
# so never let cleanup fail the build.
$oldBin = "$root\src-tauri\binaries"
if (Test-Path $oldBin) {
    try { Remove-Item $oldBin -Recurse -Force -ErrorAction Stop }
    catch { Write-Host "    (note: 无法删除旧的 binaries\ (可忽略): $($_.Exception.Message))" -ForegroundColor DarkGray }
}

$exe = Join-Path $dstDir "kyzs-sidecar.exe"
$fileCount = (Get-ChildItem $dstDir -Recurse -File | Measure-Object).Count
Write-Host "`nDone: onedir sidecar -> $dstDir ($fileCount files)" -ForegroundColor Green
Write-Host "      exe: $exe" -ForegroundColor Green
