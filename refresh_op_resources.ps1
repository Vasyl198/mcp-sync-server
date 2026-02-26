$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

Write-Host "[1/3] Export tool schemas..."
node .\export_tool_schemas.mjs

Write-Host "[2/3] Refresh tools snapshot from running MCP server..."
powershell -ExecutionPolicy Bypass -File .\create_tools_snapshot.ps1

Write-Host "[3/3] Validate task_* presence in snapshot..."
$snapshotPath = if ($env:TOOLS_SNAPSHOT_PATH) { $env:TOOLS_SNAPSHOT_PATH } else { ".\_sync\tools_snapshot.json" }
if (-not (Test-Path $snapshotPath)) {
  throw "Snapshot file not found: $snapshotPath"
}

$snapshot = Get-Content -Raw -Path $snapshotPath | ConvertFrom-Json
$required = @("experiment_create", "experiment_run", "experiment_list", "experiment_compare", "experiment_leaderboard", "experiment_best", "experiment_search_tick", "task_create", "task_link", "task_graph", "task_plan_generate", "task_status_update", "orchestrator_tick", "execution_bind_tick", "recovery_tick", "governance_get", "governance_set", "agent_registry", "agent_metrics_snapshot", "agent_version_create", "agent_version_activate", "evolution_tick", "shadow_evaluation_tick", "agent_dispatch_tick")
$missing = @()
foreach ($name in $required) {
  if (-not ($snapshot.tools -contains $name)) {
    $missing += $name
  }
}

if ($missing.Count -gt 0) {
  Write-Host "Missing tools in snapshot: $($missing -join ', ')" -ForegroundColor Yellow
  exit 2
}

Write-Host "Snapshot contains all task_* tools." -ForegroundColor Green
Write-Host ""
Write-Host "Next step: restart/reload your connector op-resource process so api_tool re-reads schemas/snapshot."
