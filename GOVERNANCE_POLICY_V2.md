# Governance Policy v2

This file is the source of truth for self-heal arena governance tuning in this repository.

## Core Rules

1. Shadow floor baseline:
- `SHADOW_WEIGHT_FLOOR = 0.1` (never use legacy `0.35` floor).

2. Shadow total minimum:
- `SHADOW_TOTAL_MIN_FLOOR = 0.1` by default.

3. Stabilization cap:
- stabilization mode may cap shadow behavior via `stabilization.shadow_cap`.
- shadow base and shadow minimums must respect stabilization caps when active.

## Domain Targets (High-Entropy Domains)

- `top1_share_target >= 0.45`
- `domain_entropy_target <= 0.92`
- preferred zone: `domain_entropy <= 0.90`

## Self-Heal Domain Profile (Policy v2)

Per-domain apply profile for stressed/high-entropy domains:
- `max_strategies_per_domain = 3`
- `promotion_margin = 0.08`
- `arena_evaluation_window = 9`
- `arena_cooldown_ms = 30000`
- `ttl_ticks = 12` for RR campaigns with 2-domain allowlist

Fallback profile (only if profile above fails and GIHI remains healthy):
- `max_strategies_per_domain = 2` (temporary, TTL-scoped)

## Validation Protocol

For RR allowlist of two domains:
- run `12` ticks (each domain gets `6` exposures),
- checkpoints: `tick 6` and `tick 12`,
- evaluate per target domain:
  - `top1_share`,
  - `domain_entropy`,
  - `shadow_share`,
  - plus global safety: `gihi_delta_ultra >= 0`.

## Hotfix Record

Shadow floor hotfix:
- removed legacy shadow defaults around `0.35`,
- replaced with `0.1` baseline and stabilization-cap-aware behavior,
- validated with RR-12 campaign and domain metrics (`domain_entropy`, `top1_share`, `shadow_share`).

Recent validation reference:
- campaign: `cmp_validate_rr_max3_m08_w9_floor_1771836603031`
- observed at tick 12 on `small|low|low|p2`:
  - `domain_entropy = 0.898038`
  - `top1_share = 0.562919`
  - `shadow_share = 0.2`

