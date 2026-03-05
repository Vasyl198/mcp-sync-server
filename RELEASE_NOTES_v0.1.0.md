# Release Notes - v0.1.0

Date: 2026-03-05

## Summary

First public-facing release focused on production-readiness, security posture, and repository clarity.

## Included

- Public repository baseline:
  - `LICENSE` (MIT)
  - `SECURITY.md`
  - CI workflow (`.github/workflows/ci.yml`)
- Build stability fixes:
  - missing `src/*` modules aligned with `src/index.ts` imports
  - TypeScript build passing in CI
- Test pipeline baseline:
  - root test scripts moved to `tests/`
  - `npm test` added
  - smoke test: `tests/repo_smoke.test.mjs`
- README productization:
  - badges
  - architecture diagram (Mermaid)
  - quick demo and feature matrix
  - analysis snapshot visuals
  - commercial pilot/contact sections

## Operational Checks

- `npm run build`: PASS
- `npm test`: PASS
- CI workflow: configured for `npm ci`, build, test, artifact check

## Known Limits

- Security gate depth depends on available scanners and target hooks.
- Some advanced analysis scripts remain optional and environment-dependent.
- Commercial deployment hardening (branch protection, issue templates, intake automation) is not yet finalized.

## Next (v0.1.1)

- Add 3-5 `good first task` issues.
- Add issue templates (`pilot request`, `bug report`, `feature request`).
- Add progress report template and weekly KPI cadence.
- Publish first technical article and social launch post.
