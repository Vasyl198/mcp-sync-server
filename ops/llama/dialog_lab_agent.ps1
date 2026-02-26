param(
  [string]$McpUrl = "http://127.0.0.1:3000/mcp",
  [string]$Model = "qwen2.5-3b-instruct",
  [string[]]$AllowedTools = @("sync_status", "search_web", "fs_projects"),
  [string]$AllowedToolsCsv = "",
  [int]$MaxSteps = 6,
  [switch]$ShowTrace,
  [string]$AuthToken = ""
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

if ($AllowedToolsCsv) {
  $AllowedTools = $AllowedToolsCsv.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
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
  } catch {
    # fallback below
  }
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

$token = if ($AuthToken) { $AuthToken } else { [string]$env:MCP_SYNC_TOKEN }

Write-Host "Initializing MCP session..."
$initResp = Invoke-McpPost -Url $McpUrl -Headers (New-McpHeaders -Bearer $token) -BodyObj @{
  jsonrpc = "2.0"
  id = 1
  method = "initialize"
  params = @{
    protocolVersion = "2024-11-05"
    capabilities = @{}
    clientInfo = @{
      name = "dialog-lab-agent"
      version = "1.0.0"
    }
  }
}

$sessionId = [string]$initResp.Headers["mcp-session-id"]
if (-not $sessionId) { throw "MCP initialize failed: missing mcp-session-id." }

Write-Host "Qwen Lab Agent dialog started. Type 'exit' to quit."
Write-Host "Model: $Model"
Write-Host "MCP:   $McpUrl"
Write-Host "Tools: $($AllowedTools -join ', ')"
Write-Host ""

$history = New-Object System.Collections.ArrayList

while ($true) {
  [Console]::Write("You: ")
  $user = [Console]::ReadLine()
  if ([string]::IsNullOrWhiteSpace($user)) { continue }
  if ($user.Trim().ToLowerInvariant() -eq "exit") { break }

  [void]$history.Add(@{ role = "user"; content = $user })

  $callResp = Invoke-McpPost -Url $McpUrl -Headers (New-McpHeaders -SessionId $sessionId -Bearer $token) -BodyObj @{
    jsonrpc = "2.0"
    id = 2
    method = "tools/call"
    params = @{
      name = "llm_agent_chat"
      arguments = @{
        messages = $history
        model = $Model
        allowed_tools = $AllowedTools
        max_steps = $MaxSteps
        trace = $true
      }
    }
  }

  $rpc = (Get-McpDataJsonText -SseContent (Get-ResponseUtf8Content -Response $callResp)) | ConvertFrom-Json
  if ($rpc.error) {
    Write-Host ""
    Write-Host "Agent error: $($rpc.error.message)"
    Write-Host ""
    continue
  }

  $contentText = [string]$rpc.result.content[0].text
  $agentResult = $contentText | ConvertFrom-Json
  $answer = [string]$agentResult.final
  if ([string]::IsNullOrWhiteSpace($answer)) { $answer = "[empty answer]" }

  Write-Host ""
  Write-Host "Qwen: $answer"
  if ($ShowTrace -and $agentResult.steps) {
    Write-Host ""
    Write-Host "Trace:"
    foreach ($s in $agentResult.steps) {
      $kind = [string]$s.kind
      if ($kind -eq "tool_call") {
        Write-Host ("- step {0}: tool_call {1}" -f $s.step, $s.tool)
      } elseif ($kind -eq "tool_error") {
        Write-Host ("- step {0}: tool_error {1} -> {2}" -f $s.step, $s.tool, $s.error)
      } else {
        Write-Host ("- step {0}: {1}" -f $s.step, $kind)
      }
    }
  }
  Write-Host ""

  [void]$history.Add(@{ role = "assistant"; content = $answer })
}

Write-Host "Dialog closed."
