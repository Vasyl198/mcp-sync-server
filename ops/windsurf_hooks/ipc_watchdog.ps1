param(
  [int]$TtlMinutes = 1440,
  [int]$MaxPerSession = 500
)

$ErrorActionPreference = "Stop"

function Ensure-Dir([string]$path) {
  if (-not (Test-Path $path)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
  }
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

function Write-Jsonl([string]$filePath, [object[]]$items) {
  $enc = [System.Text.UTF8Encoding]::new($false)
  $tmp = "$filePath.tmp"
  if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  foreach ($it in $items) {
    $line = $it | ConvertTo-Json -Depth 20 -Compress
    [System.IO.File]::AppendAllText($tmp, $line + [Environment]::NewLine, $enc)
  }
  Move-Item -Path $tmp -Destination $filePath -Force
}

function Append-Jsonl([string]$filePath, $obj) {
  $enc = [System.Text.UTF8Encoding]::new($false)
  $line = $obj | ConvertTo-Json -Depth 20 -Compress
  [System.IO.File]::AppendAllText($filePath, $line + [Environment]::NewLine, $enc)
}

function Parse-Utc($v) {
  try {
    return [DateTime]::Parse([string]$v).ToUniversalTime()
  } catch {
    return $null
  }
}

$root = "C:\Users\anani\Projects\mcp-sync-server"
$ipcDir = Join-Path $root "_sync\windsurf_hooks\ipc"
Ensure-Dir $ipcDir

$messagesFile = Join-Path $ipcDir "messages.jsonl"
$acksFile = Join-Path $ipcDir "acks.jsonl"
$logFile = Join-Path $ipcDir "watchdog_log.jsonl"

$now = [DateTime]::UtcNow
$ttl = [Math]::Max(1, $TtlMinutes)
$maxKeep = [Math]::Max(50, $MaxPerSession)

$messages = Read-Jsonl $messagesFile
$acks = Read-Jsonl $acksFile

$beforeMessages = @($messages).Count
$beforeAcks = @($acks).Count

# TTL prune
$messages = @($messages | Where-Object {
  $ts = Parse-Utc($_.ts_utc)
  if ($null -eq $ts) { return $true }
  return (($now - $ts).TotalMinutes -le $ttl)
})
$acks = @($acks | Where-Object {
  $ts = Parse-Utc($_.ts_utc)
  if ($null -eq $ts) { return $true }
  return (($now - $ts).TotalMinutes -le $ttl)
})

# Per-session cap for messages
$bySession = @{}
foreach ($m in $messages) {
  $sid = [string]$m.session_id
  if ([string]::IsNullOrWhiteSpace($sid)) { $sid = "__default__" }
  if (-not $bySession.ContainsKey($sid)) { $bySession[$sid] = @() }
  $bySession[$sid] += $m
}
$trimmed = @()
foreach ($sid in $bySession.Keys) {
  $arr = @($bySession[$sid])
  if (@($arr).Count -gt $maxKeep) {
    $arr = $arr | Select-Object -Last $maxKeep
  }
  $trimmed += $arr
}
$messages = @($trimmed)

# Dedup ACKs by (id,agent,session_id) keep latest
$ackMap = @{}
foreach ($a in $acks) {
  $k = "{0}::{1}::{2}" -f ([string]$a.id),([string]$a.agent),([string]$a.session_id)
  $ackMap[$k] = $a
}
$acks = @($ackMap.Values)

Write-Jsonl $messagesFile $messages
Write-Jsonl $acksFile $acks

$result = @{
  ts_utc = $now.ToString("o")
  ttl_minutes = $ttl
  max_per_session = $maxKeep
  before = @{
    messages = $beforeMessages
    acks = $beforeAcks
  }
  after = @{
    messages = @($messages).Count
    acks = @($acks).Count
  }
}
Append-Jsonl $logFile $result
$result | ConvertTo-Json -Depth 20

