param(
  [string]$SessionId = "default",
  [string]$TargetAgent = "swe",
  [int]$Limit = 20,
  [int]$RecentMinutes = 120
)

$ErrorActionPreference = "Stop"

function Ensure-Dir([string]$path) {
  if (-not (Test-Path $path)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
  }
}

function Append-Jsonl([string]$filePath, $obj) {
  $line = $obj | ConvertTo-Json -Depth 20 -Compress
  $enc = [System.Text.UTF8Encoding]::new($false)
  for ($i = 0; $i -lt 8; $i++) {
    try {
      [System.IO.File]::AppendAllText($filePath, $line + [Environment]::NewLine, $enc)
      return
    } catch {
      Start-Sleep -Milliseconds (25 + ($i * 25))
    }
  }
  throw "Failed to append JSONL after retries: $filePath"
}

function Read-Jsonl([string]$filePath) {
  if (-not (Test-Path $filePath)) { return @() }
  $rows = @()
  foreach ($line in [System.IO.File]::ReadLines($filePath)) {
    $normalized = [string]$line
    if ($normalized.Length -gt 0) { $normalized = $normalized.TrimStart([char]0xFEFF) }
    if ([string]::IsNullOrWhiteSpace($normalized)) { continue }
    try { $rows += ($normalized | ConvertFrom-Json) } catch {}
  }
  return $rows
}

$root = "C:\Users\anani\Projects\mcp-sync-server"
$hooksDir = Join-Path $root "_sync\windsurf_hooks"
$ipcDir = Join-Path $hooksDir "ipc"
$queueFile = Join-Path $hooksDir "needs_revision_queue.jsonl"
$processedFile = Join-Path $ipcDir "bridge_tick_processed.jsonl"
$tickLogFile = Join-Path $ipcDir "bridge_tick_log.jsonl"
$bridgeScript = Join-Path $root "ops\windsurf_hooks\windsurf_bridge.ps1"

Ensure-Dir $hooksDir
Ensure-Dir $ipcDir

$queue = Read-Jsonl $queueFile
$processed = Read-Jsonl $processedFile
$seen = @{}
foreach ($p in $processed) {
  if ($null -ne $p.key) { $seen["$($p.key)"] = $true }
}

$created = @()
$count = 0
foreach ($item in $queue) {
  if ($count -ge [Math]::Max(1, [Math]::Min(200, $Limit))) { break }
  $itemSession = [string]($item.session_id)
  if (-not [string]::IsNullOrWhiteSpace($itemSession) -and $itemSession -ne $SessionId) { continue }
  $itemTsRaw = [string]($item.ts_utc)
  if (-not [string]::IsNullOrWhiteSpace($itemTsRaw)) {
    try {
      $itemTs = [DateTime]::Parse($itemTsRaw).ToUniversalTime()
      $ageMin = ([DateTime]::UtcNow - $itemTs).TotalMinutes
      if ($ageMin -gt [Math]::Max(1, $RecentMinutes)) { continue }
    } catch {}
  }
  $traj = [string]($item.trajectory_id)
  $reason = [string]($item.reason)
  if ([string]::IsNullOrWhiteSpace($traj)) { continue }
  $key = "$traj::$reason"
  if ($seen.ContainsKey($key)) { continue }

  $msg = "needs_revision from hook policy. trajectory_id=$traj reason=$reason. Please revise output with EVIDENCE and TOOL_RESULT() before DONE."
  $json = & powershell -NoProfile -ExecutionPolicy Bypass -File $bridgeScript -Op send -From "hook-policy" -To $TargetAgent -SessionId $SessionId -Kind "needs_revision" -Message $msg
  $created += ($json | ConvertFrom-Json)

  Append-Jsonl $processedFile @{
    ts_utc = [DateTime]::UtcNow.ToString("o")
    key = $key
    trajectory_id = $traj
    reason = $reason
  }
  $seen[$key] = $true
  $count += 1
}

$result = @{
  ts_utc = [DateTime]::UtcNow.ToString("o")
  session_id = $SessionId
  target_agent = $TargetAgent
  scanned = @($queue).Count
  created = @($created).Count
  created_items = $created
}
Append-Jsonl $tickLogFile $result
$result | ConvertTo-Json -Depth 20
