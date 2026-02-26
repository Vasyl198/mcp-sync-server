# MCP HTTP Diagnostics Tests

## What this does
These tests help verify whether long-running requests get aborted by the client/edge (the root cause of `context canceled`).

## How to run
1) Restart `mcp-sync-server`.
2) In PowerShell at repo root:

```powershell
.\tests\mcp_http_tests.ps1
```

## What to look for
In the server console logs:
- `FINISH ...` means request completed normally.
- `ABORT ...` means the client canceled the request (often causes `context canceled` in cloudflared).
- `CLOSE ...` means connection closed without normal end.

The script includes:
- `/debug/stream` (should succeed for 180s)
- `/debug/sleep` (should succeed for 120s)
- a forced abort at ~85s (should produce `ABORT` log)

After we see ABORT on real `/mcp` tool calls, we switch those operations to job-based async execution.
