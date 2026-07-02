# Bundle the Python backend into a single-file exe (Tauri sidecar) via PyInstaller.
# Output is renamed to binaries/sidecar-<target-triple>.exe as Tauri requires.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$mirror = "https://pypi.tuna.tsinghua.edu.cn/simple"

Set-Location "$root\backend"

Write-Host "==> Installing PyInstaller" -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m pip install -i $mirror pyinstaller

Write-Host "==> Bundling backend (scipy/matplotlib need --collect-all)" -ForegroundColor Cyan
# --collect-submodules app: bundle ALL app.* backend modules. Many endpoints use lazy
#   (in-function) imports that PyInstaller's static analysis can miss (projects/config_io/
#   refio/ethics/deidentify), which would ship a release missing those features.
# bibtexparser/rispy: third-party deps of refio (reference import/export); hidden-import to be safe.
# --add-data app\data: --collect-submodules only grabs .py modules, NOT data files;
#   without it the exe silently loses scimago quartile annotation (scimago.py degrades to {}).
# --collect-all citeproc/citeproc_styles: both read CSL locale/style files from package
#   data at runtime; missing them breaks reference checking/formatting in the exe.
& ".\.venv\Scripts\pyinstaller.exe" `
    --onefile `
    --name sidecar `
    --collect-all scipy `
    --collect-all matplotlib `
    --collect-all pandas `
    --collect-all sklearn `
    --collect-all pingouin `
    --collect-all lifelines `
    --collect-all citeproc `
    --collect-all citeproc_styles `
    --collect-submodules app `
    --add-data "app\data;app\data" `
    --hidden-import app.main `
    --hidden-import bibtexparser `
    --hidden-import rispy `
    sidecar_entry.py

# Tauri requires the sidecar filename to carry the target triple suffix
$triple = (rustc -vV | Select-String "host:").ToString().Split(" ")[1]
$binDir = "$root\src-tauri\binaries"
New-Item -ItemType Directory -Force $binDir | Out-Null
Copy-Item "dist\sidecar.exe" "$binDir\sidecar-$triple.exe" -Force

Write-Host "`nDone: $binDir\sidecar-$triple.exe" -ForegroundColor Green
