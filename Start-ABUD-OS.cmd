@echo off
rem Double-click to start ABUD FUN Company OS. Other actions: Start-ABUD-OS.cmd status ^| stop ^| restart ^| shortcut ^| autostart-on ^| autostart-off ^| autostart-status  (add -Force to stop/restart an unresponsive instance)
setlocal
if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ABUD-OS.ps1" -Action start
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ABUD-OS.ps1" -Action %*
)
if errorlevel 1 pause
