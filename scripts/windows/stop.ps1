param(
    [string]$TaskName = "LodestarCore"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dataDir = Join-Path $root "data"
$logDir = Join-Path $root "logs"
$pidFile = Join-Path $logDir "polaris-core.pid"
New-Item -ItemType Directory -Force $dataDir | Out-Null

# Core SendGuard polls this sentinel every 5s.
New-Item -ItemType File -Force (Join-Path $dataDir "STOP") | Out-Null
Write-Host "Kill switch written: $(Join-Path $dataDir 'STOP')"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $TaskName
    Write-Host "Stopped scheduled task '$TaskName'."
} else {
    Write-Host "Scheduled task '$TaskName' not found; stopping by PID only."
}

if (Test-Path $pidFile) {
    $targetPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($targetPid) {
        $process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -Id $targetPid -Force
            Write-Host "Stopped Lodestar core (PID $targetPid)."
        } else {
            Write-Host "PID $targetPid is not running."
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "No PID file."
}

Write-Host "Logs: $logDir"
