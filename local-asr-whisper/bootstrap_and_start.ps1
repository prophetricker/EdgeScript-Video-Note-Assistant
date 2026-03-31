param(
  [ValidateSet("quick", "quality")]
  [string]$Profile = "quick",
  [switch]$SkipPythonInstall,
  [switch]$SkipSetup,
  [switch]$ForcePythonReinstall
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "== Local Whisper Bootstrap =="
Write-Host "Profile: $Profile"
Write-Host ""

if (-not $SkipPythonInstall) {
  Write-Host "[1/3] Ensure Python 3.11 via winget..."
  & powershell -ExecutionPolicy Bypass -File ".\install_python311_winget.ps1" @(
    if ($ForcePythonReinstall) { "-ForceReinstall" }
  )
} else {
  Write-Host "[1/3] Skip Python install"
}

if (-not $SkipSetup) {
  Write-Host "[2/3] Setup venv and dependencies..."
  & powershell -ExecutionPolicy Bypass -File ".\setup.ps1" -PythonExe py -PythonVersionArg -3.11
} else {
  Write-Host "[2/3] Skip setup"
}

Write-Host "[3/3] Start ASR service..."
if ($Profile -eq "quality") {
  & powershell -ExecutionPolicy Bypass -File ".\start_quality.ps1"
} else {
  & powershell -ExecutionPolicy Bypass -File ".\start_quick.ps1"
}
