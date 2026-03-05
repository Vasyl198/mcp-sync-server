param(
  [string]$Repo = "Vasyl198/mcp-sync-server"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function New-Issue([string]$Title, [string]$Body) {
  gh issue create `
    --repo $Repo `
    --title $Title `
    --body $Body `
    --label "good first issue" `
    --label "help wanted" | Out-Null
  Write-Host "Created: $Title"
}

$issues = @(
  @{
    Title = "Add JSON schema validation for quality_tick artifacts"
    Body = @"
Scope:
- Add schema file for `_sync/autogen_learning/quality_tick_latest.json`.
- Add a small validator script in `tests/`.

Acceptance Criteria:
1. Validator fails on malformed artifact.
2. Validator passes on current valid artifact example.
3. CI step includes schema check (non-blocking is acceptable for v1).
"@
  },
  @{
    Title = "Add direct issue links in README for Pilot/Bug/Feature templates"
    Body = @"
Scope:
- Add explicit, clickable links in `README.md` to issue templates.

Acceptance Criteria:
1. README has direct links to Pilot Request, Bug, Feature.
2. Links resolve correctly in GitHub UI.
"@
  },
  @{
    Title = "Add minimal API smoke test for /health"
    Body = @"
Scope:
- Add `tests/health_smoke.test.mjs` using built-in Node APIs.

Acceptance Criteria:
1. Test validates status `200` and expected payload keys.
2. `npm test` remains green locally and in CI.
"@
  },
  @{
    Title = "Add CHANGELOG.md bootstrap with v0.1.0"
    Body = @"
Scope:
- Add `CHANGELOG.md` using Keep a Changelog format.
- Move summary from `RELEASE_NOTES_v0.1.0.md`.

Acceptance Criteria:
1. `CHANGELOG.md` exists and includes `0.1.0`.
2. README references changelog.
"@
  },
  @{
    Title = "Add README badge consistency smoke test"
    Body = @"
Scope:
- Add a small test that verifies README includes CI and License badges.

Acceptance Criteria:
1. Test fails when badge links are removed/broken.
2. Test runs in `npm test`.
"@
  }
)

foreach ($it in $issues) {
  New-Issue -Title $it.Title -Body $it.Body
}

Write-Host "Done. Check issues: https://github.com/$Repo/issues"
