@echo off
chcp 65001 >nul
title YouTube 字幕翻译 - 本地 LLM 桥接

cd /d "%~dp0"

echo.
echo   正在启动本地翻译桥接服务 (localhost:8788)...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 找不到 node，请先安装 Node.js
  pause
  exit /b 1
)

rem 如果已经在跑，就不用重复启动
netstat -ano | findstr ":8788" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo   [提示] 8788 端口已被占用，桥接可能已在运行。
  echo.
  node -e "fetch('http://localhost:8788/health').then(r=>r.json()).then(j=>console.log('   健康检查 OK:',JSON.stringify(j))).catch(e=>console.log('   健康检查失败:',e.message))" 2>nul
  echo.
  pause
  exit /b 0
)

echo   使用 OpenCode 本地模型，不消耗任何付费额度。
echo   翻译字幕期间请保持本窗口开启。
echo   按 Ctrl+C 可停止服务。
echo.

node server.mjs

echo.
echo   桥接服务已停止。
pause