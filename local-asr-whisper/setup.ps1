param(
  [string]$PythonExe = "py",
  [string]$PythonVersionArg = "-3.11",
  [string]$VenvDir = ".venv"
)

$ErrorActionPreference = "Stop"

Write-Host "[1/4] Create virtual environment: $VenvDir"
$PythonArgs = @()
if ($PythonVersionArg) {
  $PythonArgs += $PythonVersionArg
}

try {
  $VersionOut = & $PythonExe @PythonArgs -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
  if ($LASTEXITCODE -ne 0) {
    throw "python launcher returned exit code $LASTEXITCODE"
  }
} catch {
  throw "Cannot launch Python with '$PythonExe $PythonVersionArg'. Install Python 3.11 and ensure 'py -3.11' works."
}

$VersionText = (($VersionOut | Select-Object -First 1) -as [string])
if (-not $VersionText) {
  throw "Cannot read Python version from '$PythonExe $PythonVersionArg'."
}
$VersionText = $VersionText.Trim()

$Parts = $VersionText.Split(".")
$Major = [int]$Parts[0]
$Minor = [int]$Parts[1]
if ($Major -ne 3 -or ($Minor -lt 10 -or $Minor -gt 11)) {
  throw "Python $VersionText is not recommended. Please install Python 3.10 or 3.11 and rerun setup."
}

& $PythonExe @PythonArgs -m venv $VenvDir

$Py = Join-Path $VenvDir "Scripts\\python.exe"
if (-not (Test-Path $Py)) {
  throw "python executable not found in venv: $Py"
}

Write-Host "[2/4] Upgrade pip/setuptools/wheel"
& $Py -m pip install --upgrade pip setuptools wheel

Write-Host "[3/4] Install dependencies"
& $Py -m pip install -r requirements.txt

Write-Host "[4/4] Done"
Write-Host ""
Write-Host "Quick start:"
Write-Host "  .\\start_quick.ps1"
Write-Host ""
Write-Host "Quality start:"
Write-Host "  .\\start_quality.ps1"
