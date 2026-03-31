param(
  [string]$CommitMessage = "chore: update EdgeScript Video Note Assistant"
)

$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/prophetricker/EdgeScript-Video-Note-Assistant.git"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Assert-GitInstalled {
  try {
    $null = git --version
  } catch {
    throw "Git is not installed. Please install Git for Windows first."
  }
}

function Assert-GitIdentity {
  $name = git config --get user.name
  $email = git config --get user.email
  if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($email)) {
    throw "Git identity is missing. Run: git config --global user.name ""Your Name"" and git config --global user.email ""you@example.com"""
  }
}

function Ensure-RepoInitialized {
  if (-not (Test-Path ".git")) {
    Write-Host "[INFO] Initialize repository..." -ForegroundColor Cyan
    git init | Out-Host
  }
}

function Ensure-MainBranch {
  $currentBranch = ""
  try {
    $currentBranch = git branch --show-current
  } catch {
    $currentBranch = ""
  }

  if ([string]::IsNullOrWhiteSpace($currentBranch)) {
    git checkout -b main | Out-Host
    return
  }

  if ($currentBranch -ne "main") {
    git branch -M main | Out-Host
  }
}

function Ensure-OriginRemote {
  $originUrl = ""
  try {
    $originUrl = git remote get-url origin 2>$null
  } catch {
    $originUrl = ""
  }

  if ([string]::IsNullOrWhiteSpace($originUrl)) {
    Write-Host "[INFO] Add remote origin..." -ForegroundColor Cyan
    git remote add origin $RepoUrl | Out-Host
    return
  }

  if ($originUrl -ne $RepoUrl) {
    Write-Host "[INFO] Update remote origin URL..." -ForegroundColor Cyan
    git remote set-url origin $RepoUrl | Out-Host
  }
}

function Commit-IfNeeded {
  Write-Host "[INFO] Stage files..." -ForegroundColor Cyan
  git add -A

  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[INFO] No staged changes. Skip commit." -ForegroundColor Yellow
    return
  }

  Write-Host "[INFO] Create commit..." -ForegroundColor Cyan
  git commit -m $CommitMessage | Out-Host
}

function Push-Main {
  Write-Host "[INFO] Push to GitHub (origin/main)..." -ForegroundColor Cyan
  git push -u origin main | Out-Host
}

Assert-GitInstalled
Assert-GitIdentity
Ensure-RepoInitialized
Ensure-MainBranch
Ensure-OriginRemote
Commit-IfNeeded
Push-Main

Write-Host "[DONE] Push completed: $RepoUrl" -ForegroundColor Green
