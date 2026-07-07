# Smoke-test the packaged sidecar BEFORE it ships inside an installer.
# ASCII-only comments on purpose (see release.ps1 header).
#
# Catches the whole class of "works in dev, broken in the exe" packaging bugs:
#   - lazily-imported deps missed by PyInstaller static analysis (openpyxl/xlrd/...)
#   - conda runtime DLLs missing (ffi.dll -> ctypes, libexpat -> pyexpat, ssl, ...)
#   - a sidecar that cannot even bind a port and serve /api/health
#
# Usage: powershell -File scripts\smoke-sidecar.ps1 [-SidecarDir <dir>]
# Exit code 0 = pass, 1 = fail. Called by release.ps1 before the installer is built.
param(
    [string]$SidecarDir = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
if (-not $SidecarDir) { $SidecarDir = "$root\src-tauri\resources\sidecar" }

function Die($msg) { Write-Host "SMOKE FAIL: $msg" -ForegroundColor Red; exit 1 }

$exe = Join-Path $SidecarDir "kyzs-sidecar.exe"
if (-not (Test-Path $exe)) { Die "sidecar exe not found: $exe" }

# --- 1. Import probe (runs inside the frozen bundle via --da-runner mode) ----
# The probe imports every dependency that is loaded lazily at runtime and thus
# invisible to PyInstaller's static analysis, plus does an xlsx write/read roundtrip.
Write-Host "==> Smoke 1/2: import probe inside the frozen bundle" -ForegroundColor Cyan
$probe = Join-Path $env:TEMP "kyzs-smoke-probe.py"
@'
fails = []
for m in ["openpyxl", "xlrd", "pyexpat", "ctypes", "ssl", "sqlite3", "lzma", "bz2",
          "pandas", "numpy", "scipy", "matplotlib", "sklearn", "pingouin", "lifelines",
          "statsmodels", "bibtexparser", "rispy", "citeproc", "citeproc_styles",
          "reportlab", "docx", "pypdf"]:
    try:
        __import__(m)
    except Exception as e:
        fails.append(f"{m}: {type(e).__name__}: {e}")
if not fails:
    import io
    import pandas as pd
    try:
        buf = io.BytesIO()
        pd.DataFrame({"a": [1, 2]}).to_excel(buf, index=False)
        pd.read_excel(io.BytesIO(buf.getvalue()))
    except Exception as e:
        fails.append(f"xlsx roundtrip: {type(e).__name__}: {e}")
if fails:
    print("SMOKE-IMPORTS: FAIL")
    for f in fails:
        print("  " + f)
else:
    print("SMOKE-IMPORTS: OK")
'@ | Out-File $probe -Encoding ascii

# NOTE: no PowerShell-level 2>&1 here. Under $ErrorActionPreference='Stop', PS 5.1 turns
# redirected native stderr (e.g. matplotlib's first-run font-cache notice) into a
# terminating NativeCommandError. Let cmd.exe do the redirection instead.
$probeOut = Join-Path $env:TEMP "kyzs-smoke-probe.out"
& cmd /c "`"$exe`" --da-runner `"$probe`" > `"$probeOut`" 2>&1"
$probeExit = $LASTEXITCODE
$out = ""
if (Test-Path $probeOut) { $out = Get-Content $probeOut -Raw }
Remove-Item $probe, $probeOut -Force -ErrorAction SilentlyContinue
if ($probeExit -ne 0) { Die "import probe process exited $probeExit`n$out" }
if ($out -notmatch "SMOKE-IMPORTS: OK") { Die "import probe reported missing modules:`n$out" }
Write-Host "    imports + xlsx roundtrip: OK" -ForegroundColor DarkGray

# --- 2. Boot probe: start the server, poll /api/health, kill it -------------
Write-Host "==> Smoke 2/2: boot server and poll /api/health" -ForegroundColor Cyan
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()

$outLog = Join-Path $env:TEMP "kyzs-smoke-stdout.log"
$errLog = Join-Path $env:TEMP "kyzs-smoke-stderr.log"
$env:SIDECAR_PORT = "$port"
$proc = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Remove-Item Env:\SIDECAR_PORT -ErrorAction SilentlyContinue

$healthy = $false
try {
    # Cold start can be slow (AV scanning a fresh ~1GB bundle): allow up to 120s.
    for ($i = 0; $i -lt 120; $i++) {
        if ($proc.HasExited) { break }
        try {
            $resp = Invoke-WebRequest "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) { $healthy = $true; break }
        } catch { Start-Sleep -Seconds 1 }
    }
} finally {
    if (-not $proc.HasExited) { try { $proc.Kill() } catch {} }
}

if (-not $healthy) {
    $tail = ""
    foreach ($f in @($outLog, $errLog)) {
        if (Test-Path $f) { $tail += (Get-Content $f -Tail 30 | Out-String) }
    }
    Die "sidecar never became healthy on port $port (process exited: $($proc.HasExited)).`n--- log tail ---`n$tail"
}
Write-Host "    /api/health responded on port ${port}: OK" -ForegroundColor DarkGray

Write-Host "`nSmoke test PASSED." -ForegroundColor Green
exit 0
