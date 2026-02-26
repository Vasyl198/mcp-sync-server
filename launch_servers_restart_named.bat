@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo Restarting MCP + Cloudflare named tunnel...
echo.

REM Run from this script directory
cd /d "%~dp0"

REM 1) Restart MCP side: stop any process listening on port 3000
set "MCP_PIDS="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ' '"`) do set "MCP_PIDS=%%P"
if not "%MCP_PIDS%"=="" (
  echo [INFO] Stopping MCP process PIDs on port 3000: %MCP_PIDS%
  for %%P in (%MCP_PIDS%) do taskkill /PID %%P /F >nul 2>&1
  timeout /t 1 /nobreak >nul
)

REM 2) Restart tunnel side: stop service and old cloudflared processes
sc query "Cloudflared" >nul 2>&1
if not errorlevel 1 (
  sc query "Cloudflared" | findstr /I "RUNNING" >nul
  if not errorlevel 1 (
    echo [INFO] Stopping Cloudflared Windows service...
    sc stop "Cloudflared" >nul
    timeout /t 2 /nobreak >nul
  )
)
taskkill /IM cloudflared.exe /F >nul 2>&1

REM 3) Start MCP server in its own window
echo Starting MCP Server window...
start "MCP Server" cmd /k "cd /d ""%~dp0"" && npm.cmd start"

timeout /t 3 /nobreak >nul

REM 4) Start named tunnel in its own window (NOT quick tunnel)
echo Getting token for named tunnel: mcp-sync
set "CF_TUNNEL_TOKEN="
for /f "usebackq delims=" %%T in (`cloudflared.exe tunnel token mcp-sync 2^>nul`) do (
  set "CF_TUNNEL_TOKEN=%%T"
  goto :token_ready
)

:token_ready

if "%CF_TUNNEL_TOKEN%"=="" (
  echo [ERROR] Could not get tunnel token. Run: cloudflared tunnel login
  pause
  exit /b 1
)

if not exist "%USERPROFILE%\.cloudflared\logs" mkdir "%USERPROFILE%\.cloudflared\logs"

echo Starting Cloudflare Named Tunnel window...
start "Cloudflare Named Tunnel" cmd /k ^
"cloudflared.exe tunnel --config ""%USERPROFILE%\.cloudflared\config.yml"" ^
  --protocol http2 --edge-ip-version 4 ^
  --loglevel info ^
  --logfile ""%USERPROFILE%\.cloudflared\logs\cloudflared.log"" ^
  run --token ""%CF_TUNNEL_TOKEN%"""

echo.
echo Restart complete. Two windows started:
echo 1) MCP Server
echo 2) Cloudflare Named Tunnel (mcp-sync)
echo.
echo MCP URL:    http://127.0.0.1:3000
echo Public URL: https://mcp.pioneer-mcp.online/
echo.
pause
