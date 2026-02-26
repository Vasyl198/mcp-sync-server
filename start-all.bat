@echo off
echo Starting MCP Sync Server and Cloudflare Tunnel...
echo.

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

echo Starting MCP Server on port 3000...
start "MCP Server" cmd /k "cd /d ""C:\Users\anani\Projects\mcp-sync-server"" && npm.cmd start"

timeout /t 3 /nobreak >nul

echo Starting Cloudflare Tunnel with permanent domain...
start "Cloudflare Tunnel" cmd /k "cd /d ""C:\Users\anani\Projects\mcp-sync-server"" && cloudflared.exe tunnel --url http://127.0.0.1:3000 --hostname mcp.pioneer-mcp.online --protocol http2"

echo.
echo Both servers starting in separate windows...
echo MCP Server: http://127.0.0.1:3000
echo Tunnel: https://mcp.pioneer-mcp.online/mcp
echo.
pause
