@echo off
echo Starting MCP Sync Server...
cd /d "C:\Users\anani\AppData\Local\Programs\Windsurf\mcp-sync-server"
set MCP_SYNC_TOKEN=
npm.cmd run dev
pause
