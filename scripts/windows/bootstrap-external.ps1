param(
    [string]$QQRoot = "",
    [string]$AstrBotRoot = "",
    [string]$SelfId = "",
    [switch]$DryRun,
    [switch]$InstallOnly,
    [switch]$SkipLoaderInstall
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$portable = Test-Path -LiteralPath (Join-Path $scriptDir "lodestar-external.cjs")
if ($portable) {
    $root = $scriptDir
} else {
    $root = Split-Path -Parent (Split-Path -Parent $scriptDir)
}
$nodeExe = if ($portable) { Join-Path $root "node.exe" } else { "" }
$configPath = Join-Path $root "config\upstream.json"
$examplePath = Join-Path $root "config\upstream.example.json"
$loaderRoot = "D:\qq-loader"
$loaderConfig = Join-Path $loaderRoot "onebot-config.json"
$loaderDir = Join-Path $loaderRoot "staged\app_launcher"
$patchedDllHash = "BF8C1AA8CE80CDC84AFE081E9F20D14C5D97430F0A6B9243E4903B95EA6E9C8C"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail([string]$Message) {
    throw $Message
}

function Read-Json([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    return $null
}

function Save-Json([string]$Path, $Value) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $Path) | Out-Null
    $json = $Value | ConvertTo-Json -Depth 20
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Ensure-Object($Parent, [string]$Name) {
    if (-not $Parent.PSObject.Properties[$Name] -or $null -eq $Parent.$Name) {
        if ($Parent.PSObject.Properties[$Name]) {
            $Parent.$Name = [pscustomobject]@{}
        } else {
            $Parent | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]@{})
        }
    }
    return $Parent.$Name
}

function Set-Field($Target, [string]$Name, $Value) {
    if ($Target.PSObject.Properties[$Name]) {
        $Target.$Name = $Value
    } else {
        $Target | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function New-AdminToken {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Test-Admin {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-TcpPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Wait-Port([int]$Port, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-TcpPort $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Find-SelfIdFromAstrBotLog {
    $log = Join-Path $env:USERPROFILE ".astrbot\logs\backend.log"
    if (-not (Test-Path -LiteralPath $log)) { return "" }
    try {
        $text = Get-Content -LiteralPath $log -Tail 4000 -ErrorAction Stop | Out-String
        $matches = [regex]::Matches($text, "self_id'\s*:\s*(\d{5,12})")
        if ($matches.Count -gt 0) {
            return $matches[$matches.Count - 1].Groups[1].Value
        }
    } catch {
        return ""
    }
    return ""
}

function Get-QQVersionDir {
    if (-not (Test-Path -LiteralPath $QQRoot)) {
        Fail "找不到 QQ 安装目录：$QQRoot。可用 -QQRoot 指定。"
    }
    $versionsRoot = Join-Path $QQRoot "versions"
    if (-not (Test-Path -LiteralPath $versionsRoot)) {
        Fail "找不到 QQ versions 目录：$versionsRoot"
    }
    $versions = Get-ChildItem -LiteralPath $versionsRoot -Directory |
        Sort-Object Name -Descending
    if (-not $versions) { Fail "QQ versions 目录为空：$versionsRoot" }
    $versionDir = $versions | Where-Object { $_.Name -eq "9.9.37-54395" } | Select-Object -First 1
    if (-not $versionDir) {
        $names = ($versions.Name -join ", ")
        Fail "当前 QQ 版本为 $names；loader 补丁仅支持 9.9.37-54395，未找到该版本。"
    }
    return $versionDir
}

function Convert-ToInstallPath([string]$Value) {
    if (-not $Value) { return "" }
    $path = $Value.Trim()
    if ($path -match '^"([^"]+)"') { $path = $Matches[1] }
    $path = $path -replace ',\d+$', ''
    if ($path -match '\.exe(\s|$|,)') {
        $path = ($path -split '\.exe')[0] + '.exe'
        $path = Split-Path -Parent $path
    }
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $path = Split-Path -Parent $path
    }
    if (Test-Path -LiteralPath $path -PathType Container) {
        return (Resolve-Path -LiteralPath $path).Path
    }
    return ""
}

function Test-QQRoot([string]$Path) {
    if (-not $Path) { return $false }
    $candidate = $Path.TrimEnd('\')
    return (
        (Test-Path -LiteralPath (Join-Path $candidate "QQ.exe")) -and
        (Test-Path -LiteralPath (Join-Path $candidate "versions"))
    )
}

function Get-QQRootCandidates {
    $candidates = New-Object System.Collections.Generic.List[string]

    try {
        Get-Process QQ -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Path) { $candidates.Add((Split-Path -Parent $_.Path)) }
        }
    } catch {}

    $keys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Tencent\QQNT",
        "HKLM:\SOFTWARE\Tencent\QQNT",
        "HKCU:\Software\Tencent\QQNT",
        "HKLM:\SOFTWARE\WOW6432Node\Tencent\QQ",
        "HKLM:\SOFTWARE\Tencent\QQ",
        "HKCU:\Software\Tencent\QQ",
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe"
    )
    foreach ($key in $keys) {
        if (-not (Test-Path $key)) { continue }
        $props = Get-ItemProperty $key -ErrorAction SilentlyContinue
        if (-not $props) { continue }
        $props.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object {
            if ($_.Value -is [string]) {
                $converted = Convert-ToInstallPath ([string]$_.Value)
                if ($converted) { $candidates.Add($converted) }
            }
        }
    }

    $uninstallRoots = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    )
    foreach ($base in $uninstallRoots) {
        Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {
            $entry = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($entry -and $entry.DisplayName -and $entry.DisplayName -match 'QQ|Tencent QQ|腾讯QQ') {
                foreach ($value in @($entry.InstallLocation, $entry.DisplayIcon, $entry.UninstallString)) {
                    if ($value -is [string]) {
                        $converted = Convert-ToInstallPath $value
                        if ($converted) { $candidates.Add($converted) }
                    }
                }
            }
        }
    }

    $common = @(
        "D:\qq",
        "D:\Tencent\QQ",
        "E:\qq",
        "E:\Tencent\QQ"
    )
    if ($env:ProgramFiles) { $common += (Join-Path $env:ProgramFiles "Tencent\QQ") }
    if (${env:ProgramFiles(x86)}) { $common += (Join-Path ${env:ProgramFiles(x86)} "Tencent\QQ") }
    if ($env:LOCALAPPDATA) {
        $common += (Join-Path $env:LOCALAPPDATA "Tencent\QQ")
        $common += (Join-Path $env:LOCALAPPDATA "Programs\QQ")
    }
    if ($env:APPDATA) { $common += (Join-Path $env:APPDATA "Tencent\QQ") }
    foreach ($value in $common) { if ($value) { $candidates.Add($value) } }

    $drives = Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue |
        Where-Object { $_.Root -match '^[A-Za-z]:\\$' }
    foreach ($drive in $drives) {
        $root = $drive.Root
        foreach ($relative in @("qq", "QQ", "Tencent\QQ", "Program Files\Tencent\QQ", "Program Files (x86)\Tencent\QQ")) {
            $candidates.Add((Join-Path $root $relative))
        }
        Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $candidates.Add($_.FullName)
            Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match 'tencent|qq' } |
                ForEach-Object { $candidates.Add($_.FullName) }
        }
    }

    return $candidates | Where-Object { $_ } | Select-Object -Unique
}

function Resolve-QQRoot([string]$Configured) {
    if ($Configured) {
        $candidate = Convert-ToInstallPath $Configured
        if (Test-QQRoot $candidate) { return $candidate }
        Fail "指定的 QQ 目录无效：$Configured（需要包含 QQ.exe 和 versions）。"
    }

    $candidates = @(Get-QQRootCandidates)
    $preferred = $candidates |
        Where-Object {
            (Test-QQRoot $_) -and
            (Test-Path -LiteralPath (Join-Path $_ "versions\9.9.37-54395"))
        } |
        Select-Object -First 1
    if ($preferred) { return $preferred }

    $valid = $candidates | Where-Object { Test-QQRoot $_ } | Select-Object -First 1
    if ($valid) { return $valid }

    Fail "找不到 QQ 安装目录。请确认已安装 QQ 9.9.37-54395，或用 -QQRoot 指定（目录需包含 QQ.exe 和 versions）。"
}

function Test-AstrBotRoot([string]$Path) {
    if (-not $Path) { return $false }
    $candidate = $Path.TrimEnd('\')
    return (
        (Test-Path -LiteralPath (Join-Path $candidate "astrbot-desktop-tauri.exe")) -or
        (Test-Path -LiteralPath (Join-Path $candidate "backend\app\main.py"))
    )
}

function Get-AstrBotRootCandidates {
    $candidates = New-Object System.Collections.Generic.List[string]

    try {
        Get-Process astrbot-desktop-tauri -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Path) { $candidates.Add((Split-Path -Parent $_.Path)) }
        }
    } catch {}

    $uninstallRoots = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    )
    foreach ($base in $uninstallRoots) {
        Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {
            $entry = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($entry -and $entry.DisplayName -and $entry.DisplayName -match 'AstrBot') {
                foreach ($value in @($entry.InstallLocation, $entry.DisplayIcon, $entry.UninstallString)) {
                    if ($value -is [string]) {
                        $converted = Convert-ToInstallPath $value
                        if ($converted) { $candidates.Add($converted) }
                    }
                }
            }
        }
    }

    $common = @(
        "D:\AstrBot",
        "E:\AstrBot",
        "C:\Program Files\AstrBot",
        "C:\Program Files (x86)\AstrBot",
        "D:\Program Files\AstrBot"
    )
    if ($env:LOCALAPPDATA) {
        $common += (Join-Path $env:LOCALAPPDATA "Programs\AstrBot")
        $common += (Join-Path $env:LOCALAPPDATA "AstrBot")
    }
    if ($env:USERPROFILE) { $common += (Join-Path $env:USERPROFILE "AstrBot") }
    foreach ($value in $common) { if ($value) { $candidates.Add($value) } }

    $drives = Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue |
        Where-Object { $_.Root -match '^[A-Za-z]:\\$' }
    foreach ($drive in $drives) {
        $root = $drive.Root
        Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $candidates.Add($_.FullName)
            Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match 'astrbot' } |
                ForEach-Object { $candidates.Add($_.FullName) }
        }
    }

    return $candidates | Where-Object { $_ } | Select-Object -Unique
}

function Resolve-AstrBotRoot([string]$Configured) {
    if ($Configured) {
        $candidate = Convert-ToInstallPath $Configured
        if (Test-AstrBotRoot $candidate) { return $candidate }
        Fail "指定的 AstrBot 目录无效：$Configured（需要 astrbot-desktop-tauri.exe 或 backend\app\main.py）。"
    }

    $candidates = @(Get-AstrBotRootCandidates)
    $valid = $candidates | Where-Object { Test-AstrBotRoot $_ } | Select-Object -First 1
    if ($valid) { return $valid }
    return ""
}

function Get-LoaderState {
    $versionDir = Get-QQVersionDir
    $appDir = Join-Path $versionDir.FullName "resources\app"
    $packagePath = Join-Path $appDir "package.json"
    $dllPath = Join-Path $versionDir.FullName "QQNT.dll"
    if (-not (Test-Path -LiteralPath $packagePath)) { Fail "找不到 QQ package.json：$packagePath" }
    if (-not (Test-Path -LiteralPath $dllPath)) { Fail "找不到 QQNT.dll：$dllPath" }
    $package = Read-Json $packagePath
    $dllHash = (Get-FileHash -LiteralPath $dllPath -Algorithm SHA256).Hash
    $sourceOnebot = Join-Path $root "spike\ntqq-loader\src\onebot.js"
    $installedOnebot = Join-Path $appDir "app_launcher\onebot.js"
    $onebotMatches = (
        (Test-Path -LiteralPath $sourceOnebot) -and
        (Test-Path -LiteralPath $installedOnebot) -and
        ((Get-FileHash -LiteralPath $sourceOnebot -Algorithm SHA256).Hash -eq
            (Get-FileHash -LiteralPath $installedOnebot -Algorithm SHA256).Hash)
    )
    $installed = (
        $package.main -eq "./app_launcher/polaris-loader.js" -and
        (Test-Path -LiteralPath (Join-Path $appDir "app_launcher\polaris-loader.js")) -and
        (Test-Path -LiteralPath (Join-Path $appDir "app_launcher\image-size.js")) -and
        (Test-Path -LiteralPath (Join-Path $appDir "app_launcher\ws\index.js")) -and
        $onebotMatches -and
        $dllHash -eq $patchedDllHash
    )
    return [pscustomobject]@{
        VersionDir = $versionDir
        AppDir = $appDir
        PackagePath = $packagePath
        DllPath = $dllPath
        DllHash = $dllHash
        Installed = $installed
    }
}

function Stage-Loader {
    $src = Join-Path $root "spike\ntqq-loader\src"
    if (-not (Test-Path -LiteralPath (Join-Path $src "polaris-loader.js"))) {
        Fail "缺少 loader 源码：$src\polaris-loader.js"
    }
    New-Item -ItemType Directory -Force $loaderDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $src "polaris-loader.js") -Destination $loaderDir -Force
    Copy-Item -LiteralPath (Join-Path $src "onebot.js") -Destination $loaderDir -Force
    Copy-Item -LiteralPath (Join-Path $src "image-size.js") -Destination $loaderDir -Force

    if ($portable) {
        $wsSource = Join-Path $root "node_modules\ws"
        if (-not (Test-Path -LiteralPath (Join-Path $wsSource "index.js"))) {
            Fail "缺少 ws 包：$wsSource"
        }
    } else {
        $wsEntry = ""
        Push-Location $root
        try {
            $wsEntry = & node -e "process.stdout.write(require.resolve('ws'))"
        } finally {
            Pop-Location
        }
        if ($LASTEXITCODE -ne 0 -or -not $wsEntry) {
            Fail "找不到 ws 包；请先运行 pnpm install。"
        }
        $wsSource = Split-Path -Parent $wsEntry
    }
    $wsDest = Join-Path $loaderDir "ws"
    if (Test-Path -LiteralPath $wsDest) { Remove-Item -LiteralPath $wsDest -Recurse -Force }
    Copy-Item -LiteralPath $wsSource -Destination $wsDest -Recurse -Force
}

function Write-LoaderConfig([string]$Id) {
    $existing = Read-Json $loaderConfig
    $value = [ordered]@{
        selfId = [long]$Id
        host = "127.0.0.1"
        port = 3001
        accessToken = if ($existing -and $existing.PSObject.Properties["accessToken"]) { [string]$existing.accessToken } else { "" }
        nickname = if ($existing -and $existing.nickname) { [string]$existing.nickname } else { "lodestar-test" }
    }
    Save-Json $loaderConfig $value
}

function Install-Loader([string]$Id) {
    Stage-Loader
    Write-LoaderConfig $Id
    $installer = Join-Path $root "spike\ntqq-loader\install-native.ps1"
    if (-not (Test-Path -LiteralPath $installer)) {
        Fail "缺少 loader 安装脚本：$installer"
    }
    Write-Step "打补丁并安装 loader（QQ 会被重启）"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
        -QQRoot $QQRoot -LoaderDir $loaderDir -LoaderConfig $loaderConfig `
        -SelfId $Id -AutoPatch
    if ($LASTEXITCODE -ne 0) {
        Fail "loader 安装失败，退出码 $LASTEXITCODE"
    }
}

if ($InstallOnly) {
    if (-not $SelfId) { Fail "InstallOnly requires -SelfId" }
    $QQRoot = Resolve-QQRoot $QQRoot
    $logPath = "D:\qq-loader\install.log"
    try {
        New-Item -ItemType Directory -Force (Split-Path -Parent $logPath) | Out-Null
        Start-Transcript -Path $logPath -Force | Out-Null
    } catch {
        # Logging is best-effort; the install still runs without it.
    }
    try {
        Install-Loader $SelfId
    } finally {
        try { Stop-Transcript | Out-Null } catch {}
    }
    exit 0
}

$QQRoot = Resolve-QQRoot $QQRoot
$AstrBotRoot = Resolve-AstrBotRoot $AstrBotRoot
Write-Host ""
Write-Host "Lodestar external bootstrap" -ForegroundColor White
Write-Host "QQ:      $QQRoot"
if ($AstrBotRoot) {
    Write-Host "AstrBot: $AstrBotRoot"
} else {
    Write-Host "AstrBot: 未检测到安装目录（若未运行，请用 -AstrBotRoot 指定）"
}

# 1. Existing config.
$config = Read-Json $configPath
if (-not $config) {
    $config = Read-Json $examplePath
}
if (-not $config) {
    $config = [pscustomobject]@{}
}
$upstream = Ensure-Object $config "upstream"
$astrbot = Ensure-Object $config "astrbot"
$admin = Ensure-Object $config "admin"
$health = Ensure-Object $config "health"

# 2. AstrBot adapter settings.
$astrbotPort = 6199
$astrbotUrl = "ws://127.0.0.1:6199/ws"
$astrbotToken = ""
$astrbotEnabled = $true
$astrbotConfigPath = Join-Path $env:USERPROFILE ".astrbot\data\cmd_config.json"
if (Test-Path -LiteralPath $astrbotConfigPath) {
    $astrbotConfig = Read-Json $astrbotConfigPath
    $platform = $null
    if ($astrbotConfig -and $astrbotConfig.platform) {
        $platform = $astrbotConfig.platform | Where-Object { $_.type -eq "aiocqhttp" } | Select-Object -First 1
    }
    if ($platform) {
        $astrbotEnabled = [bool]$platform.enable
        $port = 0
        if ($platform.ws_reverse_port) { $port = [int]$platform.ws_reverse_port }
        if ($port -gt 0) { $astrbotPort = $port }
        $hostName = [string]$platform.ws_reverse_host
        if (-not $hostName -or $hostName -eq "0.0.0.0") { $hostName = "127.0.0.1" }
        $astrbotUrl = "ws://${hostName}:$astrbotPort/ws"
        $astrbotToken = [string]$platform.ws_reverse_token
    }
} elseif ($astrbot.url) {
    $astrbotUrl = [string]$astrbot.url
    $astrbotToken = [string]$astrbot.token
}

# 3. QQ account id: saved config > loader config > AstrBot log > prompt.
$detectedSelfId = ""
if ($SelfId) {
    $detectedSelfId = $SelfId
} elseif ($config.selfId -and [string]$config.selfId -ne "0" -and [string]$config.selfId -ne "123456789") {
    $detectedSelfId = [string]$config.selfId
} elseif (Test-Path -LiteralPath $loaderConfig) {
    $loaderConfigValue = Read-Json $loaderConfig
    if ($loaderConfigValue.selfId) { $detectedSelfId = [string]$loaderConfigValue.selfId }
}
if (-not $detectedSelfId) {
    $detectedSelfId = Find-SelfIdFromAstrBotLog
}
if (-not $detectedSelfId) {
    $detectedSelfId = Read-Host "测试号 QQ 号（首次配置后保存，不再询问）"
}
if (-not ($detectedSelfId -match "^\d{5,12}$")) {
    Fail "QQ 号无效：$detectedSelfId"
}

# 4. Loader state.
$loaderState = $null
if (-not $SkipLoaderInstall) {
    $loaderState = Get-LoaderState
    Write-Host "QQ 版本: $($loaderState.VersionDir.Name)"
}
Write-Host "QQ 号:   $detectedSelfId"
Write-Host "AstrBot: $astrbotUrl (adapter enabled: $astrbotEnabled)"
if ($loaderState) {
    Write-Host "Loader:  $(if ($loaderState.Installed) { 'installed' } else { 'needs install' })"
} else {
    Write-Host "Loader:  skipped (assuming an OneBot server on 3001)"
}

if ($DryRun) {
    Write-Host ""
    Write-Host "Dry run: no files or processes were changed." -ForegroundColor Yellow
    exit 0
}

if ((Test-TcpPort 18080) -or (Test-TcpPort 18081)) {
    Fail "18080/18081 已被占用，请先关闭正在运行的 Lodestar/demo，再运行本脚本。"
}

# 5. AstrBot must be running and the adapter enabled.
if (-not $astrbotEnabled) {
    Fail "AstrBot 的 aiocqhttp 适配器未启用。请在 AstrBot 中启用 OneBot v11 适配器后重试。"
}
if (-not (Test-TcpPort $astrbotPort)) {
    if (-not $AstrBotRoot) {
        Fail "AstrBot 未运行，且未检测到安装目录。请先启动 AstrBot，或用 -AstrBotRoot 指定路径。"
    }
    $astrbotExe = Join-Path $AstrBotRoot "astrbot-desktop-tauri.exe"
    if (-not (Test-Path -LiteralPath $astrbotExe)) {
        Fail "AstrBot 未运行，且找不到 $astrbotExe。请先启动 AstrBot，或用 -AstrBotRoot 指定。"
    }
    Write-Step "启动 AstrBot"
    Start-Process -FilePath $astrbotExe | Out-Null
    if (-not (Wait-Port $astrbotPort 120)) {
        Fail "AstrBot 已启动，但 $astrbotPort 端口未监听。请检查 OneBot v11 适配器是否启用。"
    }
}
Write-Host "AstrBot 已监听 $astrbotPort" -ForegroundColor Green

# 6. Install/restart/start the QQ loader.
if ($SkipLoaderInstall) {
    Write-Step "跳过 loader 安装；假定已有 OneBot 服务在 3001 端口"
} else {
    $qqRunning = Get-Process QQ,QQEX -ErrorAction SilentlyContinue
    $needsInstall = -not $loaderState.Installed
    $needsRestart = (-not $needsInstall) -and (-not (Test-TcpPort 3001)) -and $qqRunning

    if ($needsInstall -or $needsRestart) {
        if (-not (Test-Admin)) {
            $reason = if ($needsInstall) { "打补丁并安装 loader" } else { "重启 QQ 以加载最新 loader" }
            Write-Step "需要管理员权限$reason（会弹出 UAC）"
            $arguments = @(
                "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", "`"$PSCommandPath`"",
                "-InstallOnly",
                "-SelfId", $detectedSelfId,
                "-QQRoot", "`"$QQRoot`""
            )
            try {
                $process = Start-Process powershell.exe -Verb RunAs -PassThru -ArgumentList $arguments
            } catch {
                Fail "管理员权限被取消，loader 未安装或未重启。"
            }
            $deadline = (Get-Date).AddSeconds(180)
            while ((Get-Date) -lt $deadline) {
                if (Test-TcpPort 3001) { break }
                if ($process.HasExited) { break }
                Start-Sleep -Milliseconds 500
            }
            if ($process.HasExited -and $process.ExitCode -ne 0) {
                Fail "loader 安装/重启失败（退出码 $($process.ExitCode)）。请查看管理员窗口日志。"
            }
            if (-not (Test-TcpPort 3001)) {
                Write-Host "请现在在 QQ 窗口登录测试号；loader 需要登录后才能附着。" -ForegroundColor Yellow
                Write-Host "脚本会等待最多 300 秒。若已登录但 3001 仍未出现，请完全退出并重开 QQ。" -ForegroundColor Yellow
                if (-not (Wait-Port 3001 300)) {
                    Fail "等待 loader 超过 300 秒仍未监听 3001。请查看管理员窗口和 D:\qq-loader\self-loader-*.jsonl。"
                }
            }
        } else {
            Install-Loader $detectedSelfId
        }
        $loaderState = Get-LoaderState
        if (-not $loaderState.Installed) {
            Fail "loader 安装后校验失败。请检查 QQNT.dll 和 package.json。"
        }
    } else {
        Write-LoaderConfig $detectedSelfId
        if (-not $qqRunning) {
            Write-Step "启动 QQ"
            Start-Process -FilePath (Join-Path $QQRoot "QQ.exe") | Out-Null
        }
    }
}

if (-not (Test-TcpPort 3001)) {
    Write-Host "请现在在 QQ 窗口登录测试号；loader 需要登录后才能附着。" -ForegroundColor Yellow
    Write-Host "脚本会等待最多 300 秒。若已登录但 3001 仍未出现，请完全退出并重开 QQ。" -ForegroundColor Yellow
}
Write-Host "等待 loader 监听 3001..." -ForegroundColor Yellow
if (-not (Wait-Port 3001 300)) {
    Fail "loader 未在 3001 端口监听。请查看 D:\qq-loader\self-loader-*.jsonl 和 QQ 是否正常启动。"
}
Write-Host "loader 已监听 3001" -ForegroundColor Green

# 7. Write the external config and keep the admin token stable.
Set-Field $config "selfId" ([long]$detectedSelfId)
Set-Field $upstream "url" "ws://127.0.0.1:3001/"
$loaderSettings = Read-Json $loaderConfig
if ($loaderSettings -and $loaderSettings.accessToken) {
    Set-Field $upstream "token" ([string]$loaderSettings.accessToken)
} elseif (-not $upstream.token) {
    Set-Field $upstream "token" ""
}
Set-Field $astrbot "url" $astrbotUrl
Set-Field $astrbot "token" $astrbotToken
Set-Field $admin "enabled" $true
Set-Field $admin "host" "127.0.0.1"
Set-Field $admin "port" 18081
Set-Field $admin "webRoot" $(if ($portable) { "web" } else { "packages/web/dist" })
if (-not $admin.token) { Set-Field $admin "token" (New-AdminToken) }
Set-Field $health "host" "127.0.0.1"
Set-Field $health "port" 18080
if (-not $config.PSObject.Properties["databasePath"]) {
    Set-Field $config "databasePath" "data/polaris.db"
}
Save-Json $configPath $config

$adminToken = [string]$admin.token

# 8. Ensure dependencies and build, then start Core in its own window.
function Ensure-Toolchain {
    if ($portable) {
        if (-not (Test-Path -LiteralPath $nodeExe)) {
            Fail "缺少 bundled node.exe：$nodeExe"
        }
        $version = (& $nodeExe -v).TrimStart("v")
    } else {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) { Fail "需要 Node.js >= 22.16，请先安装。" }
        $version = (& $node.Source -v).TrimStart("v")
    }
    if ([version]$version -lt [version]"22.16.0") {
        Fail "需要 Node.js >= 22.16，当前 $version"
    }
}

function Find-Pnpm {
    foreach ($name in @("pnpm.cmd", "pnpm.exe", "pnpm")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    $candidates = @(
        (Join-Path $env:APPDATA "npm\pnpm.cmd"),
        (Join-Path $env:ProgramFiles "nodejs\pnpm.cmd"),
        (Join-Path $env:LOCALAPPDATA "pnpm\pnpm.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    if ($corepack) { return $corepack.Source }
    return ""
}

function Ensure-Dependencies {
    if ($portable) {
        if (-not (Test-Path -LiteralPath (Join-Path $root "lodestar-external.cjs"))) {
            Fail "缺少 lodestar-external.cjs"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $root "web\index.html"))) {
            Fail "缺少 web/index.html"
        }
        return
    }
    $needInstall = -not (Test-Path (Join-Path $root "node_modules"))
    $needBuild = -not (Test-Path (Join-Path $root "packages\core\dist\index.js"))
    if (-not $needInstall -and -not $needBuild) { return }

    $pnpm = Find-Pnpm
    if (-not $pnpm) {
        Fail "缺少依赖且找不到 pnpm。请运行 npm install -g pnpm@10 后重试。"
    }
    $isCorepack = (Split-Path -Leaf $pnpm) -match "^corepack"
    Push-Location $root
    try {
        if ($needInstall) {
            Write-Step "安装依赖"
            if ($isCorepack) { & $pnpm pnpm install } else { & $pnpm install }
            if ($LASTEXITCODE -ne 0) { Fail "pnpm install 失败" }
        }
        if ($needBuild) {
            Write-Step "构建 Core"
            if ($isCorepack) { & $pnpm pnpm build } else { & $pnpm build }
            if ($LASTEXITCODE -ne 0) { Fail "pnpm build 失败" }
        }
    } finally {
        Pop-Location
    }
}

Ensure-Toolchain
Ensure-Dependencies

Write-Step "启动 Lodestar Core"
if ($portable) {
    $coreCommand = "`$env:LODESTAR_NO_OPEN='1'; Set-Location -LiteralPath '$root'; & '$nodeExe' 'lodestar-external.cjs'"
} else {
    $coreCommand = "`$env:LODESTAR_NO_OPEN='1'; Set-Location -LiteralPath '$root'; node scripts/upstream.mjs"
}
Start-Process powershell.exe -ArgumentList @(
    "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $coreCommand
) | Out-Null

if (-not (Wait-Port 18081 60)) {
    Fail "Core 未在 18081 启动。请查看新打开的 Core 窗口日志。"
}

Write-Host ""
Write-Host "Lodestar external is running" -ForegroundColor Green
Write-Host "  Panel: http://127.0.0.1:18081"
Write-Host "  Token: $adminToken"
Write-Host "  QQ:    $detectedSelfId"
Write-Host "  AstrBot: $astrbotUrl"
Write-Host ""
Write-Host "请在 QQ 窗口登录测试号；登录后无需再运行任何命令。" -ForegroundColor Yellow
Start-Process "http://127.0.0.1:18081"
