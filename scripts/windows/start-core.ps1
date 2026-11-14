param(
    [Parameter(Mandatory = $true)]
    [string]$SelfId,

    [string]$Token = $env:POLARIS_ONEBOT_TOKEN,

    [string]$Url = "ws://127.0.0.1:6199/ws",

    [string]$GroupId = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$entry = Join-Path $root "packages\core\dist\main.js"
$logDir = Join-Path $root "logs"
$dataDir = Join-Path $root "data"
$pidFile = Join-Path $logDir "polaris-core.pid"

if (-not (Test-Path $entry)) {
    throw "Build output not found: $entry. Run 'pnpm build' first."
}

New-Item -ItemType Directory -Force $logDir | Out-Null
New-Item -ItemType Directory -Force $dataDir | Out-Null

if (Test-Path $pidFile) {
    $existing = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
        throw "Lodestar core is already running (PID $existing). Run stop-core.ps1 first."
    }
}

# Clear the kill-switch sentinel for this run.
Remove-Item (Join-Path $dataDir "STOP") -Force -ErrorAction SilentlyContinue

$env:POLARIS_ONEBOT_URL = $Url
$env:POLARIS_ONEBOT_TOKEN = $Token
$env:POLARIS_SELF_ID = $SelfId
$env:POLARIS_LOG_LEVEL = "info"
$env:POLARIS_DAILY_QUOTA = "96"
$env:POLARIS_AT_ONLY = "1"
if ($GroupId) {
    $env:POLARIS_GROUP_WHITELIST = $GroupId
}

$stdout = Join-Path $logDir "core.out.log"
$stderr = Join-Path $logDir "core.err.log"

$process = Start-Process -FilePath "node" `
    -ArgumentList "packages/core/dist/main.js" `
    -WorkingDirectory $root `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru `
    -WindowStyle Hidden

$process.Id | Set-Content $pidFile
Write-Host "Lodestar core started (PID $($process.Id))."
Write-Host "Logs: $stdout / $stderr"
Write-Host "Stop with: scripts\windows\stop-core.ps1"
