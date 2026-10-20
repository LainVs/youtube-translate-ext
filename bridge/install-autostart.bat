@echo off
rem One-time installer: writes a hidden launcher into the user's Startup
rem folder and starts the bridge supervisor in the background.
rem Keep this file pure ASCII (see note in autostart-supervisor.bat).
title Install bridge autostart
cd /d "%~dp0"

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\yt-subtitle-bridge.vbs"

echo.
echo   ============================================
echo    YouTube subtitles - install autostart
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] node not found. Install Node.js 18+ first.
  echo.
  pause
  exit /b 1
)

if not exist "%STARTUP%" (
  echo   [ERROR] Startup folder not found: %STARTUP%
  echo.
  pause
  exit /b 1
)

rem Remove a stale stop flag from a previous uninstall.
del /f /q "%~dp0.supervisor-stop" >nul 2>nul

rem Write the hidden launcher (VBS runs the supervisor with no window).
> "%VBS%" echo ' YouTube subtitle bridge autostart (hidden, auto-restart on crash)
>>"%VBS%" echo ' Delete this file to disable, or run bridge\uninstall-autostart.bat
>>"%VBS%" echo CreateObject("WScript.Shell").Run """%~dp0autostart-supervisor.bat""", 0, False

echo   [OK] Startup entry written:
echo        %VBS%

netstat -ano | findstr /R /C:"LISTENING" | findstr /R /C:":8788 " >nul
if not errorlevel 1 (
  echo   [INFO] Bridge is already running - started manually.
  echo          The hidden supervisor takes over from the next login.
) else (
  echo   Starting bridge in background, hidden window...
  wscript.exe "%VBS%"
  timeout /t 3 /nobreak >nul
)

echo.
echo   Health check...
node -e "fetch('http://localhost:8788/health').then(r=>r.json()).then(j=>{console.log('   health OK: '+JSON.stringify(j).slice(0,300));process.exit(0)}).catch(e=>{console.log('   health FAILED: '+e.message);process.exit(1)})"
if errorlevel 1 (
  echo.
  echo   [ERROR] Health check failed. See log: %~dp0bridge.log
  echo.
  pause
  exit /b 1
)

echo.
echo   [DONE] Autostart installed. Bridge runs hidden after each login.
echo          To remove: run uninstall-autostart.bat
echo.
pause
