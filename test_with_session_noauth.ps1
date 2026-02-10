$uri = "http://localhost:3000/mcp"

$headersBase = @{
  "Content-Type" = "application/json"
  "Accept" = "application/json, text/event-stream"
}

Write-Host "1) INITIALIZE (no session header)"
$initBodyObj = @{
  jsonrpc = "2.0"
  id      = 1
  method  = "initialize"
  params  = @{
    protocolVersion = "2024-11-05"
    clientInfo      = @{ name = "ps-test"; version = "0.1" }
    capabilities    = @{ }
  }
}

$initBody = $initBodyObj | ConvertTo-Json -Depth 10
$initResp = Invoke-WebRequest -Uri $uri -Method Post -Headers $headersBase -Body $initBody

$sessionId = $initResp.Headers["mcp-session-id"]
if (-not $sessionId) {
  Write-Host "ERROR: mcp-session-id header not found"
  Write-Host "Status:" $initResp.StatusCode
  Write-Host "Body:" $initResp.Content
  exit 1
}

Write-Host "OK session id =" $sessionId
Write-Host ""

Write-Host "2) tools/call whoami (with session header)"
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

$whoResp | ConvertTo-Json -Depth 10
