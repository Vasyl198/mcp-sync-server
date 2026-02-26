# Latency Policy (Sync vs Async)

## Rule

Any tool invocation or workflow whose expected runtime exceeds `N` seconds at `p95` MUST run via async-tools (queued job).

The synchronous path MUST return within `N` seconds and include:
- `job_id`
- current `status` (`queued` or `running`)
- polling mechanism (`poll_url` or status tool)

Only operations proven to meet the `p95 <= N` bound are allowed inline.

## Default Thresholds

- Chat / interactive UI: `N = 4s` (project default)
- API integrations: `N = 5-10s` (based on client SLA/timeouts)
- Internal admin flows: `N = 10-20s` (if waiting is acceptable)

Decisions MUST be based on `p95/p99`, not averages.

## Mandatory Async Conditions

Operation MUST be async if any condition is true:
- expected runtime is greater than `N`
- runtime is highly variable
- external dependencies are involved (network APIs, third-party systems)
- operation includes retries/backoff/rate-limit handling
- high timeout risk exists (client, edge, tunnel, or upstream)

Typical async candidates:
- multi-step LLM/tool orchestration
- external API chains and web fetch/scraping
- heavy CPU or large file/data processing
- long DB/disk/cloud I/O jobs
- batch/report generation pipelines

## Exceptions

Sync may be allowed only when both are true:
- operation is transactionally required in a single response
- `p95 <= N` is still respected after optimization

If sync is still required for UX reasons, it MUST include:
- streaming or visible progress
- strict timeout
- graceful degradation/fallback

## Async Contract

### Immediate Response

- `job_id`
- `status`: `queued | running`
- optional `estimated_wait`
- status check method (`job_history_list`, dedicated status tool, or equivalent)

### Completion

- poll-based retrieval (`*_get` / status tool) and/or callback channel when available
- idempotent behavior for duplicate submissions
- result TTL and retention policy

## Reliability Requirements

- idempotency key support where applicable
- retries with bounded backoff
- best-effort cancellation
- queue depth and tail latency monitoring

Minimum observability:
- per-tool latency (`p50/p95/p99`)
- queue depth
- job success/error/cancel rates

## Implementation Notes for This Repo

- Use queue-backed execution for long jobs (`queue_push`, `queue_pop`, `queue_ack`, `router_execute_*`).
- Keep sync MCP tool handlers for fast operations only.
- For potentially long diagnostics, prefer async patterns similar to `debug_sleep_async_start` + `debug_sleep_async_get`.
