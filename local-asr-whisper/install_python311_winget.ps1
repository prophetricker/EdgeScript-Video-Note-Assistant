param(
  [switch]$ForceReinstall
)

$ErrorActionPreference = "Stop"

function Test-Py311 {
  try {
    $null = & py -3.11 -c "import sys; print(sys.version)"
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

if ((Test-Py311) -and (-not $ForceReinstall)) {
  Write-Host "Python 3.11 already available via 'py -3.11'."
  exit 0
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget not found. Please install App Installer from Microsoft Store first."
}

Write-Host "Installing Python 3.11 via winget..."
& winget install --id Python.Python.3.11 -e --source winget --scope user --accept-package-agreements --accept-source-agreements

if (-not (Test-Py311)) {
  throw "Python 3.11 install finished but 'py -3.11' is still unavailable. Open a new terminal and retry."
}

Write-Host "Python 3.11 installation OK."
