@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0bootstrap_and_start.ps1" -Profile quick
endlocal
