# Publish the built Windows installer to a GitHub Release.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as the system
# codepage, so non-ASCII here would corrupt. Chinese release notes live in
# scripts/release-notes.md (read by gh as UTF-8).
#
# Prereqs: `cargo tauri build` produced the installer, and `gh auth login` was done once.
# Usage:   powershell -ExecutionPolicy Bypass -File scripts\publish-release.ps1
#
# NOTE: do NOT set $ErrorActionPreference='Stop' here. gh writes to stderr on the
# "release view" existence probe; under Stop, PS 5.1 turns that native stderr into a
# terminating error and aborts. We check $LASTEXITCODE explicitly instead.
$root = Split-Path $PSScriptRoot -Parent

function Die($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# Resolve gh: prefer PATH, else fall back to the winget user-scope install location.
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
    $cand = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter gh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cand) { $gh = $cand.FullName }
}
if (-not $gh) { Die "gh (GitHub CLI) not found. Install: winget install --id GitHub.cli" }

# Read version from tauri.conf.json -> tag (needed to pick the matching installer).
$conf = Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$tag = "v$($conf.version)"
$ver = $conf.version

# Locate THIS version's installer. The nsis folder accumulates every version's *-setup.exe,
# so we MUST match the current version exactly. Exclude our own ASCII copies (ResearchAssistant_*)
# to avoid re-picking a stale copy. (Earlier bug: Select -First 1 grabbed ResearchAssistant_0.1.0
# alphabetically and re-uploaded 0.1.0 for every release.)
$nsis = "$root\src-tauri\target\release\bundle\nsis"
$exe = Get-ChildItem "$nsis\*_${ver}_x64-setup.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike 'ResearchAssistant_*' } | Select-Object -First 1
if (-not $exe) { Die "No installer matching version $ver found in $nsis. Run cargo tauri build first." }
$sizeMB = [math]::Round($exe.Length / 1MB)
Write-Host "    source installer: $($exe.Name) ($($exe.Length) bytes)" -ForegroundColor DarkGray

# GitHub strips non-ASCII from asset filenames (the productName is Chinese), which yields
# an ugly "_0.1.0_x64-setup.exe". Upload an ASCII-named copy so the download link is clean.
$asciiName = "ResearchAssistant_$($conf.version)_x64-setup.exe"
$asset = Join-Path $exe.DirectoryName $asciiName
Copy-Item $exe.FullName $asset -Force
Write-Host "==> Publishing $tag : $asciiName ($sizeMB MB)" -ForegroundColor Cyan

$notesFile = "$root\scripts\release-notes.md"

# Probe whether the release already exists (gh exits non-zero + stderr if not; that's fine).
& $gh release view $tag *> $null
$exists = ($LASTEXITCODE -eq 0)

if (-not $exists) {
    & $gh release create $tag "$asset" --title "Research Assistant $tag" --notes-file "$notesFile"
} else {
    Write-Host "Release $tag exists; re-uploading asset (clobber)..." -ForegroundColor Yellow
    & $gh release upload $tag "$asset" --clobber
}
if ($LASTEXITCODE -ne 0) { Die "gh release step failed (exit $LASTEXITCODE)." }

Write-Host "`nDone. Download page:" -ForegroundColor Green
& $gh release view $tag --json url -q .url
