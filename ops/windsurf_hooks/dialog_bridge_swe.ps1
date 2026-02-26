param(
  [string]$SessionId = "default",
  [string]$ConsumerScript = "C:\Users\anani\Projects\mcp-sync-server\ops\windsurf_hooks\swe_consumer.ps1",
  [int]$WaitMs = 800,
  [int]$MaxPolls = 12
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

$root = "C:\Users\anani\Projects\mcp-sync-server"
$ipcDir = Join-Path $root "_sync\windsurf_hooks\ipc"
$messagesFile = Join-Path $ipcDir "messages.jsonl"

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

function New-MessageId() {
  return "dlg-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 6)
}

function Ask-BridgeSwe([string]$question) {
  $id = New-MessageId
  $msg = @{
    ts_utc = [DateTime]::UtcNow.ToString("o")
    id = $id
    session_id = $SessionId
    kind = "task"
    from = "user"
    to = "swe"
    message = $question
  }
  Append-Jsonl -filePath $messagesFile -obj $msg

  for ($i = 0; $i -lt $MaxPolls; $i++) {
    powershell -NoProfile -ExecutionPolicy Bypass -File $ConsumerScript -Once -SessionId $SessionId -Limit 50 | Out-Null
    $resp = Read-Jsonl $messagesFile |
      Where-Object { $_ -and $_.from -eq "swe" -and $_.to -eq "codex" -and $_.relates_to -eq $id } |
      Select-Object -Last 1
    if ($resp) { return [string]$resp.message }
    Start-Sleep -Milliseconds $WaitMs
  }
  return "NO_RESPONSE"
}

Ensure-Dir $ipcDir

Write-Host "Bridge SWE dialog started. Type 'exit' to quit."
Write-Host "Session: $SessionId"
Write-Host ""

while ($true) {
  $user = Read-Host "You"
  if ([string]::IsNullOrWhiteSpace($user)) { continue }
  if ($user.Trim().ToLowerInvariant() -eq "exit") { break }

  $reply = Ask-BridgeSwe -question $user
  Write-Host ""
  Write-Host "Bridge SWE:"
  Write-Host $reply
  Write-Host ""
}
