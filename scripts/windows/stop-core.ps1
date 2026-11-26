$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $root "logs"
$pidFile = Join-Path $logDir "polaris-core.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "No PID file; Lodestar core is not running."
    exit 0
}

$targetPid = Get-Content $pidFile -ErrorAction SilentlyContinue

if (-not $targetPid) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host "Empty PID file removed."
    exit 0
}

$process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue

if ($process) {
    Stop-Process -Id $targetPid -Force
    Write-Host "Stopped Lodestar core (PID $targetPid)."
} else {
    Write-Host "PID $targetPid is not running (stale PID file)."
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Lodestar core stopped."
