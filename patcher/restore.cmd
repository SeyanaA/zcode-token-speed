@echo off
tasklist /FI "IMAGENAME eq ZCode.exe" 2>nul | find /I "ZCode.exe" >nul
if not errorlevel 1 (
  echo Fully quit ZCode including the tray icon, then run this restore script again.
  pause
  exit /b 1
)
node "%~dp0restore.mjs"
pause
