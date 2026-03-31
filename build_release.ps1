param(
  [string]$OutputDir = "dist",
  [switch]$Clean
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

function Ensure-File {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Required file not found: $Path"
  }
}

function Read-ExtensionVersion {
  $manifest = Get-Content -LiteralPath "manifest.json" -Raw | ConvertFrom-Json
  $version = [string]$manifest.version
  if ([string]::IsNullOrWhiteSpace($version)) {
    throw "manifest.json has no version field."
  }
  return $version.Trim()
}

function Read-AsrVersion {
  $serverPath = "local-asr-whisper\server.py"
  Ensure-File $serverPath
  $content = Get-Content -LiteralPath $serverPath -Raw
  $match = [regex]::Match($content, 'APP_VERSION\s*=\s*"([^"]+)"')
  if (-not $match.Success) {
    throw "Cannot parse APP_VERSION in local-asr-whisper/server.py"
  }
  return $match.Groups[1].Value.Trim()
}

function Ensure-CleanDir {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Path | Out-Null
}

function Copy-FilesToStage {
  param(
    [string]$BaseDir,
    [string[]]$RelativeFiles
  )
  foreach ($item in $RelativeFiles) {
    $src = Join-Path $RootDir $item
    Ensure-File $src
    $dest = Join-Path $BaseDir $item
    $destParent = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destParent)) {
      New-Item -ItemType Directory -Path $destParent | Out-Null
    }
    Copy-Item -LiteralPath $src -Destination $dest -Force
  }
}

function Write-HashFile {
  param(
    [string]$Path,
    [string[]]$Files
  )
  $lines = @()
  foreach ($f in $Files) {
    $hash = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
    $name = Split-Path -Leaf $f
    $lines += "$hash  $name"
  }
  Set-Content -LiteralPath $Path -Value ($lines -join [Environment]::NewLine) -Encoding utf8
}

$extVersion = Read-ExtensionVersion
$asrVersion = Read-AsrVersion

$outAbs = if ([System.IO.Path]::IsPathRooted($OutputDir)) { $OutputDir } else { Join-Path $RootDir $OutputDir }
$tmpDir = Join-Path $RootDir ".release-tmp"

if ($Clean -and (Test-Path -LiteralPath $outAbs)) {
  Remove-Item -LiteralPath $outAbs -Recurse -Force
}
if (-not (Test-Path -LiteralPath $outAbs)) {
  New-Item -ItemType Directory -Path $outAbs | Out-Null
}
Ensure-CleanDir $tmpDir

$extStageRoot = Join-Path $tmpDir "EdgeScript-extension"
$asrStageRoot = Join-Path $tmpDir "local-asr-whisper"
New-Item -ItemType Directory -Path $extStageRoot | Out-Null
New-Item -ItemType Directory -Path $asrStageRoot | Out-Null

$extensionFiles = @(
  "manifest.json",
  "background.js",
  "content-script.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "options.html",
  "options.css",
  "options.js",
  "README.md",
  "CHANGELOG.md",
  "LICENSE"
)

$asrFiles = @(
  "local-asr-whisper\README.md",
  "local-asr-whisper\requirements.txt",
  "local-asr-whisper\server.py",
  "local-asr-whisper\setup.ps1",
  "local-asr-whisper\start_quick.ps1",
  "local-asr-whisper\start_quality.ps1",
  "local-asr-whisper\bootstrap_and_start.ps1",
  "local-asr-whisper\bootstrap_and_start_quick.cmd",
  "local-asr-whisper\bootstrap_and_start_quality.cmd",
  "local-asr-whisper\install_python311_winget.ps1"
)

Copy-FilesToStage -BaseDir $extStageRoot -RelativeFiles $extensionFiles
Copy-FilesToStage -BaseDir $asrStageRoot -RelativeFiles $asrFiles

$extZip = Join-Path $outAbs ("EdgeScript-extension-v{0}.zip" -f $extVersion)
$asrZip = Join-Path $outAbs ("local-asr-whisper-v{0}.zip" -f $asrVersion)
$hashFile = Join-Path $outAbs "SHA256SUMS.txt"

if (Test-Path -LiteralPath $extZip) { Remove-Item -LiteralPath $extZip -Force }
if (Test-Path -LiteralPath $asrZip) { Remove-Item -LiteralPath $asrZip -Force }

Compress-Archive -Path (Join-Path $extStageRoot "*") -DestinationPath $extZip -CompressionLevel Optimal
Compress-Archive -Path (Join-Path $asrStageRoot "*") -DestinationPath $asrZip -CompressionLevel Optimal
Write-HashFile -Path $hashFile -Files @($extZip, $asrZip)

Remove-Item -LiteralPath $tmpDir -Recurse -Force

Write-Host ""
Write-Host "[DONE] Release artifacts generated:" -ForegroundColor Green
Write-Host "  $extZip"
Write-Host "  $asrZip"
Write-Host "  $hashFile"
Write-Host ""
Write-Host "Suggested tag: v$extVersion"

