$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$Python = "C:\Users\csrkzhu\miniconda3\envs\storage-monitor\python.exe"
$LogDir = Join-Path $ProjectRoot "logs"
$LogFile = Join-Path $LogDir "refresh-once.log"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Set-Location $ProjectRoot

$timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
"[$timestamp] Starting storage monitor refresh" | Tee-Object -FilePath $LogFile -Append

& $Python (Join-Path $ProjectRoot "monitor.py") --once 2>&1 | Tee-Object -FilePath $LogFile -Append

$exitCode = $LASTEXITCODE
$timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
"[$timestamp] Finished storage monitor refresh with exit code $exitCode" | Tee-Object -FilePath $LogFile -Append

exit $exitCode
