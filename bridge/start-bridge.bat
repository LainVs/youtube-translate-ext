@echo off
chcp 65001 >nul
title YouTube Subtitle LLM Bridge
cd /d "%~dp0"

echo.
echo   ============================================
echo    YouTube Subtitle - Local LLM Bridge
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] node command not found.
  echo.
  echo   Please install Node.js 18+ from https://nodejs.org
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

rem Must match the LISTENING line exactly. Plain "findstr :8788"
rem also matches outbound client ports and falsely reports "already running".
netstat -ano | findstr /R /C:"LISTENING" | findstr /R /C:":8788 " >nul
if not errorlevel 1 (
  echo   [INFO] Port 8788 is already in use - bridge may already be running.
  echo.
  node -e "fetch('http://localhost:8788/health').then(r=>r.json()).then(j=>{console.log('   health OK: '+JSON.stringify(j))}).catch(e=>{console.log('   health FAILED: '+e.message)})"
  echo.
  echo   If the extension already translates fine, just close this window.
  echo.
  pause
  exit /b 0
)

echo   Starting bridge on http://localhost:8788 ...
echo.
echo   - Uses local OpenCode model, no paid quota consumed
echo   - Keep this window OPEN while translating subtitles
echo   - Press Ctrl+C to stop
echo   - Tired of manual start? Run install-autostart.bat once
echo     (auto-start hidden on login, auto-restart on crash)
echo.

node server.mjs
set EXITCODE=%errorlevel%

echo.
echo   ============================================
if "%EXITCODE%"=="0" (
  echo    Bridge stopped normally
) else (
  echo    Bridge exited with error code %EXITCODE%
  echo.
  echo   Common causes:
  echo     1. node older than v18 - please upgrade
  echo     2. port 8788 taken by another program
  echo     3. OpenCode CLI not on PATH
)
echo   ============================================
echo.
pause
