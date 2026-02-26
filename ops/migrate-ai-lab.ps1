param(
  [string]$SourceProjectsRoot = "C:\Users\anani\Projects",
  [string]$LabRoot = "C:\Users\anani\AI-Lab",
  [switch]$SkipStateCopy
)

$ErrorActionPreference = "Stop"

function Copy-Tree([string]$src, [string]$dst) {
  if (-not (Test-Path $src)) {
    Write-Host "Skip missing: $src"
    return
  }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  $null = robocopy $src $dst /E /R:1 /W:1 /NFL /NDL /NP /NJH /NJS
  if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed for $src -> $dst (exit $LASTEXITCODE)"
  }
}

$coreRoot = Join-Path $LabRoot "core"
$stateRoot = Join-Path $LabRoot "state"
$connectorsRoot = Join-Path $LabRoot "connectors"
$opsRoot = Join-Path $LabRoot "ops"

New-Item -ItemType Directory -Force -Path $coreRoot,$stateRoot,$connectorsRoot,$opsRoot | Out-Null

# Core
Copy-Tree (Join-Path $SourceProjectsRoot "mcp-sync-server") (Join-Path $coreRoot "mcp-sync-server")

# State (separate from core)
$srcState = Join-Path $SourceProjectsRoot "mcp-sync-server\_sync"
$dstState = Join-Path $stateRoot "_sync"
if (-not $SkipStateCopy) {
  Copy-Tree $srcState $dstState
} else {
  New-Item -ItemType Directory -Force -Path $dstState | Out-Null
}

# Connectors (optional, copied as-is)
Copy-Tree (Join-Path $SourceProjectsRoot "chatgpt_cascade_bridge") (Join-Path $connectorsRoot "chatgpt_cascade_bridge")
Copy-Tree (Join-Path $SourceProjectsRoot "mcp-bridge") (Join-Path $connectorsRoot "mcp-bridge")
Copy-Tree (Join-Path $SourceProjectsRoot "snake-mcp") (Join-Path $connectorsRoot "snake-mcp")

# Ops scripts from core template
$srcOps = Join-Path $SourceProjectsRoot "mcp-sync-server\ops"
if (Test-Path $srcOps) {
  Copy-Tree $srcOps $opsRoot
}

Write-Host ""
Write-Host "AI-Lab layout is ready:"
Write-Host "  $LabRoot"
Write-Host ""
Write-Host "Next:"
Write-Host "  1) Open $LabRoot\\core\\mcp-sync-server\\.env.local and set SYNC_DIR=$dstState"
Write-Host "  2) Run: $LabRoot\\ops\\run-offline.ps1   or   $LabRoot\\ops\\run-online.ps1"
