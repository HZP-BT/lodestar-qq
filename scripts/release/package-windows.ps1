param(
    [string]$Version = "",
    [string]$OutputDir = "release",
    [switch]$IncludeNode,
    [string]$NodeVersion = "24.11.1"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Version) {
    $Version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
}

$outputRoot = Join-Path $root $OutputDir
$stageName = "lodestar-$Version-windows-x64"
$stage = Join-Path $outputRoot $stageName
$zipPath = Join-Path $outputRoot "$stageName.zip"
$sumPath = Join-Path $outputRoot "SHA256SUMS.txt"

New-Item -ItemType Directory -Force $outputRoot | Out-Null
if (Test-Path $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force $stage | Out-Null
New-Item -ItemType Directory -Force (Join-Path $stage "data") | Out-Null

Push-Location $root
try {
    Write-Host "Building packages..."
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }

    Write-Host "Bundling portable demo..."
    $bundle = Join-Path $stage "lodestar-demo.cjs"
    & pnpm exec esbuild scripts/dev-mock.mjs --bundle --platform=node --format=cjs `
        --target=node22 "--outfile=$bundle" --log-level=warning `
        --log-override:empty-import-meta=silent
    if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }
} finally {
    Pop-Location
}

Copy-Item -Path (Join-Path $root "packages\web\dist") -Destination (Join-Path $stage "web") -Recurse
Copy-Item -Path (Join-Path $root "README.md") -Destination $stage
Copy-Item -Path (Join-Path $root "LICENSE") -Destination $stage

$configSource = Join-Path $root "config"
$configTarget = Join-Path $stage "config"
New-Item -ItemType Directory -Force $configTarget | Out-Null
Get-ChildItem -Path $configSource -Filter "*.example.json" -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $configTarget
}

$launcher = @'
@echo off
setlocal
cd /d "%~dp0"
set "LODESTAR_DATA_DIR=%~dp0data"
set "LODESTAR_WEB_ROOT=%~dp0web"
if exist "%~dp0node.exe" (
  "%~dp0node.exe" "%~dp0lodestar-demo.cjs"
) else (
  node "%~dp0lodestar-demo.cjs"
)
if errorlevel 1 pause
'@
Set-Content -Path (Join-Path $stage "Lodestar-Demo.cmd") -Value $launcher -Encoding ASCII
Set-Content -Path (Join-Path $stage "data\README.txt") -Encoding ASCII -Value @'
Lodestar demo data is created here on first run.
Delete this directory to reset the local demo database and admin token.
'@

if ($IncludeNode) {
    Write-Host "Downloading Node v$NodeVersion for a self-contained release..."
    $nodeZip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
    $nodeExtract = Join-Path $env:TEMP "lodestar-node-v$NodeVersion"
    if (-not (Test-Path $nodeZip)) {
        Invoke-WebRequest -UseBasicParsing `
            -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" `
            -OutFile $nodeZip
    }
    if (Test-Path $nodeExtract) {
        Remove-Item -LiteralPath $nodeExtract -Recurse -Force
    }
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
    $nodeExe = Join-Path $nodeExtract "node-v$NodeVersion-win-x64\node.exe"
    if (-not (Test-Path $nodeExe)) { throw "node.exe not found in downloaded archive" }
    Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $stage "node.exe")
}

if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Write-Host "Creating $zipPath..."
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$zipName = Split-Path -Leaf $zipPath
$otherSums = @()
if (Test-Path $sumPath) {
    $otherSums = Get-Content -LiteralPath $sumPath |
        Where-Object { $_ -and ($_ -notmatch [regex]::Escape($zipName)) }
}
Set-Content -Path $sumPath -Value (@($otherSums) + "$hash  $zipName") -Encoding ASCII
Write-Host ""
Write-Host "Release package ready:"
Write-Host "  $zipPath"
Write-Host "  SHA256 $hash"
if ($IncludeNode) {
    Write-Host "  Bundled Node v$NodeVersion"
} else {
    Write-Host "  Node.js is required on PATH (>= 22.16.0)"
}
Write-Host "  Run Lodestar-Demo.cmd inside the extracted folder."
