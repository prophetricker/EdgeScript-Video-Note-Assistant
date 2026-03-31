@echo off
setlocal

set SCRIPT_DIR=%~dp0
set PS_SCRIPT=%SCRIPT_DIR%build_release.ps1

if not exist "%PS_SCRIPT%" (
  echo [ERROR] build_release.ps1 not found.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [FAILED] Release build failed. Exit code: %EXIT_CODE%
  pause
  exit /b %EXIT_CODE%
)

echo.
echo [DONE] Release artifacts are ready in dist folder.
pause
exit /b 0

