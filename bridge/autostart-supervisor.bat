@echo off
rem Supervisor: starts server.mjs and restarts it 5s after it exits.
rem Launched hidden by the VBS in the Startup folder (install-autostart.bat).
rem Can also be started manually (a console window will be visible).
rem
rem NOTE: keep this file pure ASCII. Batch files with UTF-8 Chinese text
rem get mis-parsed by cmd.exe (GBK codepage), which shreds commands.
title YTSubtitleBridgeSupervisor
cd /d "%~dp0"

set "LOG=%~dp0bridge.log"

rem Keep the log under 5MB (type nul > file truncates it).
if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF gtr 5242880 type nul > "%LOG%"

where node >nul 2>nul
if errorlevel 1 (
  echo [%date% %time%] node not found, supervisor exits >> "%LOG%"
  exit /b 1
)

rem If 8788 is already in use (e.g. another autostart instance), yield.
netstat -ano | findstr /R /C:"LISTENING" | findstr /R /C:":8788 " >nul
if not errorlevel 1 (
  echo [%date% %time%] port 8788 already in use, supervisor yields >> "%LOG%"
  exit /b 0
)

echo [%date% %time%] supervisor started >> "%LOG%"

:loop
echo [%date% %time%] starting server.mjs >> "%LOG%"
node server.mjs >> "%LOG%" 2>&1
echo [%date% %time%] bridge exited, code %errorlevel%, restart check in 5s >> "%LOG%"
timeout /t 5 /nobreak >nul
rem Stop flag: uninstall-autostart.bat creates it before killing the bridge.
if exist "%~dp0.supervisor-stop" (
  del /f /q "%~dp0.supervisor-stop" >nul 2>nul
  echo [%date% %time%] stop flag found, supervisor exits >> "%LOG%"
  exit /b 0
)
rem Another instance grabbed the port while we waited: yield instead of looping.
netstat -ano | findstr /R /C:"LISTENING" | findstr /R /C:":8788 " >nul
if not errorlevel 1 (
  echo [%date% %time%] port 8788 taken by another instance, supervisor yields >> "%LOG%"
  exit /b 0
)
goto loop
