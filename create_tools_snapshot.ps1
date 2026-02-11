$uri = "http://localhost:3000/mcp"

$headersBase = @{
  "Content-Type" = "application/json"
  "Accept" = "application/json, text/event-stream"
}

# Initialize session
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
$initResp = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method Post -Headers $headersBase -Body $initBody

$sessionId = $initResp.Headers["mcp-session-id"]
Write-Host "Session ID: $sessionId"

# Get whoami response
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

# Parse whoami response and extract tools list
$whoamiText = $whoResp.result.content[0].text
$whoamiObj = $whoamiText | ConvertFrom-Json

$toolsSnapshot = @{
  timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
  auth = $whoamiObj.auth
  roots = $whoamiObj.roots
  sync_dir = $whoamiObj.sync_dir
  tools_count = $whoamiObj.tools.Count
  tools = $whoamiObj.tools
}

# Write snapshot to file
$snapshotPath = "C:\Users\anani\Projects\_sync\tools_snapshot.json"
$snapshotJson = $toolsSnapshot | ConvertTo-Json -Depth 10
$snapshotJson | Out-File -FilePath $snapshotPath -Encoding UTF8

Write-Host "Tools snapshot saved to: $snapshotPath"
Write-Host "Total tools: $($toolsSnapshot.tools_count)"
Write-Host "Tools list:"
$toolsSnapshot.tools | ForEach-Object { Write-Host "  - $_" }
