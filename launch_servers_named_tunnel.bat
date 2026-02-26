@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo Starting MCP Sync Server...
echo.

REM Optional: stop Windows cloudflared service to avoid duplicate tunnel process
if /I "%STOP_CLOUDFLARED_SERVICE%"=="1" (
  echo STOP_CLOUDFLARED_SERVICE=1 -> attempting to stop Cloudflared service...
  sc query "Cloudflared" | findstr /I "RUNNING" >nul
  if not errorlevel 1 (
    sc stop "Cloudflared" >nul
    timeout /t 2 /nobreak >nul
  )
)

REM Detect running Cloudflared service (it may already hold metrics port)
set "CF_SERVICE_RUNNING=0"
sc query "Cloudflared" | findstr /I "RUNNING" >nul
if not errorlevel 1 (
  echo [WARN] Cloudflared Windows service is RUNNING. This script starts another cloudflared process.
  echo [WARN] To force single instance, stop service first:   sc stop Cloudflared
  echo [WARN] Or run this script as: set STOP_CLOUDFLARED_SERVICE=1 ^&^& launch_servers_named_tunnel.bat
  echo.
  set "CF_SERVICE_RUNNING=1"
)

REM 1) Start local MCP server
REM Stop previous MCP server on port 3000 if it is already running
set "MCP_PIDS="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ' '"`) do set "MCP_PIDS=%%P"
if not "%MCP_PIDS%"=="" (
  echo [WARN] Port 3000 is in use by PIDs: %MCP_PIDS%
  for %%P in (%MCP_PIDS%) do (
    echo Stopping PID %%P...
    taskkill /PID %%P /F >nul 2>&1
  )
  timeout /t 1 /nobreak >nul
)

echo Starting MCP Server on port 3000 from current directory...
start "MCP Server" cmd /k "cd /d ""%CD%"" && npm.cmd start"

timeout /t 3 /nobreak >nul

REM 2) Start Cloudflare NAMED tunnel (NOT quick tunnel)
if "%CF_SERVICE_RUNNING%"=="1" (
  echo Cloudflared service already running. Skipping tunnel process start.
) else (
  echo Starting Cloudflare Named Tunnel (mcp-sync)...
  echo Using config: %USERPROFILE%\.cloudflared\config.yml

  REM Get a fresh token each run (JWT line only; ignore cloudflared info logs)
  set "CF_TUNNEL_TOKEN="
  for /f "usebackq delims=" %%T in (`
    powershell -NoProfile -Command ^
      "$t = (cloudflared.exe tunnel token mcp-sync 2^>^&1 ^| Select-String -Pattern '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' ^| Select-Object -First 1).Line; ^
       if (-not $t) { exit 1 } else { $t }"
  `) do set "CF_TUNNEL_TOKEN=%%T"

  if "%CF_TUNNEL_TOKEN%"=="" (
    echo [ERROR] Could not obtain tunnel token. Make sure you are logged in: cloudflared tunnel login
    pause
    exit /b 1
  )

  REM Ensure log dir exists
  if not exist "%USERPROFILE%\.cloudflared\logs" mkdir "%USERPROFILE%\.cloudflared\logs"

  REM Pick a free metrics port (prefer 20241..20245), fallback to 20250
  set "METRICS_PORT="
  for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$ports=20241..20245; $busy=(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique); $free=($ports | Where-Object { $busy -notcontains $_ } | Select-Object -First 1); if(-not $free){$free=20250}; Write-Output $free"`) do set "METRICS_PORT=%%P"
  if "%METRICS_PORT%"=="" set "METRICS_PORT=20250"
  echo Using cloudflared metrics port: %METRICS_PORT%

  REM Force http2 protocol and prefer IPv4 on flaky networks + logging + metrics
  start "Cloudflare Tunnel" cmd /k ^
  "cloudflared.exe tunnel --config ""%USERPROFILE%\.cloudflared\config.yml"" ^
    --protocol http2 --edge-ip-version 4 ^
    --metrics 127.0.0.1:%METRICS_PORT% ^
    --loglevel info ^
    --logfile ""%USERPROFILE%\.cloudflared\logs\cloudflared.log"" ^
    run --token ""%CF_TUNNEL_TOKEN%"""
)

echo.
echo Both servers starting in separate windows...
echo MCP Server:  http://127.0.0.1:3000
echo Tunnel host: https://mcp.pioneer-mcp.online/
echo.
echo If you still see trycloudflare.com, you are running the old command:
echo   cloudflared tunnel --url ... --hostname ...
echo.
pause
