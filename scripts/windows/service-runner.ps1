param(
    [string]$ConfigPath = "",
    [string]$Entrypoint = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $root "config\polaris.json"
}

$logDir = Join-Path $root "logs"
$dataDir = Join-Path $root "data"
New-Item -ItemType Directory -Force $logDir | Out-Null
New-Item -ItemType Directory -Force $dataDir | Out-Null

$serviceLog = Join-Path $logDir "service.log"
$pidFile = Join-Path $logDir "polaris-core.pid"

function Write-ServiceLog([string]$Message) {
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -Path $serviceLog -Value $line
    Write-Host $line
}

try {
    if (-not (Test-Path $ConfigPath)) {
        throw "Config not found: $ConfigPath. Run install.ps1 or copy config/polaris.example.json."
    }

    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

    if (-not $config.onebot.url) {
        throw "config.onebot.url is required"
    }
    if (-not $config.onebot.selfId -or [int]$config.onebot.selfId -le 0) {
        throw "config.onebot.selfId must be a positive integer"
    }

    $configuredEntrypoint = if ($Entrypoint) { $Entrypoint } else { [string]$config.entrypoint }
    $entry = if ([System.IO.Path]::IsPathRooted($configuredEntrypoint)) {
        $configuredEntrypoint
    } else {
        Join-Path $root $configuredEntrypoint
    }
    if (-not (Test-Path $entry)) {
        $hint = if ($Entrypoint) { " (entrypoint override)" } else { "" }
        throw "Entrypoint not found$hint`: $entry. Run 'pnpm build' first."
    }
    if ($Entrypoint) {
        Write-ServiceLog "entrypoint override: $Entrypoint"
    }

    $node = (Get-Command node -ErrorAction Stop).Source
    $nodeVersion = (& $node -v).TrimStart("v")
    if ([version]$nodeVersion -lt [version]"22.16.0") {
        throw "Node >= 22.16.0 is required, found $nodeVersion"
    }

    $env:POLARIS_ONEBOT_URL = [string]$config.onebot.url
    if ($config.onebot.token) {
        $env:POLARIS_ONEBOT_TOKEN = [string]$config.onebot.token
    }
    $env:POLARIS_SELF_ID = [string]$config.onebot.selfId
    $env:POLARIS_DB_PATH = [string]$config.databasePath

    if ($config.health -and $config.health.port) {
        $env:POLARIS_HEALTH_PORT = [string]$config.health.port
    }
    if ($config.control -and $config.control.port) {
        $env:POLARIS_CONTROL_PORT = [string]$config.control.port
    }

    $stdout = Join-Path $logDir "core.out.log"
    $stderr = Join-Path $logDir "core.err.log"

    Write-ServiceLog "starting $node $entry"
    $process = Start-Process -FilePath $node `
        -ArgumentList "`"$entry`"" `
        -WorkingDirectory $root `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru `
        -WindowStyle Hidden

    $process.Id | Set-Content $pidFile
    Write-ServiceLog "started PID $($process.Id)"

    $process.WaitForExit()
    Write-ServiceLog "node exited with code $($process.ExitCode)"

    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit $process.ExitCode
} catch {
    Write-ServiceLog "ERROR: $($_.Exception.Message)"
    exit 2
}
