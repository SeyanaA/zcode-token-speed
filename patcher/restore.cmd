@echo off
tasklist /FI "IMAGENAME eq ZCode.exe" 2>nul | find /I "ZCode.exe" >nul
if not errorlevel 1 (
  echo 请先完全退出 ZCode（包括托盘图标），再运行此还原脚本。
  pause
  exit /b 1
)
node "%~dp0restore.mjs"
pause
