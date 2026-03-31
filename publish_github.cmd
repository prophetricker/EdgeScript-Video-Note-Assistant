@echo off
setlocal

set SCRIPT_DIR=%~dp0
set PS_SCRIPT=%SCRIPT_DIR%publish_github.ps1

if not exist "%PS_SCRIPT%" (
  echo [ERROR] 未找到 publish_github.ps1
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [FAILED] 推送失败，退出码：%EXIT_CODE%
  pause
  exit /b %EXIT_CODE%
)

echo.
echo [DONE] 推送完成。
pause
exit /b 0

