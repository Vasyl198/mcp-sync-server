$uri = if ($env:MCP_SERVER_URL) { $env:MCP_SERVER_URL } else { "http://localhost:3000/mcp" }
$snapshotPath = if ($env:TOOLS_SNAPSHOT_PATH) { $env:TOOLS_SNAPSHOT_PATH } else { ".\_sync\tools_snapshot.json" }

$headersBase = @{
  "Content-Type" = "application/json"
  "Accept" = "application/json, text/event-stream"
}

if ($env:MCP_SYNC_TOKEN) {
  $headersBase["Authorization"] = "Bearer $($env:MCP_SYNC_TOKEN)"
}

function Convert-McpResponseToObject {
  param(
    [Parameter(Mandatory = $true)]
    $Response
  )

  if ($Response -is [string]) {
    $raw = [string]$Response
    $dataLine = ($raw -split "`r?`n") | Where-Object { $_ -like "data: *" } | Select-Object -Last 1
    if (-not $dataLine) {
      throw "Failed to parse MCP SSE response: no data line found."
    }
    $json = $dataLine.Substring(6).Trim()
    return ($json | ConvertFrom-Json)
  }

  return $Response
}

# Initialize session
$initBodyObj = @{
  jsonrpc = "2.0"
  id      = 1
  method  = "initialize"
  params  = @{
    protocolVersion = "2024-11-05"
    clientInfo      = @{ name = "snapshot"; version = "1.0" }
    capabilities    = @{ }
  }
}

$initBody = $initBodyObj | ConvertTo-Json -Depth 10
$initResp = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method Post -Headers $headersBase -Body $initBody
$sessionId = $initResp.Headers["mcp-session-id"]

if (-not $sessionId) {
  throw "Failed to initialize MCP session. No mcp-session-id header."
}

$headers = $headersBase.Clone()
$headers["mcp-session-id"] = $sessionId

$whoBodyObj = @{
  jsonrpc = "2.0"
  id      = 2
  method  = "tools/call"
  params  = @{
    name      = "whoami"
    arguments = @{ }
  }
}

$whoBody = $whoBodyObj | ConvertTo-Json -Depth 10
$whoResp = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $whoBody
$whoObj = Convert-McpResponseToObject -Response $whoResp

if ($whoObj.error) {
  throw "MCP tools/call whoami failed: $($whoObj.error | ConvertTo-Json -Compress)"
}

if (-not $whoObj.result -or -not $whoObj.result.content -or $whoObj.result.content.Count -lt 1) {
  throw "MCP whoami response has no result.content payload."
}

$whoamiText = $whoObj.result.content[0].text
if (-not $whoamiText) {
  throw "MCP whoami content[0].text is empty."
}

$whoamiObj = $whoamiText | ConvertFrom-Json
if (-not $whoamiObj.tools) {
  throw "Parsed whoami payload has no tools list."
}

$toolsSnapshot = @{
  timestamp   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  auth        = $whoamiObj.auth
  roots       = $whoamiObj.roots
  sync_dir    = $whoamiObj.sync_dir
  sync        = $whoamiObj.sync
  tools_count = $whoamiObj.tools.Count
  tools       = $whoamiObj.tools
}

$snapshotJson = $toolsSnapshot | ConvertTo-Json -Depth 10
$snapshotJson | Out-File -FilePath $snapshotPath -Encoding UTF8

Write-Host "Tools snapshot saved to: $snapshotPath"
Write-Host "Total tools: $($toolsSnapshot.tools_count)"
Write-Host "Tools list:"
$toolsSnapshot.tools | ForEach-Object { Write-Host "  - $_" }
