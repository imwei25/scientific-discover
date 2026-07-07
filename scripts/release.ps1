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
#   powershell -File scripts\release.ps1                # full: tests + sidecar + smoke + build + publish
#   powershell -File scripts\release.ps1 -SkipSidecar   # reuse existing resources\sidecar\ (onedir)
#   powershell -File scripts\release.ps1 -SkipPublish   # build only, do not upload (dry run)
#   powershell -File scripts\release.ps1 -SkipTests     # skip the backend pytest gate (emergency only)
#   powershell -File scripts\release.ps1 -AllowDirty    # allow dirty/unpushed git state (tag will NOT match sources!)
param(
    [switch]$SkipSidecar,
    [switch]$SkipPublish,
    [switch]$SkipTests,
    [switch]$AllowDirty
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

# Git state: `gh release create` tags the REMOTE default-branch HEAD, not the local
# commit. Releasing with uncommitted or unpushed work means the tag points at code
# that is NOT what went into the installer. Hard-fail unless -AllowDirty.
Set-Location $root
$dirty = (& git status --porcelain)
if ($dirty -and -not $AllowDirty) {
    Die "Working tree is dirty (uncommitted changes). Commit + push first, or use -AllowDirty (tag will not match sources)."
}
# try/catch: under Stop, PS 5.1 may turn redirected native stderr ("fatal: no upstream")
# into a terminating NativeCommandError (same gotcha as publish-release.ps1's header).
$hasUpstream = $true
try { & git rev-parse --abbrev-ref --symbolic-full-name '@{u}' *> $null } catch { $hasUpstream = $false }
if ($LASTEXITCODE -ne 0) { $hasUpstream = $false }
if ($hasUpstream) {
    $ahead = (& git rev-list --count '@{u}..HEAD')
    if ([int]$ahead -gt 0 -and -not $AllowDirty) {
        Die "Local branch is $ahead commit(s) ahead of upstream. Push first (gh tags the remote HEAD), or use -AllowDirty."
    }
} else {
    Write-Host "    (note: no upstream tracking branch; skipping push check)" -ForegroundColor DarkGray
}

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

# --- 0. Backend test gate (fast: ~30s for the whole suite) ------------------
if (-not $SkipTests) {
    Step "Running backend tests (pytest)"
    Set-Location "$root\backend"
    & ".\.venv\Scripts\python.exe" -m pytest -q
    if ($LASTEXITCODE -ne 0) { Die "backend tests failed. Fix them or use -SkipTests (emergency only)." }
    Set-Location $root
} else {
    Write-Host "    -SkipTests set: backend test gate skipped" -ForegroundColor Yellow
}

# --- Signing env for the updater artifacts (createUpdaterArtifacts=true).
#     The key is password-protected. The password lives next to the key in a
#     gitignored .pw file (NOT in the repo). It MUST be non-empty: Windows cannot
#     pass an empty-string env var to a child process (PowerShell $env:X="" makes
#     it *unset*), so an empty password would make `cargo tauri build` fall back
#     to an interactive prompt and hang. TAURI_SIGNING_PRIVATE_KEY may be a path
#     or the key contents.
$pwFile = "$key.pw"
if (-not (Test-Path $pwFile)) {
    Die "Signing-key password file not found at $pwFile. It is required (empty passwords can't be passed to the build on Windows)."
}
$pw = (Get-Content $pwFile -Raw).Trim()
if (-not $pw) { Die "Signing-key password file $pwFile is empty. A non-empty password is required on Windows." }
$env:TAURI_SIGNING_PRIVATE_KEY = $key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $pw

# --- 1. Sidecar (Python backend -> single exe) -----------------------------
if (-not $SkipSidecar) {
    Step "Building Python sidecar (PyInstaller)"
    & "$PSScriptRoot\build-sidecar.ps1"
    if ($LASTEXITCODE -ne 0) { Die "sidecar build failed." }
} else {
    if (-not (Test-Path "$root\src-tauri\resources\sidecar\kyzs-sidecar.exe")) {
        Die "-SkipSidecar set but resources\sidecar\kyzs-sidecar.exe missing. Run without -SkipSidecar."
    }
    Write-Host "    reusing resources\sidecar\ (onedir)" -ForegroundColor DarkGray
}

# --- 1b. Smoke-test the frozen sidecar BEFORE building the installer --------
# Catches packaging-only failures (lazily-imported deps missed by PyInstaller,
# conda runtime DLLs, boot crashes) that dev-mode tests can never see.
Step "Smoke-testing packaged sidecar"
& "$PSScriptRoot\smoke-sidecar.ps1"
if ($LASTEXITCODE -ne 0) { Die "sidecar smoke test failed. Do NOT ship this build." }

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
