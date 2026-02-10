$body = @{
  jsonrpc = "2.0"
  id = 1
  method = "tools/call"
  params = @{
    name = "whoami"
    arguments = @{}
  }
} | ConvertTo-Json -Depth 10

try {
  $response = Invoke-RestMethod -Uri "http://localhost:3000/mcp" -Method Post -ContentType "application/json" -Body $body
  Write-Host "WHOAMI RESPONSE:"
  Write-Host ($response | ConvertTo-Json -Depth 10)
} catch {
  Write-Host "ERROR:"
  Write-Host $_.Exception.Message
}
