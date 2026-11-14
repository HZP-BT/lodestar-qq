param(
    [switch]$Demo,
    [switch]$External
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tokenFile = Join-Path $root "data\demo\admin-token"

function Pause-Exit([int]$Code) {
    Read-Host "Press Enter to exit"
    exit $Code
}

function Ensure-Toolchain {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "Node.js >= 22.16 is required. Install it from https://nodejs.org/"
    }
    $version = (& $node.Source -v).TrimStart("v")
    if ([version]$version -lt [version]"22.16.0") {
        throw "Node.js >= 22.16 is required, found $version"
    }
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        throw "pnpm 10 is required. Run: npm install -g pnpm@10"
    }
}

function Ensure-Dependencies {
    if (-not (Test-Path (Join-Path $root "node_modules"))) {
        Write-Host "Installing dependencies..."
        Push-Location $root
        try {
            & pnpm install
            if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
        } finally {
            Pop-Location
        }
    }
    if (-not (Test-Path (Join-Path $root "packages\core\dist\index.js"))) {
        Write-Host "Building packages..."
        Push-Location $root
        try {
            & pnpm build
            if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
        } finally {
            Pop-Location
        }
    }
}

function Wait-ForToken {
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-Path $tokenFile) {
            $value = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
            if ($value) { return $value }
        }
        Start-Sleep -Seconds 1
    }
    return ""
}

function Start-Demo {
    Ensure-Toolchain
    Ensure-Dependencies
    Write-Host "Starting mock demo in a new PowerShell window..."
    $command = "`$env:LODESTAR_NO_OPEN='1'; Set-Location -LiteralPath '$root'; pnpm demo"
    Start-Process powershell.exe -ArgumentList @(
        "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command
    ) | Out-Null
    $token = Wait-ForToken
    if (-not $token) {
        throw "The demo did not start within 30 seconds. Check the demo window for errors."
    }
    Write-Host ""
    Write-Host "Lodestar demo: http://127.0.0.1:18081"
    Write-Host "Admin token: $token"
    Start-Process "http://127.0.0.1:18081"
}

function Start-Bootstrap {
    $bootstrap = Join-Path $PSScriptRoot "bootstrap-external.ps1"
    if (-not (Test-Path -LiteralPath $bootstrap)) {
        throw "Missing $bootstrap"
    }
    & $bootstrap
}

try {
    # Demo is development-only now. The default and -External path is the
    # one-click real backend: detect AstrBot, patch/install the loader, start QQ,
    # write config/upstream.json and launch Core.
    if ($Demo) {
        Start-Demo
        Pause-Exit 0
    }
    Start-Bootstrap
    Pause-Exit 0
} catch {
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Pause-Exit 1
}
