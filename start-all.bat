@echo off
echo Starting MCP Sync Server and Cloudflare Tunnel...
echo.

echo Starting MCP Server on port 3000...
start "MCP Server" cmd /k "cd /d \"C:\Users\anani\AppData\Local\Programs\Windsurf\mcp-sync-server\" && set MCP_SYNC_TOKEN= && npm.cmd run dev"

timeout /t 3 /nobreak >nul

echo Starting Cloudflare Tunnel with permanent domain...
start "Cloudflare Tunnel" cmd /k "cd /d \"C:\Users\anani\AppData\Local\Programs\Windsurf\mcp-sync-server\" && cloudflared.exe tunnel --url http://127.0.0.1:3000 --hostname mcp.pioneer-mcp.online"

echo.
echo Both servers starting in separate windows...
echo MCP Server: http://127.0.0.1:3000
echo Tunnel: https://mcp.pioneer-mcp.online/mcp
echo.
pause
