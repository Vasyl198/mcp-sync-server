# Test simple JSON
$json = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
Write-Host "JSON:"
Write-Host $json

try {
  $response = Invoke-RestMethod -Uri "http://localhost:3000/mcp" -Method Post -ContentType "application/json" -Body $json
  Write-Host "RESPONSE:"
  Write-Host ($response | ConvertTo-Json -Depth 10)
} catch {
  Write-Host "ERROR:"
  Write-Host $_.Exception.Message
  Write-Host "STATUS:"
  Write-Host $_.Exception.Response.StatusCode.value__
  Write-Host "CONTENT:"
  Write-Host $_.Exception.Response.Content
}
