@echo off
rem Vibe Research portable package (Windows): double-click to start. Close this window to quit.
rem Keep this file ASCII-only: cmd.exe reads batch files in the OEM code page before chcp takes effect.
chcp 65001 >nul
cd /d "%~dp0"
rem Double-clicking the .cmd inside the zip runs it alone from a temp folder: the scripts next to it are missing.
if not exist "%~dp0scripts\portable\start-portable.ps1" (
  echo [Vibe Research] Unzip the whole package first: right-click the zip, choose "Extract All", then double-click Start-VibeResearch.cmd in the extracted folder.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\portable\start-portable.ps1" %*
set "code=%ERRORLEVEL%"
if not "%code%"=="0" (
  echo.
  echo [Vibe Research] exit code %code%. See the messages above.
  pause
)
exit /b %code%
