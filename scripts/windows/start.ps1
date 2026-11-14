param(
    [string]$TaskName = "LodestarCore"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pidFile = Join-Path $root "logs\polaris-core.pid"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    throw "Scheduled task '$TaskName' not found. Run install.ps1 first."
}

Start-ScheduledTask -TaskName $TaskName
Write-Host "Started scheduled task '$TaskName'. Waiting for PID..."

for ($i = 0; $i -lt 30; $i++) {
    if (Test-Path $pidFile) {
        $targetPid = Get-Content $pidFile -ErrorAction SilentlyContinue
        if ($targetPid -and (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
            Write-Host "Lodestar core running (PID $targetPid)."
            Write-Host "Logs: $(Join-Path $root 'logs')"
            exit 0
        }
    }
    Start-Sleep -Seconds 1
}

Write-Host "Task started, but no PID file yet. Check logs: $(Join-Path $root 'logs')"
