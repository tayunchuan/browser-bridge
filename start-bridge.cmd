@echo off
chcp 65001 >nul
setlocal
rem Start the browser bridge server. Keep this window open while you use it.
rem Usage: start-bridge.cmd [port]
rem
rem Optional: create bridge.config.cmd next to this file with a line like
rem   set "NODE=C:\path\to\node.exe"
rem to use a specific Node binary instead of the one in PATH.

set "NODE=node"
if exist "%~dp0bridge.config.cmd" call "%~dp0bridge.config.cmd"

if "%~1"=="" (set "BRIDGE_PORT=7233") else (set "BRIDGE_PORT=%~1")
"%NODE%" "%~dp0server.mjs" || (
  echo.
  echo [!] Failed to start. Node 18+ is required: https://nodejs.org
  pause
)
endlocal
