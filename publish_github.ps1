param(
  [string]$CommitMessage = "chore: update EdgeScript Video Note Assistant"
)

$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/prophetricker/EdgeScript-Video-Note-Assistant.git"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)][string]$Args,
    [Parameter(Mandatory = $true)][string]$Step
  )
  Write-Host "[GIT] git $Args" -ForegroundColor DarkGray
  & git @($Args.Split(" "))
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed: $Step (git $Args)"
  }
}

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
    Invoke-Git -Args "init" -Step "initialize repository"
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
    Invoke-Git -Args "checkout -b main" -Step "create main branch"
    return
  }

  if ($currentBranch -ne "main") {
    Invoke-Git -Args "branch -M main" -Step "rename branch to main"
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
    Invoke-Git -Args "remote add origin $RepoUrl" -Step "add origin remote"
    return
  }

  if ($originUrl -ne $RepoUrl) {
    Write-Host "[INFO] Update remote origin URL..." -ForegroundColor Cyan
    Invoke-Git -Args "remote set-url origin $RepoUrl" -Step "update origin remote"
  }
}

function Commit-IfNeeded {
  Write-Host "[INFO] Stage files..." -ForegroundColor Cyan
  Invoke-Git -Args "add -A" -Step "stage files"

  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[INFO] No staged changes. Skip commit." -ForegroundColor Yellow
    return
  }

  Write-Host "[INFO] Create commit..." -ForegroundColor Cyan
  & git commit -m $CommitMessage
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed: commit changes"
  }
}

function Push-Main {
  Write-Host "[INFO] Push to GitHub (origin/main)..." -ForegroundColor Cyan
  Invoke-Git -Args "push -u origin main" -Step "push to origin/main"
}

Assert-GitInstalled
Assert-GitIdentity
Ensure-RepoInitialized
Ensure-MainBranch
Ensure-OriginRemote
Commit-IfNeeded
Push-Main

Write-Host "[DONE] Push completed: $RepoUrl" -ForegroundColor Green
