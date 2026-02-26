# MCP Local Agent Capability Registry

Project: mcp-sync-server
Location: C:\Users\anani\Projects\mcp-sync-server
Role: Autonomous Local AI Agent

---

## 1. Core Role

This server acts as a Local Execution Agent for MCP-compatible clients (Windsurf / ChatGPT).
It provides secure access to:
- File system
- Command execution
- Cloudflare tunnel monitoring
- Task queue
- Diagnostics
- Persistent memory

Architecture:
ChatGPT -> MCP -> mcp-sync-server -> OS

---

## 2. File System Tools

### fs_list
List files and folders.
Args:
- dir
- limit

### fs_read
Read file content.
Args:
- path
- max_bytes

### fs_write
Create or overwrite files.
Args:
- path
- content
- create

### fs_mkdir
Create directories.
Args:
- path

### fs_exists
Check file/folder existence.
Args:
- path

### search_in_files
Search text in files.
Args:
- root
- query

---

## 3. Command Execution

### exec
Execute system commands.
Args:
- cmd
- args
- cwd
- timeout_ms

### router_execute_command
Execute routed commands via MCP.

---

## 4. Queue / Background Jobs

### queue_push
Add job to execution queue.

### queue_pop
Retrieve next job.

### queue_ack
Acknowledge job completion.

### router_execute_from_queue
Execute queued jobs.

Used for autonomous background execution.

---

## 5. Memory & State

### notes_upsert
Store persistent notes.

### notes_list
List notes.

### tasks_create
Create long-running tasks.

### tasks_list
List tasks.

### events_log
Log internal events.

---

## 6. Diagnostics

### diag_recent_requests
Shows recent MCP requests.

Fields:
- timestamp
- method
- status
- durationMs
- toolName
- error
- cfRay

### diag_snapshot
Full system snapshot.

### tunnel_metrics
Cloudflared Prometheus metrics.

### tunnel_log_tail
Tail cloudflared logs.

---

## 7. Cloudflare Tunnel

Monitored via:
- tunnel_metrics
- tunnel_log_tail

Common errors:
- context canceled
- Failed to proxy HTTP

Usually caused by:
- Client disconnect
- Edge reconnect
- SSE timeout

---

## 8. Security Model

- Root directories are restricted
- Auth can be enabled/disabled
- MCP session required
- SSE heartbeat enabled

---

## 9. Autonomous Agent Mode (Planned)

Future extensions:
- agent_loop
- agent_run
- agent_health
- agent_self_heal

These will enable:
- Self-monitoring
- Auto-restart
- Auto-fix
- Scheduled jobs

---

## 10. Limitations

- Depends on MCP client
- UI-level OpenAI limits may apply
- Network stability affects tunnel
- Windows permissions apply

---

## 11. Best Practices

- Use queue for long jobs
- Enforce `p95` latency threshold (`N=4s` default for interactive flows)
- If `p95 > N`, return fast with `job_id` and move execution to async queue/worker
- Prefer fs_write over manual edits
- Monitor tunnel regularly
- Use diag_snapshot after failures

Policy reference: `LATENCY_POLICY.md`

---

Maintained by: anani + AI Agent
Purpose: Prevent capability loss and confusion
