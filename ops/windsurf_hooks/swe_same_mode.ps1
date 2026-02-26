param(
  [Parameter(Mandatory = $true)]
  [string]$Message,
  [string]$SessionId = "same-mode",
  [int]$WaitMs = 1800
)

$ErrorActionPreference = "Stop"
$root = "C:\Users\anani\Projects\mcp-sync-server"
$bridge = Join-Path $root "ops\windsurf_hooks\windsurf_bridge.ps1"

if (-not (Test-Path $bridge)) {
  throw "Bridge script not found: $bridge"
}

$send = & powershell -NoProfile -ExecutionPolicy Bypass -File $bridge -Op send -From codex -To swe -SessionId $SessionId -Kind task -Message $Message
Start-Sleep -Milliseconds $WaitMs
$poll = & powershell -NoProfile -ExecutionPolicy Bypass -File $bridge -Op poll -To codex -SessionId $SessionId -Limit 20

$sendObj = $send | ConvertFrom-Json
$pollObj = $poll | ConvertFrom-Json

$result = [ordered]@{
  session_id = $SessionId
  sent_id = $sendObj.id
  pending = $pollObj.pending
  items = $pollObj.items
}

$result | ConvertTo-Json -Depth 20
