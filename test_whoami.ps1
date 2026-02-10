$body = @{
  jsonrpc = "2.0"
  id = 1
  method = "tools/call"
  params = @{
    name = "whoami"
    arguments = @{}
  }
} | ConvertTo-Json -Depth 10

Write-Host "Request body:"
Write-Host $body

$response = Invoke-RestMethod -Uri "http://localhost:3000/mcp" -Method Post -ContentType "application/json" -Body $body
Write-Host "Response:"
Write-Host ($response | ConvertTo-Json -Depth 10)
