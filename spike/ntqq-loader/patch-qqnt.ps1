param(
    [string]$DllPath = "D:\qq\versions\9.9.37-54395\QQNT.dll",
    [switch]$Apply
)

$ErrorActionPreference = "Stop"

# Each entry is pinned to one QQ build and requires both the original and
# patched SHA256 to match. This script must not be used as a generic bypass;
# a new QQ build needs a fresh diff and a new entry.
$known = @{
    "cead5c2d4e1e1ffc953abd85dd8bd875087bf6b9c9c09f22909dbde376c467d7" = @{
        Version = "9.9.37-54395"
        Offset  = 0x510D08
        Before  = "e853dde601"
        After   = "b801000000"
        Patched = "bf8c1aa8ce80cdc84afe081e9f20d14c5d97430f0a6b9243e4903b95ea6e9c8c"
    }
}

function HexToBytes([string]$Hex) {
    $bytes = New-Object byte[] ($Hex.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        $bytes[$i] = [Convert]::ToByte($Hex.Substring($i * 2, 2), 16)
    }
    return $bytes
}

function BytesToHex([byte[]]$Bytes) {
    return (($Bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

if (-not (Test-Path -LiteralPath $DllPath)) {
    throw "DLL not found: $DllPath"
}

$hash = (Get-FileHash -LiteralPath $DllPath -Algorithm SHA256).Hash.ToLowerInvariant()
$patchedHashes = @($known.Values | ForEach-Object { $_.Patched })
if ($patchedHashes -contains $hash) {
    Write-Host "Already patched: $DllPath"
    Write-Host "SHA256: $hash"
    exit 0
}

$entry = $known[$hash]
if (-not $entry) {
    throw "Unsupported QQNT.dll hash $hash. Diff and add a pinned entry before patching."
}

$before = HexToBytes $entry.Before
$after = HexToBytes $entry.After

$backup = "$DllPath.bak"
if (-not (Test-Path -LiteralPath $backup)) {
    if ($Apply) {
        Copy-Item -LiteralPath $DllPath -Destination $backup
        Write-Host "Backup     : $backup"
    }
} elseif ((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) {
    throw "Existing backup has an unexpected hash: $backup"
}

$stream = [System.IO.File]::Open(
    $DllPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
)
try {
    $stream.Seek([int64]$entry.Offset, [System.IO.SeekOrigin]::Begin) | Out-Null
    $current = New-Object byte[] $before.Length
    [void]$stream.Read($current, 0, $current.Length)
    $currentHex = BytesToHex $current
    if ($currentHex -ne $entry.Before) {
        throw "Unexpected bytes at 0x$($entry.Offset.ToString('X')): $currentHex (expected $($entry.Before))"
    }

    Write-Host "QQ version : $($entry.Version)"
    Write-Host "DLL        : $DllPath"
    Write-Host "Offset     : 0x$($entry.Offset.ToString('X'))"
    Write-Host "Before     : $($entry.Before)"
    Write-Host "After      : $($entry.After)"

    if (-not $Apply) {
        Write-Host "Dry run: re-run with -Apply to write the patch."
        exit 0
    }

    $stream.Seek([int64]$entry.Offset, [System.IO.SeekOrigin]::Begin) | Out-Null
    $stream.Write($after, 0, $after.Length)
    $stream.Flush()
} finally {
    $stream.Dispose()
}

$newHash = (Get-FileHash -LiteralPath $DllPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($newHash -ne $entry.Patched) {
    throw "Patched hash mismatch: $newHash (expected $($entry.Patched)); restore $DllPath.bak"
}
Write-Host "Patched OK"
Write-Host "SHA256: $newHash"
