param(
    [string]$SelfId = "",
    [string]$Token = "",
    [string]$Url = "",
    [string]$GroupId = "",
    [int]$DailyQuota = 0,
    [string]$ConfigPath = "",
    [string]$TaskName = "LodestarCore",
    [string]$Entrypoint = "",
    [switch]$DevMock,
    [switch]$Start,
    [switch]$NoRegister
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$configDir = Join-Path $root "config"
$logDir = Join-Path $root "logs"
$dataDir = Join-Path $root "data"
New-Item -ItemType Directory -Force $configDir | Out-Null
New-Item -ItemType Directory -Force $logDir | Out-Null
New-Item -ItemType Directory -Force $dataDir | Out-Null

if (-not $ConfigPath) {
    $ConfigPath = Join-Path $configDir "polaris.json"
}

$installLog = Join-Path $logDir "install.log"

function Write-InstallLog([string]$Message) {
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -Path $installLog -Value $line
    Write-Host $line
}

try {
    if ($DevMock -and $Entrypoint) {
        throw "Use either -DevMock or -Entrypoint, not both."
    }

    $node = (Get-Command node -ErrorAction Stop).Source
    $nodeVersion = (& $node -v).TrimStart("v")
    if ([version]$nodeVersion -lt [version]"22.16.0") {
        throw "Node >= 22.16.0 is required, found $nodeVersion"
    }

    $example = Join-Path $configDir "polaris.example.json"
    if (-not (Test-Path $ConfigPath)) {
        if (-not (Test-Path $example)) {
            throw "Missing config template: $example"
        }

        $config = Get-Content $example -Raw | ConvertFrom-Json
        Write-InstallLog "created config from template: $ConfigPath"
    } else {
        $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    }

    if ($SelfId) {
        $config.onebot.selfId = [int]$SelfId
    }
    if ($Token) {
        $config.onebot.token = $Token
    }
    if ($Url) {
        $config.onebot.url = $Url
    }
    if ($GroupId) {
        $groups = @($GroupId.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $config.sendGuard.groupWhitelist = @($groups | ForEach-Object { [int]$_ })
    }
    if ($DailyQuota -gt 0) {
        $config.sendGuard.dailyQuota = $DailyQuota
    }

    if ($DevMock -and (-not $config.onebot.selfId -or [int]$config.onebot.selfId -le 0)) {
        $config.onebot.selfId = 10001
        Write-InstallLog "DevMock: using demo selfId 10001"
    }

    if (-not $config.onebot.url) {
        throw "config.onebot.url is required"
    }
    if (-not $config.onebot.selfId -or [int]$config.onebot.selfId -le 0) {
        throw "config.onebot.selfId must be a positive integer. Pass -SelfId or edit $ConfigPath."
    }

    $configJson = $config | ConvertTo-Json -Depth 10
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ConfigPath, $configJson, $utf8NoBom)
    Write-InstallLog "config validated: $ConfigPath"

    $effectiveEntrypoint = if ($DevMock) {
        "scripts/dev-mock.mjs"
    } elseif ($Entrypoint) {
        $Entrypoint
    } else {
        [string]$config.entrypoint
    }

    $entry = if ([System.IO.Path]::IsPathRooted($effectiveEntrypoint)) {
        $effectiveEntrypoint
    } else {
        Join-Path $root $effectiveEntrypoint
    }

    if ($DevMock) {
        Write-InstallLog "MODE=dev-mock entrypoint=$effectiveEntrypoint; ports 18080/18090 will be occupied; dev-mock is mutually exclusive with a real backend."
    } else {
        Write-InstallLog "MODE=default entrypoint=$effectiveEntrypoint"
    }

    $needsBuild = -not (Test-Path $entry)
    if ($DevMock -and -not (Test-Path (Join-Path $root "packages\core\dist\index.js"))) {
        $needsBuild = $true
    }

    if ($needsBuild) {
        if (Get-Command pnpm -ErrorAction SilentlyContinue) {
            Write-InstallLog "build output missing; running pnpm install and pnpm build"
            Push-Location $root
            try {
                & pnpm install
                if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
                & pnpm build
                if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
            } finally {
                Pop-Location
            }
        } else {
            throw "Build output missing: $entry. Install pnpm and run 'pnpm build' first."
        }
    }

    $runner = Join-Path $PSScriptRoot "service-runner.ps1"
    if (-not (Test-Path $runner)) {
        throw "Missing service runner: $runner"
    }

    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -ConfigPath `"$ConfigPath`""
    if ($DevMock -or $Entrypoint) {
        $actionArgs += " -Entrypoint `"$effectiveEntrypoint`""
    }

    if ($NoRegister) {
        Write-InstallLog "validation complete; NoRegister set, scheduled task was not registered"
        Write-Host ""
        Write-Host "Dry run complete. Config: $ConfigPath"
        exit 0
    }

    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Force | Out-Null

    Write-InstallLog "scheduled task registered: $TaskName (at logon, restart on failure)"

    if ($Start) {
        Start-ScheduledTask -TaskName $TaskName
        Write-InstallLog "scheduled task started"
    }

    Write-Host ""
    Write-Host "Install complete."
    Write-Host "Config : $ConfigPath"
    Write-Host "Logs   : $logDir"
    Write-Host "Data   : $dataDir"
    Write-Host "Start  : powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1"
    Write-Host "Stop   : powershell -ExecutionPolicy Bypass -File scripts\windows\stop.ps1"
} catch {
    Write-InstallLog "ERROR: $($_.Exception.Message)"
    Write-Error $_.Exception.Message
    exit 2
}
