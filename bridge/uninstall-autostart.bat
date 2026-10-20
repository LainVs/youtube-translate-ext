@echo off
rem Remove the Startup entry and stop the bridge (supervisor included).
rem Keep this file pure ASCII (see note in autostart-supervisor.bat).
title Remove bridge autostart

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\yt-subtitle-bridge.vbs"

echo.
echo   ============================================
echo    YouTube subtitles - remove autostart
echo   ============================================
echo.

if exist "%VBS%" (
  del /f /q "%VBS%" >nul 2>nul
  echo   [OK] Startup entry removed
) else (
  echo   [INFO] Startup entry was not present
)

rem Stop flag: the supervisor exits on its next loop instead of restarting.
> "%~dp0.supervisor-stop" echo stop

rem Best effort: kill the supervisor console by its window title.
taskkill /F /FI "WINDOWTITLE eq YTSubtitleBridgeSupervisor" >nul 2>nul

rem Kill whatever listens on 8788; repeat a few times in case the supervisor
rem is mid-restart. It will see the stop flag and exit on its own.
for /L %%I in (1,1,8) do (
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:"LISTENING" ^| findstr /R /C:":8788 "') do taskkill /F /PID %%P >nul 2>nul
  timeout /t 1 /nobreak >nul
)

rem The supervisor deletes the flag itself; if it is still there, it was not running.
if exist "%~dp0.supervisor-stop" del /f /q "%~dp0.supervisor-stop" >nul 2>nul

netstat -ano | findstr /R /C:"LISTENING" | findstr /R /C:":8788 " >nul
if errorlevel 1 (
  echo   [DONE] Bridge stopped, autostart removed
) else (
  echo   [WARN] Port 8788 is still listening - another program?
)
echo.
pause
