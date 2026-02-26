# mcp-sync-server

## Installation

```bash
npm install
npm run build
npm start
```

For development with hot reload:
```bash
npm run dev
```

This project follows a strict sync-vs-async policy for MCP tools and workflows.

- Default interactive threshold: `N = 4s` (`p95`)
- If expected runtime exceeds `N` at `p95`, execution MUST go through async-tools/queue
- Sync responses for async work MUST return quickly with `job_id` + status/poll mechanism

Full policy: `LATENCY_POLICY.md`

Example diagnostic tool for this policy:
- `debug_sleep_auto` (auto-routes by budget)
  - sync path: returns inline result
  - async path: returns `job_id`, `status=running`, `status_tool=debug_sleep_async_get`

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

## Sync Fallback Via Existing Tools

If your connector schema does not expose direct `sync_*` tools yet, you can still run sync via:

1. `protocol_write_command`
2. `router_execute_command`

`protocol_write_command` accepts plain command strings and JSON command envelopes.

Examples:

- Outbound batch:
  `{"id":"job-1","command":"sync_outbound_once","batch_size":20}`
- Inbound batch:
  `{"id":"job-2","command":"sync_inbound_once","batch_size":20}`
- Sync status:
  `{"id":"job-3","command":"sync_status"}`
- Reconcile:
  `{"id":"job-4","command":"sync_reconcile"}`
- Enqueue inbound response:
  `{"id":"job-5","command":"enqueue_inbound_response_id","conversation_id":"default","response_id":"resp_123"}`

## Task Graph Fallback Via Existing Tools

If your connector schema does not expose direct `task_*` tools yet, call them through the same fallback path:

1. `protocol_write_command`
2. `router_execute_command`

Examples:

- Create node:
  `{"id":"job-t1","command":"task_create","project_id":"ai_platform","title":"Implement API bridge"}`
- Link node:
  `{"id":"job-t2","command":"task_link","task_id":"t1","depends_on":["t0"],"children":["t2"]}`
- Read graph:
  `{"id":"job-t3","command":"task_graph","project_id":"ai_platform"}`
- Generate plan:
  `{"id":"job-t4","command":"task_plan_generate","project_id":"ai_platform","goal":"Ship Layer 2 to prod","max_tasks":8}`
- Update status:
  `{"id":"job-t5","command":"task_status_update","task_id":"t1","status":"in_progress"}`

## Queue Contract For `project_task`

`router_execute_from_queue` now accepts both legacy and normalized payload shapes:

- Legacy:
  `{"task":"create_website","project_path":"C:/work/demo"}`
- Normalized command envelope:
  `{"command":"task_create","args":{"project_id":"ai_platform","title":"Implement API bridge"}}`
- Alternate normalized:
  `{"type":"task_plan_generate","input":{"project_id":"ai_platform","goal":"Ship Layer 2","max_tasks":8}}`

Supported routed commands in `project_task` handler:

- `create_website`
- `task_create`
- `task_link`
- `task_graph`
- `task_plan_generate`
- `task_status_update`
- `orchestrator_tick`
- `execution_bind_tick`
- `recovery_tick`
- `governance_get`
- `governance_set`
- `agent_registry`
- `agent_metrics_snapshot`
- `agent_version_create`
- `agent_version_activate`
- `evolution_tick`
- `shadow_evaluation_tick`
- `agent_dispatch_tick`
- `agent_run_task`

`task_create` also supports retry policy:

`"execution_policy": { "max_attempts": 3, "retry_delay_ms": 2000, "backoff_multiplier": 1 }`

`task_create` supports role-based routing:

`"role": "planner" | "dev" | "research" | "critic"`

## AI-Lab Relocation and Run Modes

Recommended layout:

```
C:\Users\anani\AI-Lab\
  core\mcp-sync-server
  state\_sync
  connectors\...
  ops\...
```

Use `SYNC_DIR` to decouple state from code:

```
SYNC_DIR=C:\Users\anani\AI-Lab\state\_sync
```

Mode switching:

- `LAB_MODE=offline` loads `.env.offline`
- `LAB_MODE=online` loads `.env.online`
- `.env.local` and `.env.local.secret` always override mode defaults

Ops scripts:

- `ops\migrate-ai-lab.ps1` - create/copy AI-Lab layout
- `ops\run-offline.ps1` - apply `.env.offline`, run dev server
- `ops\run-online.ps1` - apply `.env.online`, run dev server
- `ops\cloudflared-online.ps1` - start named tunnel

Experiment tools:

- `experiment_create`
- `experiment_run`
- `experiment_list`
- `experiment_compare`
- `experiment_leaderboard`
- `experiment_best`
- `experiment_search_tick`

Agent metrics/versioning tools:

- `agent_registry` (with optional `role`)
- `agent_metrics_snapshot` (with optional `role`)
- `agent_version_create` (`role` required; creates next version and can activate it)
- `agent_version_activate` (`role` + `version`, safe rollback/promotion control)
- `evolution_tick` (rule-based version creation, defaults to shadow mode)
- `shadow_evaluation_tick` (replay evaluation of shadow versions with auto promote/discard)
- `governance_get` / `governance_set` (global evolution constraints: caps, cooldown, replay minimums, promotion margin, rollback thresholds)
