param(
    [string]$QQRoot = "D:\qq",
    [string]$PatcherPath = "",
    [string]$LoaderDir = "D:\qq-loader\staged\app_launcher",
    [string]$LoaderConfig = "D:\qq-loader\onebot-config.json",
    [string]$SelfId = "",
    [int]$OneBotPort = 3001,
    [switch]$AutoPatch,
    [switch]$SkipPatcher,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if (-not $DryRun) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this installer from an elevated PowerShell (Administrator)."
    }
}

if (-not (Test-Path $QQRoot)) {
    throw "QQ root not found: $QQRoot"
}
$versionsRoot = Join-Path $QQRoot "versions"
if (-not (Test-Path $versionsRoot)) {
    throw "QQ versions directory not found: $versionsRoot"
}
$versionDir = Get-ChildItem $versionsRoot -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1
if (-not $versionDir) {
    throw "No QQ version directory found under $versionsRoot"
}
$appDir = Join-Path $versionDir.FullName "resources\app"
$dll = Join-Path $versionDir.FullName "QQNT.dll"
$package = Join-Path $appDir "package.json"
if (-not (Test-Path $dll) -or -not (Test-Path $package)) {
    throw "QQNT.dll or package.json missing under $($versionDir.FullName)"
}

Write-Host "QQ version : $($versionDir.Name)"
Write-Host "QQ app     : $appDir"
Write-Host "Loader dir : $LoaderDir"

if (-not (Test-Path (Join-Path $LoaderDir "polaris-loader.js"))) {
    throw "Loader files not found in $LoaderDir"
}
if (-not (Test-Path $LoaderConfig)) {
    if (-not $SelfId) {
        throw "Missing $LoaderConfig; pass -SelfId to create it."
    }
    if (-not $DryRun) {
        $config = [ordered]@{
            selfId = [long]$SelfId
            host = "127.0.0.1"
            port = $OneBotPort
            accessToken = ""
            nickname = "polaris-test"
        }
        New-Item -ItemType Directory -Force (Split-Path -Parent $LoaderConfig) | Out-Null
        $config | ConvertTo-Json | Set-Content -Path $LoaderConfig -Encoding ASCII
    }
}

$backupRoot = Join-Path $QQRoot ("polaris-backup\" + $versionDir.Name + "-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$alreadyPatched = (Test-Path "$dll.bak") -and ((Get-FileHash $dll -Algorithm SHA256).Hash -ne (Get-FileHash "$dll.bak" -Algorithm SHA256).Hash)
$patcherReady = $SkipPatcher -or $alreadyPatched

if ($DryRun) {
    Write-Host ""
    Write-Host "Dry run: no files will be changed."
    Write-Host "  already patched: $alreadyPatched"
    Write-Host "  patcher needed : $(-not $patcherReady)"
    if (-not $patcherReady -and $AutoPatch) {
        Write-Host "  auto patcher   : pinned 9.9.37 patch"
    } elseif (-not $patcherReady -and -not $PatcherPath) {
        Write-Host "  patcher path   : missing (-PatcherPath)"
    }
    exit 0
}

Write-Host "Stopping QQ..."
Get-Process QQ,QQEX -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

New-Item -ItemType Directory -Force $backupRoot | Out-Null
Copy-Item -LiteralPath $dll -Destination (Join-Path $backupRoot "QQNT.dll")
Copy-Item -LiteralPath $package -Destination (Join-Path $backupRoot "package.json")
Write-Host "Backup: $backupRoot"

if (-not $patcherReady) {
    if ($AutoPatch) {
        $autoPatcher = Join-Path $PSScriptRoot "patch-qqnt.ps1"
        if (-not (Test-Path $autoPatcher)) {
            throw "Built-in patcher not found: $autoPatcher"
        }
        Write-Host ""
        Write-Host "Applying pinned 9.9.37 patch (no GUI)..."
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $autoPatcher -DllPath $dll -Apply
        if ($LASTEXITCODE -ne 0) {
            throw "Built-in patcher failed; restore from $backupRoot if needed."
        }
        $patcherReady = $true
    } else {
        if (-not $PatcherPath -or -not (Test-Path $PatcherPath)) {
            throw "Patcher not found. Pass -PatcherPath, -AutoPatch, or -SkipPatcher if the DLL is already patched."
        }
        Write-Host ""
        Write-Host "The patcher is GUI-only (no CLI). Select this file in its dialog:"
        Write-Host "  $dll"
        $patcher = Start-Process -FilePath $PatcherPath -PassThru
        $patcher.WaitForExit()
        if (-not (Test-Path "$dll.bak")) {
            throw "Patcher did not create QQNT.dll.bak; restore from $backupRoot if needed."
        }
        $oldHash = (Get-FileHash (Join-Path $backupRoot "QQNT.dll") -Algorithm SHA256).Hash
        $newHash = (Get-FileHash $dll -Algorithm SHA256).Hash
        if ($oldHash -eq $newHash) {
            throw "QQNT.dll hash did not change; patching was not applied."
        }
        Write-Host "Patched QQNT.dll"
    }
}

$newPackage = Get-Content -LiteralPath $package -Raw | ConvertFrom-Json
$newPackage.main = "./app_launcher/polaris-loader.js"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($package, ($newPackage | ConvertTo-Json -Depth 20), $utf8NoBom)

$appLauncher = Join-Path $appDir "app_launcher"
New-Item -ItemType Directory -Force $appLauncher | Out-Null
Copy-Item -LiteralPath (Join-Path $LoaderDir "polaris-loader.js") -Destination $appLauncher -Force
Copy-Item -LiteralPath (Join-Path $LoaderDir "onebot.js") -Destination $appLauncher -Force
Copy-Item -LiteralPath (Join-Path $LoaderDir "image-size.js") -Destination $appLauncher -Force
$wsSource = Join-Path $LoaderDir "ws"
$wsTarget = Join-Path $appLauncher "ws"
if (Test-Path -LiteralPath $wsTarget) {
    Remove-Item -LiteralPath $wsTarget -Recurse -Force
}
Copy-Item -LiteralPath $wsSource -Destination $wsTarget -Recurse -Force

Write-Host ""
Write-Host "Installed:"
Write-Host "  $package -> ./app_launcher/polaris-loader.js"
Write-Host "  $appLauncher\polaris-loader.js"
Write-Host "  $appLauncher\onebot.js"
Write-Host "  $LoaderConfig"
Write-Host ""
Write-Host "Starting QQ..."
Start-Process -FilePath (Join-Path $QQRoot "QQ.exe")
Write-Host "Log in with the test account. The loader will open 127.0.0.1:$OneBotPort."
Write-Host "If QQ refuses to start, restore QQNT.dll and package.json from:"
Write-Host "  $backupRoot"
