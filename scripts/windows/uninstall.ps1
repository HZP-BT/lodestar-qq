param(
    [string]$TaskName = "LodestarCore"
)

$ErrorActionPreference = "Stop"

$stopScript = Join-Path $PSScriptRoot "stop.ps1"
if (Test-Path $stopScript) {
    & $stopScript -TaskName $TaskName
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Unregistered scheduled task '$TaskName'."
} else {
    Write-Host "Scheduled task '$TaskName' was not registered."
}

Write-Host "Config, logs and data are kept for inspection."
Write-Host "Remove them manually if you intend to uninstall completely."
