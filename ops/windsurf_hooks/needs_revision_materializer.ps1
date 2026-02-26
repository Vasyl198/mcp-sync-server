param(
  [int]$Limit = 50
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
  [System.IO.File]::AppendAllText($filePath, $line + [Environment]::NewLine, $enc)
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
Ensure-Dir $hooksDir
Ensure-Dir $ipcDir

$queueFile = Join-Path $hooksDir "needs_revision_queue.jsonl"
$tasksFile = Join-Path $hooksDir "needs_revision_tasks.jsonl"
$doneFile = Join-Path $hooksDir "needs_revision_materialized.jsonl"
$logFile = Join-Path $ipcDir "materializer_log.jsonl"

$queue = Read-Jsonl $queueFile
$done = Read-Jsonl $doneFile
$seen = @{}
foreach ($d in $done) {
  if ($null -ne $d.key) { $seen["$($d.key)"] = $true }
}

$created = @()
$count = 0
foreach ($item in $queue) {
  if ($count -ge [Math]::Max(1, [Math]::Min(200, $Limit))) { break }
  $traj = [string]$item.trajectory_id
  $reason = [string]$item.reason
  if ([string]::IsNullOrWhiteSpace($traj)) { continue }
  $key = "$traj::$reason"
  if ($seen.ContainsKey($key)) { continue }

  $task = @{
    task_id = "nr-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 6)
    ts_utc = [DateTime]::UtcNow.ToString("o")
    type = "needs_revision"
    source = "hook_policy"
    trajectory_id = $traj
    reason = $reason
    session_id = [string]$item.session_id
    status = "open"
    title = "Fix SWE response evidence"
    description = "SWE returned DONE without sufficient evidence. trajectory_id=$traj reason=$reason"
  }
  Append-Jsonl $tasksFile $task
  Append-Jsonl $doneFile @{
    ts_utc = [DateTime]::UtcNow.ToString("o")
    key = $key
    trajectory_id = $traj
    reason = $reason
  }
  $seen[$key] = $true
  $created += $task
  $count += 1
}

$result = @{
  ts_utc = [DateTime]::UtcNow.ToString("o")
  scanned = @($queue).Count
  created = @($created).Count
  items = $created
}
Append-Jsonl $logFile $result
$result | ConvertTo-Json -Depth 20

