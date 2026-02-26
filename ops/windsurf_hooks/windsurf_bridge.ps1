param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("send", "poll", "ack", "status")]
  [string]$Op,

  [string]$From = "codex",
  [string]$To = "swe",
  [string]$SessionId = "default",
  [string]$Message = "",
  [string]$Kind = "task",
  [string]$Id = "",
  [int]$Limit = 20,
  [switch]$AutoDispatch,
  [switch]$AutoAck
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

function New-Id() {
  return ("msg-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
}

function Is-True([string]$v) {
  if ([string]::IsNullOrWhiteSpace($v)) { return $false }
  $x = $v.Trim().ToLowerInvariant()
  return ($x -eq "1" -or $x -eq "true" -or $x -eq "yes" -or $x -eq "on")
}

$root = "C:\Users\anani\Projects\mcp-sync-server"
$busDir = Join-Path $root "_sync\windsurf_hooks\ipc"
Ensure-Dir $busDir

$messagesFile = Join-Path $busDir "messages.jsonl"
$acksFile = Join-Path $busDir "acks.jsonl"
$stateFile = Join-Path $busDir "state.json"
$consumerScript = Join-Path $root "ops\windsurf_hooks\swe_consumer.ps1"

switch ($Op) {
  "send" {
    if ([string]::IsNullOrWhiteSpace($Message)) {
      throw "send requires -Message"
    }
    $msgId = if ([string]::IsNullOrWhiteSpace($Id)) { New-Id } else { $Id }
    $entry = @{
      ts_utc = [DateTime]::UtcNow.ToString("o")
      id = $msgId
      session_id = $SessionId
      kind = $Kind
      from = $From
      to = $To
      message = $Message
    }
    Append-Jsonl $messagesFile $entry
    $autoDispatchRaw = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_BRIDGE_AUTO_DISPATCH)) { "1" } else { [string]$env:WINDSURF_BRIDGE_AUTO_DISPATCH }
    $autoDispatchEnabled = $AutoDispatch.IsPresent -or ($autoDispatchRaw -eq "1")
    if ($autoDispatchEnabled -and $To -eq "swe" -and (Test-Path $consumerScript)) {
      try {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $consumerScript -SessionId $SessionId -Limit 20 -Once | Out-Null
      } catch {}
    }
    $entry | ConvertTo-Json -Depth 10
    exit 0
  }

  "poll" {
    $messages = Read-Jsonl $messagesFile
    $acks = Read-Jsonl $acksFile
    $acked = @{}
    foreach ($a in $acks) {
      if ($null -ne $a.id -and $null -ne $a.agent) {
        $acked["$($a.id)::$($a.agent)"] = $true
      }
    }
    $out = @()
    foreach ($m in $messages) {
      if ($null -eq $m) { continue }
      if ($m.to -ne $To) { continue }
      if ($m.session_id -ne $SessionId) { continue }
      $k = "$($m.id)::$To"
      if ($acked.ContainsKey($k)) { continue }
      $out += $m
    }
    $out = $out | Select-Object -Last ([Math]::Max(1, [Math]::Min(200, $Limit)))
    $outArr = @($out)
    $autoAckEnabled = $AutoAck.IsPresent
    if (-not $autoAckEnabled -and $To -eq "codex") {
      $autoAckEnabled = Is-True([string]$env:WINDSURF_BRIDGE_AUTO_ACK_CODEX)
    }
    if ($autoAckEnabled -and $To -eq "codex") {
      foreach ($m in $outArr) {
        if ($null -eq $m -or $null -eq $m.id) { continue }
        $ack = @{
          ts_utc = [DateTime]::UtcNow.ToString("o")
          id = [string]$m.id
          agent = "codex"
          session_id = $SessionId
        }
        Append-Jsonl $acksFile $ack
      }
    }
    @{
      session_id = $SessionId
      to = $To
      pending = $outArr.Count
      items = $outArr
    } | ConvertTo-Json -Depth 20
    exit 0
  }

  "ack" {
    if ([string]::IsNullOrWhiteSpace($Id)) {
      throw "ack requires -Id"
    }
    $ack = @{
      ts_utc = [DateTime]::UtcNow.ToString("o")
      id = $Id
      agent = $To
      session_id = $SessionId
    }
    Append-Jsonl $acksFile $ack
    $ack | ConvertTo-Json -Depth 10
    exit 0
  }

  "status" {
    $messages = Read-Jsonl $messagesFile
    $acks = Read-Jsonl $acksFile
    $state = @{
      ts_utc = [DateTime]::UtcNow.ToString("o")
      totals = @{
        messages = @($messages).Count
        acks = @($acks).Count
      }
      files = @{
        messages = $messagesFile
        acks = $acksFile
      }
      last_message = if (@($messages).Count -gt 0) { $messages[-1] } else { $null }
      last_ack = if (@($acks).Count -gt 0) { $acks[-1] } else { $null }
    }
    $state | ConvertTo-Json -Depth 20 | Set-Content -Path $stateFile -Encoding UTF8
    $state | ConvertTo-Json -Depth 20
    exit 0
  }
}
