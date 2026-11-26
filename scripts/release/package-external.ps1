param(
    [string]$OutputDir = "release-external",
    [string]$NodeVersion = "24.11.1"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutputDir -or $OutputDir.Length -lt 3) {
    throw "OutputDir is required"
}
$out = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir
} else {
    Join-Path $root $OutputDir
}

if (Test-Path -LiteralPath $out) {
    Remove-Item -LiteralPath $out -Recurse -Force
}
New-Item -ItemType Directory -Force $out | Out-Null
New-Item -ItemType Directory -Force (Join-Path $out "config") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $out "data") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $out "web") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $out "node_modules") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $out "spike\ntqq-loader") | Out-Null

Push-Location $root
try {
    Write-Host "Building packages..."
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }

    Write-Host "Bundling external runtime..."
    $bundle = Join-Path $out "lodestar-external.cjs"
    & pnpm exec esbuild scripts/upstream.mjs --bundle --platform=node --format=cjs `
        --target=node22 "--outfile=$bundle" --log-level=warning `
        --log-override:empty-import-meta=silent
    if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }
} finally {
    Pop-Location
}

Copy-Item -Path (Join-Path $root "packages\web\dist\*") -Destination (Join-Path $out "web") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root "config\upstream.example.json") -Destination (Join-Path $out "config") -Force
Copy-Item -LiteralPath (Join-Path $root "config\send-guard.example.json") -Destination (Join-Path $out "config") -Force
Copy-Item -Path (Join-Path $root "spike\ntqq-loader\*") -Destination (Join-Path $out "spike\ntqq-loader") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root "scripts\windows\bootstrap-external.ps1") -Destination (Join-Path $out "bootstrap-external.ps1") -Force
Copy-Item -LiteralPath (Join-Path $root "docs\quickstart.md") -Destination (Join-Path $out "README.md") -Force

$wsRoot = Get-ChildItem -LiteralPath (Join-Path $root "node_modules\.pnpm") -Directory -Filter "ws@*" |
    Select-Object -First 1
if (-not $wsRoot) { throw "ws package not found; run pnpm install first" }
$wsSource = Join-Path $wsRoot.FullName "node_modules\ws"
Copy-Item -LiteralPath $wsSource -Destination (Join-Path $out "node_modules\ws") -Recurse -Force

$nodeExe = Get-ChildItem -LiteralPath (Join-Path $root "release") -Directory -Filter "lodestar-*-windows-x64" -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName "node.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
$nodeZip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
$nodeExtract = Join-Path $env:TEMP "lodestar-node-v$NodeVersion"
if ($nodeExe -and (Test-Path -LiteralPath $nodeExe)) {
    Write-Host "Copying bundled node.exe from the release stage..."
    Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $out "node.exe") -Force
} else {
    Write-Host "Downloading Node v$NodeVersion..."
    if (-not (Test-Path -LiteralPath $nodeZip)) {
        Invoke-WebRequest -UseBasicParsing `
            -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" `
            -OutFile $nodeZip
    }
    if (Test-Path -LiteralPath $nodeExtract) {
        Remove-Item -LiteralPath $nodeExtract -Recurse -Force
    }
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
    $downloaded = Join-Path $nodeExtract "node-v$NodeVersion-win-x64\node.exe"
    if (-not (Test-Path -LiteralPath $downloaded)) { throw "node.exe not found in archive" }
    Copy-Item -LiteralPath $downloaded -Destination (Join-Path $out "node.exe") -Force
}

$nodeLicense = Join-Path $out "NODE-LICENSE.txt"
$licenseCandidates = @(
    (Join-Path $nodeExtract "node-v$NodeVersion-win-x64\LICENSE"),
    (Join-Path $env:TEMP "node-v$NodeVersion-win-x64\LICENSE")
)
$licenseFound = $false
foreach ($candidate in $licenseCandidates) {
    if (Test-Path -LiteralPath $candidate) {
        Copy-Item -LiteralPath $candidate -Destination $nodeLicense -Force
        $licenseFound = $true
        break
    }
}
if (-not $licenseFound -and (Test-Path -LiteralPath $nodeZip)) {
    $licenseTemp = Join-Path $env:TEMP "lodestar-node-license"
    if (Test-Path -LiteralPath $licenseTemp) {
        Remove-Item -LiteralPath $licenseTemp -Recurse -Force
    }
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $licenseTemp -Force
    $candidate = Join-Path $licenseTemp "node-v$NodeVersion-win-x64\LICENSE"
    if (Test-Path -LiteralPath $candidate) {
        Copy-Item -LiteralPath $candidate -Destination $nodeLicense -Force
        $licenseFound = $true
    }
    Remove-Item -LiteralPath $licenseTemp -Recurse -Force
}
if (-not $licenseFound) {
    try {
        Invoke-WebRequest -UseBasicParsing `
            -Uri "https://raw.githubusercontent.com/nodejs/node/v$NodeVersion/LICENSE" `
            -OutFile $nodeLicense
    } catch {
        Set-Content -Path $nodeLicense -Encoding ASCII -Value @"
Node.js v$NodeVersion is distributed under the Node.js license:
https://github.com/nodejs/node/blob/v$NodeVersion/LICENSE
"@
    }
}

$launcher = @'
@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap-external.ps1"
echo.
pause
'@
Set-Content -Path (Join-Path $out "Lodestar-Setup.cmd") -Value $launcher -Encoding ASCII

$start = @'
Lodestar（Windows x64）安装包

1. 确认已安装 QQ 9.9.37-54395 和 AstrBot（安装器会自动查找目录）。
2. 双击 Lodestar-Setup.cmd。
3. 允许 UAC，并在弹出的 QQ 窗口登录测试号。
4. 面板：http://127.0.0.1:18081；管理 token 在 setup 窗口打印。

完整说明、SendGuard 配置、故障排查和回滚见 README.md。
'@
Set-Content -Path (Join-Path $out "START-HERE.txt") -Value $start -Encoding UTF8

Copy-Item -LiteralPath (Join-Path $root "LICENSE") -Destination $out -Force

Write-Host ""
Write-Host "Installer package ready:"
Write-Host "  $out"
Write-Host "  node.exe: $(Test-Path (Join-Path $out 'node.exe'))"
Write-Host "  bundle:   $(Test-Path (Join-Path $out 'lodestar-external.cjs'))"
Write-Host "  loader:   $(Test-Path (Join-Path $out 'spike\ntqq-loader\install-native.ps1'))"
Write-Host "  ws:       $(Test-Path (Join-Path $out 'node_modules\ws\index.js'))"
