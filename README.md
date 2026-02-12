# mcp-sync-server

## Auth

Server-side Bearer auth is controlled by:

- `MCP_SYNC_TOKEN` - expected token value for `Authorization: Bearer <token>`
- `AUTH_ENABLED` - optional mode switch:
  - `true|1|on|enabled` -> auth forced on
  - `false|0|off|disabled` -> auth forced off (dev compatibility mode)
  - empty -> auto mode (enabled when `MCP_SYNC_TOKEN` is non-empty)

## Protected Routes

When auth is enabled, Bearer token is required for:

- `/mcp`
- `/messages`
- `/sse`
- `/sse-simple`
