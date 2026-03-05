# MCP Sync Server

Production-oriented MCP server for local/edge AI workflows: tool routing, queue execution, task graph operations, and sync endpoints.

## Quick Start

```powershell
cd C:\Users\anani\Projects\mcp-sync-server
npm ci
npm run build
npm start
```

Server default:
- URL: `http://127.0.0.1:3000`
- Health: `GET /health`
- MCP: `/mcp`

## Auth

Bearer auth is controlled by:
- `MCP_SYNC_TOKEN` - expected token value for `Authorization: Bearer <token>`
- `AUTH_ENABLED`:
  - `true|1|on|enabled`: force auth on
  - `false|0|off|disabled`: force auth off (dev only)
  - empty: auto mode (on when token is set)

Protected routes when auth is enabled:
- `/mcp`
- `/messages`
- `/sse`
- `/sse-simple`

## Development

```powershell
npm run dev
```

## Build and Test

```powershell
npm run build
npm test
```

CI (`.github/workflows/ci.yml`) runs:
1. `npm ci`
2. `npm run build`
3. `npm test`
4. build artifact check (`dist/index.js`)

## Analysis Snapshots

![System Analysis](docs/assets/system-analysis.svg)
![Security Analysis](docs/assets/security-analysis.svg)

Example report artifacts:
- `_sync/autogen_learning/quality_tick_latest.json`
- `_sync/external_analysis/hook_probe_latest.json`
- `_sync/external_analysis/security_mode_latest.json`

## Tests Layout

Root-level test scripts were moved into `tests/` to keep repository root clean.

## Security

See `SECURITY.md` for vulnerability reporting and token hygiene requirements.

## Commercial Setup (Variant 1)

1. Generate a strong bearer token.
2. Set `AUTH_ENABLED=true`.
3. Set `MCP_ALLOWED_ROOTS` to the client repository root.
4. Set `MCP_ALLOWED_ORIGINS` to client domain + localhost.
5. Run security/token checks before release.

## License

MIT - see `LICENSE`.
