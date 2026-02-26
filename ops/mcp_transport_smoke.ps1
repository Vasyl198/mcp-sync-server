param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [string]$AuthToken = "",
  [switch]$SkipToolsList
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

function Write-Check([string]$Name, [bool]$Ok, [string]$Details = "") {
  $prefix = if ($Ok) { "[OK]" } else { "[FAIL]" }
  if ([string]::IsNullOrWhiteSpace($Details)) {
    Write-Host "$prefix $Name"
  } else {
    Write-Host "$prefix $Name :: $Details"
  }
}

function Get-ResponseUtf8Content {
  param([object]$Response)
  if ($null -eq $Response) { return "" }
  try {
    if ($Response.PSObject.Properties.Name -contains "RawContentStream" -and $Response.RawContentStream) {
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

function Get-FirstSseDataJsonText {
  param([string]$SseContent)
  $line = ($SseContent -split "`r?`n" | Where-Object { $_ -like "data:*" } | Select-Object -First 1)
  if (-not $line) { throw "No 'data:' line in SSE response." }
  return $line.Substring(5).Trim()
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

function New-McpHeaders {
  param(
    [string]$Accept = "application/json, text/event-stream",
    [string]$SessionId = "",
    [string]$Bearer = ""
  )
  $headers = @{
    "Accept" = $Accept
    "mcp-protocol-version" = "2024-11-05"
  }
  if ($SessionId) { $headers["mcp-session-id"] = $SessionId }
  if ($Bearer) { $headers["Authorization"] = "Bearer $Bearer" }
  return $headers
}

$token = if ($AuthToken) { $AuthToken } else { [string]$env:MCP_SYNC_TOKEN }
$mcpUrl = ($BaseUrl.TrimEnd("/")) + "/mcp"
$healthUrl = ($BaseUrl.TrimEnd("/")) + "/health"

$failed = $false

Write-Host "MCP transport smoke"
Write-Host "Base: $BaseUrl"
Write-Host "MCP : $mcpUrl"
Write-Host ""

# 1) Health
try {
  $health = Invoke-WebRequest -UseBasicParsing -Method Get -Uri $healthUrl -TimeoutSec 5
  $healthText = (Get-ResponseUtf8Content -Response $health).Trim()
  $ok = ($health.StatusCode -eq 200 -and $healthText -eq "ok")
  Write-Check "GET /health" $ok "status=$($health.StatusCode), body='$healthText'"
  if (-not $ok) { $failed = $true }
} catch {
  Write-Check "GET /health" $false $_.Exception.Message
  $failed = $true
}

# 2) Fail-fast: wrong Accept should return 406
try {
  $badAcceptHeaders = New-McpHeaders -Accept "application/json" -Bearer $token
  $null = Invoke-McpPost -Url $mcpUrl -Headers $badAcceptHeaders -BodyObj @{
    jsonrpc = "2.0"
    id = "bad-accept"
    method = "tools/list"
    params = @{}
  }
  Write-Check "POST /mcp bad Accept -> 406" $false "server unexpectedly accepted request"
  $failed = $true
} catch {
  $resp = $_.Exception.Response
  $code = if ($resp) { [int]$resp.StatusCode } else { -1 }
  $ok = ($code -eq 406)
  Write-Check "POST /mcp bad Accept -> 406" $ok "status=$code"
  if (-not $ok) { $failed = $true }
}

# 3) Initialize with SSE accept
$sessionId = ""
try {
  $initResp = Invoke-McpPost -Url $mcpUrl -Headers (New-McpHeaders -Bearer $token) -BodyObj @{
    jsonrpc = "2.0"
    id = "init-1"
    method = "initialize"
    params = @{
      protocolVersion = "2024-11-05"
      capabilities = @{}
      clientInfo = @{
        name = "mcp-transport-smoke"
        version = "1.0.0"
      }
    }
  }
  $sessionId = [string]$initResp.Headers["mcp-session-id"]
  $contentType = [string]$initResp.Headers["Content-Type"]
  $sseBody = Get-ResponseUtf8Content -Response $initResp
  $jsonText = Get-FirstSseDataJsonText -SseContent $sseBody
  $rpc = $jsonText | ConvertFrom-Json
  $ok = ($initResp.StatusCode -eq 200 -and -not [string]::IsNullOrWhiteSpace($sessionId) -and $null -ne $rpc.result)
  Write-Check "POST /mcp initialize" $ok "status=$($initResp.StatusCode), contentType='$contentType', session='$sessionId'"
  if (-not $ok) { $failed = $true }
} catch {
  Write-Check "POST /mcp initialize" $false $_.Exception.Message
  $failed = $true
}

# 4) tools/list with session
if (-not $SkipToolsList) {
  if ([string]::IsNullOrWhiteSpace($sessionId)) {
    Write-Check "POST /mcp tools/list" $false "missing session id from initialize"
    $failed = $true
  } else {
    try {
      $toolsResp = Invoke-McpPost -Url $mcpUrl -Headers (New-McpHeaders -SessionId $sessionId -Bearer $token) -BodyObj @{
        jsonrpc = "2.0"
        id = "tools-1"
        method = "tools/list"
        params = @{}
      }
      $toolsJson = (Get-FirstSseDataJsonText -SseContent (Get-ResponseUtf8Content -Response $toolsResp)) | ConvertFrom-Json
      $count = @($toolsJson.result.tools).Count
      $ok = ($toolsResp.StatusCode -eq 200 -and $count -gt 0)
      Write-Check "POST /mcp tools/list" $ok "status=$($toolsResp.StatusCode), tools=$count"
      if (-not $ok) { $failed = $true }
    } catch {
      Write-Check "POST /mcp tools/list" $false $_.Exception.Message
      $failed = $true
    }
  }
}

Write-Host ""
if ($failed) {
  Write-Host "Result: FAIL"
  exit 1
}

Write-Host "Result: PASS"
exit 0

