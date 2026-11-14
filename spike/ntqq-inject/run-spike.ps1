param(
    [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$build = Join-Path $root "build"
$target = Join-Path $build "target.exe"
$injector = Join-Path $build "injector.exe"
$payload = Join-Path $build "payload.dll"

foreach ($file in @($target, $injector, $payload)) {
    if (-not (Test-Path $file)) {
        throw "missing build output: $file (run build.ps1 first)"
    }
}

Write-Host "starting benign target..."
$targetProcess = Start-Process -FilePath $target -PassThru
try {
    Start-Sleep -Milliseconds 300
    Write-Host "target pid: $($targetProcess.Id)"
    Write-Host "running manual-map injector..."

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $injector
    $startInfo.Arguments = "$($targetProcess.Id) `"$payload`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $injectorProcess = New-Object System.Diagnostics.Process
    $injectorProcess.StartInfo = $startInfo

    try {
        $injectorProcess.Start() | Out-Null
    }
    catch {
        throw "failed to start injector (Windows Defender may be blocking it; see README): $($_.Exception.Message)"
    }

    # Read asynchronously so a hung injector hits the timeout below instead of
    # blocking forever on ReadToEnd.
    $stdoutTask = $injectorProcess.StandardOutput.ReadToEndAsync()
    $stderrTask = $injectorProcess.StandardError.ReadToEndAsync()
    if (-not $injectorProcess.WaitForExit($TimeoutSeconds * 1000)) {
        $injectorProcess.Kill()
        throw "injector timed out after $TimeoutSeconds seconds"
    }
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result

    if ($stdout) { Write-Host $stdout.TrimEnd() }
    if ($stderr) { Write-Host $stderr.TrimEnd() }

    if ($injectorProcess.ExitCode -ne 0) {
        throw "injector exit code $($injectorProcess.ExitCode)"
    }

    if ($stdout -notmatch "polaris-spike-payload-attached") {
        throw "payload did not signal through the named pipe"
    }

    if ($targetProcess.HasExited) {
        throw "target exited unexpectedly; manual mapping crashed it"
    }

    Write-Host "PASS: payload executed inside target and signaled via named pipe"
}
finally {
    if (-not $targetProcess.HasExited) {
        Stop-Process -Id $targetProcess.Id -Force
    }
}
