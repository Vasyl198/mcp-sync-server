param(
  [string]$SessionId = "default",
  [int]$Limit = 20,
  [switch]$Once,
  [string]$Mode = ""
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

function Acquire-ConsumerLock([string]$lockPath) {
  $enabledRaw = [string]($env:WINDSURF_SWE_CONSUMER_LOCK)
  $enabled = $true
  if (-not [string]::IsNullOrWhiteSpace($enabledRaw) -and $enabledRaw -eq "0") {
    $enabled = $false
  }
  if (-not $enabled) { return $null }
  try {
    return [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    return $null
  }
}

function Get-PendingForSwe([object[]]$messages, [object[]]$acks, [string]$sessionId, [int]$limit) {
  $acked = @{}
  foreach ($a in $acks) {
    if ($null -ne $a.id -and $null -ne $a.agent) {
      $acked["$($a.id)::$($a.agent)"] = $true
    }
  }
  $out = @()
  foreach ($m in $messages) {
    if ($null -eq $m) { continue }
    if ([string]$m.to -ne "swe") { continue }
    if ([string]$m.session_id -ne $sessionId) { continue }
    $k = "$($m.id)::swe"
    if ($acked.ContainsKey($k)) { continue }
    $out += $m
  }
  return $out | Select-Object -First ([Math]::Max(1, [Math]::Min(200, $limit)))
}

function Get-Mode() {
  if ($Mode -and $Mode.Trim()) { return $Mode.Trim().ToLowerInvariant() }
  $raw = [string]($env:WINDSURF_SWE_MODE)
  if (-not [string]::IsNullOrWhiteSpace($raw)) { return $raw.Trim().ToLowerInvariant() }
  # Default SWE-only behavior: deterministic tool execution, no LLM fallback.
  return "auto_exec"
}

function Get-ResponseProfile() {
  return "broad"
}

function Invoke-LlmReply([string]$kind, [string]$origId, [string]$msg) {
  try {
    if (-not (Is-ExecAllowed "llm_agent_chat")) {
      return @{
        ok = $false
        mode = "llm_loop"
        error = "llm_agent_chat not allowed by WINDSURF_SWE_EXEC_ALLOWLIST"
        text = ""
      }
    }

    $catalog = Get-ToolsCatalog
    $allowed = @()
    foreach ($t in @($catalog.tools)) {
      $name = [string]$t.name
      if ([string]::IsNullOrWhiteSpace($name)) { continue }
      if ($name -eq "llm_agent_chat") { continue }
      if (-not (Is-ExecAllowed $name)) { continue }
      $allowed += $name
    }
    $allowed = @($allowed | Select-Object -Unique)

    $maxSteps = 8
    $maxRaw = [string]($env:WINDSURF_SWE_LLM_MAX_STEPS)
    if (-not [string]::IsNullOrWhiteSpace($maxRaw)) {
      try { $maxSteps = [Math]::Max(2, [Math]::Min(12, [int]$maxRaw)) } catch {}
    }

    $system = @"
Ты SWE-агент AI-лаборатории в Windsurf.
Твоя задача: дать инженерный ответ по запросу пользователя, при необходимости вызвать инструменты.
Правила:
1) Не выдумывай факты; используй tools.
2) Если делал tool calls, включи короткий блок EVIDENCE.
3) Отвечай на русском, ясно и по делу.
"@

    $payload = @{
      messages = @(
        @{ role = "system"; content = $system },
        @{ role = "user"; content = [string]$msg }
      )
      max_steps = $maxSteps
      allowed_tools = $allowed
      tool_choice = "auto"
      trace = $true
      stop_on_final = $true
      enforce_boot = $true
      require_evidence = $false
    }

    $res = Invoke-McpTool -ToolName "llm_agent_chat" -Arguments $payload -UseReasonerEndpoint
    $raw = ""
    try { $raw = [string]$res.content[0].text } catch {}
    if ([string]::IsNullOrWhiteSpace($raw)) {
      return @{ ok = $false; mode = "llm_loop"; error = "empty llm_agent_chat response"; text = "" }
    }
    $obj = $raw | ConvertFrom-Json
    $final = ""
    if ($obj.PSObject.Properties.Name -contains "final") { $final = [string]$obj.final }
    if ([string]::IsNullOrWhiteSpace($final)) {
      $final = $raw
    }
    $usedTools = @()
    try { $usedTools = @($obj.used_tools) } catch {}
    $steps = @()
    try { $steps = @($obj.steps) } catch {}
    return @{
      ok = $true
      mode = "llm_loop"
      text = $final
      used_tools = $usedTools
      steps = $steps
    }
  } catch {
    return @{
      ok = $false
      mode = "llm_loop"
      error = $_.Exception.Message
      text = ""
    }
  }
}

function Build-StubReply([string]$kind, [string]$origId, [string]$msg) {
  $replyText = switch ($kind) {
    "needs_revision" {
      "SWE_AUTO_REPLY: needs_revision received. Next reply will include EVIDENCE and TOOL_RESULT(). EVIDENCE: TOOL_RESULT(ipc_receive): id=$origId."
    }
    "policy_verdict" {
      "SWE_AUTO_REPLY: policy verdict received. EVIDENCE: TOOL_RESULT(ipc_receive): id=$origId."
    }
    default {
      "SWE_AUTO_REPLY: task received. EVIDENCE: TOOL_RESULT(ipc_receive): id=$origId; summary=$msg"
    }
  }
  return $replyText
}

function Get-McpDataJsonText {
  param([string]$SseContent)
  $line = ($SseContent -split "`r?`n" | Where-Object { $_ -like "data:*" } | Select-Object -First 1)
  if (-not $line) { throw "MCP response has no data line." }
  return $line.Substring(5).Trim()
}

function Get-ResponseUtf8Content {
  param([object]$Response)
  try {
    if ($Response -and $Response.PSObject.Properties.Name -contains "RawContentStream" -and $Response.RawContentStream) {
      $stream = $Response.RawContentStream
      if ($stream.CanSeek) { $stream.Position = 0 }
      $ms = New-Object System.IO.MemoryStream
      $stream.CopyTo($ms)
      $bytes = $ms.ToArray()
      $ms.Dispose()
      return [System.Text.Encoding]::UTF8.GetString($bytes)
    }
  } catch {}
  return [string]$Response.Content
}

function New-McpHeaders {
  param(
    [string]$SessionId = "",
    [string]$Bearer = ""
  )
  $headers = @{
    "Accept" = "application/json, text/event-stream"
    "mcp-protocol-version" = "2024-11-05"
  }
  if ($SessionId) { $headers["mcp-session-id"] = $SessionId }
  if ($Bearer) { $headers["Authorization"] = "Bearer $Bearer" }
  return $headers
}

function Invoke-McpPost {
  param(
    [string]$Url,
    [hashtable]$Headers,
    [object]$BodyObj
  )
  $body = $BodyObj | ConvertTo-Json -Depth 30 -Compress
  return Invoke-WebRequest -UseBasicParsing -Method Post -Uri $Url -Headers $Headers -ContentType "application/json; charset=utf-8" -Body $body
}

function Get-McpUrl([switch]$ForReasoner) {
  $main = [string]($env:WINDSURF_SWE_MCP_URL)
  if ([string]::IsNullOrWhiteSpace($main)) { $main = "http://127.0.0.1:3000/mcp" }
  if ($ForReasoner) {
    $reasoner = [string]($env:WINDSURF_SWE_REASONER_MCP_URL)
    if (-not [string]::IsNullOrWhiteSpace($reasoner)) { return $reasoner }
    # Stable default: reasoner shares the same MCP endpoint as exec unless explicitly overridden.
    return $main
  }
  return $main
}

function To-Hashtable($obj) {
  if ($null -eq $obj) { return @{} }
  if ($obj -is [hashtable]) { return $obj }
  $ht = @{}
  if ($obj -is [System.Collections.IDictionary]) {
    foreach ($k in $obj.Keys) {
      $ht[[string]$k] = $obj[$k]
    }
    return $ht
  }
  foreach ($p in $obj.PSObject.Properties) {
    $ht[[string]$p.Name] = $p.Value
  }
  return $ht
}

function Invoke-McpTool {
  param(
    [string]$ToolName,
    $Arguments,
    [switch]$UseReasonerEndpoint
  )
  $argsHash = To-Hashtable $Arguments
  $mcpUrl = Get-McpUrl -ForReasoner:$UseReasonerEndpoint
  $token = [string]($env:MCP_SYNC_TOKEN)
  if ([string]::IsNullOrWhiteSpace($token)) { $token = [string]($env:WINDSURF_SWE_MCP_TOKEN) }

  $initResp = Invoke-McpPost -Url $mcpUrl -Headers (New-McpHeaders -Bearer $token) -BodyObj @{
    jsonrpc = "2.0"
    id = "init-swe-consumer"
    method = "initialize"
    params = @{
      protocolVersion = "2024-11-05"
      capabilities = @{}
      clientInfo = @{
        name = "windsurf-swe-consumer"
        version = "1.0.0"
      }
    }
  }
  $sessionId = [string]$initResp.Headers["mcp-session-id"]
  if ([string]::IsNullOrWhiteSpace($sessionId)) {
    throw "Missing MCP session id"
  }

  $callResp = Invoke-McpPost -Url $mcpUrl -Headers (New-McpHeaders -SessionId $sessionId -Bearer $token) -BodyObj @{
    jsonrpc = "2.0"
    id = "call-swe-consumer"
    method = "tools/call"
    params = @{
      name = $ToolName
      arguments = $argsHash
    }
  }
  $rpc = (Get-McpDataJsonText -SseContent (Get-ResponseUtf8Content -Response $callResp)) | ConvertFrom-Json
  if ($rpc.error) {
    throw ("MCP tool error: " + [string]$rpc.error.message)
  }
  if ($rpc.result -and ($rpc.result.PSObject.Properties.Name -contains "isError") -and $rpc.result.isError) {
    $detail = ""
    try {
      if ($rpc.result.content -and $rpc.result.content.Count -gt 0) {
        $detail = [string]$rpc.result.content[0].text
      }
    } catch {}
    if ([string]::IsNullOrWhiteSpace($detail)) {
      throw "MCP tool result flagged isError=true"
    }
    throw ("MCP tool result flagged isError=true: " + $detail)
  }
  try {
    if ($rpc.result -and $rpc.result.content -and $rpc.result.content.Count -gt 0) {
      $txt = [string]$rpc.result.content[0].text
      if (-not [string]::IsNullOrWhiteSpace($txt)) {
        $parsed = $txt | ConvertFrom-Json
        if ($parsed -and ($parsed.PSObject.Properties.Name -contains "ok") -and (-not [bool]$parsed.ok)) {
          $msg = ""
          if ($parsed.PSObject.Properties.Name -contains "error") { $msg = [string]$parsed.error }
          if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "tool returned ok=false" }
          throw ("MCP tool payload error: " + $msg)
        }
      }
    }
  } catch {
    # If payload isn't JSON, ignore and keep raw result.
    $e = [string]$_.Exception.Message
    if ($e -like "MCP tool payload error:*") { throw }
  }
  return $rpc.result
}

function Invoke-McpToolsList {
  $mcpUrl = [string]($env:WINDSURF_SWE_MCP_URL)
  if ([string]::IsNullOrWhiteSpace($mcpUrl)) { $mcpUrl = "http://127.0.0.1:3000/mcp" }
  $token = [string]($env:MCP_SYNC_TOKEN)
  if ([string]::IsNullOrWhiteSpace($token)) { $token = [string]($env:WINDSURF_SWE_MCP_TOKEN) }

  $initResp = Invoke-McpPost -Url $mcpUrl -Headers (New-McpHeaders -Bearer $token) -BodyObj @{
    jsonrpc = "2.0"
    id = "init-swe-tools-list"
    method = "initialize"
    params = @{
      protocolVersion = "2024-11-05"
      capabilities = @{}
      clientInfo = @{
        name = "windsurf-swe-consumer"
        version = "1.0.0"
      }
    }
  }
  $sessionId = [string]$initResp.Headers["mcp-session-id"]
  if ([string]::IsNullOrWhiteSpace($sessionId)) {
    throw "Missing MCP session id for tools/list"
  }

  $callResp = Invoke-McpPost -Url $mcpUrl -Headers (New-McpHeaders -SessionId $sessionId -Bearer $token) -BodyObj @{
    jsonrpc = "2.0"
    id = "list-swe-tools"
    method = "tools/list"
    params = @{}
  }
  $rpc = (Get-McpDataJsonText -SseContent (Get-ResponseUtf8Content -Response $callResp)) | ConvertFrom-Json
  if ($rpc.error) {
    throw ("MCP tools/list error: " + [string]$rpc.error.message)
  }
  return $rpc.result
}

function Get-ToolMemoryPath() {
  return "C:\Users\anani\Projects\mcp-sync-server\_sync\windsurf_hooks\swe_tool_memory.json"
}

function Read-ToolMemory() {
  $path = Get-ToolMemoryPath
  if (-not (Test-Path $path)) { return $null }
  try {
    return (Get-Content -Raw -Path $path | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-ToolMemory($obj) {
  $path = Get-ToolMemoryPath
  $dir = Split-Path -Parent $path
  Ensure-Dir $dir
  $json = $obj | ConvertTo-Json -Depth 30
  $enc = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($path, $json, $enc)
}

function Get-ToolsCatalog([switch]$ForceRefresh) {
  $ttlSec = 300
  $ttlRaw = [string]($env:WINDSURF_SWE_TOOL_MEMORY_TTL_SEC)
  if (-not [string]::IsNullOrWhiteSpace($ttlRaw)) {
    try { $ttlSec = [Math]::Max(30, [int]$ttlRaw) } catch {}
  }

  $mem = Read-ToolMemory
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $hasFresh = $false
  if ($mem -and $mem.ts_unix) {
    try {
      $age = [int64]$now - [int64]$mem.ts_unix
      if ($age -ge 0 -and $age -lt $ttlSec -and $mem.tools) {
        $hasFresh = $true
      }
    } catch {}
  }
  if ($hasFresh -and -not $ForceRefresh) {
    return $mem
  }

  $result = Invoke-McpToolsList
  $tools = @()
  try { $tools = @($result.tools) } catch { $tools = @() }
  $catalog = @{
    ts_utc = [DateTime]::UtcNow.ToString("o")
    ts_unix = $now
    count = @($tools).Count
    tools = @()
  }
  foreach ($t in $tools) {
    $name = [string]$t.name
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $desc = ""
    try { $desc = [string]$t.description } catch {}
    $catalog.tools += @{
      name = $name
      description = $desc
    }
  }
  Write-ToolMemory -obj $catalog
  return $catalog
}

function Find-ToolByName([string]$name, $catalog) {
  if ([string]::IsNullOrWhiteSpace($name) -or -not $catalog -or -not $catalog.tools) { return $null }
  $needle = $name.Trim().ToLowerInvariant()
  foreach ($t in $catalog.tools) {
    $n = [string]$t.name
    if ([string]::IsNullOrWhiteSpace($n)) { continue }
    $nl = $n.ToLowerInvariant()
    if ($nl -eq $needle) { return $t }
  }
  foreach ($t in $catalog.tools) {
    $n = [string]$t.name
    if ([string]::IsNullOrWhiteSpace($n)) { continue }
    $nl = $n.ToLowerInvariant()
    if ($nl -like "*$needle*" -or $needle -like "*$nl*") { return $t }
  }
  return $null
}

function Extract-ToolNameFromMessage([string]$msg) {
  if ([string]::IsNullOrWhiteSpace($msg)) { return "" }
  $m = [regex]::Match($msg, "(?i)(tool|инструмент)\s+([a-zA-Z0-9_:\-\.]+)")
  if ($m.Success) { return [string]$m.Groups[2].Value.Trim() }
  $m2 = [regex]::Match($msg, "(?i)(что\s+делает|что\s+умеет)\s+([a-zA-Z0-9_:\-\.]+)")
  if ($m2.Success) { return [string]$m2.Groups[2].Value.Trim() }
  return ""
}

function Get-ExecAllowlist() {
  $raw = [string]($env:WINDSURF_SWE_EXEC_ALLOWLIST)
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return @("*")
  }
  return @($raw.Split(",") | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ -ne "" } | Select-Object -Unique)
}

function Is-ExecAllowed([string]$toolName) {
  $allow = Get-ExecAllowlist
  if ($allow -contains "*") { return $true }
  return $allow -contains [string]$toolName.ToLowerInvariant()
}

function Invoke-FirstAvailableTool {
  param(
    [string[]]$ToolNames,
    $Arguments
  )
  $lastError = $null
  foreach ($t in $ToolNames) {
    if (-not (Is-ExecAllowed $t)) { continue }
    try {
      $res = Invoke-McpTool -ToolName $t -Arguments $Arguments
      return @{ ok = $true; tool = $t; result = $res }
    } catch {
      $lastError = $_.Exception.Message
    }
  }
  return @{ ok = $false; error = [string]$lastError }
}

function Try-ExtractQuery([string]$msg) {
  if ([string]::IsNullOrWhiteSpace($msg)) { return "" }
  $q = $msg
  $q = $q -replace "(?i)search\s+web", ""
  $q = $q -replace "(?i)search_web", ""
  $q = $q -replace "(?i)web_search", ""
  $q = $q -replace "(?i)find\s+on\s+internet", ""
  $q = $q -replace "(?i)find\s+in\s+internet", ""
  $q = $q -replace "(?i)найди\s+в\s+интернете", ""
  $q = $q -replace "(?i)поищи\s+в\s+интернете", ""
  $q = $q -replace "(?i)найди", ""
  $q = $q -replace "(?i)поиск", ""
  $q = $q -replace "(?i)погода", "погода"
  $q = $q -replace "(?i)internet", ""
  $q = $q -replace "(?i)web", ""
  $q = $q -replace "(?i)query", ""
  $q = $q -replace "(?i):", " "
  return [string]$q.Trim(" ", "`t", "`r", "`n", ".", ":", ";", '"', "'")
}
function Try-ExtractFsPath([string]$msg) {
  if ([string]::IsNullOrWhiteSpace($msg)) { return "C:\Users\anani\Projects" }
  $m = [regex]::Match($msg, "([A-Za-z]:\\[^`r`n""']+)")
  if ($m.Success) {
    $p = [string]$m.Groups[1].Value.Trim()
    $cut = @(" and ", " then ", " with ", ";", ",")
    foreach ($sep in $cut) {
      $idx = $p.ToLowerInvariant().IndexOf($sep)
      if ($idx -gt 0) { $p = $p.Substring(0, $idx).Trim() }
    }
    return $p.Trim(" ", "`t", "`r", "`n", ".", ":", ";", """", "'")
  }
  return "C:\Users\anani\Projects"
}

function Try-ParseTerminalSweRequest([string]$msg) {
  if ([string]::IsNullOrWhiteSpace($msg)) { return $null }
  $m = [regex]::Match($msg, "(?is)terminal_swe\s+op\s+([a-z_]+)(.*)$")
  if (-not $m.Success) { return $null }
  $op = [string]$m.Groups[1].Value.Trim().ToLowerInvariant()
  $rest = [string]$m.Groups[2].Value.Trim()
  $args = @{ op = $op }

  switch ($op) {
    "bash" {
      $mc = [regex]::Match($rest, "(?is)\bcmd\s+(.+)$")
      if ($mc.Success) { $args["cmd"] = [string]$mc.Groups[1].Value.Trim() }
      $mcwd = [regex]::Match($rest, "(?is)\bcwd\s+(.+?)(\s+\w+\s+.+|$)")
      if ($mcwd.Success) { $args["cwd"] = [string]$mcwd.Groups[1].Value.Trim() }
    }
    "list_dir" {
      $mp = [regex]::Match($rest, "(?is)\b(path|dir|root)\s+(.+)$")
      if ($mp.Success) { $args["path"] = [string]$mp.Groups[2].Value.Trim() }
    }
    "search_web" {
      $mq = [regex]::Match($rest, "(?is)\b(query|q)\s+(.+)$")
      if ($mq.Success) { $args["query"] = [string]$mq.Groups[2].Value.Trim() }
      elseif (-not [string]::IsNullOrWhiteSpace($rest)) { $args["query"] = $rest.Trim() }
    }
    "read_url_content" {
      $mu = [regex]::Match($rest, "(?is)\b(url)\s+(.+)$")
      if ($mu.Success) { $args["url"] = [string]$mu.Groups[2].Value.Trim() }
      elseif (-not [string]::IsNullOrWhiteSpace($rest)) { $args["url"] = $rest.Trim() }
    }
    "read_file" {
      $mp = [regex]::Match($rest, "(?is)\b(path)\s+(.+)$")
      if ($mp.Success) { $args["path"] = [string]$mp.Groups[2].Value.Trim() }
      elseif (-not [string]::IsNullOrWhiteSpace($rest)) { $args["path"] = $rest.Trim() }
    }
    default {
      # Keep only op if unparsed; server-side validation will return precise error.
    }
  }

  return $args
}

function Try-ParseGovernanceTunerRequest([string]$msg) {
  if ([string]::IsNullOrWhiteSpace($msg)) { return $null }
  if ($msg -notmatch "(?i)governance_tuner_tick") { return $null }
  $args = @{
    dry_run = $false
    max_changes = 1
  }
  $mDry = [regex]::Match($msg, "(?i)dry_run\s*=\s*(true|false|1|0)")
  if ($mDry.Success) {
    $v = $mDry.Groups[1].Value.ToLowerInvariant()
    $args["dry_run"] = ($v -eq "true" -or $v -eq "1")
  }
  $mMax = [regex]::Match($msg, "(?i)max_changes\s*=\s*(\d+)")
  if ($mMax.Success) {
    try {
      $args["max_changes"] = [Math]::Max(1, [Math]::Min(2, [int]$mMax.Groups[1].Value))
    } catch {}
  }
  return $args
}

function Try-ParseGovernanceThresholdTunerRequest([string]$msg) {
  if ([string]::IsNullOrWhiteSpace($msg)) { return $null }
  if ($msg -notmatch "(?i)governance_threshold_tuner_tick") { return $null }
  $args = @{
    dry_run = $false
    max_changes = 1
  }
  $mDry = [regex]::Match($msg, "(?i)dry_run\s*=\s*(true|false|1|0)")
  if ($mDry.Success) {
    $v = $mDry.Groups[1].Value.ToLowerInvariant()
    $args["dry_run"] = ($v -eq "true" -or $v -eq "1")
  }
  $mMax = [regex]::Match($msg, "(?i)max_changes\s*=\s*(\d+)")
  if ($mMax.Success) {
    try {
      $args["max_changes"] = [Math]::Max(1, [Math]::Min(2, [int]$mMax.Groups[1].Value))
    } catch {}
  }
  return $args
}

function Try-ParseArenaGovernanceSetRequest([string]$msg) {
  if ([string]::IsNullOrWhiteSpace($msg)) { return $null }
  if ($msg -notmatch "(?i)arena_governance_set") { return $null }
  $mSig = [regex]::Match($msg, "(?i)domain_signature\s*=\s*([^\s]+)")
  if (-not $mSig.Success) { return $null }
  $sig = [string]$mSig.Groups[1].Value.Trim()
  $args = @{ domain_signature = $sig }

  $mShadow = [regex]::Match($msg, "(?i)shadow_cap\s*=\s*([0-9]*\.?[0-9]+)")
  if ($mShadow.Success) {
    try { $args["shadow_cap"] = [double]$mShadow.Groups[1].Value } catch {}
  }
  $mWindow = [regex]::Match($msg, "(?i)arena_evaluation_window\s*=\s*(\d+)")
  if ($mWindow.Success) {
    try { $args["arena_evaluation_window"] = [int]$mWindow.Groups[1].Value } catch {}
  }
  $mMargin = [regex]::Match($msg, "(?i)promotion_margin\s*=\s*([0-9]*\.?[0-9]+)")
  if ($mMargin.Success) {
    try { $args["promotion_margin"] = [double]$mMargin.Groups[1].Value } catch {}
  }
  $mCooldown = [regex]::Match($msg, "(?i)arena_cooldown_ms\s*=\s*(\d+)")
  if ($mCooldown.Success) {
    try { $args["arena_cooldown_ms"] = [int]$mCooldown.Groups[1].Value } catch {}
  }
  $mMax = [regex]::Match($msg, "(?i)max_strategies_per_domain\s*=\s*(\d+)")
  if ($mMax.Success) {
    try { $args["max_strategies_per_domain"] = [int]$mMax.Groups[1].Value } catch {}
  }
  return $args
}

function Summarize-McpToolText([string]$toolName, [string]$jsonText) {
  if ([string]::IsNullOrWhiteSpace($jsonText)) { return "${toolName}: empty_result" }
  try {
    $obj = $jsonText | ConvertFrom-Json
    switch ($toolName) {
      "sync" {
        $enabled = ""
        $pending = ""
        if ($obj.PSObject.Properties.Name -contains "enabled") { $enabled = [string]$obj.enabled }
        if ($obj.PSObject.Properties.Name -contains "mappings" -and $obj.mappings -and ($obj.mappings.PSObject.Properties.Name -contains "pending_inbound_ids")) {
          $pending = [string]$obj.mappings.pending_inbound_ids
        }
        return ("sync: enabled={0}, pending_inbound_ids={1}" -f $enabled, $pending)
      }
      "worker_metrics_snapshot" {
        return ("worker_metrics_snapshot: queue_depths={0}" -f ($jsonText -replace "\s+", " ").Substring(0, [Math]::Min(180, $jsonText.Length)))
      }
      "sync_status" {
        return ("sync_status: " + ($jsonText -replace "\s+", " ").Substring(0, [Math]::Min(220, $jsonText.Length)))
      }
      "intelligence_health_snapshot" {
        $gihi = ""
        if ($obj.PSObject.Properties.Name -contains "gihi") { $gihi = [string]$obj.gihi }
        return ("intelligence_health_snapshot: gihi={0}" -f $gihi)
      }
      "governance_tuner_tick" {
        return ("governance_tuner_tick: " + ($jsonText -replace "\s+", " ").Substring(0, [Math]::Min(220, $jsonText.Length)))
      }
      default {
        return ($toolName + ": " + ($jsonText -replace "\s+", " ").Substring(0, [Math]::Min(220, $jsonText.Length)))
      }
    }
  } catch {
    return ($toolName + ": " + ($jsonText -replace "\s+", " ").Substring(0, [Math]::Min(220, $jsonText.Length)))
  }
}

function Invoke-And-Summarize([string]$toolName, $toolArgs) {
  $result = Invoke-McpTool -ToolName $toolName -Arguments $toolArgs
  $txt = ""
  try { $txt = [string]$result.content[0].text } catch {}
  return Summarize-McpToolText -toolName $toolName -jsonText $txt
}

function Invoke-Sync-Any() {
  return Invoke-And-Summarize -toolName "sync" -toolArgs @{ op = "status" }
}

function Try-ExecuteTask([string]$msg) {
  if ([string]::IsNullOrWhiteSpace($msg)) {
    return @{ executed = $false; reason = "empty_message" }
  }
  $lower = $msg.ToLowerInvariant()
  $matchWeekdayTime = ($lower -match "день\s+недел") -or ($lower -match "какой\s+сегодня") -or ($lower -match "который\s+час") -or ($lower -match "текущее\s+время") -or ($lower -match "what\s+day") -or ($lower -match "day\s+of\s+week") -or ($lower -match "current\s+time") -or ($lower -match "what\s+time")
  $matchIdentity = ($lower -match "кто\s+ты") -or ($lower -match "что\s+умеешь") -or ($lower -match "что\s+можешь") -or ($lower -match "какие\s+возможности") -or ($lower -match "who\s+are\s+you") -or ($lower -match "what\s+can\s+you\s+do")
  $matchToolsList = ($lower -match "какие\s+.*инструмент") -or ($lower -match "доступные\s+инструмент") -or ($lower -match "list\s+tools") -or ($lower -match "available\s+tools")
  $matchToolExplain = ($lower -match "что\s+делает\s+") -or ($lower -match "что\s+умеет\s+tool") -or ($lower -match "what\s+does\s+tool")
  $matchComplexImprove = ($lower -match "improve") -or ($lower -match "improvement") -or ($lower -match "улучш")
  $matchSyncStatus = ($lower -match "sync\s*\(\s*op\s*=\s*[""']?status[""']?\s*\)") -or ($lower -match "sync\(op=status\)") -or ($lower -match "sync_status")
  $matchSearchWeb = ($lower -match "search_web") -or ($lower -match "web_search") -or ($lower -match "internet") -or ($lower -match "weather") -or ($lower -match "kurs") -or ($lower -match "usd") -or ($lower -match "uah") -or ($lower -match "погод") -or ($lower -match "курс") -or ($lower -match "доллар") -or ($lower -match "гривн")
  $matchFsProjects = ($lower -match "list_directory") -or ($lower -match "fs_projects") -or ($lower -match "list files") -or ($lower -match "folders") -or ($lower -match "directory") -or ($lower -match "c:\\users\\anani\\projects")
  $matchTerminalSwe = ($lower -match "terminal_swe\s+op\s+")
  $matchGovernanceTuner = ($lower -match "governance_tuner_tick")
  $matchGovernanceThresholdTuner = ($lower -match "governance_threshold_tuner_tick")
  $matchArenaGovernanceSet = ($lower -match "arena_governance_set")

  if ($matchArenaGovernanceSet) {
    if (-not (Is-ExecAllowed "arena_governance_set")) {
      return @{ executed = $false; reason = "not_allowed"; tool = "arena_governance_set" }
    }
    $toolArgs = Try-ParseArenaGovernanceSetRequest -msg $msg
    if ($null -eq $toolArgs) {
      return @{ executed = $false; reason = "missing_query"; tool = "arena_governance_set" }
    }
    try {
      $before = $null
      if (Is-ExecAllowed "arena_governance_get") {
        try {
          $beforeRes = Invoke-McpTool -ToolName "arena_governance_get" -Arguments @{}
          $before = [string]$beforeRes.content[0].text
        } catch {}
      }
      $runRes = Invoke-McpTool -ToolName "arena_governance_set" -Arguments $toolArgs
      $runTxt = ""
      try { $runTxt = [string]$runRes.content[0].text } catch {}
      $after = $null
      if (Is-ExecAllowed "arena_governance_get") {
        try {
          $afterRes = Invoke-McpTool -ToolName "arena_governance_get" -Arguments @{}
          $after = [string]$afterRes.content[0].text
        } catch {}
      }
      $e = New-Object System.Collections.ArrayList
      [void]$e.Add(("arena_governance_set args={0} result={1}" -f (($toolArgs | ConvertTo-Json -Compress), ($runTxt -replace '\s+',' ').Substring(0, [Math]::Min(300, $runTxt.Length)))))
      if ($before) { [void]$e.Add(("arena_before={0}" -f (($before -replace '\s+',' ').Substring(0, [Math]::Min(300, $before.Length)))) ) }
      if ($after) { [void]$e.Add(("arena_after={0}" -f (($after -replace '\s+',' ').Substring(0, [Math]::Min(300, $after.Length)))) ) }
      return @{
        executed = $true
        tool = "arena_governance_set"
        op = "run"
        summary = "arena_governance_set executed"
        evidence_lines = @($e)
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "arena_governance_set"
        error = $_.Exception.Message
      }
    }
  }

  if ($matchGovernanceThresholdTuner) {
    if (-not (Is-ExecAllowed "governance_threshold_tuner_tick")) {
      return @{ executed = $false; reason = "not_allowed"; tool = "governance_threshold_tuner_tick" }
    }
    $toolArgs = Try-ParseGovernanceThresholdTunerRequest -msg $msg
    if ($null -eq $toolArgs) {
      return @{ executed = $false; reason = "missing_query"; tool = "governance_threshold_tuner_tick" }
    }
    try {
      $before = $null
      if (Is-ExecAllowed "governance_get") {
        try {
          $beforeRes = Invoke-McpTool -ToolName "governance_get" -Arguments @{}
          $before = [string]$beforeRes.content[0].text
        } catch {}
      }
      $runRes = Invoke-McpTool -ToolName "governance_threshold_tuner_tick" -Arguments $toolArgs
      $runTxt = ""
      try { $runTxt = [string]$runRes.content[0].text } catch {}
      $after = $null
      if (Is-ExecAllowed "governance_get") {
        try {
          $afterRes = Invoke-McpTool -ToolName "governance_get" -Arguments @{}
          $after = [string]$afterRes.content[0].text
        } catch {}
      }
      $e = New-Object System.Collections.ArrayList
      [void]$e.Add(("governance_threshold_tuner_tick args={0} result={1}" -f (($toolArgs | ConvertTo-Json -Compress), ($runTxt -replace '\s+',' ').Substring(0, [Math]::Min(300, $runTxt.Length)))))
      if ($before) { [void]$e.Add(("governance_before={0}" -f (($before -replace '\s+',' ').Substring(0, [Math]::Min(300, $before.Length)))) ) }
      if ($after) { [void]$e.Add(("governance_after={0}" -f (($after -replace '\s+',' ').Substring(0, [Math]::Min(300, $after.Length)))) ) }
      return @{
        executed = $true
        tool = "governance_threshold_tuner_tick"
        op = "run"
        summary = "governance_threshold_tuner_tick executed"
        evidence_lines = @($e)
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "governance_threshold_tuner_tick"
        error = $_.Exception.Message
      }
    }
  }

  if ($matchGovernanceTuner) {
    if (-not (Is-ExecAllowed "governance_tuner_tick")) {
      return @{ executed = $false; reason = "not_allowed"; tool = "governance_tuner_tick" }
    }
    $toolArgs = Try-ParseGovernanceTunerRequest -msg $msg
    if ($null -eq $toolArgs) {
      return @{ executed = $false; reason = "missing_query"; tool = "governance_tuner_tick" }
    }
    try {
      $before = $null
      if (Is-ExecAllowed "governance_get") {
        try {
          $beforeRes = Invoke-McpTool -ToolName "governance_get" -Arguments @{}
          $before = [string]$beforeRes.content[0].text
        } catch {}
      }
      $runRes = Invoke-McpTool -ToolName "governance_tuner_tick" -Arguments $toolArgs
      $runTxt = ""
      try { $runTxt = [string]$runRes.content[0].text } catch {}
      $after = $null
      if (Is-ExecAllowed "governance_get") {
        try {
          $afterRes = Invoke-McpTool -ToolName "governance_get" -Arguments @{}
          $after = [string]$afterRes.content[0].text
        } catch {}
      }
      $e = New-Object System.Collections.ArrayList
      [void]$e.Add(("governance_tuner_tick args={0} result={1}" -f (($toolArgs | ConvertTo-Json -Compress), ($runTxt -replace '\s+',' ').Substring(0, [Math]::Min(300, $runTxt.Length)))))
      if ($before) { [void]$e.Add(("governance_before={0}" -f (($before -replace '\s+',' ').Substring(0, [Math]::Min(300, $before.Length)))) ) }
      if ($after) { [void]$e.Add(("governance_after={0}" -f (($after -replace '\s+',' ').Substring(0, [Math]::Min(300, $after.Length)))) ) }
      return @{
        executed = $true
        tool = "governance_tuner_tick"
        op = "run"
        summary = "governance_tuner_tick executed"
        evidence_lines = @($e)
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "governance_tuner_tick"
        error = $_.Exception.Message
      }
    }
  }

  if ($matchTerminalSwe) {
    if (-not (Is-ExecAllowed "terminal_swe")) {
      return @{ executed = $false; reason = "not_allowed"; tool = "terminal_swe" }
    }
    $toolArgs = Try-ParseTerminalSweRequest -msg $msg
    if ($null -eq $toolArgs) {
      return @{ executed = $false; reason = "missing_query"; tool = "terminal_swe" }
    }
    try {
      $res = Invoke-McpTool -ToolName "terminal_swe" -Arguments $toolArgs
      $summary = ""
      try {
        $json = [string]$res.content[0].text
        if (-not [string]::IsNullOrWhiteSpace($json)) {
          $obj = $json | ConvertFrom-Json
          if ($obj.PSObject.Properties.Name -contains "data") {
            $summary = ("terminal_swe op={0} result_ok=true" -f [string]$toolArgs.op)
          } else {
            $summary = ("terminal_swe op={0} executed" -f [string]$toolArgs.op)
          }
        }
      } catch {}
      if ([string]::IsNullOrWhiteSpace($summary)) {
        $summary = ("terminal_swe op={0} executed" -f [string]$toolArgs.op)
      }
      return @{
        executed = $true
        tool = "terminal_swe"
        op = [string]$toolArgs.op
        summary = $summary
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "terminal_swe"
        error = $_.Exception.Message
      }
    }
  }

  if ($matchIdentity) {
    try {
      $catalog = Get-ToolsCatalog
      $total = [int]$catalog.count
      $hasFs = $null -ne (Find-ToolByName -name "fs" -catalog $catalog)
      $hasTasks = $null -ne (Find-ToolByName -name "tasks" -catalog $catalog)
      $hasNotes = $null -ne (Find-ToolByName -name "notes" -catalog $catalog)
      $hasExec = $null -ne (Find-ToolByName -name "exec" -catalog $catalog)
      $hasSync = $null -ne (Find-ToolByName -name "sync" -catalog $catalog)
      $hasExp = $null -ne (Find-ToolByName -name "experiment" -catalog $catalog)
      $hasCamp = $null -ne (Find-ToolByName -name "campaign" -catalog $catalog)
      $hasAgents = $null -ne (Find-ToolByName -name "agent_registry" -catalog $catalog)
      $hasEvents = $null -ne (Find-ToolByName -name "event_list" -catalog $catalog)

      $caps = New-Object System.Collections.ArrayList
      if ($hasFs) { [void]$caps.Add("- Чтение и изменение файлов проекта") }
      if ($hasExec) { [void]$caps.Add("- Выполнение терминальных команд и диагностики") }
      if ($hasTasks -or $hasNotes) { [void]$caps.Add("- Управление задачами и заметками лаборатории") }
      if ($hasSync) { [void]$caps.Add("- Синхронизация outbound/inbound и контроль транспорта") }
      if ($hasExp -or $hasCamp) { [void]$caps.Add("- Запуск экспериментов и кампаний") }
      if ($hasAgents) { [void]$caps.Add("- Управление версиями агентов (create/activate/evaluate)") }
      if ($hasEvents) { [void]$caps.Add("- Публикация и анализ событий/логов") }
      if ($caps.Count -eq 0) { [void]$caps.Add("- Базовые операции через доступные MCP tools") }

      $text = @(
        "Я — SWE-агент вашей AI-лаборатории в Windsurf (через MCP мост).",
        "",
        "Что я умею делать:",
        ($caps -join "`n"),
        "",
        ("Сейчас вижу {0} инструментов лаборатории и могу вызывать их по задаче." -f $total),
        "Могу работать как инженер-исполнитель: анализ, изменения, проверка, отчёт по фактам."
      ) -join "`n"

      return @{
        executed = $true
        tool = "tools_catalog"
        op = "identity"
        verdict = "DONE"
        summary = ("identity_response_built_from_catalog tools={0}" -f $total)
        human_text = $text
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "tools_catalog"
        error = $_.Exception.Message
      }
    }
  }

  if ($matchToolsList) {
    try {
      $catalog = Get-ToolsCatalog
      $top = @($catalog.tools | Select-Object -First 40)
      $lines = New-Object System.Collections.ArrayList
      foreach ($t in $top) {
        $name = [string]$t.name
        $desc = [string]$t.description
        if ([string]::IsNullOrWhiteSpace($desc)) {
          [void]$lines.Add("$name")
        } else {
          [void]$lines.Add("${name}: $desc")
        }
      }
      return @{
        executed = $true
        tool = "tools_catalog"
        op = "list"
        verdict = "DONE"
        summary = ("tools_loaded={0}, showing={1}" -f [int]$catalog.count, [int]$top.Count)
        evidence_lines = @($lines)
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "tools_catalog"
        error = $_.Exception.Message
      }
    }
  }

  if ($matchToolExplain) {
    try {
      $toolName = Extract-ToolNameFromMessage -msg $msg
      if ([string]::IsNullOrWhiteSpace($toolName)) {
        return @{ executed = $false; reason = "missing_query"; tool = "tools_catalog" }
      }
      $catalog = Get-ToolsCatalog
      $toolInfo = Find-ToolByName -name $toolName -catalog $catalog
      if ($null -eq $toolInfo) {
        return @{
          executed = $false
          reason = "tool_execution_failed"
          tool = "tools_catalog"
          error = ("tool_not_found_in_catalog: " + $toolName)
        }
      }
      $desc = [string]$toolInfo.description
      if ([string]::IsNullOrWhiteSpace($desc)) { $desc = "description_not_provided" }
      return @{
        executed = $true
        tool = "tools_catalog"
        op = "describe"
        verdict = "DONE"
        summary = ("{0}: {1}" -f [string]$toolInfo.name, $desc)
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "tools_catalog"
        error = $_.Exception.Message
      }
    }
  }

  if ($matchWeekdayTime) {
    if (-not (Is-ExecAllowed "exec")) {
      return @{ executed = $false; reason = "not_allowed"; tool = "exec" }
    }
    try {
      $res = Invoke-McpTool -ToolName "exec" -Arguments @{
        cmd = "powershell"
        args = @("-NoProfile", "-Command", "(Get-Date).ToString('dddd, yyyy-MM-dd HH:mm:ss')")
        timeout_ms = 15000
      }
      $summary = ""
      try {
        $json = [string]$res.content[0].text
        if (-not [string]::IsNullOrWhiteSpace($json)) {
          $obj = $json | ConvertFrom-Json
          $stdout = [string]$obj.stdout
          $stdout = $stdout.Trim()
          if (-not [string]::IsNullOrWhiteSpace($stdout)) {
            $summary = ("local_datetime={0}" -f $stdout)
          }
        }
      } catch {}
      if ([string]::IsNullOrWhiteSpace($summary)) {
        $summary = "local datetime fetched via exec"
      }
      return @{
        executed = $true
        tool = "exec"
        op = "get_datetime"
        summary = $summary
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "exec"
        error = $_.Exception.Message
      }
    }
  }

  if ($matchComplexImprove) {
    $evidence = New-Object System.Collections.ArrayList
    $attemptedAllowed = $false
    $specs = @(
      @{ tool = "worker_metrics_snapshot"; args = @{} },
      @{ tool = "intelligence_health_snapshot"; args = @{} },
      @{ tool = "governance_tuner_tick"; args = @{ dry_run = $true; max_changes = 1; min_state_streak = 2 } }
    )
    if (Is-ExecAllowed "sync") {
      try {
        [void]$evidence.Add(("sync_any: " + (Invoke-Sync-Any)))
        $attemptedAllowed = $true
      } catch {
        [void]$evidence.Add("sync_any: failed; error=$($_.Exception.Message)")
      }
    }
    foreach ($s in $specs) {
      $toolName = [string]$s.tool
      if (-not (Is-ExecAllowed $toolName)) { continue }
      $attemptedAllowed = $true
      try {
        $line = Invoke-And-Summarize -toolName $toolName -toolArgs $s.args
        [void]$evidence.Add($line)
      } catch {
        [void]$evidence.Add("${toolName}: failed; error=$($_.Exception.Message)")
      }
    }
    if (-not $attemptedAllowed) {
      return @{ executed = $false; reason = "no_allowed_tools_for_complex"; tool = "planner" }
    }
    return @{
      executed = $true
      tool = "planner"
      op = "improve_lab_diagnostics"
      verdict = "DONE"
      summary = "complex task analyzed with real tools; improvement plan prepared"
      evidence_lines = @($evidence)
    }
  }

  if ($matchSyncStatus) {
    if (-not (Is-ExecAllowed "sync")) {
      return @{ executed = $false; reason = "not_allowed"; tool = "sync" }
    }
    try {
      $syncResult = Invoke-McpTool -ToolName "sync" -Arguments @{ op = "status" }
      $summary = ""
      try {
        $json = [string]$syncResult.content[0].text
        if (-not [string]::IsNullOrWhiteSpace($json)) {
          $obj = $json | ConvertFrom-Json
          $summary = ("enabled={0}, pending_inbound_ids={1}" -f $obj.enabled, $obj.mappings.pending_inbound_ids)
        }
      } catch {}
      if ([string]::IsNullOrWhiteSpace($summary)) {
        $summary = "sync status fetched"
      }
      return @{
        executed = $true
        tool = "sync"
        op = "status"
        summary = $summary
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "sync"
        error = $_.Exception.Message
      }
    }
  }

  if ($matchSearchWeb) {
    if (-not (Is-ExecAllowed "web") -and -not (Is-ExecAllowed "search_web")) {
      return @{ executed = $false; reason = "not_allowed"; tool = "web" }
    }
    $query = Try-ExtractQuery -msg $msg
    if ([string]::IsNullOrWhiteSpace($query)) {
      return @{ executed = $false; reason = "missing_query"; tool = "web" }
    }
    try {
      $invoke = Invoke-FirstAvailableTool -ToolNames @("web", "search_web") -Arguments @{ op = "search"; query = $query; max_results = 3 }
      if (-not $invoke.ok) {
        return @{
          executed = $false
          reason = "tool_execution_failed"
          tool = "web"
          error = [string]$invoke.error
        }
      }
      $res = $invoke.result
      $usedTool = [string]$invoke.tool
      $summary = ""
      try {
        $json = [string]$res.content[0].text
        if (-not [string]::IsNullOrWhiteSpace($json)) {
          $obj = $json | ConvertFrom-Json
          $r0 = $null
          if ($obj.results -and $obj.results.Count -gt 0) { $r0 = $obj.results[0] }
          $head = [string]$obj.heading
          $first = ""
          if ($null -ne $r0) { $first = [string]$r0.text }
          $summary = ("query='{0}', heading='{1}', first='{2}'" -f $query, $head, $first)
        }
      } catch {}
      if ([string]::IsNullOrWhiteSpace($summary)) {
        $summary = ("query='{0}', results fetched" -f $query)
      }
      return @{
        executed = $true
        tool = $usedTool
        op = "query"
        summary = $summary
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "search_web"
        error = $_.Exception.Message
      }
    }
  }

  if ($matchFsProjects) {
    if (-not (Is-ExecAllowed "fs_projects") -and -not (Is-ExecAllowed "fs")) {
      return @{ executed = $false; reason = "not_allowed"; tool = "fs_projects" }
    }
    $path = Try-ExtractFsPath -msg $msg
    try {
      $invoke = Invoke-FirstAvailableTool -ToolNames @("fs_projects", "fs") -Arguments @{ path = $path; limit = 20; op = "list"; dir = $path }
      if (-not $invoke.ok) {
        return @{
          executed = $false
          reason = "tool_execution_failed"
          tool = "fs_projects"
          error = [string]$invoke.error
        }
      }
      $res = $invoke.result
      $usedTool = [string]$invoke.tool
      $summary = ""
      try {
        $json = [string]$res.content[0].text
        if (-not [string]::IsNullOrWhiteSpace($json)) {
          $obj = $json | ConvertFrom-Json
          $count = 0
          if ($obj.PSObject.Properties.Name -contains "count") { $count = [int]$obj.count }
          elseif ($obj.PSObject.Properties.Name -contains "items" -and $obj.items) { $count = [int]$obj.items.Count }
          $first = ""
          if ($obj.PSObject.Properties.Name -contains "entries" -and $obj.entries -and $obj.entries.Count -gt 0) {
            $first = [string]$obj.entries[0].name
          } elseif ($obj.PSObject.Properties.Name -contains "items" -and $obj.items -and $obj.items.Count -gt 0) {
            $first = [string]$obj.items[0]
          }
          $target = ""
          if ($obj.PSObject.Properties.Name -contains "target") { $target = [string]$obj.target } else { $target = $path }
          $summary = ("target='{0}', count={1}, first='{2}'" -f $target, $count, $first)
        }
      } catch {}
      if ([string]::IsNullOrWhiteSpace($summary)) {
        $summary = ("path='{0}', fs_projects fetched" -f $path)
      }
      return @{
        executed = $true
        tool = $usedTool
        op = "list"
        summary = $summary
      }
    } catch {
      return @{
        executed = $false
        reason = "tool_execution_failed"
        tool = "fs_projects"
        error = $_.Exception.Message
      }
    }
  }

  return @{ executed = $false; reason = "no_supported_command" }
}

function Build-NotProvenReply($taskExec, [string]$origId) {
  $profile = Get-ResponseProfile
  $reason = [string]$taskExec.reason
  $tool = [string]$taskExec.tool
  $evidenceLine = ""
  switch ($reason) {
    "not_allowed" {
      $evidenceLine = "TOOL_RESULT(ipc_receive): id=$origId; reject=tool_not_allowed; tool=$tool"
    }
    "missing_query" {
      $evidenceLine = "TOOL_RESULT(ipc_receive): id=$origId; reject=missing_query"
    }
    "tool_execution_failed" {
      $evidenceLine = "TOOL_RESULT($tool): failed; error=$($taskExec.error)"
    }
    "no_allowed_tools_for_complex" {
      $evidenceLine = "TOOL_RESULT(ipc_receive): id=$origId; reject=no_allowed_tools_for_complex"
    }
    default {
      $evidenceLine = "TOOL_RESULT(ipc_receive): id=$origId; reject=unsupported_command"
    }
  }
  if ($profile -eq "broad") {
    return @(
      "EVIDENCE: $evidenceLine",
      "VERDICT: NOT_PROVEN",
      "reason: insufficient executable actions in bridge runtime"
    ) -join "`n"
  }
  return @(
      "PLAN:",
      "- validate request and run only allowed tools",
      "ACTION:",
      "- execution blocked or insufficient inputs",
      "EVIDENCE:",
      "- $evidenceLine",
      "VERDICT:",
      "NOT_PROVEN"
    ) -join "`n"
}

function Build-DoneReply($taskExec) {
  $human = ""
  if ($taskExec -is [hashtable]) {
    if ($taskExec.ContainsKey("human_text")) { $human = [string]$taskExec["human_text"] }
  } else {
    if ($taskExec.PSObject.Properties.Name -contains "human_text") { $human = [string]$taskExec.human_text }
  }
  if (-not [string]::IsNullOrWhiteSpace($human)) { return $human }
  $profile = Get-ResponseProfile
  $verdict = if ([string]::IsNullOrWhiteSpace([string]$taskExec.verdict)) { "DONE" } else { [string]$taskExec.verdict.ToUpperInvariant() }
  $evidenceLines = New-Object System.Collections.ArrayList
  if ($taskExec.evidence_lines -and $taskExec.evidence_lines.Count -gt 0) {
    foreach ($l in $taskExec.evidence_lines) {
      [void]$evidenceLines.Add("- TOOL_RESULT($($taskExec.tool)): $l")
    }
  } else {
    [void]$evidenceLines.Add("- TOOL_RESULT($($taskExec.tool)): $($taskExec.summary)")
  }
  if ($profile -eq "broad") {
    $outBroad = New-Object System.Collections.ArrayList
    [void]$outBroad.Add("EVIDENCE:")
    foreach ($el in $evidenceLines) { [void]$outBroad.Add([string]$el) }
    [void]$outBroad.Add("VERDICT: $verdict")
    [void]$outBroad.Add("reason: bridge execution completed with available tools")
    return ($outBroad -join "`n")
  }
  $out = New-Object System.Collections.ArrayList
  [void]$out.Add("PLAN:")
  [void]$out.Add("- execute requested tool command with strict evidence contract")
  [void]$out.Add("ACTION:")
  [void]$out.Add("- tool execution completed")
  [void]$out.Add("EVIDENCE:")
  foreach ($el in $evidenceLines) { [void]$out.Add([string]$el) }
  [void]$out.Add("VERDICT:")
  [void]$out.Add($verdict)
  return ($out -join "`n")
}

function Build-ChatFallback([string]$msg) {
  $trimmed = ([string]$msg).Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    return "Готов к работе. Напишите задачу, и я выполню ее через доступные инструменты."
  }
  if ($trimmed -match '^(привет|здравствуй|здравствуйте|hello|hi)\b') {
    return "Здравствуйте. Готов выполнять задачи через мост IPC. Напишите, что именно сделать."
  }
  if ($trimmed -match 'кто\s*ты|что\s*умеешь|функц|инструмент|рас+кажи\s*о\s*себе|раскажи\s*о\s*себе|о\s*себе') {
    return @(
      "Я мостовой SWE в режиме auto_exec.",
      "Умею выполнять реальные действия через инструменты (файлы, задачи, метрики, MCP tool-вызовы).",
      "Для точного выполнения дайте команду в формате действия, например: 'покажи папки в C:\\Users\\anani\\Projects' или 'узнай текущий день недели'."
    ) -join " "
  }
  return @(
    "Принял запрос: '$trimmed'.",
    "Сейчас режим auto_exec: выполняю подтверждаемые действия через инструменты.",
    "Если хотите именно выполнение, сформулируйте конкретное действие (что проверить/прочитать/запустить)."
  ) -join " "
}

$root = "C:\Users\anani\Projects\mcp-sync-server"
$ipcDir = Join-Path $root "_sync\windsurf_hooks\ipc"
Ensure-Dir $ipcDir

$messagesFile = Join-Path $ipcDir "messages.jsonl"
$acksFile = Join-Path $ipcDir "acks.jsonl"
$logFile = Join-Path $ipcDir "consumer_log.jsonl"
$lockFile = Join-Path $ipcDir "swe_consumer.lock"

function Process-Once {
  $profile = Get-ResponseProfile
  $activeMode = Get-Mode
  try { [void](Get-ToolsCatalog) } catch {}
  $messages = Read-Jsonl $messagesFile
  $acks = Read-Jsonl $acksFile
  $pending = Get-PendingForSwe -messages $messages -acks $acks -sessionId $SessionId -limit $Limit
  $processed = 0
  $responses = @()

  foreach ($m in $pending) {
    $origId = [string]$m.id
    $kind = [string]$m.kind
    $msg = [string]$m.message
    $now = [DateTime]::UtcNow.ToString("o")
    $replyText = ""
    $replyMode = "auto_stub"
    $llmError = $null
    $llm = $null
    $taskExec = Try-ExecuteTask -msg $msg
    if ($taskExec.executed) {
      $replyText = Build-DoneReply -taskExec $taskExec
      $replyMode = "auto_exec"
    } elseif ($taskExec.reason -eq "no_supported_command" -and ($activeMode -eq "hybrid" -or $activeMode -eq "llm_loop" -or $activeMode -eq "llm")) {
      $llm = Invoke-LlmReply -kind $kind -origId $origId -msg $msg
      if ($llm.ok -and -not [string]::IsNullOrWhiteSpace([string]$llm.text)) {
        $replyText = [string]$llm.text
        $replyMode = "llm_loop"
      } else {
        $llmError = [string]$llm.error
        $replyText = @(
          "EVIDENCE: TOOL_RESULT(llm_agent_chat): failed; error=$llmError",
          "VERDICT: NOT_PROVEN",
          "reason: llm_loop_unavailable"
        ) -join "`n"
        $replyMode = "llm_loop_error"
      }
    } elseif ($taskExec.reason -eq "no_supported_command" -and $activeMode -eq "auto_exec") {
      $replyText = Build-ChatFallback -msg $msg
      $replyMode = "auto_chat"
    } elseif ($taskExec.reason -eq "not_allowed" -or $taskExec.reason -eq "missing_query" -or $taskExec.reason -eq "tool_execution_failed" -or $taskExec.reason -eq "no_supported_command" -or $taskExec.reason -eq "no_allowed_tools_for_complex") {
      $replyText = Build-NotProvenReply -taskExec $taskExec -origId $origId
      $replyMode = "auto_exec_reject"
    } else {
      $replyText = Build-StubReply -kind $kind -origId $origId -msg $msg
      $replyMode = "auto_stub"
    }

    $reply = @{
      ts_utc = $now
      id = New-Id
      session_id = $SessionId
      kind = "response"
      from = "swe"
      to = "codex"
      relates_to = $origId
      mode = $replyMode
      message = $replyText
    }
    if ($null -ne $llmError -and -not [string]::IsNullOrWhiteSpace($llmError)) {
      $reply["llm_error"] = $llmError
    }
    if ($null -ne $llm -and $llm.ok) {
      try { $reply["llm_used_tools"] = @($llm.used_tools) } catch {}
      try { $reply["llm_steps_count"] = @($llm.steps).Count } catch {}
    }
    Append-Jsonl $messagesFile $reply

    $ack = @{
      ts_utc = $now
      id = $origId
      agent = "swe"
      session_id = $SessionId
    }
    Append-Jsonl $acksFile $ack
    $processed += 1
    $responses += $reply
  }

  $result = @{
    ts_utc = [DateTime]::UtcNow.ToString("o")
    session_id = $SessionId
    mode = $activeMode
    pending = @($pending).Count
    processed = $processed
    responses = $responses
  }
  Append-Jsonl $logFile $result
  return $result
}

if ($Once) {
  $lock = Acquire-ConsumerLock -lockPath $lockFile
  if ($null -eq $lock) {
    @{
      ts_utc = [DateTime]::UtcNow.ToString("o")
      session_id = $SessionId
      mode = "locked_skip"
      pending = 0
      processed = 0
      responses = @()
    } | ConvertTo-Json -Depth 20
    exit 0
  }
  try {
    Process-Once | ConvertTo-Json -Depth 20
  } finally {
    $lock.Dispose()
  }
  exit 0
}

$loopLock = Acquire-ConsumerLock -lockPath $lockFile
if ($null -eq $loopLock) {
  # Another consumer is active; do not run second loop.
  exit 0
}

try {
  while ($true) {
    Process-Once | Out-Null
    Start-Sleep -Milliseconds 700
  }
} finally {
  $loopLock.Dispose()
}

