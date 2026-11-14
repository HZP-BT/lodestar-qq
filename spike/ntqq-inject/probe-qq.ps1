param(
    [string]$InstallRoot = ""
)

# Read-only probe: no files are written, no process is touched.
$ErrorActionPreference = "Stop"

function Get-PeMachine {
    param([string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $reader = New-Object System.IO.BinaryReader($stream)
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            return "not-pe"
        }
        $stream.Position = 0x3C
        $e_lfanew = $reader.ReadInt32()
        $stream.Position = $e_lfanew
        if ($reader.ReadUInt32() -ne 0x00004550) {
            return "not-pe"
        }
        $machine = $reader.ReadUInt16()
        switch ($machine) {
            0x8664 { return "x64 (0x8664)" }
            0x014C { return "x86 (0x014C)" }
            0xAA64 { return "arm64 (0xAA64)" }
            default { return ("0x{0:X4}" -f $machine) }
        }
    }
    finally {
        $stream.Dispose()
    }
}

Write-Host "== registry =="
$keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Tencent\QQNT",
    "HKLM:\SOFTWARE\Tencent\QQNT",
    "HKCU:\SOFTWARE\Tencent\QQNT"
)
foreach ($key in $keys) {
    if (Test-Path $key) {
        $values = Get-ItemProperty $key
        Write-Host "$key"
        $values.PSObject.Properties |
            Where-Object { $_.Name -notlike "PS*" } |
            ForEach-Object { Write-Host ("  {0} = {1}" -f $_.Name, $_.Value) }
        if (-not $InstallRoot -and $values.Install) {
            $InstallRoot = $values.Install
        }
    }
}

if (-not $InstallRoot) {
    $InstallRoot = "C:\Program Files\Tencent\QQNT"
}

Write-Host ""
Write-Host "== install =="
Write-Host "root: $InstallRoot"
if (-not (Test-Path $InstallRoot)) {
    Write-Warning "install root not found"
    exit 0
}

$launcher = Join-Path $InstallRoot "QQ.exe"
if (Test-Path $launcher) {
    $item = Get-Item $launcher
    Write-Host ("launcher: {0} ({1:N0} bytes, {2})" -f $item.FullName, $item.Length, (Get-PeMachine $launcher))
}
else {
    Write-Warning "QQ.exe not found under install root"
}

$versionsDir = Join-Path $InstallRoot "versions"
if (Test-Path $versionsDir) {
    Write-Host ""
    Write-Host "== versions =="
    Get-ChildItem $versionsDir -Directory | ForEach-Object {
        $versionRoot = $_.FullName
        $packageJson = Join-Path $versionRoot "resources\app\package.json"
        $qqNtDll = Join-Path $versionRoot "QQNT.dll"
        $mainExe = Join-Path $versionRoot "QQ.exe"

        $info = [ordered]@{
            Folder = $_.Name
        }
        if (Test-Path $packageJson) {
            try {
                $pkg = Get-Content $packageJson -Raw | ConvertFrom-Json
                $info.AppVersion = $pkg.version
                $info.Main = $pkg.main
            }
            catch {
                $info.AppVersion = "package.json unreadable"
            }
        }
        if (Test-Path $qqNtDll) {
            $dll = Get-Item $qqNtDll
            $info.QQNT = ("{0:N0} bytes, {1}" -f $dll.Length, (Get-PeMachine $qqNtDll))
        }
        if (Test-Path $mainExe) {
            $exe = Get-Item $mainExe
            $info.Exe = ("{0:N0} bytes, {1}" -f $exe.Length, (Get-PeMachine $mainExe))
        }
        [pscustomobject]$info
    } | Format-List
}

Write-Host "== processes =="
Get-Process -Name QQ -ErrorAction SilentlyContinue |
    Select-Object Id, ProcessName, Path, StartTime |
    Format-Table -AutoSize

Write-Host "probe complete (read-only)"
