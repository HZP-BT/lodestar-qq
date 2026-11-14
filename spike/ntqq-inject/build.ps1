param(
    [string]$Zig = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root "src"
$build = Join-Path $root "build"

if (-not (Test-Path $build)) {
    New-Item -ItemType Directory -Path $build | Out-Null
}

if ([string]::IsNullOrWhiteSpace($Zig)) {
    $candidates = @()
    $command = Get-Command zig -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
        $candidates += $command.Source
    }
    $candidates += Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\zig.zig_Microsoft.Winget.Source_8wekyb3d8bbwe\zig-x86_64-windows-0.17.1\zig.exe"

    $Zig = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $Zig) {
        throw "zig not found; install with: winget install zig.zig"
    }
}

Write-Host "zig: $Zig"
& $Zig version
if ($LASTEXITCODE -ne 0) {
    throw "zig version failed"
}

function Invoke-Zig {
    param([string[]]$Arguments)
    Write-Host "zig cc $($Arguments -join ' ')"
    & $Zig cc @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "zig cc failed with exit code $LASTEXITCODE"
    }
}

Invoke-Zig @(
    "-target", "x86_64-windows-gnu",
    "-O2",
    "-o", (Join-Path $build "target.exe"),
    (Join-Path $src "target.c")
)

Invoke-Zig @(
    "-target", "x86_64-windows-gnu",
    "-O2",
    "-o", (Join-Path $build "injector.exe"),
    (Join-Path $src "injector.c")
)

# Manual-map payload: custom entry, no CRT, kernel32 only. This keeps the
# manual mapper from having to satisfy UCRT imports or run TLS callbacks.
Invoke-Zig @(
    "-target", "x86_64-windows-gnu",
    "-O2",
    "-shared",
    "-nostdlib",
    "-Wl,--entry,payload_main",
    "-lkernel32",
    "-o", (Join-Path $build "payload.dll"),
    (Join-Path $src "payload.c")
)

Write-Host ""
Get-ChildItem $build | Select-Object Name, Length | Format-Table
