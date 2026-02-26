---
auto_execution_mode: 0
description: AI-Lab Mode — always use MCP lab tools (boot sequence + task/journal discipline)
---
# AI‑Lab Mode (Windsurf)

You are working inside Windsurf with a connected MCP server (the user’s AI‑Lab). Your job is to **always** use the MCP tools for state, files, tasks, and telemetry.

## Non‑negotiable rule
Before you answer or act, you MUST perform the **Boot Sequence** below. If any step fails, stop and report what failed.

## Boot Sequence (run at the start of every session AND whenever you suspect missing capabilities)

1) Read the source-of-truth capabilities file:
   - tool: `fs`
   - op: `read_content`
   - path: `C:\\Users\\anani\\Projects\\mcp-sync-server\\_sync\\CAPABILITIES.md`

2) Run:
   - tool: `whoami`

3) Verify:
   - `roots` includes:
     - `C:\\Users\\anani\\Projects`
     - `C:\\Users\\anani\\.codeium\\windsurf`

4) Read Windsurf MCP config:
   - tool: `fs`
   - op: `read_content`
   - path: `C:\\Users\\anani\\.codeium\\windsurf\\mcp_config.json`

5) Publish handshake telemetry (no secrets):
   - tool: `event_publish`
   - type: `client.handshake`
   - source: `windsurf.ai-lab-mode`
   - payload:
     ```json
     {
       "client": "windsurf",
       "mode": "AI-Lab Mode",
       "active_mcp": "codex-chatgpt",
       "roots_ok": true,
       "ts": "<now>"
     }
     ```

## Operating rules (after boot)

### 1) Always journal important steps
- Use `notes` to store:
  - what you changed
  - commands you ran (without secrets)
  - outcomes (pass/fail)

### 2) Always create/track tasks
- Use `tasks` to create a task for the user request.
- Update status as you work: `todo` → `in_progress` → `done` / `error`.

### 3) Validate with commands (when applicable)
- Use `exec` for build/test/run.
- Prefer `powershell` and `node` (see CAPABILITIES.md).
- Never attempt `cmd` if it’s blocked.

### 4) Telemetry
- Publish `event_publish` on start and finish of work:
  - `type`: `task.started` / `task.completed` / `task.failed`

### 5) If you think you cannot do something
Re-run Boot Sequence steps 1–3 and re-check CAPABILITIES.md.