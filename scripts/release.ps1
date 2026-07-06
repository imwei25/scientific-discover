# One-command Windows release: sidecar -> signed installer -> GitHub Release.
# ASCII-only comments on purpose (Windows PowerShell 5.1 reads BOM-less .ps1 as the
# system codepage; non-ASCII would corrupt). Chinese release notes live in
# scripts/release-notes.md and are read by gh as UTF-8.
#
# Prereqs (one-time, see scripts/release-README.md):
#   - Rust + MSVC toolchain, `cargo install tauri-cli`
#   - GitHub CLI authenticated: `gh auth login`
#   - Updater signing key at %USERPROFILE%\.tauri\research-assistant.key
#
# Usage:
#   powershell -File scripts\release.ps1                # full: sidecar + build + publish
#   powershell -File scripts\release.ps1 -SkipSidecar   # reuse existing binaries\sidecar-*.exe
#   powershell -File scripts\release.ps1 -SkipPublish   # build only, do not upload (dry run)
param(
    [switch]$SkipSidecar,
    [switch]$SkipPublish
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

function Die($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# --- Put the Rust toolchain on PATH (rustup installs to %USERPROFILE%\.cargo\bin;
#     a shell opened before install won't have it yet). Gives us cargo / cargo-tauri / rustc.
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# --- Preflight -------------------------------------------------------------
Step "Preflight checks"
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Die "cargo not found. Install Rust (rustup) first." }
& cargo tauri --version *> $null
if ($LASTEXITCODE -ne 0) { Die "cargo-tauri not found. Run: cargo install tauri-cli --version ^2 --locked" }

$key = "$env:USERPROFILE\.tauri\research-assistant.key"
if (-not (Test-Path $key)) {
    Die "Signing key not found at $key. Generate: cargo tauri signer generate -w `"$key`"  (then update pubkey in tauri.conf.json)"
}

# Resolve gh (PATH, else winget user-scope install) so we can fail early if not authed.
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
    $cand = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter gh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cand) { $gh = $cand.FullName }
}
if (-not $SkipPublish) {
    if (-not $gh) { Die "gh (GitHub CLI) not found. Install: winget install --id GitHub.cli" }
    & $gh auth status *> $null
    if ($LASTEXITCODE -ne 0) { Die "gh not authenticated. Run once: gh auth login" }
}

# Version sanity: Cargo.toml and tauri.conf.json must agree (installer name/tag come from conf).
$conf = Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$cargoVer = (Select-String -Path "$root\src-tauri\Cargo.toml" -Pattern '^\s*version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches.Groups[1].Value
if ($conf.version -ne $cargoVer) {
    Die "Version mismatch: tauri.conf.json=$($conf.version) Cargo.toml=$cargoVer. Align both before releasing."
}
Write-Host "    version: v$($conf.version)   installer target: nsis   updater: on" -ForegroundColor DarkGray

# --- Signing env for the updater artifacts (createUpdaterArtifacts=true).
#     Value may be a path or the key contents; our key has an empty password.
$env:TAURI_SIGNING_PRIVATE_KEY = $key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

# --- 1. Sidecar (Python backend -> single exe) -----------------------------
if (-not $SkipSidecar) {
    Step "Building Python sidecar (PyInstaller)"
    & "$PSScriptRoot\build-sidecar.ps1"
    if ($LASTEXITCODE -ne 0) { Die "sidecar build failed." }
} else {
    $triple = (rustc -vV | Select-String "host:").ToString().Split(" ")[1]
    if (-not (Test-Path "$root\src-tauri\binaries\sidecar-$triple.exe")) {
        Die "-SkipSidecar set but binaries\sidecar-$triple.exe missing. Run without -SkipSidecar."
    }
    Write-Host "    reusing binaries\sidecar-$triple.exe" -ForegroundColor DarkGray
}

# --- 2. Installer (Tauri: runs frontend `npm run build` via beforeBuildCommand) ---
Step "Building signed installer (cargo tauri build)"
Set-Location $root
& cargo tauri build
if ($LASTEXITCODE -ne 0) { Die "cargo tauri build failed." }

# --- 3. Publish to GitHub Release ------------------------------------------
if ($SkipPublish) {
    Write-Host "`n-SkipPublish set. Installer + latest.json are in src-tauri\target\release\bundle\nsis. Not uploaded." -ForegroundColor Yellow
    exit 0
}
Step "Publishing to GitHub Release"
& "$PSScriptRoot\publish-release.ps1"
if ($LASTEXITCODE -ne 0) { Die "publish step failed." }

Write-Host "`nRelease complete." -ForegroundColor Green
