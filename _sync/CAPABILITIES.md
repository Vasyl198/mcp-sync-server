# AI‑Lab Capabilities (source of truth)

> IMPORTANT (for any agent / SWE session): **Before answering or taking action, first read this file** and then run `whoami`.

Last updated: 2026-02-24

## 1) Allowed filesystem roots (MCP_ALLOWED_ROOTS)

These are the only places the lab can read/write via MCP `fs` tool:

- `C:\\Users\\anani\\Projects`
- `C:\\Users\\anani\\.codeium\\windsurf`

If you need access to another folder, add it to `MCP_ALLOWED_ROOTS` in `C:\\Users\\anani\\Projects\\mcp-sync-server\\.env` and restart the server.

## 2) Windsurf MCP configuration

Windsurf MCP config file (readable/writable by the lab):

- `C:\\Users\\anani\\.codeium\\windsurf\\mcp_config.json`

Current expected state:

- Active MCP server: **`codex-chatgpt`** (`disabled: false`)
- `sync-core-local`: disabled (`disabled: true`)
- Remote URL in config: `https://mcp.pioneer-mcp.online/mcp`
- Auth header exists (Bearer token) — **DO NOT copy/paste tokens into notes/events**.

Backups live next to it as `mcp_config.json.bak_*`.

## 3) Command execution policy (MCP `exec` tool)

Execution is sandboxed and may block some commands.

### Tested
- ✅ `powershell` works
- ✅ `node` works
- ❌ `cmd` is blocked ("Command not allowed: cmd")

### Practical rules
- Prefer **PowerShell** for scripting.
- Always set `cwd` inside allowed roots.
- Keep timeouts reasonable; use queue/async patterns for long jobs.
- Avoid printing secrets/tokens to stdout/stderr.

If you want to expand allow/deny lists, adjust the server’s command policy (repo code/config) and retest.

## 4) Key tools available (high value)

- `whoami` — verify server + roots.
- `fs` — list/read/write files within roots.
- `exec` — run allowed commands (see policy above).
- `event_publish` / `event_list` — telemetry + handshake.
- `notes` — persistent journal.
- `tasks` — task tracking (create/list/status_update/orchestrator_tick...).
- `search_in_files` — grep-like search within roots.
- `sync` — sync engine status/reconcile.
- `patch_*`, `campaign`, `experiment`, `agent_*` — lab automation layer.

## 5) Mandatory boot sequence (do this at the start of every session)

1) `fs.read_content` this file: `...\\_sync\\CAPABILITIES.md`
2) Run `whoami`
3) Verify `roots` contains both allowed roots above
4) `fs.read_content` Windsurf config: `...\\mcp_config.json`
5) Publish handshake:
   - tool: `event_publish`
   - `type`: `client.handshake`
   - `source`: `windsurf.ai-lab-mode`
   - `payload` (no secrets):
     ```json
     {
       "client": "windsurf",
       "mode": "AI-Lab Mode",
       "active_mcp": "codex-chatgpt",
       "roots_ok": true,
       "ts": "<now>"
     }
     ```
6) Only then proceed with tasks / code changes.

## 6) When something looks "impossible"

If an agent says it cannot read/write/run something, it MUST:

- re-run `whoami` to confirm roots
- confirm the target path is inside roots
- if it’s a command: test via `exec` (prefer `powershell`), and update this file if policy changed
