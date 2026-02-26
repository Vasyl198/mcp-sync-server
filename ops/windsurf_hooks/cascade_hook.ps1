param()

$ErrorActionPreference = "Stop"

function Read-StdinJson {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return @{ }
  }
  try {
    $obj = $raw | ConvertFrom-Json
    if ($obj -is [System.Collections.IDictionary]) { return $obj }
    return $obj
  } catch {
    return @{
      parse_error = $_.Exception.Message
      raw = $raw
    }
  }
}

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

function Get-Value($h, [string]$key, $default = $null) {
  if ($null -eq $h) { return $default }
  if ($h -is [System.Collections.IDictionary]) {
    if ($h.Contains($key)) { return $h[$key] }
    return $default
  }
  $prop = $h.PSObject.Properties[$key]
  if ($null -ne $prop) { return $prop.Value }
  return $default
}

function Exit-Blocked([string]$reason) {
  Write-Error $reason
  exit 2
}

function Get-StringValue($h, [string[]]$keys) {
  foreach ($k in $keys) {
    $v = Get-Value $h $k $null
    if ($v -is [string] -and -not [string]::IsNullOrWhiteSpace($v)) { return $v }
  }
  return ""
}

function Evaluate-ResponseEvidence([string]$text) {
  # SWE unrestricted mode: do not hard-reject response structure/content.
  $result = @{
    verdict = "pass"
    reason = "audit_only"
    has_done = $false
    has_evidence_block = $false
    has_tool_result = $false
    has_plan_block = $false
    has_action_block = $false
    has_verdict_block = $false
  }
  if ([string]::IsNullOrWhiteSpace($text)) {
    $result.verdict = "skip"
    $result.reason = "empty_response"
    return $result
  }
  $hasDone = [regex]::IsMatch($text, "(?i)VERDICT\s*:\s*DONE\b")
  $hasPlanBlock = [regex]::IsMatch($text, "(?im)^\s*PLAN\s*:")
  $hasActionBlock = [regex]::IsMatch($text, "(?im)^\s*ACTION\s*:")
  $hasEvidenceBlock = [regex]::IsMatch($text, "(?i)EVIDENCE\s*:")
  $hasToolResult = [regex]::IsMatch($text, "(?i)TOOL_RESULT\s*\(")
  $hasVerdictBlock = [regex]::IsMatch($text, "(?im)^\s*VERDICT\s*:")
  $result.has_done = $hasDone
  $result.has_plan_block = $hasPlanBlock
  $result.has_action_block = $hasActionBlock
  $result.has_evidence_block = $hasEvidenceBlock
  $result.has_tool_result = $hasToolResult
  $result.has_verdict_block = $hasVerdictBlock
  if ($hasDone -and (-not $hasEvidenceBlock -or -not $hasToolResult)) {
    $result.reason = "audit_done_without_full_evidence"
  }
  return $result
}

$payload = Read-StdinJson
$deferredBlockReason = $null
$hookEvent = Get-StringValue $payload @(
  "hook_event",
  "hook_event_name",
  "event",
  "agent_action_name"
)
$root = "C:\Users\anani\Projects\mcp-sync-server"
$syncDir = Join-Path $root "_sync"
$bridgeDir = Join-Path $syncDir "windsurf_hooks"
$ipcDir = Join-Path $bridgeDir "ipc"
$eventsFile = Join-Path $bridgeDir "events.jsonl"
$verdictsFile = Join-Path $bridgeDir "verdicts.jsonl"
$escalationsFile = Join-Path $bridgeDir "needs_revision_queue.jsonl"
$ipcMessagesFile = Join-Path $ipcDir "messages.jsonl"
$bridgeTickScript = Join-Path $root "ops\windsurf_hooks\bridge_tick.ps1"
$sweConsumerScript = Join-Path $root "ops\windsurf_hooks\swe_consumer.ps1"
$ipcWatchdogScript = Join-Path $root "ops\windsurf_hooks\ipc_watchdog.ps1"
$windsurfBridgeScript = Join-Path $root "ops\windsurf_hooks\windsurf_bridge.ps1"
$materializerScript = Join-Path $root "ops\windsurf_hooks\needs_revision_materializer.ps1"

Ensure-Dir $syncDir
Ensure-Dir $bridgeDir
Ensure-Dir $ipcDir

$now = [DateTime]::UtcNow.ToString("o")
$entry = @{
  ts_utc = $now
  hook_event = $hookEvent
  trajectory_id = Get-StringValue $payload @("trajectory_id")
  session_id = Get-StringValue $payload @("session_id")
  execution_id = Get-StringValue $payload @("execution_id")
  tool_name = Get-StringValue $payload @("tool_name")
  tool_server = Get-StringValue $payload @("tool_server")
  command = Get-StringValue $payload @("command")
  payload = $payload
}

# Optional policy checks: safe defaults, can be bypassed by env switch.
$hooksPolicy = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_HOOKS_POLICY)) { "1" } else { [string]$env:WINDSURF_HOOKS_POLICY }
$checksEnabled = $hooksPolicy -eq "1"
if ($checksEnabled) {
  if ($hookEvent -eq "pre_run_command") {
    $cmd = [string](Get-Value $payload "command" "")
    $danger = @(
      "rm -rf /",
      "del /s /q c:\",
      "format c:",
      "shutdown /s",
      "shutdown -s"
    )
    foreach ($d in $danger) {
      if ($cmd.ToLowerInvariant().Contains($d.ToLowerInvariant())) {
        $entry["blocked"] = $true
        $entry["block_reason"] = "dangerous_command_pattern:$d"
        Append-Jsonl $eventsFile $entry
        Exit-Blocked "Blocked by hook policy: dangerous command pattern '$d'"
      }
    }
  }

  if ($hookEvent -eq "pre_mcp_tool_use") {
    $allowCsv = if ($null -eq $env:WINDSURF_MCP_ALLOWLIST) { "" } else { [string]$env:WINDSURF_MCP_ALLOWLIST }
    if (-not [string]::IsNullOrWhiteSpace($allowCsv)) {
      $allow = $allowCsv.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
      $tool = [string](Get-Value $payload "tool_name" "")
      if ($tool -and -not ($allow -contains $tool)) {
        $entry["blocked"] = $true
        $entry["block_reason"] = "tool_not_in_allowlist"
        Append-Jsonl $eventsFile $entry
        Exit-Blocked "Blocked by hook policy: tool '$tool' is not in WINDSURF_MCP_ALLOWLIST."
      }
    }
  }
}

Append-Jsonl $eventsFile $entry

if ($hookEvent -eq "post_cascade_response") {
  $strictRaw = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_HOOKS_STRICT_DONE_EVIDENCE)) { "0" } else { [string]$env:WINDSURF_HOOKS_STRICT_DONE_EVIDENCE }
  $strict = $strictRaw -eq "1"
  $autoEscalateRaw = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_HOOKS_AUTO_ESCALATE)) { "0" } else { [string]$env:WINDSURF_HOOKS_AUTO_ESCALATE }
  $autoEscalate = $autoEscalateRaw -eq "1"
  $responseText = Get-StringValue $payload @(
    "response",
    "assistant_response",
    "final_response",
    "content",
    "text",
    "output_text"
  )
  if ([string]::IsNullOrWhiteSpace($responseText)) {
    $nested = Get-Value $payload "payload" $null
    if ($null -ne $nested) {
      $responseText = Get-StringValue $nested @(
        "response",
        "assistant_response",
        "final_response",
        "content",
        "text",
        "output_text"
      )
    }
  }
  $eval = Evaluate-ResponseEvidence $responseText
  $verdictEntry = @{
    ts_utc = $now
    hook_event = $hookEvent
    trajectory_id = Get-Value $payload "trajectory_id" $null
    session_id = Get-Value $payload "session_id" $null
    execution_id = Get-Value $payload "execution_id" $null
    verdict = $eval.verdict
    reason = $eval.reason
    has_done = $eval.has_done
    has_plan_block = $eval.has_plan_block
    has_action_block = $eval.has_action_block
    has_evidence_block = $eval.has_evidence_block
    has_tool_result = $eval.has_tool_result
    has_verdict_block = $eval.has_verdict_block
  }
  Append-Jsonl $verdictsFile $verdictEntry
  $ipcEntry = @{
    ts_utc = $now
    id = "hook-verdict-" + [Guid]::NewGuid().ToString("N").Substring(0, 10)
    session_id = (Get-Value $payload "session_id" "default")
    kind = "policy_verdict"
    from = "codex"
    to = "swe"
    message = "Hook verdict: " + $eval.verdict + "; reason=" + $eval.reason
    trajectory_id = Get-Value $payload "trajectory_id" $null
    execution_id = Get-Value $payload "execution_id" $null
  }
  Append-Jsonl $ipcMessagesFile $ipcEntry

  if ($eval.verdict -eq "reject" -and $autoEscalate) {
    $esc = @{
      ts_utc = $now
      type = "needs_revision"
      source = "windsurf_hook_policy_v2"
      reason = $eval.reason
      trajectory_id = Get-Value $payload "trajectory_id" $null
      execution_id = Get-Value $payload "execution_id" $null
      session_id = Get-Value $payload "session_id" $null
    }
    Append-Jsonl $escalationsFile $esc
  }

  $autoBridgeTickRaw = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_HOOKS_AUTO_BRIDGE_TICK)) { "1" } else { [string]$env:WINDSURF_HOOKS_AUTO_BRIDGE_TICK }
  $autoBridgeTick = $autoBridgeTickRaw -eq "1"
  if ($autoBridgeTick -and (Test-Path $bridgeTickScript)) {
    $bridgeSession = [string](Get-Value $payload "session_id" "default")
    try {
      $tickOut = & powershell -NoProfile -ExecutionPolicy Bypass -File $bridgeTickScript -SessionId $bridgeSession -TargetAgent "swe" -Limit 20
      Append-Jsonl $eventsFile @{
        ts_utc = [DateTime]::UtcNow.ToString("o")
        hook_event = "bridge_tick_auto"
        session_id = $bridgeSession
        result = $tickOut
      }
      $autoSweConsumerRaw = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_HOOKS_AUTO_SWE_CONSUMER)) { "1" } else { [string]$env:WINDSURF_HOOKS_AUTO_SWE_CONSUMER }
      $autoSweConsumer = $autoSweConsumerRaw -eq "1"
      if ($autoSweConsumer -and (Test-Path $sweConsumerScript)) {
        try {
          $consumerOut = & powershell -NoProfile -ExecutionPolicy Bypass -File $sweConsumerScript -SessionId $bridgeSession -Limit 20 -Once
          Append-Jsonl $eventsFile @{
            ts_utc = [DateTime]::UtcNow.ToString("o")
            hook_event = "swe_consumer_auto"
            session_id = $bridgeSession
            result = $consumerOut
          }
        } catch {
          Append-Jsonl $eventsFile @{
            ts_utc = [DateTime]::UtcNow.ToString("o")
            hook_event = "swe_consumer_auto_error"
            session_id = $bridgeSession
            error = $_.Exception.Message
          }
        }
      }
    } catch {
      Append-Jsonl $eventsFile @{
        ts_utc = [DateTime]::UtcNow.ToString("o")
        hook_event = "bridge_tick_auto_error"
        session_id = $bridgeSession
        error = $_.Exception.Message
      }
    }
  }

  if ($eval.verdict -eq "reject" -and $strict) {
    $deferredBlockReason = "Hook policy v2: rejected DONE without sufficient EVIDENCE/TOOL_RESULT."
  }
}

$autoWatchdogRaw = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_HOOKS_AUTO_WATCHDOG)) { "1" } else { [string]$env:WINDSURF_HOOKS_AUTO_WATCHDOG }
$autoWatchdog = $autoWatchdogRaw -eq "1"
if ($autoWatchdog -and (Test-Path $ipcWatchdogScript)) {
  try {
    $ttlRaw = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_HOOKS_WATCHDOG_TTL_MINUTES)) { "1440" } else { [string]$env:WINDSURF_HOOKS_WATCHDOG_TTL_MINUTES }
    $maxRaw = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_HOOKS_WATCHDOG_MAX_PER_SESSION)) { "500" } else { [string]$env:WINDSURF_HOOKS_WATCHDOG_MAX_PER_SESSION }
    $ttlMinutes = 1440
    $maxPerSession = 500
    [void][int]::TryParse($ttlRaw, [ref]$ttlMinutes)
    [void][int]::TryParse($maxRaw, [ref]$maxPerSession)
    & powershell -NoProfile -ExecutionPolicy Bypass -File $ipcWatchdogScript -TtlMinutes $ttlMinutes -MaxPerSession $maxPerSession | Out-Null
  } catch {}
}

$autoMaterializeRaw = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_HOOKS_AUTO_MATERIALIZE)) { "1" } else { [string]$env:WINDSURF_HOOKS_AUTO_MATERIALIZE }
$autoMaterialize = $autoMaterializeRaw -eq "1"
if ($autoMaterialize -and (Test-Path $materializerScript)) {
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $materializerScript -Limit 50 | Out-Null
  } catch {}
}

$autoPollCodexRaw = if ([string]::IsNullOrWhiteSpace($env:WINDSURF_HOOKS_AUTO_POLL_CODEX)) { "1" } else { [string]$env:WINDSURF_HOOKS_AUTO_POLL_CODEX }
$autoPollCodex = $autoPollCodexRaw -eq "1"
if ($autoPollCodex -and (Test-Path $windsurfBridgeScript)) {
  $bridgeSession = [string](Get-Value $payload "session_id" "default")
  try {
    $pollOut = & powershell -NoProfile -ExecutionPolicy Bypass -File $windsurfBridgeScript -Op poll -To codex -SessionId $bridgeSession -Limit 20 -AutoAck
    Append-Jsonl $eventsFile @{
      ts_utc = [DateTime]::UtcNow.ToString("o")
      hook_event = "codex_poll_auto"
      session_id = $bridgeSession
      result = $pollOut
    }
  } catch {}
}

if (-not [string]::IsNullOrWhiteSpace($deferredBlockReason)) {
  Exit-Blocked $deferredBlockReason
}

exit 0
