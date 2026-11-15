@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
if errorlevel 1 (
  echo.
  echo Kunne ikke oprette genveje.
  pause
  exit /b 1
)
echo.
pause
