# Good First Tasks

Use these as first community issues.  
Recommended labels: `good first issue`, `help wanted`.

## 1) Add JSON schema validation for `quality_tick` artifacts

### Scope
- Add schema file for `_sync/autogen_learning/quality_tick_latest.json`.
- Add a small validator script in `tests/`.

### Acceptance Criteria
1. Validator fails on malformed artifact.
2. Validator passes on current valid artifact example.
3. CI step includes schema check (non-blocking is acceptable for v1).

## 2) Add issue links in README for Pilot intake

### Scope
- Add explicit links to issue templates from `README.md`.

### Acceptance Criteria
1. README has direct links to `Pilot Request`, `Bug`, `Feature`.
2. Links resolve correctly in GitHub UI.

## 3) Add minimal API smoke test for `/health`

### Scope
- Add `tests/health_smoke.test.mjs` using built-in Node APIs.

### Acceptance Criteria
1. Test starts server (or mocks endpoint) and validates `200` + expected payload keys.
2. `npm test` remains green locally and in CI.

## 4) Add changelog bootstrap

### Scope
- Add `CHANGELOG.md` with Keep a Changelog format.
- Move `RELEASE_NOTES_v0.1.0.md` summary into changelog.

### Acceptance Criteria
1. `CHANGELOG.md` exists and includes `0.1.0`.
2. README references the changelog.

## 5) Add CI badge and release badge consistency check

### Scope
- Add tiny test to verify README contains CI badge and license badge.

### Acceptance Criteria
1. Test fails if badge links are broken/missing.
2. Test runs in `npm test`.
